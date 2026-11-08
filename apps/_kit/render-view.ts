import type { DataSource, ShowField, ViewSpec } from "../../src/app-spec-types";
import { banner, el, errorMessage, loading } from "../_shared/shell";
import { countBy, defaultColumns, fill, get, labelFor, rowsOf, textOf, type Row } from "./data";
import type { Gateway } from "./runtime";

// Loads rows from `source`, or from the result of the tool that opened the app. `render` is
// called again on refresh.
export function withRows(gw: Gateway, body: HTMLElement, source: DataSource | undefined, render: (rows: Row[]) => void): () => void {
  const load = async () => {
    if (!source) return;
    loading(body);
    try {
      const res = await gw.call(source.tool, fill(source.args ?? {}, { input: gw.input() ?? {} }));
      render(rowsOf(res, source.path));
    } catch (err) {
      banner(body, "error", errorMessage(err));
    }
  };
  if (source) {
    // Wait briefly for the tool input so {{input.x}} args are filled.
    let started = false;
    const go = () => { if (!started) { started = true; void load(); } };
    gw.onInput(go);
    gw.ready.then(() => setTimeout(go, 300));
  } else {
    loading(body, "Waiting for data…");
    gw.onResult((s, isError) => {
      if (isError) banner(body, "error", textOf(s?.["message"]) || "The tool failed.");
      else render(rowsOf(s));
    });
  }
  return load;
}

function table(rows: Row[], spec: ViewSpec): HTMLElement {
  const cols: ShowField[] = spec.columns?.length ? spec.columns : defaultColumns(rows).map((field) => ({ field }));
  const t = el("table", { class: "grid" });
  const head = el("tr");
  for (const c of cols) head.append(el("th", { scope: "col" }, c.label ?? labelFor(c.field)));
  t.append(el("thead", {}, head));
  const tb = el("tbody");
  for (const r of rows.slice(0, spec.limit ?? 50)) {
    const tr = el("tr");
    for (const c of cols) tr.append(el("td", {}, textOf(get(r, c.field))));
    tb.append(tr);
  }
  t.append(tb);
  return el("div", { class: "grid-wrap" }, t);
}

function bars(counts: [string, number][]): HTMLElement {
  const max = Math.max(1, ...counts.map((c) => c[1]));
  const box = el("div", { class: "bars", role: "list" });
  for (const [k, n] of counts) {
    const fill_ = el("div", { class: "bar-fill" });
    fill_.style.width = `${(n / max) * 100}%`;
    box.append(el("div", { class: "bar-row", role: "listitem", title: `${k}: ${n}` },
      el("span", { class: "bar-label" }, k), el("div", { class: "bar-track" }, fill_), el("span", { class: "bar-n" }, String(n))));
  }
  return box;
}

function stats(total: number, counts: [string, number][]): HTMLElement {
  const box = el("div", { class: "stats" });
  box.append(el("div", { class: "stat" }, el("b", {}, String(total)), el("span", {}, "Total")));
  for (const [k, n] of counts.slice(0, 7)) box.append(el("div", { class: "stat" }, el("b", {}, String(n)), el("span", {}, k)));
  return box;
}

export function renderView(gw: Gateway, root: HTMLElement, spec: ViewSpec): void {
  const body = el("div");
  const head = el("div", { class: "head" }, el("h1", {}, spec.title));
  root.replaceChildren(head, ...(spec.description ? [el("p", { class: "muted" }, spec.description)] : []), body);
  const reload = withRows(gw, body, spec.source, (rows) => {
    if (!rows.length) { body.replaceChildren(el("p", { class: "muted" }, "No records.")); return; }
    const counts = spec.groupBy ? countBy(rows, spec.groupBy) : [];
    const note = el("p", { class: "muted small" }, `${rows.length} record${rows.length === 1 ? "" : "s"}${spec.groupBy ? ` by ${labelFor(spec.groupBy).toLowerCase()}` : ""}`);
    if (spec.display === "bar" && spec.groupBy) body.replaceChildren(bars(counts), note);
    else if (spec.display === "stats") body.replaceChildren(stats(rows.length, counts), note);
    else body.replaceChildren(table(rows, spec), note);
    const summary = counts.length ? counts.map(([k, n]) => `${k}: ${n}`).join(", ") : `${rows.length} rows`;
    void gw.setContext(`${spec.title} is showing ${rows.length} records. ${summary}`);
  });
  if (spec.source) {
    const btn = el("button", { type: "button" }, "Refresh");
    btn.onclick = () => void reload();
    head.append(btn);
  }
}
