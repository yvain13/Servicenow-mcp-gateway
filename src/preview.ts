// Runs a tool for the management UI's app preview. Reads go to the live instance with the
// gateway's service account; writes are never sent: they return a dry-run result instead.
import { callTool, type SNCredentials } from "./servicenow.js";
import { SNClient, SNError } from "./sn-client.js";
import { getHandler, type HandlerContext } from "./handlers/index.js";
import { isWriteTool, visibilityOf } from "./mcp-instance.js";
import type { MCPServer } from "./types.js";

export interface PreviewResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function err(message: string, code = "preview"): PreviewResult {
  return { content: [{ type: "text", text: message }], structuredContent: { error: code, message }, isError: true };
}

export async function previewCall(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
  getCreds: () => SNCredentials
): Promise<PreviewResult> {
  const tool = server.tools.find((t) => t.name === name);
  if (!tool) return err(`Unknown tool ${name}`, "unknown_tool");
  if (!visibilityOf(tool).includes("app")) return err(`${name} is model-only; apps cannot call it`, "not_app_visible");
  if (isWriteTool(tool)) {
    const text = `Preview: ${name} was not sent (it writes to ServiceNow). Arguments: ${JSON.stringify(args)}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: { preview: true, tool: name, args, result: { number: "PREVIEW", sys_id: "preview", state: "preview" }, number: "PREVIEW" },
    };
  }
  const creds = getCreds();
  if (!creds.instanceUrl) return err("No ServiceNow instance is configured");
  try {
    if (tool.kind === "handler") {
      const def = getHandler(tool.handler);
      if (!def) return err(`Unknown handler ${tool.handler}`);
      const sn = new SNClient(getCreds);
      const caller: HandlerContext["caller"] = { mode: "service", username: creds.username };
      const ctx: HandlerContext = {
        sn,
        caller,
        server,
        tool,
        sessionId: "preview",
        appsClient: true,
        callerSysId: async () => {
          if (caller.sysId) return caller.sysId;
          const rows = await sn.list("sys_user", `user_name=${caller.username.replace(/[\^=]/g, "")}`, { fields: ["sys_id", "name"], limit: 1 });
          caller.sysId = rows[0]?.sys_id;
          return caller.sysId;
        },
      };
      const r = await def.fn(args, ctx);
      return { content: [{ type: "text", text: r.text }], structuredContent: r.structured, isError: r.isError };
    }
    const data = await callTool(tool, args, creds);
    const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data };
    return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 2000) }], structuredContent: structured };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), e instanceof SNError ? "servicenow" : "internal");
  }
}
