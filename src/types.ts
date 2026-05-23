export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ParamType = "string" | "number" | "boolean";
export type ApiType = "table" | "scripted";

export interface Parameter {
  name: string;
  description: string;
  type: ParamType;
  required: boolean;
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
