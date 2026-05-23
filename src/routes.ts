import { Router } from "express";
import * as storage from "./storage.js";
import { testConnection } from "./servicenow.js";
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

    const { name, description, method, endpoint, apiType, parameters } = req.body;
    if (!name || !method || !endpoint || !apiType) {
      res.status(400).json({ error: "name, method, endpoint, and apiType are required" });
      return;
    }
    const tool = storage.addTool(req.params["id"]!, {
      name,
      description: description ?? "",
      method,
      endpoint,
      apiType,
      parameters: parameters ?? [],
    });
    res.status(201).json(tool);
  });

  r.put("/servers/:sid/tools/:tid", (req, res) => {
    try {
      const tool = storage.updateTool(req.params["sid"]!, req.params["tid"]!, req.body);
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
