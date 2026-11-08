import type { AppSpec } from "./app-spec-types.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ParamType = "string" | "number" | "boolean";
export type ApiType = "table" | "scripted";
export type ParamLocation = "body" | "query" | "path";

export interface Parameter {
  name: string;
  description: string;
  type: ParamType;
  required: boolean;
  // Where the value is sent. Defaults: body for POST/PATCH, query for GET/DELETE.
  // Path params are also auto-detected from `{name}` placeholders in the endpoint.
  in?: ParamLocation;
}

export type ToolVisibility = "model" | "app";

// Links a tool to a ui:// resource (MCP Apps). Hosts that support MCP Apps render the
// resource when the model calls the tool; `visibility: ["app"]` hides it from the model.
export interface ToolUI {
  resourceUri?: string; // ui://change-ops/change-create
  visibility?: ToolVisibility[]; // default ["model", "app"]
}

export type ToolKind = "rest" | "handler";

export interface Tool {
  id: string;
  name: string;
  description: string;
  // REST tools (kind "rest", the default) use method/endpoint/apiType.
  method: HttpMethod;
  endpoint: string;
  apiType: ApiType;
  parameters: Parameter[];
  kind?: ToolKind; // default "rest" = callTool() in servicenow.ts
  handler?: string; // e.g. "change.submit", resolved from src/handlers
  ui?: ToolUI;
  // Extra JSON Schema for complex inputs (arrays, objects) that `parameters` can't express.
  // Merged over the schema built from `parameters`.
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface UIAppCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
}

// Declared external references, as in ServiceNow's MCP Server Console:
// "resource" = libraries, fonts, styles, images loaded at render time (CSP resourceDomains);
// "connection" = domains the page sends requests to at runtime (CSP connectDomains).
export interface UIAppReference {
  type: "resource" | "connection";
  url: string; // an https origin, e.g. https://esm.sh (wildcard subdomains allowed: https://*.example.com)
  name?: string; // e.g. "MCP Apps SDK"
}

// Browser features the page needs (MCP Apps _meta.ui.permissions).
export type UIAppPermission = "camera" | "microphone" | "geolocation" | "clipboardWrite";

// Where an app's HTML comes from:
// - "bundle": a Vite-built app under apps/ (code apps such as change-create)
// - "spec":   a JSON spec (form / view / approval) rendered by the App Kit; no build step
// - "html":   one uploaded self-contained HTML file, with the App Kit's window.gw injected
export type UIAppSource = "bundle" | "spec" | "html";

export interface UIApp {
  uri: string; // ui://change-ops/change-create
  name: string;
  description?: string;
  source?: UIAppSource; // default "bundle"
  bundle?: string; // source "bundle": apps/change-create/dist/index.html (relative to the project root)
  spec?: AppSpec; // source "spec"
  file?: string; // source "html": <serverId>/<slug>.html under the apps data dir
  csp?: UIAppCsp; // derived from references
  references?: UIAppReference[];
  permissions?: UIAppPermission[];
}

// How callers are identified to ServiceNow.
// - "service": the gateway's shared service account from .env (default).
// - "per-user": each MCP client sends its own ServiceNow login as an
//   `Authorization: Basic ...` header on the MCP endpoint (demo only, PDI use).
export type IdentityMode = "service" | "per-user";

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  port: number;
  tools: Tool[];
  appsEnabled?: boolean; // serve ui:// resources and _meta.ui (default false)
  apps?: UIApp[];
  identity?: IdentityMode;
}

export interface InstanceConfig {
  url: string;
  username: string;
  // password is kept in .env / env vars, never stored in data.json
}

export interface Store {
  instance: InstanceConfig | null;
  servers: MCPServer[];
}

export interface ServerStats {
  callsToday: number;
  avgLatencyMs: number;
}
