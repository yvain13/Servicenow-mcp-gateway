import express from "express";
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import * as http from "http";
import * as storage from "./storage.js";
import { callTool, testConnection } from "./servicenow.js";
import type { SNCredentials } from "./servicenow.js";
import { SNClient, SNError } from "./sn-client.js";
import { getHandler } from "./handlers/index.js";
import type { CallerIdentity, HandlerContext, HandlerResult } from "./handlers/index.js";
import { RESOURCE_MIME_TYPE, appMeta, readBundle } from "./apps.js";
import { audit } from "./audit.js";
import { RateLimiter } from "./rate-limit.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { GatewayOAuthProvider, broker, setServerLookup, startRouter } from "./oauth.js";
import type { NextFunction, RequestHandler } from "express";

setServerLookup((id) => storage.getServer(id));
import type { MCPServer, Tool, ToolVisibility } from "./types.js";

interface Session {
  id: string;
  getCreds: () => SNCredentials;
  caller: CallerIdentity;
  appsClient: boolean;
  limiter: RateLimiter;
  authSession?: string; // "oauth" identity: the signed-in ServiceNow session this MCP session belongs to
}

// True when the client declared MCP Apps support at initialize
// (capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes includes the app MIME type).
// MCP_APPS_ASSUME_SUPPORT=1 forces it on for hosts that render apps without declaring it.
export function clientSupportsApps(caps: ClientCapabilities | undefined): boolean {
  if (process.env["MCP_APPS_ASSUME_SUPPORT"] === "1") return true;
  const ext = (caps as { extensions?: Record<string, any> } | undefined)?.extensions?.[EXTENSION_ID];
  if (!ext) return false;
  const mimeTypes = ext.mimeTypes as string[] | undefined;
  return !mimeTypes || mimeTypes.includes(RESOURCE_MIME_TYPE);
}

export function visibilityOf(tool: Tool): ToolVisibility[] {
  return tool.ui?.visibility?.length ? tool.ui.visibility : ["model", "app"];
}

export function isAppOnly(tool: Tool): boolean {
  return !visibilityOf(tool).includes("model");
}

export function isWriteTool(tool: Tool): boolean {
  if (tool.kind === "handler") return getHandler(tool.handler)?.write === true;
  return tool.method !== "GET";
}

export function buildInputSchema(tool: Tool): Record<string, unknown> {
  const base = {
    type: "object" as const,
    properties: Object.fromEntries(
      tool.parameters.map((p) => [p.name, { type: p.type, description: p.description }])
    ),
    required: tool.parameters.filter((p) => p.required).map((p) => p.name),
  };
  if (!tool.inputSchema) return base;
  const extra = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...base,
    ...extra,
    type: "object",
    properties: { ...base.properties, ...(extra.properties ?? {}) },
    required: [...new Set([...base.required, ...(extra.required ?? [])])],
  };
}

// Builds the tools/list entry for a tool. `apps` = this session renders MCP Apps.
export function listEntry(tool: Tool, apps: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    inputSchema: buildInputSchema(tool),
  };
  if (tool.outputSchema) entry["outputSchema"] = tool.outputSchema;
  if (apps && tool.ui) {
    const ui: Record<string, unknown> = { visibility: visibilityOf(tool) };
    const meta: Record<string, unknown> = { ui };
    if (tool.ui.resourceUri) {
      ui["resourceUri"] = tool.ui.resourceUri;
      meta[RESOURCE_URI_META_KEY] = tool.ui.resourceUri; // legacy key some hosts still read
    }
    entry["_meta"] = meta;
  }
  return entry;
}

function asStructured(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (v === undefined) return undefined;
  return { result: v };
}

// Points an MCP session at a signed-in user's ServiceNow token. Returns false if the
// sign-in no longer exists.
function bindUser(session: Session, snSessionId: string): boolean {
  const sn = broker.sessions.get(snSessionId);
  if (!sn) return false;
  session.getCreds = () => ({ instanceUrl: sn.instanceUrl, username: sn.user.userName, password: "", accessToken: sn.access });
  session.caller = { mode: "user", username: sn.user.userName, sysId: sn.user.sysId, displayName: sn.user.name };
  session.authSession = sn.id;
  return true;
}

export class MCPInstance {
  private app: Express;
  private httpServer: http.Server | null = null;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private sessions: Map<string, Session> = new Map();

  constructor(
    private readonly config: MCPServer,
    private readonly getCreds: () => SNCredentials
  ) {
    this.app = express();
    this.app.use(express.json({ limit: "1mb" }));
    this.mountRoutes();
  }

  // Latest stored definition, so UI edits (apps, flags) apply without a restart.
  private current(): MCPServer {
    return storage.getServer(this.config.id) ?? this.config;
  }

  private appsActive(session: Session): boolean {
    return this.current().appsEnabled === true && session.appsClient;
  }

  // One Server per session — the SDK's Protocol class allows only one transport per Server.
  private buildServer(session: Session): Server {
    const server = new Server(
      { name: this.config.name, version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } }
    );

    server.oninitialized = () => {
      session.appsClient = clientSupportsApps(server.getClientCapabilities());
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const apps = this.appsActive(session);
      const tools = storage.listTools(this.config.id);
      return {
        tools: tools.filter((t) => apps || !isAppOnly(t)).map((t) => listEntry(t, apps)),
      } as any;
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (!this.appsActive(session)) return { resources: [] };
      return {
        resources: (this.current().apps ?? []).map((a) => ({
          uri: a.uri,
          name: a.name,
          description: a.description,
          mimeType: RESOURCE_MIME_TYPE,
          _meta: appMeta(a),
        })),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const app = this.appsActive(session)
        ? (this.current().apps ?? []).find((a) => a.uri === req.params.uri)
        : undefined;
      if (!app) throw new Error(`Unknown resource: ${req.params.uri}`);
      return {
        contents: [
          { uri: app.uri, mimeType: RESOURCE_MIME_TYPE, text: await readBundle(app), _meta: appMeta(app) },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      return (await this.callTool(session, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)) as any;
    });

    return server;
  }

  private async callTool(session: Session, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tool = storage.getToolByName(this.config.id, name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const apps = this.appsActive(session);
    if (isAppOnly(tool) && !apps) {
      return {
        content: [{ type: "text", text: `Tool ${name} can only be called from its MCP App.` }],
        isError: true,
      };
    }

    const write = isWriteTool(tool);
    if (write && !session.limiter.take()) {
      return {
        content: [{ type: "text", text: "Rate limit exceeded for write tools on this session. Try again in a minute." }],
        structuredContent: { error: "rate_limited" },
        isError: true,
      };
    }

    let result: HandlerResult;
    try {
      if (tool.kind === "handler") {
        const def = getHandler(tool.handler);
        if (!def) throw new Error(`Tool ${name} references unknown handler "${tool.handler}"`);
        const sn = new SNClient(session.getCreds);
        const ctx: HandlerContext = {
          sn,
          caller: session.caller,
          server: this.current(),
          tool,
          sessionId: session.id,
          appsClient: apps,
          callerSysId: async () => {
            if (session.caller.sysId) return session.caller.sysId;
            const rows = await sn.list("sys_user", `user_name=${session.caller.username.replace(/[\^=]/g, "")}`, {
              fields: ["sys_id", "name"],
              limit: 1,
            });
            if (rows[0]) {
              session.caller.sysId = rows[0].sys_id;
              session.caller.displayName = rows[0].name;
            }
            return session.caller.sysId;
          },
        };
        result = await def.fn(args, ctx);
      } else {
        const data = await callTool(tool, args, session.getCreds());
        result = {
          text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
          structured: asStructured(data),
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        text: message,
        structured: { error: err instanceof SNError ? "servicenow" : "internal", message },
        isError: true,
      };
    }

    if (write) {
      await audit({
        caller: `${session.caller.mode}:${session.caller.username}`,
        server: this.config.name,
        tool: name,
        record: result.audit?.record,
        decision: result.audit?.decision,
        ok: !result.isError,
      });
    }

    const out: CallToolResult = { content: [{ type: "text", text: result.text }] };
    if (result.structured) out.structuredContent = result.structured;
    if (result.isError) out.isError = true;
    return out;
  }

  // Resolves who this session acts as. Per-user servers require the client's own ServiceNow
  // login as `Authorization: Basic ...` on the MCP endpoint (demo mode, PDI only).
  private async resolveSession(req: Request): Promise<Session | { error: string }> {
    const mode = this.current().identity ?? "service";
    const id = randomUUID();
    if (mode === "service") {
      return {
        id,
        getCreds: this.getCreds,
        caller: { mode: "service", username: this.getCreds().username },
        appsClient: false,
        limiter: new RateLimiter(),
      };
    }

    if (mode === "oauth") {
      // Clients may connect and list tools before signing in; the first tool call asks for
      // sign-in (401), and the session is bound to that user once it carries a token.
      const session: Session = {
        id,
        getCreds: () => {
          throw new Error("Sign in to ServiceNow first.");
        },
        caller: { mode: "user", username: "(not signed in)" },
        appsClient: false,
        limiter: new RateLimiter(),
      };
      const sid = req.auth?.extra?.["snSessionId"] as string | undefined;
      if (sid && !bindUser(session, sid)) return { error: "Sign in required." };
      return session;
    }

    const header = req.headers["authorization"];
    const m = typeof header === "string" ? /^Basic\s+(.+)$/i.exec(header) : null;
    if (!m) return { error: "This server requires per-user ServiceNow credentials (Authorization: Basic header)." };
    const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i <= 0) return { error: "Malformed Authorization header." };
    const username = decoded.slice(0, i);
    const password = decoded.slice(i + 1);
    const getCreds = (): SNCredentials => ({ instanceUrl: this.getCreds().instanceUrl, username, password });
    const test = await testConnection(getCreds());
    if (!test.ok) return { error: `ServiceNow rejected the supplied credentials (${test.error}).` };
    return {
      id,
      getCreds,
      caller: { mode: "user", username },
      appsClient: false,
      limiter: new RateLimiter(),
    };
  }

  private mountRoutes(): void {
    this.mountOAuth();
    const handle = async (req: Request, res: Response): Promise<void> => {
      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport = sessionId ? this.transports.get(sessionId) : undefined;

        if (!transport) {
          if (req.method !== "POST" || !isInitializeRequest(req.body)) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: no valid session ID. Send initialize first.",
              },
              id: null,
            });
            return;
          }

          const session = await this.resolveSession(req);
          if ("error" in session) {
            res.status(403).json({
              jsonrpc: "2.0",
              error: { code: -32001, message: session.error },
              id: (req.body as { id?: unknown })?.id ?? null,
            });
            return;
          }

          this.sessions.set(session.id, session);
          const server = this.buildServer(session);
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => session.id,
            onsessioninitialized: (sid) => {
              this.transports.set(sid, newTransport);
            },
          });

          // Break the close-cycle: server.close() calls transport.close(), which
          // fires this onclose again. The flag bails on re-entry so we don't recurse.
          let cleaningUp = false;
          newTransport.onclose = () => {
            if (cleaningUp) return;
            cleaningUp = true;
            const sid = newTransport.sessionId;
            if (sid) {
              this.transports.delete(sid);
              this.sessions.delete(sid);
            }
            server.close().catch(() => {});
          };

          await server.connect(newTransport);
          await newTransport.handleRequest(req, res, req.body);
          return;
        }

        // An OAuth MCP session is bound to the first user who signs in on it, and stays theirs.
        const existing = this.sessions.get(sessionId!);
        const signedIn = req.auth?.extra?.["snSessionId"] as string | undefined;
        if (existing && signedIn) {
          if (!existing.authSession) bindUser(existing, signedIn);
          else if (existing.authSession !== signedIn) {
            const now = broker.sessions.get(signedIn);
            const was = broker.sessions.get(existing.authSession);
            // A re-sign-in by the same person (new token) keeps the session; anyone else is refused.
            if (now && (!was || was.user.userName === now.user.userName)) bindUser(existing, signedIn);
            else {
              res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: "This session belongs to another sign-in." }, id: null });
              return;
            }
          }
        }
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error(`[mcp] ${this.config.name} handler error:`, err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          });
        }
      }
    };

    this.app.post("/mcp", handle);
    this.app.get("/mcp", handle);
    this.app.delete("/mcp", handle);

    // Health / info endpoint
    this.app.get("/", (_req: Request, res: Response) => {
      const cur = this.current();
      res.json({
        server: cur.name,
        description: cur.description,
        tools: storage.listTools(this.config.id).map((t) => t.name),
        apps: cur.appsEnabled ? (cur.apps ?? []).map((a) => a.uri) : [],
        identity: cur.identity ?? "service",
        endpoint: `http://localhost:${this.config.port}/mcp`,
      });
    });
  }

  // MCP authorization (only while the server's identity is "oauth"): discovery metadata,
  // /authorize (login page), /token, /register and /revoke from the SDK's router, the login
  // form's /oauth/start, and a Bearer check on /mcp that answers 401 with the metadata URL.
  private mountOAuth(): void {
    const port = this.config.port;
    const provider = new GatewayOAuthProvider(() => this.current());
    const mcpUrl = new URL(`http://localhost:${port}/mcp`);
    const auth = mcpAuthRouter({
      provider,
      issuerUrl: new URL(`http://localhost:${port}`),
      resourceServerUrl: mcpUrl,
      resourceName: this.config.name,
    });
    const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
    const whenOAuth = (h: RequestHandler): RequestHandler => (req: Request, res: Response, next: NextFunction) =>
      this.current().identity === "oauth" ? h(req, res, next) : next();
    // Sign-in is asked for only when a tool runs. Connecting, listing tools and reading app
    // resources need no token, so opening Claude doesn't pop a browser. A token that is sent
    // is used when valid; an invalid one (e.g. after a gateway restart) only matters for a tool call.
    const lazyBearer: RequestHandler = async (req, res, next) => {
      const messages = Array.isArray(req.body) ? req.body : [req.body];
      const callsTool = req.method === "POST" && messages.some((m: any) => m?.method === "tools/call");
      const header = req.headers["authorization"];
      if (!callsTool) {
        const m = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header) : null;
        if (m) {
          try {
            req.auth = await provider.verifyAccessToken(m[1]!);
          } catch {
            /* signed-out view until a tool is called */
          }
        }
        next();
        return;
      }
      bearer(req, res, next);
    };
    this.app.use(whenOAuth(auth));
    this.app.use(whenOAuth(startRouter()));
    this.app.use("/mcp", whenOAuth(lazyBearer));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onListen = () => {
        console.log(`[mcp] ${this.config.name} → http://localhost:${this.config.port}/mcp`);
        resolve();
      };
      // MCP_HOST optionally restricts the bind address (default: all interfaces, as before).
      const host = process.env["MCP_HOST"];
      this.httpServer = host
        ? this.app.listen(this.config.port, host, onListen)
        : this.app.listen(this.config.port, onListen);
      this.httpServer.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    for (const t of this.transports.values()) {
      await t.close().catch(() => {});
    }
    this.transports.clear();

    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) { resolve(); return; }
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      this.httpServer = null;
    });
  }

  get port(): number { return this.config.port; }
  get id(): string { return this.config.id; }
  get name(): string { return this.config.name; }
  get running(): boolean { return this.httpServer !== null; }
}
