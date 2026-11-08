import type { FieldSpec, FormSpec } from "../../src/app-spec-types";
import { banner, el, errorMessage, ToolError } from "../_shared/shell";
import { Typeahead, type Option } from "../_shared/typeahead";
import { fill, fillText, get, labelFor, rawOf, rowsOf, textOf, type Row } from "./data";
import type { Gateway } from "./runtime";

interface Control {
  spec: FieldSpec;
  wrap: HTMLElement;
  err: HTMLElement;
  get(): unknown;
  set(v: unknown): void;
  disable(d: boolean): void;
}

const SYS_ID = /^[0-9a-f]{32}$/;

function choices(f: FieldSpec): { value: string; label: string }[] {
  return (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value }));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function control(gw: Gateway, f: FieldSpec, input: () => Row): Control {
  const id = `f_${f.name}`;
  const type = f.type ?? "text";
  const label = el("label", { for: id }, f.label ?? labelFor(f.name));
  if (f.required) label.append(el("span", { class: "req", "aria-hidden": "true" }, "*"));
  const err = el("div", { class: "err", id: `${id}_err` });
  const wrap = el("div", { class: "field" });
  let get: () => unknown;
  let set: (v: unknown) => void;
  let disable: (d: boolean) => void;

  if (type === "lookup" && f.lookup) {
    const lk = f.lookup;
    const ta = new Typeahead(async (text) => {
      const q = text.replace(/\^/g, ""); // keep typed text from adding encoded-query clauses
      const args = fill(lk.args ?? {}, { input: input(), text: q }) as Row;
      if (!JSON.stringify(lk.args ?? {}).includes("{{text")) args[lk.textArg ?? "text"] = q;
      const res = await gw.call(lk.tool, args);
      return rowsOf(res, lk.path).map((r): Option => ({
        sys_id: String(rawOf(get_(r, lk.value ?? "sys_id")) ?? ""),
        label: textOf(get_(r, lk.label ?? ("name" in r ? "name" : "label"))),
        detail: lk.detail ? textOf(get_(r, lk.detail)) : undefined,
      }));
    }, f.placeholder ?? "Search…");
    ta.input.id = id;
    if (f.required) ta.input.setAttribute("aria-required", "true");
    wrap.append(label, ta.root);
    get = () => (ta.selected ? ta.selected.sys_id : ta.input.value.trim() ? { unresolved: ta.input.value } : undefined);
    set = (v) => {
      const s = String(v ?? "");
      if (!s) return;
      if (SYS_ID.test(s)) ta.set({ sys_id: s, label: s });
      else void ta.resolve(s);
    };
    disable = (d) => ta.setDisabled(d);
  } else {
    let input_: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (type === "textarea") input_ = el("textarea", { id, rows: "3" });
    else if (type === "select") {
      const s = el("select", { id });
      s.append(el("option", { value: "" }, f.required ? "Select…" : "—"));
      for (const c of choices(f)) s.append(el("option", { value: c.value }, c.label));
      input_ = s;
    } else {
      const t = { number: "number", date: "date", datetime: "datetime-local", checkbox: "checkbox" }[type as string] ?? "text";
      input_ = el("input", { id, type: t });
    }
    if (f.placeholder && "placeholder" in input_) input_.setAttribute("placeholder", f.placeholder);
    if (f.required) input_.setAttribute("aria-required", "true");
    input_.setAttribute("aria-describedby", `${id}_err`);
    const isBox = type === "checkbox";
    if (isBox) wrap.append(el("label", { class: "check" }, input_, " ", f.label ?? labelFor(f.name)));
    else wrap.append(label, input_);
    get = () => {
      if (isBox) return (input_ as HTMLInputElement).checked;
      const v = input_.value.trim();
      if (!v) return undefined;
      if (type === "number") return Number(v);
      if (type === "datetime") return new Date(v).toISOString();
      return v;
    };
    set = (v) => {
      if (v === undefined || v === null) return;
      if (isBox) (input_ as HTMLInputElement).checked = v === true || v === "true";
      else if (type === "datetime") {
        const d = new Date(String(v));
        if (!isNaN(d.getTime()))
          input_.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } else input_.value = String(v);
    };
    disable = (d) => (input_.disabled = d);
  }
  if (f.help) wrap.append(el("small", { class: "muted" }, f.help));
  wrap.append(err);
  if (f.default !== undefined) set(f.default);
  return { spec: f, wrap, err, get, set, disable };
}

const get_ = get;

export function renderForm(gw: Gateway, root: HTMLElement, spec: FormSpec): void {
  const status = el("div");
  const form = el("form", { novalidate: "" });
  const controls = spec.fields.map((f) => control(gw, f, () => gw.input() ?? {}));
  controls.forEach((c) => form.append(c.wrap));
  const submit = el("button", { type: "submit", class: "primary" }, spec.submit.label ?? "Submit");
  form.append(el("div", { class: "actions" }, submit));
  root.replaceChildren(
    el("h1", {}, spec.title),
    ...(spec.description ? [el("p", { class: "muted" }, spec.description)] : []),
    status,
    form
  );

  gw.onInput((args) => {
    for (const c of controls) if (args[c.spec.name] !== undefined) c.set(args[c.spec.name]);
  });

  const setError = (c: Control, msg: string) => {
    c.wrap.classList.toggle("invalid", !!msg);
    c.err.textContent = msg;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    status.replaceChildren();
    const values: Row = {};
    let bad = 0;
    for (const c of controls) {
      const v = c.get();
      let msg = "";
      if (v && typeof v === "object" && "unresolved" in v) msg = "Pick a match from the list";
      else if (c.spec.required && (v === undefined || v === false)) msg = "Required";
      else if (typeof v === "number" && isNaN(v)) msg = "Enter a number";
      setError(c, msg);
      if (msg) bad++;
      else if (v !== undefined) values[c.spec.name] = v;
    }
    if (bad) {
      form.querySelector<HTMLElement>(".field.invalid input, .field.invalid textarea, .field.invalid select")?.focus();
      return;
    }
    const args = { ...fill(spec.submit.args ?? {}, { ...values, input: gw.input() ?? {} }), ...values };
    if (spec.submit.confirm !== false) {
      const details: [string, string][] = controls
        .filter((c) => values[c.spec.name] !== undefined)
        .map((c) => {
          const ta = c.wrap.querySelector("input");
          const shown = c.spec.type === "lookup" && ta ? ta.value : textOf(values[c.spec.name]);
          return [c.spec.label ?? labelFor(c.spec.name), shown];
        });
      const ok = await gw.confirm({ title: `${spec.submit.label ?? "Submit"}?`, details, confirmLabel: spec.submit.label ?? "Submit" });
      if (!ok) return;
    }
    submit.disabled = true;
    controls.forEach((c) => c.disable(true));
    try {
      const res = await gw.call(spec.submit.tool, args);
      // {{result.x}} is the created record: Table API wraps it in { result: {...} }.
      const inner = (res as Row)["result"];
      const record = inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Row) : res;
      const scope = { ...record, result: record };
      const heading = spec.result?.title ? fillText(spec.result.title, scope) : "Submitted";
      const card = el("div", { class: "card" }, el("h1", {}, heading));
      if (spec.result?.fields?.length) {
        const dl = el("dl", { class: "kv" });
        for (const f of spec.result.fields) dl.append(el("dt", {}, f.label ?? labelFor(f.field)), el("dd", {}, textOf(get(scope, f.field)) || "—"));
        card.append(dl);
      }
      root.replaceChildren(card);
      await gw.setContext(`${spec.title}: ${heading}`, res);
    } catch (err) {
      submit.disabled = false;
      controls.forEach((c) => c.disable(false));
      if (err instanceof ToolError && err.fieldErrors.length) {
        let placed = 0;
        for (const fe of err.fieldErrors) {
          const c = controls.find((x) => x.spec.name === fe.field);
          if (c) { setError(c, fe.message); placed++; }
        }
        banner(status, "error", placed === err.fieldErrors.length ? "Fix the highlighted fields." : err.fieldErrors.map((f) => `${f.field}: ${f.message}`).join("; "));
      } else banner(status, "error", errorMessage(err));
    }
  });
}
