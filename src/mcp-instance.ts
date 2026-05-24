import express from "express";
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import * as http from "http";
import * as storage from "./storage.js";
import { callTool } from "./servicenow.js";
import type { SNCredentials } from "./servicenow.js";
import type { MCPServer } from "./types.js";

export class MCPInstance {
  private app: Express;
  private httpServer: http.Server | null = null;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();

  constructor(
    private readonly config: MCPServer,
    private readonly creds: SNCredentials
  ) {
    this.app = express();
    this.app.use(express.json());
    this.mountRoutes();
  }

  // One Server per session — the SDK's Protocol class allows only one transport per Server.
  private buildServer(): Server {
    const server = new Server(
      { name: this.config.name, version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = storage.listTools(this.config.id);
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: "object" as const,
            properties: Object.fromEntries(
              t.parameters.map((p) => [
                p.name,
                { type: p.type, description: p.description },
              ])
            ),
            required: t.parameters.filter((p) => p.required).map((p) => p.name),
          },
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = storage.getToolByName(this.config.id, req.params.name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        };
      }

      try {
        const result = await callTool(
          tool,
          (req.params.arguments ?? {}) as Record<string, unknown>,
          this.creds
        );
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: String(err) }],
          isError: true,
        };
      }
    });

    return server;
  }

  private mountRoutes(): void {
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

          const server = this.buildServer();
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
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
            if (sid) this.transports.delete(sid);
            server.close().catch(() => {});
          };

          await server.connect(newTransport);
          await newTransport.handleRequest(req, res, req.body);
          return;
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
      res.json({
        server: this.config.name,
        description: this.config.description,
        tools: storage.listTools(this.config.id).map((t) => t.name),
        endpoint: `http://localhost:${this.config.port}/mcp`,
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = this.app.listen(this.config.port, () => {
        console.log(`[mcp] ${this.config.name} → http://localhost:${this.config.port}/mcp`);
        resolve();
      });
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
