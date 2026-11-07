import { Router } from "express";
import * as storage from "./storage.js";
import { testConnection } from "./servicenow.js";
import { bundleStatus } from "./apps.js";
import { handlerNames } from "./handlers/index.js";
import type { IdentityMode, Tool, ToolUI } from "./types.js";
import type { MCPManager } from "./mcp-manager.js";
import type { SNCredentials } from "./servicenow.js";

export function buildRouter(manager: MCPManager, getCreds: () => SNCredentials): Router {
  const r = Router();

  // ── Instance ────────────────────────────────────────────────────────────────

  r.get("/instance", (_req, res) => {
    const cfg = storage.getInstance();
    res.json(cfg ?? {});
  });

  r.put("/instance", async (req, res) => {
    const { url, username, password } = req.body as {
      url?: string;
      username?: string;
      password?: string;
    };
    if (!url || !username || !password) {
      res.status(400).json({ error: "url, username, and password are required" });
      return;
    }

    const creds: SNCredentials = { instanceUrl: url, username, password };
    const test = await testConnection(creds);
    if (!test.ok) {
      res.status(400).json({ error: `Cannot reach instance: ${test.error}` });
      return;
    }

    storage.setInstance({ url, username });
    // Persist password into env so the running process can use it
    process.env["SN_INSTANCE_URL"] = url;
    process.env["SN_USERNAME"] = username;
    process.env["SN_PASSWORD"] = password;
    manager.updateCreds(creds);

    res.json({ ok: true });
  });

  r.post("/instance/test", async (req, res) => {
    const { url, username, password } = req.body as {
      url?: string;
      username?: string;
      password?: string;
    };
    if (!url || !username || !password) {
      res.status(400).json({ error: "url, username, and password are required" });
      return;
    }
    const result = await testConnection({ instanceUrl: url, username, password });
    res.json(result);
  });

  // ── Servers ─────────────────────────────────────────────────────────────────

  r.get("/servers", (_req, res) => {
    const servers = storage.listServers();
    res.json(
      servers.map((s) => ({
        ...s,
        running: manager.isRunning(s.id),
        endpointUrl: `http://localhost:${s.port}/mcp`,
      }))
    );
  });

  r.get("/servers/:id", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ...server, running: manager.isRunning(server.id), endpointUrl: `http://localhost:${server.port}/mcp` });
  });

  r.post("/servers", async (req, res) => {
    const { name, description, port } = req.body as {
      name?: string;
      description?: string;
      port?: number;
    };
    if (!name || !port) {
      res.status(400).json({ error: "name and port are required" });
      return;
    }
    const server = storage.createServer({
      name,
      description: description ?? "",
      port,
    });
    await manager.start(server);
    res.status(201).json({ ...server, running: true, endpointUrl: `http://localhost:${server.port}/mcp` });
  });

  // Update server-level flags: appsEnabled, identity, description.
  r.patch("/servers/:id", (req, res) => {
    const { appsEnabled, identity, description } = req.body as {
      appsEnabled?: boolean;
      identity?: IdentityMode;
      description?: string;
    };
    if (identity !== undefined && identity !== "service" && identity !== "per-user") {
      res.status(400).json({ error: "identity must be service or per-user" });
      return;
    }
    try {
      const patch: Parameters<typeof storage.updateServer>[1] = {};
      if (appsEnabled !== undefined) patch.appsEnabled = Boolean(appsEnabled);
      if (identity !== undefined) patch.identity = identity;
      if (description !== undefined) patch.description = String(description);
      res.json(storage.updateServer(req.params["id"]!, patch));
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  // ui:// resources for a server, with bundle build status.
  r.get("/servers/:id/apps", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const apps = await Promise.all(
      (server.apps ?? []).map(async (a) => ({
        ...a,
        status: await bundleStatus(a),
        tools: server.tools.filter((t) => t.ui?.resourceUri === a.uri).map((t) => t.name),
      }))
    );
    res.json({ appsEnabled: server.appsEnabled === true, identity: server.identity ?? "service", apps });
  });

  r.get("/handlers", (_req, res) => {
    res.json(handlerNames());
  });

  r.delete("/servers/:id", async (req, res) => {
    await manager.stop(req.params["id"]!);
    const ok = storage.deleteServer(req.params["id"]!);
    res.json({ ok });
  });

  r.post("/servers/:id/start", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    await manager.start(server);
    res.json({ running: true });
  });

  r.post("/servers/:id/stop", async (req, res) => {
    await manager.stop(req.params["id"]!);
    res.json({ running: false });
  });

  r.get("/servers/:id/config-snippet", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }

    const snippet = {
      mcpServers: {
        [server.name]: {
          command: "npx",
          args: ["mcp-remote", `http://localhost:${server.port}/mcp`],
        },
      },
    };
    res.json({ snippet, json: JSON.stringify(snippet, null, 2) });
  });

  // ── Tools ────────────────────────────────────────────────────────────────────

  r.get("/servers/:id/tools", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    res.json(storage.listTools(req.params["id"]!));
  });

  r.post("/servers/:id/tools", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }

    const { name, description, method, endpoint, apiType, parameters, kind, handler, ui } = req.body;
    const isHandler = kind === "handler";
    if (!name || (!isHandler && (!method || !endpoint || !apiType))) {
      res.status(400).json({ error: "name, method, endpoint, and apiType are required" });
      return;
    }
    if (isHandler && !handlerNames().includes(handler)) {
      res.status(400).json({ error: `Unknown handler: ${handler}` });
      return;
    }
    const uiErr = validateUI(server.apps ?? [], ui);
    if (uiErr) { res.status(400).json({ error: uiErr }); return; }
    const data: Omit<Tool, "id"> = {
      name,
      description: description ?? "",
      method: method ?? "POST",
      endpoint: endpoint ?? "",
      apiType: apiType ?? "scripted",
      parameters: parameters ?? [],
    };
    if (isHandler) { data.kind = "handler"; data.handler = handler; }
    if (ui) data.ui = ui;
    const tool = storage.addTool(req.params["id"]!, data);
    res.status(201).json(tool);
  });

  r.put("/servers/:sid/tools/:tid", (req, res) => {
    const server = storage.getServer(req.params["sid"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const patch = { ...(req.body ?? {}) };
    delete patch.id;
    if ("ui" in patch) {
      const uiErr = validateUI(server.apps ?? [], patch.ui);
      if (uiErr) { res.status(400).json({ error: uiErr }); return; }
      if (patch.ui === null) patch.ui = undefined;
    }
    if (patch.kind === "handler" && !handlerNames().includes(patch.handler)) {
      res.status(400).json({ error: `Unknown handler: ${patch.handler}` });
      return;
    }
    try {
      const tool = storage.updateTool(req.params["sid"]!, req.params["tid"]!, patch);
      res.json(tool);
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  r.delete("/servers/:sid/tools/:tid", (req, res) => {
    const ok = storage.deleteTool(req.params["sid"]!, req.params["tid"]!);
    res.json({ ok });
  });

  // Test a tool against the live instance
  r.post("/servers/:sid/tools/:tid/test", async (req, res) => {
    const tool = storage.getTool(req.params["sid"]!, req.params["tid"]!);
    if (!tool) { res.status(404).json({ error: "Tool not found" }); return; }

    if (tool.kind === "handler") {
      res.status(400).json({
        ok: false,
        error: "Code-backed handler tools are tested from an MCP client (they may render an app or need a caller identity).",
      });
      return;
    }

    const creds = getCreds();
    if (!creds.instanceUrl) {
      res.status(400).json({ error: "No instance configured" });
      return;
    }

    const { callTool } = await import("./servicenow.js");
    try {
      const result = await callTool(tool, req.body ?? {}, creds);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  return r;
}

function validateUI(apps: { uri: string }[], ui: unknown): string | null {
  if (ui === undefined || ui === null) return null;
  if (typeof ui !== "object") return "ui must be an object";
  const u = ui as ToolUI;
  if (u.resourceUri !== undefined && !apps.some((a) => a.uri === u.resourceUri)) {
    return `Unknown app ${u.resourceUri}; it must be one of this server's apps`;
  }
  if (u.visibility !== undefined) {
    if (!Array.isArray(u.visibility) || u.visibility.length === 0 || u.visibility.some((v) => v !== "model" && v !== "app")) {
      return "visibility must be a non-empty subset of [model, app]";
    }
  }
  return null;
}
