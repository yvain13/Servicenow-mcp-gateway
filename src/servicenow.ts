import type { Tool, Parameter, ParamLocation } from "./types.js";

export interface SNCredentials {
  instanceUrl: string; // e.g. https://dev00000.service-now.com
  username: string;
  password: string;
}

function authHeader(creds: SNCredentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
}

const PATH_PLACEHOLDER = /\{([^}]+)\}/g;

function defaultLocation(method: Tool["method"]): ParamLocation {
  return method === "POST" || method === "PATCH" ? "body" : "query";
}

function resolveLocation(p: Parameter, method: Tool["method"], pathNames: Set<string>): ParamLocation {
  if (p.in) return p.in;
  if (pathNames.has(p.name)) return "path";
  return defaultLocation(method);
}

// Maps tool parameters to a ServiceNow REST call.
// - `{name}` placeholders in endpoint → substituted from path params
// - body params → JSON body (flat object)
// - query params → URL query string (Table API params mapped to sysparm_*)
export async function callTool(
  tool: Tool,
  args: Record<string, unknown>,
  creds: SNCredentials
): Promise<unknown> {
  const baseUrl = creds.instanceUrl.replace(/\/$/, "");

  const pathNames = new Set<string>();
  for (const match of tool.endpoint.matchAll(PATH_PLACEHOLDER)) {
    pathNames.add(match[1]!);
  }

  // Catch tool-definition mistakes early: param marked as path but endpoint has no slot for it.
  for (const p of tool.parameters) {
    if (p.in === "path" && !pathNames.has(p.name)) {
      throw new Error(
        `Tool "${tool.name}": parameter "${p.name}" is marked as a path parameter, ` +
        `but the endpoint "${tool.endpoint}" has no {${p.name}} placeholder. ` +
        `Add {${p.name}} to the endpoint URL.`
      );
    }
  }

  const buckets = { body: {} as Record<string, unknown>, query: {} as Record<string, unknown>, path: {} as Record<string, unknown> };

  for (const p of tool.parameters) {
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    const loc = resolveLocation(p, tool.method, pathNames);
    buckets[loc][p.name] = value;
  }

  // Pass through any args that weren't declared but match a path placeholder.
  for (const name of pathNames) {
    if (buckets.path[name] === undefined && args[name] !== undefined) {
      buckets.path[name] = args[name];
    }
  }

  // Substitute path placeholders.
  let path = tool.endpoint.replace(PATH_PLACEHOLDER, (_, name: string) => {
    const v = buckets.path[name];
    if (v === undefined || v === null || v === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(v));
  });

  // Query string.
  const qs = buildQueryString(tool, buckets.query);
  if (qs) path += (path.includes("?") ? "&" : "?") + qs;

  const url = baseUrl + path;

  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    Accept: "application/json",
  };

  let body: string | undefined;
  if (Object.keys(buckets.body).length > 0) {
    body = JSON.stringify(buckets.body);
    headers["Content-Type"] = "application/json";
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
