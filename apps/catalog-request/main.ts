// Generic Service Catalog form: renders any catalog item's variables (from catalog_item_form)
// and orders it with catalog_order, which creates the REQ and its RITMs. UI policies and
// client scripts are not run; the gateway validates mandatory fields, choices and references.
import { createShell, el, banner, loading, errorMessage, ToolError } from "../_shared/shell";
import type { Shell } from "../_shared/shell";
import { Typeahead } from "../_shared/typeahead";
import type { Option } from "../_shared/typeahead";
import "./style.css";

type VarKind =
  | "text" | "textarea" | "email" | "url" | "ip" | "masked" | "yesno" | "checkbox" | "radio" | "select"
  | "reference" | "list" | "date" | "datetime" | "label" | "section" | "unsupported";

interface CatalogVariable {
  id: string;
  name: string;
  label: string;
  kind: VarKind;
  type: number;
  mandatory: boolean;
  read_only: boolean;
  help_text?: string;
  default_value?: string;
  default_display?: string;
  reference_table?: string;
  choices?: { value: string; label: string }[];
}

interface CatalogItemForm {
  item: {
    sys_id: string;
    name: string;
    short_description: string;
    description: string;
    price: string;
    delivery_time: string;
    quantity_allowed: boolean;
    url: string;
  };
  variables: CatalogVariable[];
  unsupported: { name: string; label: string; reason: string }[];
}

interface RitmRow { number: string; sys_id: string; stage: string; state: string; approval: string; url: string }
interface OrderResult {
  request_number: string;
  request_sys_id: string;
  request_url: string;
  item: string;
  quantity: number;
  items: RitmRow[];
}

// A field's value getter/setter, whatever control renders it.
interface Control {
  v: CatalogVariable;
  box: HTMLElement;
  get(): string;
  set(value: string): Promise<void> | void;
  display(): string;
  focus(): void;
  touched(): boolean; // something typed that isn't a valid value yet (reference text)
}

const root = document.getElementById("root")!;
const idempotencyKey =
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

let shell: Shell;
let form: CatalogItemForm | null = null;
let itemId: string | null = null;
let prefill: Record<string, string> = {};
let prefillQty: number | undefined;
let submitting = false;
const controls = new Map<string, Control>();
const status = el("div");
let qtyInput: HTMLInputElement | null = null;
let submitBtn: HTMLButtonElement;

// ── safe description HTML (catalog descriptions are rich text) ──────────────
const ALLOWED = new Set(["P", "BR", "UL", "OL", "LI", "B", "STRONG", "I", "EM", "U", "H1", "H2", "H3", "H4", "SPAN", "DIV", "A"]);
function safeHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const frag = document.createDocumentFragment();
  const walk = (src: Node, dst: Node) => {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) dst.appendChild(document.createTextNode(n.textContent ?? ""));
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element;
        if (!ALLOWED.has(e.tagName)) {
          if (!["SCRIPT", "STYLE", "IFRAME", "OBJECT"].includes(e.tagName)) walk(e, dst);
          continue;
        }
        const tag = e.tagName.startsWith("H") ? "strong" : e.tagName.toLowerCase();
        const out = document.createElement(tag);
        if (e.tagName === "A") {
          const href = e.getAttribute("href") ?? "";
          if (/^https?:/i.test(href)) {
            out.setAttribute("href", href);
            out.addEventListener("click", (ev) => {
              ev.preventDefault();
              shell.openLink(href);
            });
          }
        }
        walk(e, out);
        dst.appendChild(out);
      }
    }
  };
  walk(doc.body, frag);
  return frag;
}

// ── controls per variable kind ───────────────────────────────────────────────
function fieldBox(v: CatalogVariable, control: HTMLElement, forId?: string): HTMLElement {
  const label = el("label", forId ? { for: forId } : {}, v.label);
  if (v.mandatory && !v.read_only) label.append(el("span", { class: "req", "aria-hidden": "true" }, "*"));
  const box = el("div", { class: "field" }, label, control);
  if (v.help_text) box.append(el("div", { class: "help" }, v.help_text));
  box.append(el("div", { class: "err" }));
  return box;
}

function simple(v: CatalogVariable, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): Control {
  const id = `v_${v.name}`;
  input.id = id;
  input.disabled = v.read_only;
  input.addEventListener("input", () => clearError(v.name));
  input.addEventListener("change", () => clearError(v.name));
  return {
    v,
    box: fieldBox(v, input, id),
    get: () => input.value.trim(),
    set: (value) => {
      input.value = value;
    },
    display: () => (input instanceof HTMLSelectElement ? input.selectedOptions[0]?.textContent ?? "" : v.kind === "masked" ? "••••" : input.value),
    focus: () => input.focus(),
    touched: () => false,
  };
}

function choiceMatch(v: CatalogVariable, value: string): string {
  const list = v.choices ?? [];
  return (list.find((c) => c.value === value) ?? list.find((c) => c.label.toLowerCase() === value.toLowerCase()))?.value ?? "";
}

function radios(v: CatalogVariable): Control {
  const list = v.choices ?? [];
  const group = el("div", { class: `choices${list.length <= 5 && list.every((c) => c.label.length < 20) ? " inline" : ""}`, role: "radiogroup" });
  const inputs: HTMLInputElement[] = [];
  for (const c of list) {
    const r = el("input", { type: "radio", name: `v_${v.name}`, value: c.value }) as HTMLInputElement;
    r.disabled = v.read_only;
    r.addEventListener("change", () => clearError(v.name));
    inputs.push(r);
    group.append(el("label", { class: "choice" }, r, c.label));
  }
  return {
    v,
    box: fieldBox(v, group),
    get: () => inputs.find((i) => i.checked)?.value ?? "",
    set: (value) => {
      const m = choiceMatch(v, value);
      for (const i of inputs) i.checked = i.value === m;
    },
    display: () => list.find((c) => c.value === inputs.find((i) => i.checked)?.value)?.label ?? "",
    focus: () => inputs[0]?.focus(),
    touched: () => false,
  };
}

function select(v: CatalogVariable): Control {
  const s = el("select", {}, el("option", { value: "" }, "— None —")) as HTMLSelectElement;
  for (const c of v.choices ?? []) s.append(el("option", { value: c.value }, c.label));
  const c = simple(v, s);
  c.set = (value) => {
    s.value = choiceMatch(v, value);
  };
  return c;
}

function checkbox(v: CatalogVariable): Control {
  const id = `v_${v.name}`;
  const cb = el("input", { type: "checkbox", id }) as HTMLInputElement;
  cb.disabled = v.read_only;
  cb.addEventListener("change", () => clearError(v.name));
  const label = el("label", { class: "choice", for: id }, cb, v.label);
  if (v.mandatory) label.append(el("span", { class: "req", "aria-hidden": "true" }, "*"));
  const box = el("div", { class: "field" }, label);
  if (v.help_text) box.append(el("div", { class: "help" }, v.help_text));
  box.append(el("div", { class: "err" }));
  return {
    v,
    box,
    get: () => (cb.checked ? "true" : "false"),
    set: (value) => {
      cb.checked = /^(true|yes|1)$/i.test(value);
    },
    display: () => (cb.checked ? "Yes" : "No"),
    focus: () => cb.focus(),
    touched: () => false,
  };
}

const searchFor = (v: CatalogVariable) => (text: string) =>
  shell.call<{ results: Option[] }>("catalog_reference_search", { variable_id: v.id, text, limit: 10 }).then((r) => r.results);

function reference(v: CatalogVariable): Control {
  const ta = new Typeahead(searchFor(v), "Search…");
  ta.input.id = `v_${v.name}`;
  ta.setDisabled(v.read_only);
  ta.onselect = () => clearError(v.name);
  return {
    v,
    box: fieldBox(v, ta.root, ta.input.id),
    get: () => ta.selected?.sys_id ?? "",
    set: async (value) => {
      if (!value) return ta.set(null);
      if (value === v.default_value && v.default_display) return ta.set({ sys_id: value, label: v.default_display });
      await ta.resolve(value);
    },
    display: () => ta.selected?.label ?? "",
    focus: () => ta.input.focus(),
    touched: () => !ta.selected && ta.input.value.trim() !== "",
  };
}

function listCollector(v: CatalogVariable): Control {
  const picked: Option[] = [];
  const chips = el("div", { class: "chips" });
  const ta = new Typeahead(searchFor(v), "Search and add…");
  ta.input.id = `v_${v.name}`;
  ta.setDisabled(v.read_only);
  const render = () =>
    chips.replaceChildren(
      ...picked.map((o, i) => {
        const x = el("button", { type: "button", "aria-label": `Remove ${o.label}` }, "×");
        x.onclick = () => {
          picked.splice(i, 1);
          render();
        };
        return el("span", { class: "pill chip" }, o.label, ...(v.read_only ? [] : [x]));
      })
    );
  ta.onselect = (o) => {
    if (!o) return;
    if (!picked.some((p) => p.sys_id === o.sys_id)) picked.push(o);
    clearError(v.name);
    render();
    ta.input.value = "";
    ta.selected = null;
  };
  return {
    v,
    box: fieldBox(v, el("div", {}, chips, ta.root), ta.input.id),
    get: () => picked.map((p) => p.sys_id).join(","),
    set: async (value) => {
      for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) await ta.resolve(part);
      ta.input.value = "";
    },
    display: () => picked.map((p) => p.label).join(", "),
    focus: () => ta.input.focus(),
    touched: () => false,
  };
}

function controlFor(v: CatalogVariable): Control | HTMLElement | null {
  switch (v.kind) {
    case "section":
      return el("div", { class: "section-title" }, v.label);
    case "label":
      return el("div", { class: "var-label" }, safeHtml(v.label));
    case "textarea":
      return simple(v, el("textarea", { rows: "3", maxlength: "4000" }));
    case "email":
      return simple(v, el("input", { type: "email" }) as HTMLInputElement);
    case "url":
      return simple(v, el("input", { type: "url", placeholder: "https://" }) as HTMLInputElement);
    case "masked":
      return simple(v, el("input", { type: "password", autocomplete: "off" }) as HTMLInputElement);
    case "date":
      return simple(v, el("input", { type: "date" }) as HTMLInputElement);
    case "datetime":
      return simple(v, el("input", { type: "datetime-local" }) as HTMLInputElement);
    case "checkbox":
      return checkbox(v);
    case "radio":
    case "select":
    case "yesno":
      // No choices could be loaded: let the user type the value rather than show nothing.
      if (!v.choices?.length) return simple(v, el("input", { type: "text", placeholder: "Type a value" }) as HTMLInputElement);
      return v.kind === "radio" ? radios(v) : select(v);
    case "reference":
      return reference(v);
    case "list":
      return listCollector(v);
    case "ip":
    case "text":
      return simple(v, el("input", { type: "text", maxlength: "4000" }) as HTMLInputElement);
    default:
      return null;
  }
}

// ── errors ───────────────────────────────────────────────────────────────────
function setError(name: string, message: string): void {
  const box = controls.get(name)?.box ?? (name === "quantity" ? qtyInput?.closest<HTMLElement>(".field") : null);
  if (!box) return;
  box.classList.add("invalid");
  box.querySelector(".err")!.textContent = message;
}
function clearError(name: string): void {
  const box = controls.get(name)?.box;
  box?.classList.remove("invalid");
  if (box) box.querySelector(".err")!.textContent = "";
}
function showErrors(errs: { field: string; message: string }[]): void {
  const general: string[] = [];
  for (const e of errs) {
    if (controls.has(e.field) || e.field === "quantity") setError(e.field, e.message);
    else general.push(`${e.field}: ${e.message}`);
  }
  banner(status, "error", general.length ? general.join("; ") : `Fix ${errs.length} field(s) highlighted below.`);
  controls.get(errs.find((e) => controls.has(e.field))?.field ?? "")?.focus();
}

// ── render ───────────────────────────────────────────────────────────────────
function render(f: CatalogItemForm): void {
  controls.clear();
  const head = el("div", { class: "item-head" }, el("div", {}, el("h1", {}, f.item.name), ...(f.item.short_description ? [el("div", { class: "muted" }, f.item.short_description)] : [])));
  const meta = el("div", { class: "item-meta" });
  if (f.item.delivery_time) meta.append(el("span", { class: "pill" }, `Delivery: ${f.item.delivery_time}`));
  if (f.item.price && !/^\D*0(\.0+)?$/.test(f.item.price)) meta.append(el("span", { class: "pill" }, f.item.price));
  const children: Node[] = [head, meta];
  if (f.item.description) children.push(el("div", { class: "desc" }, safeHtml(f.item.description)));
  children.push(status);
  if (f.unsupported.length) {
    children.push(
      el(
        "div",
        { class: "banner warn" },
        `Not shown here: ${f.unsupported.map((u) => `${u.label} (${u.reason})`).join(", ")}. Use ServiceNow if the item needs them.`
      )
    );
  }

  const formEl = el("form", { novalidate: "" });
  for (const v of f.variables) {
    const c = controlFor(v);
    if (!c) continue;
    if (c instanceof HTMLElement) formEl.append(c);
    else {
      controls.set(v.name, c);
      formEl.append(c.box);
    }
  }
  if (!controls.size) formEl.append(el("p", { class: "muted" }, "This item has no questions."));

  const footer = el("div", { class: "footer" });
  if (f.item.quantity_allowed) {
    qtyInput = el("input", { type: "number", min: "1", max: "100", value: "1", id: "qty" }) as HTMLInputElement;
    footer.append(el("div", { class: "field qty" }, el("label", { for: "qty" }, "Quantity"), qtyInput, el("div", { class: "err" })));
  } else {
    qtyInput = null;
    footer.append(el("span"));
  }
  submitBtn = el("button", { type: "submit", class: "primary" }, "Order now") as HTMLButtonElement;
  footer.append(submitBtn);
  formEl.append(footer);
  formEl.onsubmit = (e) => {
    e.preventDefault();
    void submit();
  };
  children.push(formEl);
  root.replaceChildren(...children);
}

async function applyValues(f: CatalogItemForm): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [name, c] of controls) {
    const value = prefill[name] ?? c.v.default_value;
    if (value !== undefined && value !== "") tasks.push(Promise.resolve(c.set(value)));
  }
  if (qtyInput && prefillQty) qtyInput.value = String(Math.min(100, Math.max(1, prefillQty)));
  await Promise.all(tasks);
  void f;
}

// ── submit ───────────────────────────────────────────────────────────────────
async function submit(): Promise<void> {
  if (submitting || !form) return;
  for (const name of controls.keys()) clearError(name);
  status.replaceChildren();

  const variables: Record<string, string> = {};
  const errs: { field: string; message: string }[] = [];
  for (const [name, c] of controls) {
    const value = c.get();
    if (c.v.read_only) continue;
    if (value && value !== "false") variables[name] = value;
    else if (c.v.kind === "checkbox") variables[name] = "false";
    if (c.v.mandatory && (!value || (c.v.kind === "checkbox" && value !== "true"))) {
      errs.push({ field: name, message: c.touched() ? "Pick a match from the list" : `${c.v.label} is required` });
    }
  }
  const quantity = qtyInput ? Number(qtyInput.value) : 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) errs.push({ field: "quantity", message: "1 to 100" });
  if (errs.length) return showErrors(errs);

  const details: [string, string][] = [["Item", form.item.name]];
  if (qtyInput) details.push(["Quantity", String(quantity)]);
  for (const c of controls.values()) {
    const d = c.display();
    if (d && d !== "No") details.push([c.v.label, d.length > 80 ? d.slice(0, 77) + "…" : d]);
  }
  const ok = await shell.confirm({ title: `Order ${form.item.name}?`, details: details.slice(0, 12), confirmLabel: "Order now" });
  if (!ok) return;

  submitting = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Ordering…";
  try {
    const res = await shell.call<OrderResult>("catalog_order", {
      item_sys_id: form.item.sys_id,
      variables,
      quantity,
      idempotency_key: idempotencyKey,
    });
    showResult(res);
  } catch (err) {
    if (err instanceof ToolError && err.fieldErrors.length) showErrors(err.fieldErrors);
    else banner(status, "error", errorMessage(err));
    submitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Order now";
  }
}

function link(url: string, text: string): HTMLElement {
  const a = el("a", { href: url }, text);
  a.onclick = (e) => {
    e.preventDefault();
    shell.openLink(url);
  };
  return a;
}

function ritmRows(items: RitmRow[]): HTMLElement {
  return el(
    "div",
    {},
    ...items.map((i) =>
      el(
        "div",
        { class: "ritm" },
        el("span", {}, link(i.url, i.number), " "),
        el("span", {}, ...[i.stage, i.approval && i.approval !== "Not Yet Requested" ? `approval ${i.approval.toLowerCase()}` : ""].filter(Boolean).map((t) => el("span", { class: "pill" }, t)))
      )
    )
  );
}

function showResult(res: OrderResult): void {
  void shell.setModelContext(
    `The user ordered ${res.quantity} × ${res.item}: request ${res.request_number} (sys_id ${res.request_sys_id})` +
      (res.items.length ? `, requested items ${res.items.map((i) => i.number).join(", ")}` : "") +
      ".",
    { order: res }
  );
  const list = el("div", {}, res.items.length ? ritmRows(res.items) : el("p", { class: "muted" }, "Requested items are being created…"));
  const msg = el("div");
  const refresh = el("button", { type: "button" }, "Refresh status");
  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      const st = await shell.call<{ request_state: string; approval: string; items: RitmRow[] }>("catalog_request_status", {
        request: res.request_sys_id || res.request_number,
      });
      list.replaceChildren(st.items.length ? ritmRows(st.items) : el("p", { class: "muted" }, "No requested items yet."));
      banner(msg, "ok", `Request ${st.request_state || "open"} · approval ${st.approval.toLowerCase() || "n/a"}`);
    } catch (err) {
      banner(msg, "error", errorMessage(err));
    }
    refresh.disabled = false;
  };
  root.replaceChildren(
    el(
      "div",
      { class: "card" },
      el("h1", {}, `${res.request_number} submitted`),
      el("p", {}, `${res.quantity} × ${res.item}. `, ...(res.request_url ? [link(res.request_url, "Open request in ServiceNow")] : [])),
      el("h2", {}, "Requested items"),
      list,
      msg,
      el("div", { class: "actions" }, refresh)
    )
  );
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function load(id: string): Promise<void> {
  if (itemId === id) return;
  itemId = id;
  loading(root, "Loading catalog item…");
  try {
    form = await shell.call<CatalogItemForm>("catalog_item_form", { item_sys_id: id });
    render(form);
    await applyValues(form);
  } catch (err) {
    itemId = null;
    banner(root, "error", `Could not load the catalog item: ${errorMessage(err)}`);
  }
}

function takeInput(s: Record<string, any> | undefined): void {
  if (!s) return;
  if (s["prefill"] && typeof s["prefill"] === "object") {
    prefill = Object.fromEntries(Object.entries(s["prefill"]).map(([k, v]) => [k, String(v)]));
  }
  if (typeof s["quantity"] === "number") prefillQty = s["quantity"];
  if (typeof s["item_sys_id"] === "string") void load(s["item_sys_id"]);
}

loading(root, "Connecting…");
let early: Record<string, any> | undefined;
shell = await createShell({
  name: "catalog-request",
  // The tool result (open_catalog_item) carries the resolved item and the prefill.
  onToolResult: (s, isError) => {
    if (isError) {
      banner(root, "error", String(s?.["message"] ?? "Could not open the catalog item."));
      return;
    }
    if (shell) takeInput(s);
    else early = s;
  },
});
if (early) takeInput(early);
else if (!itemId) loading(root, "Waiting for the catalog item…");
