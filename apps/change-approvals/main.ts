import { createShell, el, banner, loading, errorMessage, formatDateTime, ToolError } from "../_shared/shell";
import type { Shell } from "../_shared/shell";
import "./style.css";

interface Approval {
  approval_sys_id: string;
  change_sys_id: string;
  number: string;
  short_description: string;
  type: string;
  risk: string;
  ci: string;
  start_date?: string;
  end_date?: string;
  on_behalf_of?: string;
  url: string;
}
interface Identity {
  mode: "service" | "user";
  user: string;
  decisions_enabled: boolean;
}
interface ListResult {
  approvals: Approval[];
  identity: Identity;
}
interface Detail {
  approval: { sys_id: string; state: string };
  change: Record<string, string>;
  affected_cis: { sys_id: string; name: string }[];
  conflicts: { type: string; conflicting_change: string; ci: string; schedule: string }[];
  history: { approver: string; state: string; state_label: string; updated?: string }[];
}

const root = document.getElementById("root")!;
let shell: Shell;
let approvals: Approval[] = [];
let identity: Identity | null = null;
let selected: string | null = null;
let deciding = false;

const status = el("div");
const listEl = el("div", { class: "list", role: "listbox", "aria-label": "Pending approvals" });
const detailEl = el("div", { class: "card" }, el("p", { class: "muted" }, "Select an approval."));

function render(): void {
  const head = el("h1", {}, "Change approvals");
  const sub = el(
    "p",
    { class: "muted" },
    identity ? `${approvals.length} waiting on ${identity.user}` : ""
  );
  root.replaceChildren(head, sub, status, el("div", { class: "layout" }, listEl, detailEl));
  if (identity && !identity.decisions_enabled) {
    banner(
      status,
      "warn",
      "This server uses a shared service account, so decisions are disabled. Configure per-user identity to approve here."
    );
  }
  renderList();
}

function renderList(): void {
  if (approvals.length === 0) {
    listEl.replaceChildren(el("p", { class: "muted" }, "Nothing waiting on you."));
    detailEl.replaceChildren(el("p", { class: "muted" }, "No approval selected."));
    return;
  }
  listEl.replaceChildren(
    ...approvals.map((a) => {
      const b = el(
        "button",
        { type: "button", class: `item${a.approval_sys_id === selected ? " sel" : ""}`, role: "option" },
        el("span", { class: "num" }, a.number),
        el("span", { class: "sd" }, a.short_description || "(no short description)"),
        el(
          "span",
          { class: "meta" },
          `${a.type} · risk ${a.risk || "?"} · ${a.ci || "no CI"} · ${formatDateTime(a.start_date)}`
        ),
        ...(a.on_behalf_of ? [el("span", { class: "meta", style: "display:block" }, `on behalf of ${a.on_behalf_of}`)] : [])
      );
      b.setAttribute("aria-selected", String(a.approval_sys_id === selected));
      b.onclick = () => select(a.approval_sys_id);
      return b;
    })
  );
}

async function refresh(): Promise<void> {
  try {
    const r = await shell.call<ListResult>("open_change_approvals", { limit: 50 });
    setList(r);
  } catch (err) {
    banner(status, "error", errorMessage(err));
  }
}

function setList(r: ListResult): void {
  approvals = r.approvals ?? [];
  identity = r.identity ?? null;
  if (selected && !approvals.some((a) => a.approval_sys_id === selected)) selected = null;
  render();
  if (selected) void select(selected);
}

async function select(id: string): Promise<void> {
  selected = id;
  renderList();
  loading(detailEl, "Loading change…");
  const a = approvals.find((x) => x.approval_sys_id === id)!;
  try {
    const d = await shell.call<Detail>("change_approval_detail", { approval_sys_id: id });
    if (selected !== id) return;
    renderDetail(a, d);
    void shell.setModelContext(
      `The approver is looking at ${d.change["number"]} (${d.change["type"]}, risk ${d.change["risk"]}): ` +
        `${d.change["short_description"]}. Window ${d.change["start_date"]} to ${d.change["end_date"]}. ` +
        `CI ${d.change["cmdb_ci"] || "none"}. ${d.affected_cis.length} affected CI(s), ${d.conflicts.length} conflict(s). ` +
        `Answer questions about "this change" using this record. You cannot approve or reject it.`,
      { selected_change: d.change, affected_cis: d.affected_cis, conflicts: d.conflicts }
    );
  } catch (err) {
    if (selected !== id) return;
    banner(detailEl, "error", errorMessage(err));
    if (err instanceof ToolError && (err.code === "not_yours" || err.code === "stale")) await refresh();
  }
}

function renderDetail(a: Approval, d: Detail): void {
  const c = d.change;
  const kv = el("dl", { class: "kv" });
  const add = (k: string, v: string | undefined) => kv.append(el("dt", {}, k), el("dd", {}, v || "—"));
  add("Type", c["type"]);
  add("State", c["state"]);
  add("Risk / impact", `${c["risk"] || "—"} / ${c["impact"] || "—"}`);
  add("CI", c["cmdb_ci"]);
  add("Group", c["assignment_group"]);
  add("Requested by", c["requested_by"]);
  add("Window", `${formatDateTime(c["start_date_iso"])} → ${formatDateTime(c["end_date_iso"])}`);
  if (a.on_behalf_of) add("Approving for", a.on_behalf_of);

  const link = el("a", { href: c["url"] ?? "#" }, "Open in ServiceNow");
  link.onclick = (e) => {
    e.preventDefault();
    if (c["url"]) shell.openLink(c["url"]);
  };

  const section = (title: string, body: string | undefined, open = false) => {
    const det = el("details", open ? { open: "" } : {}, el("summary", {}, title), el("pre", {}, body || "—"));
    return det;
  };

  const cis = el("details", {}, el("summary", {}, `Affected CIs (${d.affected_cis.length})`));
  cis.append(el("ul", {}, ...d.affected_cis.map((x) => el("li", {}, x.name))));
  const conflicts = el("details", d.conflicts.length ? { open: "" } : {}, el("summary", {}, `Conflicts (${d.conflicts.length})`));
  conflicts.append(
    el("ul", {}, ...d.conflicts.map((x) => el("li", {}, [x.type, x.conflicting_change, x.ci, x.schedule].filter(Boolean).join(" · "))))
  );
  const hist = el("details", { open: "" }, el("summary", {}, `Approval history (${d.history.length})`));
  hist.append(el("ul", { class: "hist" }, ...d.history.map((h) => el("li", {}, `${h.approver}: ${h.state_label}${h.updated ? ` · ${formatDateTime(h.updated)}` : ""}`))));

  const decide = renderDecide(a, c);
  detailEl.replaceChildren(
    el("div", { class: "num mono muted" }, c["number"] ?? ""),
    el("h1", {}, c["short_description"] ?? ""),
    link,
    kv,
    section("Description", c["description"], true),
    section("Justification", c["justification"]),
    section("Implementation plan", c["implementation_plan"]),
    section("Risk and impact analysis", c["risk_impact_analysis"]),
    section("Backout plan", c["backout_plan"]),
    section("Test plan", c["test_plan"]),
    cis,
    conflicts,
    hist,
    decide
  );
}

function renderDecide(a: Approval, c: Record<string, string>): HTMLElement {
  const box = el("div", { class: "decide" });
  const msg = el("div");
  const comments = el("textarea", { rows: "3", placeholder: "Comments (required to reject)", maxlength: "4000" }) as HTMLTextAreaElement;
  const approve = el("button", { type: "button", class: "primary" }, "Approve");
  const reject = el("button", { type: "button", class: "danger" }, "Reject");
  const enabled = identity?.decisions_enabled === true;
  approve.disabled = reject.disabled = comments.disabled = !enabled;

  const go = async (decision: "approved" | "rejected") => {
    if (deciding) return;
    const text = comments.value.trim();
    if (decision === "rejected" && !text) {
      banner(msg, "error", "Add a comment to reject.");
      comments.focus();
      return;
    }
    const ok = await shell.confirm({
      title: `${decision === "approved" ? "Approve" : "Reject"} ${c["number"]}?`,
      details: [
        ["Change", c["number"] ?? ""],
        ["Decision", decision],
        ...(a.on_behalf_of ? ([["On behalf of", a.on_behalf_of]] as [string, string][]) : []),
        ["Comment", text],
      ],
      confirmLabel: decision === "approved" ? "Approve" : "Reject",
      danger: decision === "rejected",
    });
    if (!ok) return;
    deciding = true;
    approve.disabled = reject.disabled = true;
    try {
      const r = await shell.call<{ number: string; decision: string; decided_at: string }>("change_approval_decide", {
        approval_sys_id: a.approval_sys_id,
        decision,
        comments: text || undefined,
      });
      approvals = approvals.filter((x) => x.approval_sys_id !== a.approval_sys_id);
      selected = null;
      render();
      banner(status, "ok", `${r.number} ${r.decision}.`);
      void shell.setModelContext(`The approver ${r.decision} ${r.number} at ${r.decided_at}.`, { decision: r });
    } catch (err) {
      if (err instanceof ToolError && (err.code === "stale" || err.code === "not_yours")) {
        banner(status, "warn", `${c["number"]}: ${err.message} The list has been refreshed.`);
        await refresh();
      } else {
        banner(msg, "error", errorMessage(err));
        approve.disabled = reject.disabled = !enabled;
      }
    } finally {
      deciding = false;
    }
  };
  approve.onclick = () => go("approved");
  reject.onclick = () => go("rejected");
  box.append(el("h2", {}, "Decision"), msg, comments, el("div", { class: "actions" }, reject, approve));
  return box;
}

loading(root, "Connecting…");
let initial: ListResult | null = null;
shell = await createShell({
  name: "change-approvals",
  onToolResult: (s) => {
    if (s?.["approvals"]) {
      if (shell) setList(s as ListResult);
      else initial = s as ListResult;
    }
  },
});
if (initial) setList(initial);
else {
  loading(root, "Loading approvals…");
  await refresh();
}
