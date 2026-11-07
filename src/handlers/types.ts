import type { SNClient } from "../sn-client.js";
import type { MCPServer, Tool } from "../types.js";

export interface CallerIdentity {
  mode: "service" | "user";
  username: string;
  sysId?: string; // sys_user.sys_id, resolved lazily
  displayName?: string;
}

export interface HandlerContext {
  sn: SNClient;
  caller: CallerIdentity;
  server: MCPServer;
  tool: Tool;
  sessionId: string;
  // true when the connected client declared MCP Apps support (so it can render the UI)
  appsClient: boolean;
  // Resolves and caches the caller's sys_user record.
  callerSysId(): Promise<string | undefined>;
}

export interface HandlerResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
  // Audit entry details, only for write handlers.
  audit?: { record?: string; decision?: string };
}

export interface HandlerDef {
  fn: (args: Record<string, unknown>, ctx: HandlerContext) => Promise<HandlerResult>;
  // Write handlers are rate-limited and audited.
  write?: boolean;
}

export type HandlerRegistry = Record<string, HandlerDef>;

// Helper for structured validation errors that the app can map to fields.
export interface FieldError {
  field: string;
  message: string;
}

export function fieldErrors(errors: FieldError[], extra: Record<string, unknown> = {}): HandlerResult {
  return {
    text:
      "Validation failed:\n" + errors.map((e) => `- ${e.field}: ${e.message}`).join("\n"),
    structured: { errors, ...extra },
    isError: true,
  };
}

export function errorResult(code: string, message: string, extra: Record<string, unknown> = {}): HandlerResult {
  return { text: message, structured: { error: code, message, ...extra }, isError: true };
}
