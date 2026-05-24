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

export interface Tool {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  endpoint: string;
  apiType: ApiType;
  parameters: Parameter[];
}

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  port: number;
  tools: Tool[];
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
