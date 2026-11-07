// Shared helpers for handlers.

export const SYS_ID = /^[0-9a-f]{32}$/;

export function isSysId(v: unknown): v is string {
  return typeof v === "string" && SYS_ID.test(v);
}

// User-typed text is embedded in an encoded query (sysparm_query). `^` separates clauses
// and `=` starts operators, so both are stripped to stop text from injecting clauses
// (e.g. "foo^ORactive=false"). Newlines and other control characters are dropped too.
export function sanitizeQueryText(input: unknown, maxLen = 100): string {
  return String(input ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\^=\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// Field names accepted in sysparm_fields / sys_choice lookups.
export function isFieldName(v: unknown): v is string {
  return typeof v === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(v);
}

// sysparm_display_value=all returns { value, display_value } per field. Flatten either shape.
export function val(field: unknown): string {
  if (field && typeof field === "object" && "value" in (field as any)) {
    return String((field as any).value ?? "");
  }
  return field === undefined || field === null ? "" : String(field);
}

export function disp(field: unknown): string {
  if (field && typeof field === "object" && "display_value" in (field as any)) {
    return String((field as any).display_value ?? "");
  }
  return field === undefined || field === null ? "" : String(field);
}

export function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

// Parse a date-time. Strings with an explicit offset or Z are honoured; a bare
// "YYYY-MM-DD HH:mm[:ss]" is treated as UTC.
export function parseDateTime(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  let iso = s.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso)) iso += "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

// ServiceNow internal (UTC) date-time format: "yyyy-MM-dd HH:mm:ss".
export function toSNDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// ServiceNow returns UTC "yyyy-MM-dd HH:mm:ss" for internal values; convert to ISO.
export function snToIso(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s.replace(" ", "T") + "Z";
  return s;
}

// Parse a ServiceNow encoded query like "a=1^b=2^EQ" into field names (for template locks).
export function encodedQueryFields(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of q.split("^")) {
    if (!part || part === "EQ") continue;
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
