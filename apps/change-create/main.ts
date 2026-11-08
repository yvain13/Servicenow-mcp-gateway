import { createShell, el, banner, loading, errorMessage, formatDateTime, ToolError } from "../_shared/shell";
import type { Shell } from "../_shared/shell";
import { Typeahead } from "../_shared/typeahead";
import type { Option } from "../_shared/typeahead";

type ChangeType = "normal" | "standard" | "emergency";
type Kind = "text" | "textarea" | "choice" | "datetime" | "ref";

interface FieldDef {
  name: string;
  label: string;
  kind: Kind;
  required: ChangeType[];
  wide?: boolean;
}

const ALL: ChangeType[] = ["normal", "standard", "emergency"];
const NE: ChangeType[] = ["normal", "emergency"];

// Mirrors the server's rules for quick feedback; change_submit stays authoritative.
const FIELDS: FieldDef[] = [
  { name: "short_description", label: "Short description", kind: "text", required: ALL, wide: true },
  { name: "description", label: "Description", kind: "textarea", required: ALL, wide: true },
  { name: "cmdb_ci", label: "Configuration item", kind: "ref", required: ALL },
  { name: "assignment_group", label: "Assignment group", kind: "ref", required: ALL },
  { name: "category", label: "Category", kind: "choice", required: [] },
  { name: "risk", label: "Risk", kind: "choice", required: [] },
  { name: "impact", label: "Impact", kind: "choice", required: [] },
  { name: "start_date", label: "Planned start", kind: "datetime", required: ALL },
  { name: "end_date", label: "Planned end", kind: "datetime", required: ALL },
  { name: "justification", label: "Justification", kind: "textarea", required: NE, wide: true },
  { name: "implementation_plan", label: "Implementation plan", kind: "textarea", required: ALL, wide: true },
  { name: "risk_impact_analysis", label: "Risk and impact analysis", kind: "textarea", required: NE, wide: true },
  { name: "backout_plan", label: "Backout plan", kind: "textarea", required: ALL, wide: true },
  { name: "test_plan", label: "Test plan", kind: "textarea", required: ALL, wide: true },
];

const root = document.getElementById("root")!;
// One key per form instance. randomUUID needs a secure context, which a sandboxed host
// iframe may not be, so fall back to getRandomValues.
const idempotencyKey =
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

let shell: Shell;
let type: ChangeType = "normal";
let template: Option | null = null;
let locked: Record<string, string> = {};
let submitting = false;

const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
const fieldBoxes = new Map<string, HTMLElement>();
const refs: Record<string, Typeahead> = {};

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const status = el("div");
const form = el("form", { novalidate: "" });

// ── date helpers (datetime-local is in the user's time zone) ─────────────────
function isoToLocalInput(v: string): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function localInputToIso(v: string): string {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// ── build form ───────────────────────────────────────────────────────────────
function fieldBox(def: FieldDef | { name: string; label: string; required: ChangeType[] }, control: HTMLElement): HTMLElement {
  const label = el("label", { for: `f_${def.name}` }, def.label);
  label.dataset["field"] = def.name;
  const box = el("div", { class: "field" }, label, control, el("div", { class: "err" }));
  fieldBoxes.set(def.name, box);
  return box;
}

const typeSeg = el("div", { class: "seg", role: "group", "aria-label": "Change type" });
for (const t of ALL) {
  const b = el("button", { type: "button", "data-type": t }, t[0]!.toUpperCase() + t.slice(1));
  b.onclick = () => setType(t);
  typeSeg.append(b);
}

const templateTa = new Typeahead(
  (text) => shell.call<{ results: Option[] }>("change_search", { kind: "template", text, limit: 10 }).then((r) => r.results),
  "Search standard change templates"
);
templateTa.onselect = (o) => {
  template = o;
  locked = (o?.["locked"] as Record<string, string>) ?? {};
  applyLocks();
};
const templateBox = fieldBox({ name: "std_change_template", label: "Standard change template", required: ["standard"] }, templateTa.root);

form.append(fieldBox({ name: "type", label: "Type", required: ALL }, typeSeg), templateBox);

let row: HTMLElement | null = null;
for (const def of FIELDS) {
  let control: HTMLElement;
  if (def.kind === "ref") {
    const kind = def.name === "cmdb_ci" ? "ci" : "group";
    const ta = new Typeahead(
      (text) => shell.call<{ results: Option[] }>("change_search", { kind, text, limit: 10 }).then((r) => r.results),
      def.name === "cmdb_ci" ? "Search configuration items" : "Search groups"
    );
    ta.input.id = `f_${def.name}`;
    ta.onselect = () => clearError(def.name);
    refs[def.name] = ta;
    control = ta.root;
  } else if (def.kind === "textarea") {
    control = el("textarea", { id: `f_${def.name}`, rows: "3" });
  } else if (def.kind === "choice") {
    control = el("select", { id: `f_${def.name}` }, el("option", { value: "" }, "—"));
  } else if (def.kind === "datetime") {
    control = el("input", { id: `f_${def.name}`, type: "datetime-local" });
  } else {
    control = el("input", { id: `f_${def.name}`, type: "text", maxlength: "160" });
  }
  if (!(control instanceof HTMLDivElement)) {
    controls.set(def.name, control as HTMLInputElement);
    control.addEventListener("input", () => clearError(def.name));
  }
  const box = fieldBox(def, control);
  if (def.wide) {
    row = null;
    form.append(box);
  } else {
    if (!row || row.children.length >= (def.kind === "choice" ? 3 : 2)) {
      row = el("div", { class: "row" });
      form.append(row);
    }
    row.append(box);
  }
  if (def.name === "end_date") {
    form.append(el("div", { class: "muted", style: "font-size:12px;margin:-4px 0 10px" }, `Times are in ${tz}.`));
    row = null;
  }
}

const submitBtn = el("button", { type: "submit", class: "primary" }, "Submit change");
form.append(el("div", { class: "actions" }, submitBtn));
form.onsubmit = (e) => {
  e.preventDefault();
  void submit();
};

// ── state ────────────────────────────────────────────────────────────────────
function setType(t: ChangeType): void {
  type = t;
  for (const b of typeSeg.querySelectorAll("button")) b.classList.toggle("on", b.dataset["type"] === t);
  templateBox.hidden = t !== "standard";
  if (t !== "standard") {
    locked = {};
    template = null;
  }
  applyLocks();
  updateRequiredMarks();
}

function applyLocks(): void {
  for (const def of FIELDS) {
    const isLocked = type === "standard" && locked[def.name] !== undefined;
    const c = controls.get(def.name);
    if (c) {
      c.disabled = isLocked;
      if (isLocked && def.kind !== "datetime") c.value = locked[def.name]!;
    }
    refs[def.name]?.setDisabled(isLocked);
    const label = fieldBoxes.get(def.name)?.querySelector("label");
    label?.querySelector(".pill")?.remove();
    if (isLocked) label?.append(" ", el("span", { class: "pill" }, "from template"));
  }
  updateRequiredMarks();
}

function updateRequiredMarks(): void {
  const all = [{ name: "type", required: ALL }, { name: "std_change_template", required: ["standard"] }, ...FIELDS];
  for (const def of all) {
    const label = fieldBoxes.get(def.name)?.querySelector("label");
    label?.querySelector(".req")?.remove();
    const required = (def.required as ChangeType[]).includes(type) && locked[def.name] === undefined;
    if (required) label?.append(el("span", { class: "req", "aria-hidden": "true" }, "*"));
  }
}

function setError(field: string, message: string): void {
  const box = fieldBoxes.get(field);
  if (!box) return;
  box.classList.add("invalid");
  box.querySelector(".err")!.textContent = message;
}
function clearError(field: string): void {
  const box = fieldBoxes.get(field);
  box?.classList.remove("invalid");
  if (box) box.querySelector(".err")!.textContent = "";
}
function clearErrors(): void {
  for (const f of fieldBoxes.keys()) clearError(f);
}

function collect(): Record<string, string> {
  const v: Record<string, string> = { type, idempotency_key: idempotencyKey };
  if (type === "standard" && template) v["std_change_template"] = template.sys_id;
  for (const def of FIELDS) {
    if (type === "standard" && locked[def.name] !== undefined) continue;
    if (def.kind === "ref") {
      const s = refs[def.name]!.selected;
      if (s) v[def.name] = s.sys_id;
      continue;
    }
    const raw = controls.get(def.name)!.value.trim();
    const value = def.kind === "datetime" ? localInputToIso(raw) : raw;
    if (value) v[def.name] = value;
  }
  return v;
}

function localCheck(v: Record<string, string>): { field: string; message: string }[] {
  const errs: { field: string; message: string }[] = [];
  if (type === "standard" && !template) errs.push({ field: "std_change_template", message: "Pick a template" });
  for (const def of FIELDS) {
    if (!def.required.includes(type) || locked[def.name] !== undefined) continue;
    if (!v[def.name]) {
      const typed = def.kind === "ref" && refs[def.name]!.input.value.trim();
      errs.push({ field: def.name, message: typed ? "Pick a match from the list" : `${def.label} is required` });
    }
  }
  if (v["start_date"] && new Date(v["start_date"]) <= new Date()) {
    errs.push({ field: "start_date", message: "Planned start must be in the future" });
  }
  if (v["start_date"] && v["end_date"] && new Date(v["end_date"]) <= new Date(v["start_date"])) {
    errs.push({ field: "end_date", message: "Planned end must be after planned start" });
  }
  return errs;
}

function showErrors(errs: { field: string; message: string }[]): void {
  const general: string[] = [];
  for (const e of errs) {
    if (fieldBoxes.has(e.field)) setError(e.field, e.message);
    else general.push(`${e.field}: ${e.message}`);
  }
  banner(status, "error", general.length ? general.join("; ") : `Fix ${errs.length} field(s) highlighted below.`);
  const first = errs.find((e) => fieldBoxes.has(e.field));
  fieldBoxes.get(first?.field ?? "")?.querySelector<HTMLElement>("input,textarea,select,button")?.focus();
}

async function submit(): Promise<void> {
  if (submitting) return;
  clearErrors();
  status.replaceChildren();
  const v = collect();
  const errs = localCheck(v);
  if (errs.length) return showErrors(errs);

  const ok = await shell.confirm({
    title: `Submit ${type} change?`,
    details: [
      ["Type", type],
      ...(template ? ([["Template", template.label]] as [string, string][]) : []),
      ["CI", refs["cmdb_ci"]!.selected?.label ?? locked["cmdb_ci"] ?? ""],
      ["Group", refs["assignment_group"]!.selected?.label ?? locked["assignment_group"] ?? ""],
      ["Window", `${formatDateTime(v["start_date"])} → ${formatDateTime(v["end_date"])}`],
    ],
    confirmLabel: "Submit",
  });
  if (!ok) return;

  submitting = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";
  try {
    const res = await shell.call<{ number: string; sys_id: string; state: string; url: string; type: ChangeType }>(
      "change_submit",
      v
    );
    showResult(res);
  } catch (err) {
    if (err instanceof ToolError && err.fieldErrors.length) showErrors(err.fieldErrors);
    else banner(status, "error", errorMessage(err));
    submitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit change";
  }
}

function showResult(res: { number: string; sys_id: string; state: string; url: string; type: ChangeType }): void {
  void shell.setModelContext(
    `The user submitted change ${res.number} (sys_id ${res.sys_id}, ${res.type}, state ${res.state}).`,
    { change: res }
  );
  const link = el("a", { href: res.url }, "Open in ServiceNow");
  link.onclick = (e) => {
    e.preventDefault();
    shell.openLink(res.url);
  };
  const card = el(
    "div",
    { class: "card" },
    el("h1", {}, `${res.number} created`),
    el("p", {}, `${res.type[0]!.toUpperCase() + res.type.slice(1)} change, state `, el("strong", { id: "chg-state" }, res.state), ". ", link)
  );
  const msg = el("div");
  card.append(msg);
  if (res.type === "normal") {
    const reqBtn = el("button", { type: "button", class: "primary" }, "Request approval");
    reqBtn.onclick = async () => {
      reqBtn.disabled = true;
      try {
        const r = await shell.call<{ number: string; state: string }>("change_request_approval", { sys_id: res.sys_id });
        banner(msg, "ok", `${r.number} moved to ${r.state}. Approvals are being generated.`);
        reqBtn.remove();
        void shell.setModelContext(`Change ${r.number} was moved to ${r.state} for approval.`, { change: { ...res, state: r.state } });
        card.append(approvalsPanel(res));
      } catch (err) {
        banner(msg, "error", errorMessage(err));
        reqBtn.disabled = false;
      }
    };
    card.append(el("div", { class: "actions" }, reqBtn));
  }
  root.replaceChildren(card);
}

// ── approvals for the submitted change ──────────────────────────────────────
interface ApprovalStatus {
  change: { number: string; state: string; approval: string };
  approvals: { approval_sys_id: string; approver: string; state: string; state_label: string; mine: boolean }[];
  decisions_enabled: boolean;
  caller: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shows the approvals ServiceNow generated for the change, live, and lets the caller
// approve or reject their own pending approval in place. The decision goes through the
// same app-only change_approval_decide tool as the approvals inbox.
function approvalsPanel(res: { number: string; sys_id: string }): HTMLElement {
  const panel = el("div", { class: "approvals" }, el("h2", {}, "Approvals"));
  const body = el("div", { class: "muted" }, "Waiting for ServiceNow to generate approvals…");
  panel.append(body);
  let busy = false;

  const load = () => shell.call<ApprovalStatus>("change_approval_status", { change_sys_id: res.sys_id });

  // Poll until approvals appear (the workflow generates them asynchronously), or until
  // the change state moves on after a decision.
  async function poll(until: (s: ApprovalStatus) => boolean, tries = 15): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try {
        const st = await load();
        render(st);
        if (until(st)) return;
      } catch (err) {
        banner(body, "error", errorMessage(err));
        return;
      }
      await sleep(2000);
    }
  }

  function render(st: ApprovalStatus): void {
    const rows = st.approvals.map((a) => {
      const line = el(
        "div",
        { class: "appr-row" },
        el("span", {}, a.approver, ...(a.mine ? [" ", el("span", { class: "pill" }, "you")] : [])),
        el("span", { class: `pill state-${a.state}` }, a.state_label)
      );
      return line;
    });
    const summary = el(
      "p",
      {},
      `${st.change.number} is `,
      el("strong", {}, st.change.state),
      ` · approval ${st.change.approval.toLowerCase()}`
    );
    const head = document.getElementById("chg-state");
    if (head) head.textContent = st.change.state;
    const mine = st.approvals.find((a) => a.mine && a.state === "requested");
    const children: (Node | string)[] = [summary, ...rows];
    if (!st.approvals.length) children.push(el("p", { class: "muted" }, "No approvals yet…"));
    if (mine && st.decisions_enabled) children.push(decideBox(st, mine.approval_sys_id));
    else if (mine) {
      children.push(
        el("div", { class: "banner warn" }, "You have a pending approval, but this server uses a shared service account. Connect with your own ServiceNow login to approve here.")
      );
    } else if (st.approvals.length && !st.approvals.some((a) => a.mine)) {
      children.push(el("p", { class: "muted" }, `No approval for ${st.caller} on this change.`));
    }
    if (!busy) body.replaceChildren(...children);
    body.className = "";
  }

  function decideBox(st: ApprovalStatus, approvalId: string): HTMLElement {
    const box = el("div", { class: "decide" });
    const msg = el("div");
    const comments = el("textarea", { rows: "2", placeholder: "Comments (required to reject)", maxlength: "4000" }) as HTMLTextAreaElement;
    const approve = el("button", { type: "button", class: "primary" }, "Approve");
    const reject = el("button", { type: "button", class: "danger" }, "Reject");
    const go = async (decision: "approved" | "rejected") => {
      const text = comments.value.trim();
      if (decision === "rejected" && !text) {
        banner(msg, "error", "Add a comment to reject.");
        comments.focus();
        return;
      }
      busy = true;
      const ok = await shell.confirm({
        title: `${decision === "approved" ? "Approve" : "Reject"} ${st.change.number}?`,
        details: [["Change", st.change.number], ["Decision", decision], ["Comment", text]],
        confirmLabel: decision === "approved" ? "Approve" : "Reject",
        danger: decision === "rejected",
      });
      if (!ok) { busy = false; return; }
      approve.disabled = reject.disabled = true;
      try {
        const r = await shell.call<{ number: string; decision: string; decided_at: string }>("change_approval_decide", {
          approval_sys_id: approvalId,
          decision,
          comments: text || undefined,
        });
        void shell.setModelContext(`The user ${r.decision} ${r.number} at ${r.decided_at}.`, { decision: r });
        busy = false;
        const before = st.change.state;
        await poll((s) => s.change.state !== before, 8);
      } catch (err) {
        busy = false;
        banner(msg, "error", errorMessage(err));
        approve.disabled = reject.disabled = false;
      }
    };
    approve.onclick = () => go("approved");
    reject.onclick = () => go("rejected");
    box.append(el("strong", {}, "Your decision"), msg, comments, el("div", { class: "actions" }, reject, approve));
    return box;
  }

  void poll((s) => s.approvals.length > 0);
  return panel;
}

// ── prefill + boot ───────────────────────────────────────────────────────────
let prefillApplied = false;
async function applyPrefill(p: Record<string, unknown>): Promise<void> {
  if (prefillApplied) return;
  prefillApplied = true;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const t = s("type").toLowerCase();
  if (t === "normal" || t === "standard" || t === "emergency") setType(t);
  for (const def of FIELDS) {
    const c = controls.get(def.name);
    const v = s(def.name);
    if (!c || !v) continue;
    c.value = def.kind === "datetime" ? isoToLocalInput(v) : v;
  }
  await Promise.all([
    s("ci_name") ? refs["cmdb_ci"]!.resolve(s("ci_name")) : undefined,
    s("group_name") ? refs["assignment_group"]!.resolve(s("group_name")) : undefined,
  ]);
}

loading(root, "Connecting…");
let pendingInput: Record<string, unknown> | null = null;
shell = await createShell({
  name: "change-create",
  onToolInput: (args) => {
    if (controls.size && shell) void applyPrefill(args);
    else pendingInput = args;
  },
  onToolResult: (s) => {
    // open_change_form's result carries the normalised prefill.
    if (s?.["prefill"]) void applyPrefill(s["prefill"] as Record<string, unknown>);
  },
});

root.replaceChildren(el("h1", {}, "New change request"), status, form);
setType(type);

try {
  const choices = await shell.call<Record<string, { value: string; label: string }[]>>("change_choices", {
    fields: ["category", "risk", "impact"],
  });
  for (const [field, list] of Object.entries(choices)) {
    const sel = controls.get(field) as HTMLSelectElement | undefined;
    if (!sel) continue;
    const current = sel.value;
    for (const c of list) sel.append(el("option", { value: c.value }, c.label));
    if (current) sel.value = current;
  }
} catch (err) {
  banner(status, "warn", `Could not load choice lists: ${errorMessage(err)}`);
}
if (pendingInput) void applyPrefill(pendingInput);
