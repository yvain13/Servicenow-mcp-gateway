import { IdempotencyCache } from "../idempotency.js";
import type { SNClient } from "../sn-client.js";
import { errorResult, fieldErrors } from "./types.js";
import type { FieldError, HandlerContext, HandlerRegistry, HandlerResult } from "./types.js";
import {
  disp,
  encodedQueryFields,
  isFieldName,
  isSysId,
  parseDateTime,
  sanitizeQueryText,
  str,
  toSNDateTime,
  val,
} from "./util.js";

export type ChangeType = "normal" | "standard" | "emergency";
export const CHANGE_TYPES: ChangeType[] = ["normal", "standard", "emergency"];

export interface FieldSpec {
  name: string;
  label: string;
  required: ChangeType[];
  kind: "text" | "textarea" | "reference" | "choice" | "datetime" | "type" | "template";
}

const ALL: ChangeType[] = ["normal", "standard", "emergency"];
const NE: ChangeType[] = ["normal", "emergency"];

// Form fields, in display order. `required` lists the change types that need the field.
export const CHANGE_FIELDS: FieldSpec[] = [
  { name: "type", label: "Type", required: ALL, kind: "type" },
  { name: "std_change_template", label: "Standard change template", required: ["standard"], kind: "template" },
  { name: "short_description", label: "Short description", required: ALL, kind: "text" },
  { name: "description", label: "Description", required: ALL, kind: "textarea" },
  { name: "cmdb_ci", label: "Configuration item", required: ALL, kind: "reference" },
  { name: "assignment_group", label: "Assignment group", required: ALL, kind: "reference" },
  { name: "category", label: "Category", required: [], kind: "choice" },
  { name: "risk", label: "Risk", required: [], kind: "choice" },
  { name: "impact", label: "Impact", required: [], kind: "choice" },
  { name: "start_date", label: "Planned start", required: ALL, kind: "datetime" },
  { name: "end_date", label: "Planned end", required: ALL, kind: "datetime" },
  { name: "justification", label: "Justification", required: NE, kind: "textarea" },
  { name: "implementation_plan", label: "Implementation plan", required: ALL, kind: "textarea" },
  { name: "risk_impact_analysis", label: "Risk and impact analysis", required: NE, kind: "textarea" },
  { name: "backout_plan", label: "Backout plan", required: ALL, kind: "textarea" },
  { name: "test_plan", label: "Test plan", required: ALL, kind: "textarea" },
];

export const CHOICE_FIELDS = ["category", "risk", "impact"];

// Columns written to change_request (everything except the meta fields).
const WRITABLE = CHANGE_FIELDS.map((f) => f.name).filter((n) => n !== "type" && n !== "std_change_template");

const PLAN_FIELDS = ["implementation_plan", "backout_plan", "test_plan", "justification", "risk_impact_analysis"];

function normType(v: unknown): ChangeType | undefined {
  const s = str(v)?.toLowerCase();
  return CHANGE_TYPES.find((t) => t === s);
}

export function missingFields(values: Record<string, unknown>, type: ChangeType | undefined, locked: string[] = []): string[] {
  const t = type ?? "normal";
  return CHANGE_FIELDS.filter(
    (f) => f.required.includes(t) && !locked.includes(f.name) && str(values[f.name]) === undefined
  ).map((f) => f.name);
}

// ── Lookups ───────────────────────────────────────────────────────────────────

export async function loadChoices(
  sn: SNClient,
  fields: string[]
): Promise<Record<string, { value: string; label: string }[]>> {
  const valid = fields.filter(isFieldName);
  const out: Record<string, { value: string; label: string }[]> = Object.fromEntries(valid.map((f) => [f, []]));
  if (valid.length === 0) return out;
  const rows = await sn.list(
    "sys_choice",
    `name=change_request^elementIN${valid.join(",")}^inactive=false^language=en^ORDERBYsequence`,
    { fields: ["element", "value", "label"], limit: 500 }
  );
  for (const r of rows) {
    const list = out[r.element];
    if (list && !list.some((c) => c.value === r.value)) list.push({ value: r.value, label: r.label });
  }
  return out;
}

export type SearchKind = "ci" | "group" | "template";

export interface SearchResult {
  sys_id: string;
  label: string;
  detail: string;
  locked?: Record<string, string>;
}

const CI_ACTIVE = "install_status!=7"; // 7 = Retired
const GROUP_ACTIVE = "active=true";

export async function search(sn: SNClient, kind: SearchKind, text: string, limit: number): Promise<SearchResult[]> {
  const q = sanitizeQueryText(text);
  const lim = Math.min(Math.max(1, Math.floor(limit) || 10), 50);
  if (kind === "ci") {
    const rows = await sn.list("cmdb_ci", `${CI_ACTIVE}${q ? `^nameLIKE${q}` : ""}^ORDERBYname`, {
      fields: ["sys_id", "name", "sys_class_name", "ip_address"],
      limit: lim,
    });
    return rows.map((r) => ({
      sys_id: r.sys_id,
      label: r.name,
      detail: [r.sys_class_name, r.ip_address].filter(Boolean).join(" · "),
    }));
  }
  if (kind === "group") {
    const rows = await sn.list("sys_user_group", `${GROUP_ACTIVE}${q ? `^nameLIKE${q}` : ""}^ORDERBYname`, {
      fields: ["sys_id", "name", "description"],
      limit: lim,
    });
    return rows.map((r) => ({ sys_id: r.sys_id, label: r.name, detail: (r.description ?? "").slice(0, 80) }));
  }
  // Standard change templates: published template versions.
  const rows = await sn.list(
    "std_change_producer_version",
    `${q ? `nameLIKE${q}^` : ""}std_change_producer.active=true^ORDERBYname`,
    { fields: ["sys_id", "name", "version", "std_change_proposal"], limit: lim }
  );
  const results: SearchResult[] = [];
  for (const r of rows) {
    results.push({
      sys_id: r.sys_id,
      label: r.name,
      detail: r.version ? `version ${r.version}` : "",
      locked: await templateFields(sn, r.sys_id, val(r.std_change_proposal)),
    });
  }
  return results;
}

// Fields a standard change template sets; the form locks these and submit ignores edits to them.
export async function templateFields(
  sn: SNClient,
  versionSysId: string,
  proposalSysId?: string
): Promise<Record<string, string> | undefined> {
  let proposal = proposalSysId;
  if (!proposal) {
    const v = await sn.get("std_change_producer_version", versionSysId, { fields: ["sys_id", "std_change_proposal"] });
    if (!v) return undefined;
    proposal = val(v.std_change_proposal);
  }
  if (!proposal) return {};
  const p = await sn.get("std_change_proposal", proposal, { fields: ["template_value"] });
  return encodedQueryFields(String(p?.template_value ?? ""));
}

async function resolveRef(
  sn: SNClient,
  field: "cmdb_ci" | "assignment_group",
  input: string
): Promise<{ sys_id?: string; label?: string; error?: string }> {
  const table = field === "cmdb_ci" ? "cmdb_ci" : "sys_user_group";
  const active = field === "cmdb_ci" ? CI_ACTIVE : GROUP_ACTIVE;
  const what = field === "cmdb_ci" ? "configuration item" : "assignment group";
  const query = isSysId(input) ? `sys_id=${input}^${active}` : `name=${sanitizeQueryText(input, 200)}^${active}`;
  const rows = await sn.list(table, query, { fields: ["sys_id", "name"], limit: 2 });
  if (rows.length === 0) return { error: `No active ${what} matches "${input}"` };
  if (rows.length > 1) return { error: `"${input}" matches more than one ${what}; pick one from the list` };
  return { sys_id: rows[0].sys_id, label: rows[0].name };
}

// ── Submit ────────────────────────────────────────────────────────────────────

export interface SubmitOk {
  number: string;
  sys_id: string;
  state: string;
  type: ChangeType;
  url: string;
}

export async function validateAndBuild(
  sn: SNClient,
  args: Record<string, unknown>,
  now = new Date()
): Promise<{ errors: FieldError[] } | { type: ChangeType; template?: string; body: Record<string, string> }> {
  const errors: FieldError[] = [];
  const values: Record<string, unknown> = { ...args };
  // Model-path aliases: names instead of sys_ids.
  if (!str(values["cmdb_ci"]) && str(values["ci_name"])) values["cmdb_ci"] = values["ci_name"];
  if (!str(values["assignment_group"]) && str(values["group_name"])) values["assignment_group"] = values["group_name"];

  const type = normType(values["type"]);
  if (!type) {
    errors.push({ field: "type", message: "Type must be normal, standard or emergency" });
    return { errors };
  }

  let locked: Record<string, string> = {};
  let template: string | undefined;
  if (type === "standard") {
    template = str(values["std_change_template"]);
    if (!template) {
      errors.push({ field: "std_change_template", message: "Standard changes need a template" });
    } else if (!isSysId(template)) {
      errors.push({ field: "std_change_template", message: "Pick a template from the list" });
    } else {
      const fields = await templateFields(sn, template);
      if (!fields) errors.push({ field: "std_change_template", message: "Template not found" });
      else locked = fields;
    }
  }

  for (const f of missingFields(values, type, Object.keys(locked))) {
    const spec = CHANGE_FIELDS.find((s) => s.name === f)!;
    if (f === "std_change_template") continue; // reported above
    errors.push({ field: f, message: `${spec.label} is required` });
  }

  const start = parseDateTime(values["start_date"]);
  const end = parseDateTime(values["end_date"]);
  if (str(values["start_date"]) && !start) errors.push({ field: "start_date", message: "Not a valid date-time" });
  if (str(values["end_date"]) && !end) errors.push({ field: "end_date", message: "Not a valid date-time" });
  if (start && start.getTime() <= now.getTime()) {
    errors.push({ field: "start_date", message: "Planned start must be in the future" });
  }
  if (start && end && end.getTime() <= start.getTime()) {
    errors.push({ field: "end_date", message: "Planned end must be after planned start" });
  }

  const body: Record<string, string> = {};
  for (const ref of ["cmdb_ci", "assignment_group"] as const) {
    const input = str(values[ref]);
    if (!input || locked[ref] !== undefined) continue;
    const r = await resolveRef(sn, ref, input);
    if (r.error) errors.push({ field: ref, message: r.error });
    else body[ref] = r.sys_id!;
  }

  if (errors.length) return { errors };

  for (const f of WRITABLE) {
    if (locked[f] !== undefined || body[f] !== undefined) continue; // template-defined fields win
    if (f === "start_date" && start) body[f] = toSNDateTime(start);
    else if (f === "end_date" && end) body[f] = toSNDateTime(end);
    else if (f !== "cmdb_ci" && f !== "assignment_group") {
      const v = str(values[f]);
      if (v !== undefined) body[f] = v;
    }
  }
  return { type, template, body };
}

const idempotency = new IdempotencyCache<HandlerResult>();
export function resetIdempotency(): void {
  idempotency.clear();
}

function recordUrl(sn: SNClient, table: string, sysId: string): string {
  return `${sn.instanceUrl}/${table}.do?sys_id=${sysId}`;
}

async function submit(args: Record<string, unknown>, ctx: HandlerContext): Promise<HandlerResult> {
  const built = await validateAndBuild(ctx.sn, args);
  if ("errors" in built) return fieldErrors(built.errors);

  const path =
    built.type === "standard"
      ? `/api/sn_chg_rest/change/standard/${built.template}`
      : `/api/sn_chg_rest/change/${built.type}`;
  const data = await ctx.sn.request("POST", path, { body: built.body });
  const r = data?.result ?? {};
  const out: SubmitOk = {
    number: disp(r.number) || val(r.number),
    sys_id: val(r.sys_id),
    state: disp(r.state) || val(r.state),
    type: built.type,
    url: recordUrl(ctx.sn, "change_request", val(r.sys_id)),
  };
  return {
    text: `Created ${built.type} change ${out.number} (state: ${out.state}). ${out.url}`,
    structured: out as unknown as Record<string, unknown>,
    audit: { record: out.number },
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const PREFILL_KEYS = [
  "type",
  "short_description",
  "description",
  "ci_name",
  "group_name",
  "start_date",
  "end_date",
  ...PLAN_FIELDS,
];

export const changeHandlers: HandlerRegistry = {
  "change.open_form": {
    async fn(args, ctx) {
      const prefill: Record<string, string> = {};
      for (const k of PREFILL_KEYS) {
        const v = str(args[k]);
        if (v !== undefined) prefill[k] = k === "type" ? (normType(v) ?? "normal") : v;
      }
      const asForm = { ...prefill, cmdb_ci: prefill["ci_name"], assignment_group: prefill["group_name"] };
      const missing = missingFields(asForm, normType(prefill["type"]));

      if (ctx.appsClient) {
        return {
          text:
            `Opened the change form${prefill["short_description"] ? ` for "${prefill["short_description"]}"` : ""}. ` +
            `The user will review and submit it in the form. Still missing: ${missing.join(", ") || "nothing"}.`,
          structured: { prefill, missing },
        };
      }

      // Text fallback: everything the model needs to collect the change conversationally.
      let choices: Record<string, { value: string; label: string }[]> = {};
      try {
        choices = await loadChoices(ctx.sn, CHOICE_FIELDS);
      } catch {
        /* choices are a convenience in the fallback */
      }
      const lines = [
        "This client can't display the change form, so collect the change in chat and then call create_change.",
        "",
        "Fields (required for: N=normal, S=standard, E=emergency):",
        ...CHANGE_FIELDS.map((f) => {
          const req = f.required.length ? ` [required: ${f.required.map((t) => t[0]!.toUpperCase()).join("")}]` : "";
          const ch = choices[f.name]?.length ? ` choices: ${choices[f.name]!.map((c) => `${c.value} (${c.label})`).join(", ")}` : "";
          return `- ${f.name}: ${f.label}${req}${ch}`;
        }),
        "",
        "cmdb_ci and assignment_group accept a sys_id or an exact name. Dates take ISO 8601 with a time zone offset.",
        `Known so far: ${JSON.stringify(prefill)}`,
        `Still missing: ${missing.join(", ") || "nothing"}`,
      ];
      return { text: lines.join("\n"), structured: { prefill, missing, fields: CHANGE_FIELDS, choices } };
    },
  },

  "change.choices": {
    async fn(args, ctx) {
      const requested = Array.isArray(args["fields"]) ? (args["fields"] as unknown[]).map(String) : CHOICE_FIELDS;
      const bad = requested.filter((f) => !isFieldName(f));
      if (bad.length) return errorResult("bad_request", `Invalid field names: ${bad.join(", ")}`);
      const choices = await loadChoices(ctx.sn, requested);
      return {
        text: Object.entries(choices)
          .map(([f, cs]) => `${f}: ${cs.map((c) => c.label).join(", ") || "(none)"}`)
          .join("\n"),
        structured: choices,
      };
    },
  },

  "change.search": {
    async fn(args, ctx) {
      const kind = String(args["kind"] ?? "") as SearchKind;
      if (!["ci", "group", "template"].includes(kind)) {
        return errorResult("bad_request", "kind must be ci, group or template");
      }
      const results = await search(ctx.sn, kind, String(args["text"] ?? ""), Number(args["limit"] ?? 10));
      return {
        text: results.map((r) => `${r.label} (${r.sys_id})${r.detail ? ` — ${r.detail}` : ""}`).join("\n") || "No matches",
        structured: { results },
      };
    },
  },

  "change.submit": {
    write: true,
    async fn(args, ctx) {
      const key = str(args["idempotency_key"]);
      if (!key) return submit(args, ctx);
      if (key.length > 100) return errorResult("bad_request", "idempotency_key is too long");
      return idempotency.run(`${ctx.server.id}:${ctx.caller.username}:${key}`, () => submit(args, ctx), (r) => !r.isError);
    },
  },

  "change.request_approval": {
    write: true,
    async fn(args, ctx) {
      const sysId = str(args["sys_id"]);
      if (!isSysId(sysId)) return errorResult("bad_request", "sys_id must be a change_request sys_id");
      const current = await ctx.sn.get("change_request", sysId, { fields: ["number", "type", "state"] });
      if (!current) return errorResult("not_found", "Change not found");
      if (current.type !== "normal") {
        return errorResult("bad_request", `Only normal changes go through Assess; ${current.number} is ${current.type}.`);
      }
      const data = await ctx.sn.request("PATCH", `/api/sn_chg_rest/change/${sysId}`, { body: { state: "assess" } });
      const r = data?.result ?? {};
      const out = { number: disp(r.number) || current.number, state: disp(r.state) || val(r.state) };
      return {
        text: `${out.number} moved to ${out.state}; approvals will be generated by the change workflow.`,
        structured: out,
        audit: { record: out.number, decision: "request_approval" },
      };
    },
  },
};
