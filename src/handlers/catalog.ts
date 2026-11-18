// Service Catalog: renders any catalog item's variables as a form and orders it through the
// Service Catalog API (sn_sc), which creates the request (sc_request) and requested items
// (sc_req_item) exactly as the portal's Order Now does.
//
// The form is built from the item's variable definitions (item_option_new, including those
// from variable sets). UI policies, client scripts and catalog data lookups are not run, so
// it suits simple items; anything the gateway can't render is listed as unsupported.
import { IdempotencyCache } from "../idempotency.js";
import type { SNClient } from "../sn-client.js";
import { errorResult, fieldErrors } from "./types.js";
import type { FieldError, HandlerContext, HandlerRegistry, HandlerResult } from "./types.js";
import { disp, isFieldName, isSysId, sanitizeQueryText, str, val } from "./util.js";

export type VarKind =
  | "text"
  | "textarea"
  | "email"
  | "url"
  | "ip"
  | "masked"
  | "yesno"
  | "checkbox"
  | "radio"
  | "select"
  | "reference"
  | "list"
  | "date"
  | "datetime"
  | "label"
  | "section"
  | "unsupported";

export interface CatalogVariable {
  id: string; // item_option_new sys_id
  name: string;
  label: string;
  kind: VarKind;
  type: number; // ServiceNow variable type
  mandatory: boolean;
  read_only: boolean;
  order: number;
  help_text?: string;
  default_value?: string;
  default_display?: string;
  reference_table?: string; // reference and list kinds
  choices?: { value: string; label: string }[];
}

export interface CatalogItemForm {
  item: {
    sys_id: string;
    name: string;
    short_description: string;
    description: string; // HTML from the catalog item
    price: string;
    delivery_time: string;
    quantity_allowed: boolean;
    url: string;
  };
  variables: CatalogVariable[];
  unsupported: { name: string; label: string; reason: string }[];
}

// item_option_new.type → how the form renders it.
const TYPE_KIND: Record<number, VarKind> = {
  1: "yesno",
  2: "textarea",
  3: "radio",
  4: "radio", // numeric scale
  5: "select",
  6: "text",
  7: "checkbox",
  8: "reference",
  9: "date",
  10: "datetime",
  11: "label",
  12: "section", // break
  16: "text", // wide single line
  18: "select", // lookup select box
  19: "section", // container start
  20: "section", // container end
  21: "list", // list collector
  22: "radio", // lookup multiple choice
  24: "section", // container split
  25: "masked",
  26: "email",
  27: "url",
  28: "ip",
  31: "reference", // requested for (sys_user)
  32: "label", // rich text label
};

const TYPE_NAMES: Record<number, string> = {
  14: "Custom (macro)",
  15: "UI page",
  17: "Custom with label",
  23: "HTML",
  29: "Duration",
  33: "Attachment",
};

const VAR_FIELDS = [
  "sys_id",
  "name",
  "question_text",
  "type",
  "mandatory",
  "read_only",
  "order",
  "help_text",
  "default_value",
  "reference",
  "list_table",
  "lookup_table",
  "lookup_value",
  "lookup_label",
  "choice_table",
  "choice_field",
  "variable_set",
  "active",
];

const ITEM_FIELDS = [
  "sys_id",
  "name",
  "short_description",
  "description",
  "price",
  "delivery_time",
  "no_quantity",
  "active",
  "sys_class_name",
];

const truthy = (v: unknown) => String(val(v)).toLowerCase() === "true";

function itemUrl(sn: SNClient, sysId: string): string {
  return `${sn.instanceUrl}/sp?id=sc_cat_item&sys_id=${sysId}`;
}
function recordUrl(sn: SNClient, table: string, sysId: string): string {
  return `${sn.instanceUrl}/${table}.do?sys_id=${sysId}`;
}

// sc_cat_item.delivery_time is a duration stored as a date-time from the epoch.
export function formatDuration(v: string): string {
  const m = /^1970-01-(\d{2}) (\d{2}):(\d{2}):\d{2}$/.exec(v);
  if (!m) return v;
  const days = Number(m[1]) - 1;
  const hours = Number(m[2]);
  const mins = Number(m[3]);
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins) parts.push(`${mins} min`);
  return parts.join(" ");
}

// ── Item lookup ─────────────────────────────────────────────────────────────

export async function findItems(sn: SNClient, text: string, limit = 10): Promise<any[]> {
  const q = sanitizeQueryText(text);
  const lim = Math.min(Math.max(1, Math.floor(limit) || 10), 50);
  const base = "active=true^sys_class_name!=sc_cat_item_guide";
  const fields = ["sys_id", "name", "short_description", "category"];
  if (!q) return sn.list("sc_cat_item", `${base}^ORDERBYname`, { fields, limit: lim, displayValue: "all" });
  const byName = await sn.list("sc_cat_item", `${base}^nameLIKE${q}^ORDERBYname`, { fields, limit: lim, displayValue: "all" });
  if (byName.length) return byName;
  return sn.list("sc_cat_item", `${base}^short_descriptionLIKE${q}^ORDERBYname`, { fields, limit: lim, displayValue: "all" });
}

// Resolves an item from a sys_id or a name. An exact name match wins over partial ones.
export async function resolveItem(
  sn: SNClient,
  input: string
): Promise<{ sys_id: string; name: string } | { error: string; candidates?: { sys_id: string; name: string }[] }> {
  if (isSysId(input)) {
    const r = await sn.get("sc_cat_item", input, { fields: ["sys_id", "name", "active"] });
    if (!r || !truthy(r.active)) return { error: "Catalog item not found or inactive" };
    return { sys_id: r.sys_id, name: r.name };
  }
  const name = sanitizeQueryText(input, 200);
  const exact = await sn.list("sc_cat_item", `active=true^name=${name}`, { fields: ["sys_id", "name"], limit: 2 });
  if (exact.length >= 1) return { sys_id: exact[0].sys_id, name: exact[0].name };
  const rows = await findItems(sn, input, 5);
  const candidates = rows.map((r) => ({ sys_id: val(r.sys_id), name: disp(r.name) }));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) return { error: `No active catalog item matches "${input}"` };
  return { error: `"${input}" matches more than one catalog item`, candidates };
}

// ── Form definition ─────────────────────────────────────────────────────────

async function loadChoices(sn: SNClient, vars: any[]): Promise<Map<string, { value: string; label: string }[]>> {
  const out = new Map<string, { value: string; label: string }[]>();
  const ids = vars.map((v) => v.sys_id);
  if (ids.length) {
    const rows = await sn.list("question_choice", `questionIN${ids.join(",")}^inactive!=true^ORDERBYorder`, {
      fields: ["question", "text", "value", "order"],
      limit: 1000,
    });
    rows.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    for (const r of rows) {
      const q = val(r.question);
      if (!out.has(q)) out.set(q, []);
      out.get(q)!.push({ value: String(r.value), label: String(r.text || r.value) });
    }
  }
  for (const v of vars) {
    if (out.get(v.sys_id)?.length) continue;
    const type = Number(v.type);
    // Choices from a table's choice list (select box "choice table" / "choice field").
    if (isFieldName(v.choice_table) && isFieldName(v.choice_field)) {
      const rows = await sn.list(
        "sys_choice",
        `name=${v.choice_table}^element=${v.choice_field}^inactive=false^language=en^ORDERBYsequence`,
        { fields: ["value", "label"], limit: 200 }
      );
      out.set(v.sys_id, rows.map((r) => ({ value: String(r.value), label: String(r.label) })));
    } else if ((type === 18 || type === 22) && isFieldName(v.lookup_table)) {
      const value = isFieldName(v.lookup_value) ? v.lookup_value : "sys_id";
      const label = isFieldName(v.lookup_label?.split(",")[0]) ? v.lookup_label.split(",")[0] : value;
      const rows = await sn
        .list(v.lookup_table, `ORDERBY${label}`, { fields: [...new Set([value, label])], limit: 200 })
        .catch(() => []);
      const seen = new Set<string>();
      const list: { value: string; label: string }[] = [];
      for (const r of rows) {
        const vv = String(val(r[value]));
        if (!vv || seen.has(vv)) continue;
        seen.add(vv);
        list.push({ value: vv, label: String(val(r[label]) || vv) });
      }
      out.set(v.sys_id, list);
    } else if (type === 4) {
      out.set(v.sys_id, ["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: n })));
    } else if (type === 1) {
      out.set(v.sys_id, [
        { value: "Yes", label: "Yes" },
        { value: "No", label: "No" },
      ]);
    }
  }
  return out;
}

export async function loadItemForm(sn: SNClient, itemSysId: string, callerSysId?: () => Promise<string | undefined>): Promise<CatalogItemForm | undefined> {
  const item = await sn.get("sc_cat_item", itemSysId, { fields: ITEM_FIELDS, displayValue: "all" });
  if (!item || !truthy(item.active)) return undefined;

  // Variable sets attached to the item, in their order on the item.
  const sets = await sn.list("io_set_item", `sc_cat_item=${itemSysId}^ORDERBYorder`, {
    fields: ["variable_set", "order"],
    limit: 100,
  });
  const setOrder = new Map<string, number>();
  for (const s of sets) if (isSysId(val(s.variable_set))) setOrder.set(val(s.variable_set), Number(val(s.order)) || 0);

  // Multi-row variable sets have type one_to_many and need a grid, which the form lacks.
  const multiRow = new Set<string>();
  const unsupported: CatalogItemForm["unsupported"] = [];
  if (setOrder.size) {
    const setRows = await sn
      .list("item_option_new_set", `sys_idIN${[...setOrder.keys()].join(",")}`, { fields: ["sys_id", "title", "type"], limit: 100 })
      .catch(() => []);
    for (const s of setRows) {
      if (String(val(s.type)) === "one_to_many") {
        multiRow.add(val(s.sys_id));
        unsupported.push({ name: val(s.sys_id), label: String(val(s.title)), reason: "Multi-row variable set" });
      }
    }
  }

  const raw = await sn.list("item_option_new", `active=true^cat_item=${itemSysId}`, { fields: VAR_FIELDS, limit: 500 });
  const singleSets = [...setOrder.keys()].filter((k) => !multiRow.has(k));
  if (singleSets.length) {
    raw.push(
      ...(await sn.list("item_option_new", `active=true^variable_setIN${singleSets.join(",")}`, { fields: VAR_FIELDS, limit: 500 }))
    );
  }

  // Item variables sort by their own order; a set's variables sit at the set's position.
  const rank = (v: any): [number, number] => {
    const set = val(v.variable_set);
    return set && setOrder.has(set) ? [setOrder.get(set)!, Number(v.order) || 0] : [Number(v.order) || 0, -1];
  };
  raw.sort((a, b) => {
    const [a1, a2] = rank(a);
    const [b1, b2] = rank(b);
    return a1 - b1 || a2 - b2;
  });

  const choices = await loadChoices(sn, raw);
  const variables: CatalogVariable[] = [];
  let me: { sys_id: string; name: string } | undefined;
  for (const v of raw) {
    const type = Number(v.type);
    const kind = TYPE_KIND[type];
    const label = String(v.question_text || v.name || "");
    if (!kind) {
      unsupported.push({ name: v.name, label, reason: TYPE_NAMES[type] ?? `Variable type ${type}` });
      continue;
    }
    if (kind === "section" && !label) continue;
    const out: CatalogVariable = {
      id: v.sys_id,
      name: String(v.name ?? ""),
      label,
      kind,
      type,
      mandatory: truthy(v.mandatory),
      read_only: truthy(v.read_only),
      order: Number(v.order) || 0,
    };
    if (v.help_text) out.help_text = String(v.help_text);
    if (kind === "reference") out.reference_table = type === 31 ? "sys_user" : String(v.reference || "") || undefined;
    if (kind === "list") out.reference_table = String(v.list_table || "") || undefined;
    if ((kind === "reference" || kind === "list") && !out.reference_table) {
      unsupported.push({ name: out.name, label, reason: "Reference without a table" });
      continue;
    }
    const c = choices.get(v.sys_id);
    if (c && (kind === "radio" || kind === "select" || kind === "yesno")) out.choices = c;

    // Defaults: literal values only; the common "current user" script is resolved here.
    const def = String(v.default_value ?? "");
    if (def && !def.startsWith("javascript:")) out.default_value = def;
    else if (/gs\.getUserID\(\)/.test(def) && out.reference_table === "sys_user" && callerSysId) {
      if (!me) {
        const id = await callerSysId();
        if (id) {
          const u = await sn.get("sys_user", id, { fields: ["sys_id", "name"] });
          if (u) me = { sys_id: u.sys_id, name: u.name };
        }
      }
      if (me) {
        out.default_value = me.sys_id;
        out.default_display = me.name;
      }
    }
    if (out.default_value && out.kind === "reference" && !out.default_display) {
      if (isSysId(out.default_value)) {
        const dv = await displayFieldFor(sn, out.reference_table!);
        const r = await sn.get(out.reference_table!, out.default_value, { fields: ["sys_id", dv] }).catch(() => null);
        if (r) out.default_display = String(r[dv] ?? "");
        else delete out.default_value;
      } else delete out.default_value;
    }
    if (out.kind === "checkbox" && out.default_value === undefined) out.default_value = "false";
    variables.push(out);
  }

  return {
    item: {
      sys_id: val(item.sys_id),
      name: disp(item.name),
      short_description: disp(item.short_description),
      description: disp(item.description),
      price: disp(item.price),
      delivery_time: formatDuration(val(item.delivery_time)),
      quantity_allowed: !truthy(item.no_quantity),
      url: itemUrl(sn, val(item.sys_id)),
    },
    variables,
    unsupported,
  };
}

// ── Reference lookups ───────────────────────────────────────────────────────

const displayCache = new Map<string, string>();

// The table's display field from the dictionary (walking up to parent tables), else "name".
export async function displayFieldFor(sn: SNClient, table: string): Promise<string> {
  const key = `${sn.instanceUrl}|${table}`;
  const cached = displayCache.get(key);
  if (cached) return cached;
  let found = "name";
  let current: string | undefined = table;
  for (let depth = 0; current && depth < 6; depth++) {
    const rows = await sn
      .list("sys_dictionary", `name=${current}^display=true`, { fields: ["element"], limit: 1 })
      .catch(() => []);
    if (rows[0]?.element) {
      found = String(rows[0].element);
      break;
    }
    const db: any[] = await sn
      .list("sys_db_object", `name=${current}`, { fields: ["super_class"], limit: 1, displayValue: "all" })
      .catch(() => []);
    const parent: string = db[0] ? (db[0].super_class?.display_value ?? "") : "";
    current = parent ? String(parent) : undefined;
  }
  // number is the display field of task tables; still search it like a name.
  displayCache.set(key, found);
  return found;
}

export function clearDisplayCache(): void {
  displayCache.clear();
}

const DETAIL_FIELDS: Record<string, string[]> = {
  sys_user: ["email", "title"],
  sys_user_group: ["description"],
  cmn_cost_center: ["code", "account_number"],
  cmn_location: ["city", "country"],
  cmn_department: ["dept_head"],
  core_company: ["city"],
};

const ACTIVE_FILTER: Record<string, string> = {
  sys_user: "active=true",
  sys_user_group: "active=true",
};

// A variable's simple reference qualifier (encoded query). Script qualifiers aren't run.
function qualifier(v: any): string {
  const use = String(v.use_reference_qualifier ?? "");
  const q = use === "simple" ? String(v.reference_qual_condition ?? "") : String(v.reference_qual ?? "");
  if (!q || q.startsWith("javascript:") || /[\n\r]/.test(q)) return "";
  return q.replace(/\^EQ$/, "");
}

export async function searchReference(
  sn: SNClient,
  variableId: string,
  text: string,
  limit = 10
): Promise<{ results: { sys_id: string; label: string; detail: string }[] } | { error: string }> {
  const v = await sn.get("item_option_new", variableId, {
    fields: ["sys_id", "type", "reference", "list_table", "reference_qual", "reference_qual_condition", "use_reference_qualifier", "active"],
  });
  if (!v || !truthy(v.active)) return { error: "Variable not found" };
  const type = Number(v.type);
  const table = type === 31 ? "sys_user" : type === 21 ? String(v.list_table ?? "") : type === 8 ? String(v.reference ?? "") : "";
  if (!isFieldName(table)) return { error: "Variable is not a reference" };

  const display = await displayFieldFor(sn, table);
  const details = DETAIL_FIELDS[table] ?? [];
  const q = sanitizeQueryText(text);
  const clauses = [ACTIVE_FILTER[table], qualifier(v), q ? `${display}LIKE${q}` : "", `ORDERBY${display}`].filter(Boolean);
  const lim = Math.min(Math.max(1, Math.floor(limit) || 10), 50);
  const rows = await sn.list(table, clauses.join("^"), { fields: ["sys_id", display, ...details], limit: lim, displayValue: true });
  return {
    results: rows.map((r) => ({
      sys_id: String(r.sys_id),
      label: String(r[display] ?? r.sys_id),
      detail: details.map((d) => r[d]).filter(Boolean).join(" · ").slice(0, 80),
    })),
  };
}

// Resolves a reference value given as a sys_id or a display value (model path).
async function resolveRefValue(sn: SNClient, table: string, input: string): Promise<{ sys_id?: string; error?: string }> {
  if (isSysId(input)) {
    const r = await sn.get(table, input, { fields: ["sys_id"] });
    return r ? { sys_id: input } : { error: "Record not found" };
  }
  const display = await displayFieldFor(sn, table);
  const name = sanitizeQueryText(input, 200);
  const active = ACTIVE_FILTER[table] ? `^${ACTIVE_FILTER[table]}` : "";
  const rows = await sn.list(table, `${display}=${name}${active}`, { fields: ["sys_id"], limit: 2 });
  if (rows.length === 1) return { sys_id: rows[0].sys_id };
  if (rows.length > 1) return { error: `"${input}" matches more than one record; pick one from the list` };
  // Users are often named by user id or email.
  if (table === "sys_user") {
    const alt = await sn.list("sys_user", `user_name=${name}^ORemail=${name}^active=true`, { fields: ["sys_id"], limit: 2 });
    if (alt.length === 1) return { sys_id: alt[0].sys_id };
  }
  return { error: `No match for "${input}"` };
}

// ── Validate + order ────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

const INPUT_KINDS = new Set<VarKind>(["label", "section", "unsupported"]);

export async function validateVariables(
  sn: SNClient,
  form: CatalogItemForm,
  input: Record<string, unknown>
): Promise<{ errors: FieldError[] } | { variables: Record<string, string> }> {
  const errors: FieldError[] = [];
  const out: Record<string, string> = {};
  for (const v of form.variables) {
    if (INPUT_KINDS.has(v.kind)) continue;
    let raw = input[v.name];
    if (Array.isArray(raw)) raw = raw.map(String).join(",");
    if (typeof raw === "boolean") raw = String(raw);
    let value = str(raw);
    if (value === undefined && v.default_value !== undefined) value = v.default_value;
    if (v.read_only) {
      if (v.default_value !== undefined) out[v.name] = v.default_value;
      continue;
    }
    if (value === undefined || (v.kind === "checkbox" && value !== "true" && v.mandatory)) {
      if (v.mandatory) errors.push({ field: v.name, message: `${v.label} is required` });
      continue;
    }
    switch (v.kind) {
      case "email":
        if (!EMAIL.test(value)) errors.push({ field: v.name, message: "Not a valid email address" });
        break;
      case "url":
        try {
          const u = new URL(value);
          if (!/^https?:$/.test(u.protocol)) throw new Error();
        } catch {
          errors.push({ field: v.name, message: "Not a valid http(s) URL" });
        }
        break;
      case "ip":
        if (!IPV4.test(value) && !(value.includes(":") && IPV6.test(value))) {
          errors.push({ field: v.name, message: "Not a valid IP address" });
        }
        break;
      case "checkbox":
        value = value === "true" ? "true" : "false";
        break;
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push({ field: v.name, message: "Use YYYY-MM-DD" });
        break;
      case "datetime": {
        const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(value);
        if (!m) errors.push({ field: v.name, message: "Use YYYY-MM-DD HH:mm" });
        else value = `${m[1]} ${m[2]}${m[3] ?? ":00"}`;
        break;
      }
      case "radio":
      case "select":
      case "yesno": {
        const list = v.choices ?? [];
        if (list.length) {
          const hit = list.find((c) => c.value === value) ?? list.find((c) => c.label.toLowerCase() === value!.toLowerCase());
          if (!hit) errors.push({ field: v.name, message: `Choose one of: ${list.map((c) => c.label).join(", ")}` });
          else value = hit.value;
        }
        break;
      }
      case "reference": {
        const r = await resolveRefValue(sn, v.reference_table!, value);
        if (r.error) errors.push({ field: v.name, message: r.error });
        else value = r.sys_id!;
        break;
      }
      case "list": {
        const ids: string[] = [];
        for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) {
          const r = await resolveRefValue(sn, v.reference_table!, part);
          if (r.error) errors.push({ field: v.name, message: `${part}: ${r.error}` });
          else ids.push(r.sys_id!);
        }
        value = ids.join(",");
        break;
      }
      default:
        if (value.length > 4000) errors.push({ field: v.name, message: "Too long" });
    }
    out[v.name] = value;
  }
  return errors.length ? { errors } : { variables: out };
}

export interface OrderResult {
  request_number: string;
  request_sys_id: string;
  request_url: string;
  item: string;
  quantity: number;
  items: RitmRow[];
}

export interface RitmRow {
  number: string;
  sys_id: string;
  stage: string;
  state: string;
  approval: string;
  url: string;
}

async function ritmsFor(sn: SNClient, requestSysId: string): Promise<RitmRow[]> {
  const rows = await sn.list("sc_req_item", `request=${requestSysId}^ORDERBYnumber`, {
    fields: ["sys_id", "number", "stage", "state", "approval", "cat_item"],
    limit: 50,
    displayValue: "all",
  });
  return rows.map((r) => ({
    number: disp(r.number),
    sys_id: val(r.sys_id),
    stage: disp(r.stage),
    state: disp(r.state),
    approval: disp(r.approval),
    url: recordUrl(sn, "sc_req_item", val(r.sys_id)),
  }));
}

async function order(args: Record<string, unknown>, ctx: HandlerContext): Promise<HandlerResult> {
  const itemInput = str(args["item_sys_id"]) ?? str(args["item"]);
  if (!itemInput) return errorResult("bad_request", "item_sys_id (or item name) is required");
  const resolved = await resolveItem(ctx.sn, itemInput);
  if ("error" in resolved) return errorResult("not_found", resolved.error, { candidates: resolved.candidates ?? [] });
  const form = await loadItemForm(ctx.sn, resolved.sys_id, ctx.callerSysId);
  if (!form) return errorResult("not_found", "Catalog item not found or inactive");

  const variables = (args["variables"] && typeof args["variables"] === "object" ? args["variables"] : {}) as Record<string, unknown>;
  const checked = await validateVariables(ctx.sn, form, variables);
  if ("errors" in checked) return fieldErrors(checked.errors);

  let quantity = Math.floor(Number(args["quantity"] ?? 1));
  if (!form.item.quantity_allowed) quantity = 1;
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
    return fieldErrors([{ field: "quantity", message: "Quantity must be between 1 and 100" }]);
  }

  const body: Record<string, unknown> = { sysparm_quantity: String(quantity), variables: checked.variables };
  const requestedFor = str(args["requested_for"]);
  if (requestedFor) {
    const r = await resolveRefValue(ctx.sn, "sys_user", requestedFor);
    if (r.error) return fieldErrors([{ field: "requested_for", message: r.error }]);
    body["sysparm_requested_for"] = r.sys_id;
  }

  // Order Now: creates the request and its requested items without touching the caller's cart.
  const data = await ctx.sn.request("POST", `/api/sn_sc/servicecatalog/items/${resolved.sys_id}/order_now`, { body });
  const r = data?.result ?? {};
  const requestSysId = String(r.request_id ?? (r.table === "sc_request" ? r.sys_id : "") ?? "");
  let requestNumber = String(r.request_number ?? r.number ?? "");
  let items: RitmRow[] = [];
  if (isSysId(requestSysId)) {
    items = await ritmsFor(ctx.sn, requestSysId).catch(() => []);
    if (!requestNumber) {
      const req = await ctx.sn.get("sc_request", requestSysId, { fields: ["number"] }).catch(() => null);
      requestNumber = String(req?.number ?? "");
    }
  }
  const out: OrderResult = {
    request_number: requestNumber,
    request_sys_id: requestSysId,
    request_url: isSysId(requestSysId) ? recordUrl(ctx.sn, "sc_request", requestSysId) : "",
    item: form.item.name,
    quantity,
    items,
  };
  return {
    text:
      `Ordered ${quantity} × ${form.item.name}: request ${out.request_number}` +
      (items.length ? `, requested item(s) ${items.map((i) => `${i.number} (${i.stage || i.state})`).join(", ")}` : "") +
      `. ${out.request_url}`,
    structured: out as unknown as Record<string, unknown>,
    audit: { record: out.request_number },
  };
}

const idempotency = new IdempotencyCache<HandlerResult>();
export function resetCatalogIdempotency(): void {
  idempotency.clear();
}

// Text description of a form, for clients that can't render the app.
function describeForm(form: CatalogItemForm): string {
  const lines = form.variables
    .filter((v) => !INPUT_KINDS.has(v.kind))
    .map((v) => {
      const bits = [`- ${v.name}: ${v.label}`, v.mandatory ? "[required]" : "", `(${v.kind}`];
      if (v.reference_table) bits.push(`→ ${v.reference_table}, give a name or sys_id`);
      bits[bits.length - 1] += ")";
      if (v.choices?.length) bits.push(`choices: ${v.choices.map((c) => `${c.value} (${c.label})`).join(", ")}`);
      if (v.default_value) bits.push(`default: ${v.default_display ?? v.default_value}`);
      if (v.read_only) bits.push("read-only");
      return bits.filter(Boolean).join(" ");
    });
  return lines.join("\n");
}

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// ── Handlers ────────────────────────────────────────────────────────────────

export const catalogHandlers: HandlerRegistry = {
  "catalog.search": {
    async fn(args, ctx) {
      const rows = await findItems(ctx.sn, String(args["text"] ?? ""), Number(args["limit"] ?? 10));
      const results = rows.map((r) => ({
        sys_id: val(r.sys_id),
        name: disp(r.name),
        short_description: disp(r.short_description),
        category: disp(r.category),
      }));
      return {
        text:
          results.map((r) => `${r.name} (${r.sys_id})${r.short_description ? ` — ${r.short_description}` : ""}`).join("\n") ||
          "No catalog items match.",
        structured: { results },
      };
    },
  },

  "catalog.open_form": {
    async fn(args, ctx) {
      const input = str(args["item_sys_id"]) ?? str(args["item"]);
      if (!input) return errorResult("bad_request", "Say which catalog item to open (name or sys_id).");
      const resolved = await resolveItem(ctx.sn, input);
      if ("error" in resolved) {
        const c = resolved.candidates ?? [];
        return errorResult(
          "not_found",
          resolved.error + (c.length ? `. Candidates: ${c.map((x) => `${x.name} (${x.sys_id})`).join("; ")}` : ""),
          { candidates: c }
        );
      }
      const values = (args["values"] && typeof args["values"] === "object" ? args["values"] : {}) as Record<string, unknown>;
      const prefill: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!isFieldName(k) || v === undefined || v === null) continue;
        prefill[k] = Array.isArray(v) ? v.map(String).join(",") : String(v);
      }
      const quantity = Number(args["quantity"]);
      const structured: Record<string, unknown> = { item_sys_id: resolved.sys_id, item_name: resolved.name, prefill };
      if (Number.isFinite(quantity) && quantity >= 1) structured["quantity"] = Math.floor(quantity);

      const form = await loadItemForm(ctx.sn, resolved.sys_id, ctx.callerSysId);
      if (!form) return errorResult("not_found", "Catalog item not found or inactive");
      const missing = form.variables
        .filter((v) => v.mandatory && !v.read_only && !INPUT_KINDS.has(v.kind) && !prefill[v.name] && !v.default_value)
        .map((v) => v.name);
      structured["missing"] = missing;

      if (ctx.appsClient) {
        return {
          text:
            `Opened the "${resolved.name}" form. The user reviews and submits it in the form. ` +
            `Variables:\n${describeForm(form)}\nStill missing: ${missing.join(", ") || "nothing"}.`,
          structured,
        };
      }
      return {
        text: [
          `This client can't display forms, so collect "${form.item.name}" in chat and then call catalog_order ` +
            `with item_sys_id ${form.item.sys_id} and a variables object keyed by name.`,
          form.item.short_description ? `About: ${form.item.short_description}` : "",
          form.item.description ? `Description: ${plain(form.item.description).slice(0, 600)}` : "",
          "",
          "Variables:",
          describeForm(form),
          form.unsupported.length ? `\nNot supported here: ${form.unsupported.map((u) => `${u.label} (${u.reason})`).join(", ")}` : "",
          `\nKnown so far: ${JSON.stringify(prefill)}`,
          `Still missing: ${missing.join(", ") || "nothing"}`,
        ]
          .filter((l) => l !== "")
          .join("\n"),
        structured: { ...structured, form },
      };
    },
  },

  "catalog.item_form": {
    async fn(args, ctx) {
      const id = str(args["item_sys_id"]);
      if (!isSysId(id)) return errorResult("bad_request", "item_sys_id must be a sc_cat_item sys_id");
      const form = await loadItemForm(ctx.sn, id, ctx.callerSysId);
      if (!form) return errorResult("not_found", "Catalog item not found or inactive");
      return {
        text: `${form.item.name}: ${form.variables.length} variable(s).\n${describeForm(form)}`,
        structured: form as unknown as Record<string, unknown>,
      };
    },
  },

  "catalog.reference_search": {
    async fn(args, ctx) {
      const id = str(args["variable_id"]);
      if (!isSysId(id)) return errorResult("bad_request", "variable_id must be an item_option_new sys_id");
      const r = await searchReference(ctx.sn, id, String(args["text"] ?? ""), Number(args["limit"] ?? 10));
      if ("error" in r) return errorResult("bad_request", r.error);
      return {
        text: r.results.map((x) => `${x.label} (${x.sys_id})${x.detail ? ` — ${x.detail}` : ""}`).join("\n") || "No matches",
        structured: r,
      };
    },
  },

  "catalog.order": {
    write: true,
    async fn(args, ctx) {
      const key = str(args["idempotency_key"]);
      if (!key) return order(args, ctx);
      if (key.length > 100) return errorResult("bad_request", "idempotency_key is too long");
      return idempotency.run(`${ctx.server.id}:${ctx.caller.username}:${key}`, () => order(args, ctx), (r) => !r.isError);
    },
  },

  "catalog.request_status": {
    async fn(args, ctx) {
      const input = str(args["request"]) ?? str(args["request_sys_id"]);
      if (!input) return errorResult("bad_request", "request (REQ number or sys_id) is required");
      const query = isSysId(input) ? `sys_id=${input}` : `number=${sanitizeQueryText(input, 40)}`;
      const reqs = await ctx.sn.list("sc_request", query, {
        fields: ["sys_id", "number", "request_state", "approval", "requested_for", "opened_at"],
        limit: 1,
        displayValue: "all",
      });
      const req = reqs[0];
      if (!req) return errorResult("not_found", `Request ${input} not found`);
      const id = val(req.sys_id);
      const items = await ritmsFor(ctx.sn, id);
      const out = {
        request_number: disp(req.number),
        request_sys_id: id,
        request_state: disp(req.request_state),
        approval: disp(req.approval),
        requested_for: disp(req.requested_for),
        request_url: recordUrl(ctx.sn, "sc_request", id),
        items,
      };
      return {
        text:
          `${out.request_number}: ${out.request_state || "?"} (approval ${out.approval || "?"}). ` +
          (items.map((i) => `${i.number}: stage ${i.stage || "?"}, state ${i.state || "?"}`).join("; ") || "No requested items."),
        structured: out,
      };
    },
  },
};
