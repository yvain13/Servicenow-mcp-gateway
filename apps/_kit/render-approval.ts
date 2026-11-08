import type { ApprovalAction, ApprovalSpec } from "../../src/app-spec-types";
import { banner, el, errorMessage } from "../_shared/shell";
import { fill, get, labelFor, textOf, type Row } from "./data";
import type { Gateway } from "./runtime";
import { withRows } from "./render-view";

function card(gw: Gateway, spec: ApprovalSpec, row: Row): HTMLElement {
  const title = textOf(get(row, spec.titleField)) || "(untitled)";
  const c = el("div", { class: "card appr" });
  c.append(el("h2", {}, title));
  if (spec.subtitleField) c.append(el("div", { class: "muted" }, textOf(get(row, spec.subtitleField))));
  if (spec.fields?.length) {
    const dl = el("dl", { class: "kv" });
    for (const f of spec.fields) dl.append(el("dt", {}, f.label ?? labelFor(f.field)), el("dd", {}, textOf(get(row, f.field)) || "—"));
    c.append(dl);
  }
  const wantsComment = spec.actions.some((a) => (a.comment ?? "none") !== "none");
  const comment = el("textarea", { rows: "2", placeholder: "Comment", "aria-label": `Comment on ${title}` }) as HTMLTextAreaElement;
  const msg = el("div");
  const bar = el("div", { class: "actions" });
  const buttons = spec.actions.map((a) => {
    const b = el("button", { type: "button", class: a.style ?? "" }, a.label);
    b.onclick = () => void act(a);
    return b;
  });
  bar.append(...buttons);
  if (wantsComment) c.append(comment);
  c.append(msg, bar);

  async function act(a: ApprovalAction) {
    msg.replaceChildren();
    const text = comment.value.trim();
    if (a.comment === "required" && !text) {
      banner(msg, "error", `A comment is required to ${a.label.toLowerCase()}.`);
      comment.focus();
      return;
    }
    if (a.confirm !== false && !(await gw.confirm({ title: `${a.label}: ${title}?`, details: text ? [["Comment", text]] : [], confirmLabel: a.label, danger: a.style === "danger" })))
      return;
    buttons.forEach((b) => (b.disabled = true));
    try {
      await gw.call(a.tool, fill(a.args, { ...row, comment: text, input: gw.input() ?? {} }));
      bar.remove();
      comment.disabled = true;
      c.classList.add("done");
      banner(msg, "ok", `${a.label} recorded.`);
      await gw.setContext(`${a.label} recorded for ${title}${text ? ` with comment "${text}"` : ""}.`);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      banner(msg, "error", errorMessage(err));
    }
  }
  return c;
}

export function renderApproval(gw: Gateway, root: HTMLElement, spec: ApprovalSpec): void {
  const body = el("div", { class: "appr-list" });
  const head = el("div", { class: "head" }, el("h1", {}, spec.title));
  root.replaceChildren(head, ...(spec.description ? [el("p", { class: "muted" }, spec.description)] : []), body);
  const reload = withRows(gw, body, spec.source, (rows) => {
    if (!rows.length) { body.replaceChildren(el("p", { class: "muted" }, spec.empty ?? "Nothing waiting for you.")); return; }
    body.replaceChildren(...rows.map((r) => card(gw, spec, r)));
    void gw.setContext(`${spec.title}: ${rows.length} item(s) shown: ${rows.map((r) => textOf(get(r, spec.titleField))).join(", ")}.`);
  });
  if (spec.source) {
    const btn = el("button", { type: "button" }, "Refresh");
    btn.onclick = () => void reload();
    head.append(btn);
  }
}
