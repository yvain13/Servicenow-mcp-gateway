import type { Tool, HttpMethod } from "./types.js";

export interface SNCredentials {
  instanceUrl: string; // e.g. https://dev00000.service-now.com
  username: string;
  password: string;
}

function authHeader(creds: SNCredentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
}

// Maps tool parameters to a ServiceNow REST call.
// For GET/DELETE: args become sysparm_* query params (Table API) or plain params.
// For POST/PATCH: args become the JSON body.
export async function callTool(
  tool: Tool,
  args: Record<string, unknown>,
  creds: SNCredentials
): Promise<unknown> {
  const baseUrl = creds.instanceUrl.replace(/\/$/, "");
  let url = baseUrl + tool.endpoint;

  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  let body: string | undefined;

  if (tool.method === "GET" || tool.method === "DELETE") {
    const qs = buildQueryString(tool, args);
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  } else {
    body = JSON.stringify(args);
  }

  const res = await fetch(url, { method: tool.method, headers, body });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `ServiceNow returned ${res.status}: ${typeof data === "object" ? JSON.stringify(data) : text}`
    );
  }

  return data;
}

function buildQueryString(tool: Tool, args: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    if (tool.apiType === "table") {
      // Map named params → standard sysparm_* names the model can use naturally
      const snKey = TABLE_PARAM_MAP[key] ?? key;
      params.set(snKey, String(value));
    } else {
      params.set(key, String(value));
    }
  }

  return params.toString();
}

// Lets tool authors use clean names like "query", "fields", "limit"
// which the model understands, while sending the correct sysparm_ names.
const TABLE_PARAM_MAP: Record<string, string> = {
  query: "sysparm_query",
  fields: "sysparm_fields",
  limit: "sysparm_limit",
  offset: "sysparm_offset",
  order_by: "sysparm_orderby",
  display_value: "sysparm_display_value",
  exclude_ref_link: "sysparm_exclude_reference_link",
  view: "sysparm_view",
};

// Quick connectivity test — fetches a single row from sys_user
export async function testConnection(creds: SNCredentials): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${creds.instanceUrl.replace(/\/$/, "")}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader(creds), Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
