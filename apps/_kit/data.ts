// Data helpers for spec-driven apps: dot paths, ServiceNow value/display_value pairs, row
// extraction from structuredContent, and {{placeholder}} templates.

export type Row = Record<string, unknown>;

export function get(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Table API fields come back as plain strings, or as { value, display_value, link } with
// sysparm_display_value=all.
export function rawOf(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) return (v as any).value;
  return v;
}

export function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as any;
    if ("display_value" in o) return textOf(o.display_value);
    if ("label" in o) return textOf(o.label);
    if ("value" in o) return textOf(o.value);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return v.map(textOf).join(", ");
  return String(v);
}

// Finds the rows to show: an explicit dot path, else the value itself if it is an array,
// else the first array among its fields (e.g. Table API { result: [...] }), else the object
// itself as a single row.
export function rowsOf(structured: unknown, path?: string): Row[] {
  const v = path ? get(structured, path) : structured;
  if (Array.isArray(v)) return v.filter((r) => r && typeof r === "object") as Row[];
  if (v && typeof v === "object") {
    if (!path) {
      for (const inner of Object.values(v)) if (Array.isArray(inner)) return rowsOf(inner);
      for (const inner of Object.values(v)) {
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          for (const deep of Object.values(inner)) if (Array.isArray(deep)) return rowsOf(deep);
        }
      }
    }
    return [v as Row];
  }
  return [];
}

const ONE = /^\{\{\s*([\w.]+)\s*\}\}$/;
const ANY = /\{\{\s*([\w.]+)\s*\}\}/g;

function lookup(scope: Row, path: string): unknown {
  return rawOf(get(scope, path));
}

// Fills placeholders in a string, or recursively in an object. Keys that end up empty are
// dropped so optional arguments are simply not sent.
export function fill<T>(template: T, scope: Row): T {
  if (typeof template === "string") {
    const one = template.match(ONE);
    if (one) return lookup(scope, one[1]!) as T;
    return template.replace(ANY, (_, p: string) => {
      const v = lookup(scope, p);
      return v === undefined || v === null ? "" : String(v);
    }) as T;
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, scope)) as T;
  if (template && typeof template === "object") {
    const out: Row = {};
    for (const [k, v] of Object.entries(template)) {
      const f = fill(v, scope);
      if (f !== undefined && f !== null && f !== "") out[k] = f;
    }
    return out as T;
  }
  return template;
}

// Text version of a template, using display values (for headings).
export function fillText(template: string, scope: Row): string {
  return template.replace(ANY, (_, p: string) => textOf(get(scope, p)));
}

export function labelFor(field: string): string {
  const last = field.split(".").pop() ?? field;
  const s = last.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function defaultColumns(rows: Row[]): string[] {
  const keys = Object.keys(rows[0] ?? {});
  const pref = keys.filter((k) => !k.startsWith("sys_"));
  return (pref.length ? pref : keys).slice(0, 6);
}

export function countBy(rows: Row[], field: string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = textOf(get(r, field)) || "(empty)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
