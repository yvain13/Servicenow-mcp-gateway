import { Router } from "express";
import * as storage from "./storage.js";
import { testConnection } from "./servicenow.js";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { dirname, join } from "path";
import { bundleStatus, readBundle, renderDraftHtml } from "./apps.js";
import { buildPrompt, templates, validateHtml, validateSpec, type ValidationReport } from "./app-spec.js";
import { previewCall } from "./preview.js";
import * as oauth from "./oauth.js";
import { handlerNames } from "./handlers/index.js";
import type { IdentityMode, MCPServer, Parameter, Tool, ToolUI, UIApp, UIAppPermission, UIAppReference } from "./types.js";
import type { AppSpec } from "./app-spec-types.js";
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
    const { appsEnabled, identity, description, oauthCredential } = req.body as {
      appsEnabled?: boolean;
      identity?: IdentityMode;
      description?: string;
      oauthCredential?: string | null;
    };
    if (identity !== undefined && identity !== "service" && identity !== "per-user" && identity !== "oauth") {
      res.status(400).json({ error: "identity must be service, per-user or oauth" });
      return;
    }
    if (oauthCredential && !oauth.getCredential(oauthCredential)) {
      res.status(400).json({ error: "Unknown OAuth credential" });
      return;
    }
    try {
      const patch: Parameters<typeof storage.updateServer>[1] = {};
      if (appsEnabled !== undefined) patch.appsEnabled = Boolean(appsEnabled);
      if (identity !== undefined) patch.identity = identity;
      if (description !== undefined) patch.description = String(description);
      if (oauthCredential !== undefined) patch.oauthCredential = oauthCredential || undefined;
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
        slug: slugOf(a),
        editable: isKitApp(a),
        status: await bundleStatus(a),
        tools: server.tools.filter((t) => t.ui?.resourceUri === a.uri).map((t) => t.name),
      }))
    );
    res.json({ appsEnabled: server.appsEnabled === true, identity: server.identity ?? "service", apps });
  });

  // ── No-code apps (App Kit): JSON spec or one uploaded HTML file ──────────────

  r.get("/app-kit/templates", (_req, res) => {
    res.json(templates());
  });

  r.post("/servers/:id/apps/validate", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    res.json(validateDraft(server, req.body ?? {}));
  });

  r.post("/servers/:id/apps/prompt", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const { format, goal } = (req.body ?? {}) as { format?: string; goal?: string };
    if (!["form", "view", "approval", "html"].includes(format ?? "")) {
      res.status(400).json({ error: "format must be form, view, approval or html" });
      return;
    }
    res.json({ prompt: buildPrompt(server, format as "form", String(goal ?? "")) });
  });

  // Renders a draft (not yet saved) the way the host would receive it, for the preview.
  r.post("/servers/:id/apps/render", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const { source, spec, html, name } = (req.body ?? {}) as Draft;
    if (source === "spec") {
      res.type("html").send(await readBundle({ uri: "ui://preview/draft", name: name || "Preview", source: "spec", spec }));
    } else if (source === "html") {
      res.type("html").send(await renderDraftHtml(String(html ?? "")));
    } else {
      const app = (server.apps ?? []).find((a) => slugOf(a) === req.body?.slug);
      if (!app) { res.status(400).json({ error: "source must be spec or html, or pass the slug of a saved app" }); return; }
      res.type("html").send(await readBundle(app));
    }
  });

  // Tool calls from the preview: reads run live, writes are dry-run.
  r.post("/servers/:id/apps/preview-call", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const { name, arguments: args } = (req.body ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    res.json(await previewCall(server, String(name ?? ""), args ?? {}, getCreds));
  });

  r.get("/servers/:id/apps/:slug/source", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    const app = server?.apps?.find((a) => slugOf(a) === req.params["slug"]);
    if (!server || !app) { res.status(404).json({ error: "Not found" }); return; }
    if (app.spec) { res.json({ source: "spec", spec: app.spec }); return; }
    if (app.file) {
      const html = await readFile(join(storage.APPS_DATA_DIR, app.file), "utf8").catch(() => "");
      res.json({ source: "html", html, references: app.references ?? [], permissions: app.permissions ?? [] });
      return;
    }
    res.json({ source: "bundle", bundle: app.bundle });
  });

  r.post("/servers/:id/apps", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const draft = (req.body ?? {}) as Draft;
    const name = String(draft.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "name is required" }); return; }
    const declErr = checkDeclarations(draft);
    if (declErr) { res.status(400).json({ error: declErr }); return; }
    const report = validateDraft(server, draft);
    if (!report.ok) { res.status(400).json({ error: "The app has errors", report }); return; }
    const opener = draft.openWith ? server.tools.find((t) => t.name === draft.openWith) : undefined;
    if (draft.openWith && !opener) { res.status(400).json({ error: `Unknown tool ${draft.openWith}` }); return; }

    const slug = uniqueSlug(server, slugify(draft.slug || name));
    const app: UIApp = { uri: `ui://${slugify(server.name)}/${slug}`, name, description: String(draft.description ?? ""), source: draft.source };
    if (draft.source === "spec") app.spec = draft.spec;
    else {
      app.file = await saveHtml(server, slug, String(draft.html));
    }
    applyDeclarations(app, draft, report);

    storage.updateServer(server.id, { apps: [...(server.apps ?? []), app], appsEnabled: true });
    let launcher: Tool | undefined;
    if (opener) {
      // An existing tool opens the app; the app renders that tool's result (standard pattern).
      launcher = storage.updateTool(server.id, opener.id, { ui: { ...opener.ui, resourceUri: app.uri } });
    } else if (draft.launcher !== false) {
      launcher = storage.addTool(server.id, launcherTool(server, app, draft));
    }
    res.status(201).json({ app: { ...app, slug }, launcher, report });
  });

  r.put("/servers/:id/apps/:slug", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    const app = server?.apps?.find((a) => slugOf(a) === req.params["slug"]);
    if (!server || !app) { res.status(404).json({ error: "Not found" }); return; }
    if (!isKitApp(app)) { res.status(400).json({ error: "Code apps are edited under apps/ and rebuilt" }); return; }
    const draft = { source: app.spec ? "spec" : "html", ...(req.body ?? {}) } as Draft;
    const declErr = checkDeclarations(draft);
    if (declErr) { res.status(400).json({ error: declErr }); return; }
    const report = validateDraft(server, draft);
    if (!report.ok) { res.status(400).json({ error: "The app has errors", report }); return; }
    const next: UIApp = { ...app, name: String(draft.name ?? app.name), description: String(draft.description ?? app.description ?? "") };
    if (draft.source === "spec") { next.spec = draft.spec; next.source = "spec"; delete next.file; }
    else { next.file = await saveHtml(server, slugOf(app), String(draft.html)); next.source = "html"; delete next.spec; }
    applyDeclarations(next, { references: app.references, permissions: app.permissions, ...draft }, report);
    storage.updateServer(server.id, { apps: (server.apps ?? []).map((a) => (a.uri === app.uri ? next : a)) });
    res.json({ app: { ...next, slug: slugOf(next) }, report });
  });

  r.delete("/servers/:id/apps/:slug", async (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    const app = server?.apps?.find((a) => slugOf(a) === req.params["slug"]);
    if (!server || !app) { res.status(404).json({ error: "Not found" }); return; }
    if (!isKitApp(app)) { res.status(400).json({ error: "Code apps are removed from data/store.json and apps/" }); return; }
    storage.updateServer(server.id, { apps: (server.apps ?? []).filter((a) => a.uri !== app.uri) });
    // Launchers made for this app go with it; other tools just lose the link.
    for (const t of server.tools.filter((t) => t.ui?.resourceUri === app.uri)) {
      if (t.kind === "handler" && t.handler === "app.open") storage.deleteTool(server.id, t.id);
      else storage.updateTool(server.id, t.id, { ui: t.ui?.visibility ? { visibility: t.ui.visibility } : undefined });
    }
    if (app.file) await rm(join(storage.APPS_DATA_DIR, app.file), { force: true });
    res.json({ ok: true });
  });

  // ── OAuth (browser sign-in) ─────────────────────────────────────────────────

  r.get("/oauth", (_req, res) => {
    res.json({
      redirectUrl: oauth.redirectUrl(),
      credentials: oauth.listCredentials().map(oauth.publicCredential),
      sessions: oauth.broker.listSessions().map((s) => ({
        id: s.id,
        server: storage.getServer(s.serverId)?.name ?? s.serverId,
        user: s.user.name ? `${s.user.name} (${s.user.userName})` : s.user.userName,
        instanceUrl: s.instanceUrl,
        signedInAt: new Date(s.createdAt).toISOString(),
        expiresAt: new Date(s.expiresAt).toISOString(),
      })),
    });
  });

  r.post("/oauth/credentials", (req, res) => {
    try {
      const { id: _ignored, ...input } = (req.body ?? {}) as Partial<oauth.OAuthCredential>;
      res.status(201).json(oauth.publicCredential(oauth.saveCredential(input)));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.put("/oauth/credentials/:id", (req, res) => {
    if (!oauth.getCredential(req.params["id"])) { res.status(404).json({ error: "Not found" }); return; }
    try {
      res.json(oauth.publicCredential(oauth.saveCredential({ ...(req.body ?? {}), id: req.params["id"] })));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.delete("/oauth/credentials/:id", (req, res) => {
    const ok = oauth.deleteCredential(req.params["id"]!);
    // Servers that preferred it fall back to the first saved credential.
    for (const s of storage.listServers()) {
      if (s.oauthCredential === req.params["id"]) storage.updateServer(s.id, { oauthCredential: undefined });
    }
    res.json({ ok });
  });

  r.delete("/oauth/sessions/:id", (req, res) => {
    res.json({ ok: oauth.broker.signOut(req.params["id"]!) });
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

  // Copy-ready client config for a server. ?identity= previews another mode without saving.
  r.get("/servers/:id/config-snippet", (req, res) => {
    const server = storage.getServer(req.params["id"]!);
    if (!server) { res.status(404).json({ error: "Not found" }); return; }
    const q = String(req.query["identity"] ?? "");
    const identity = (["service", "per-user", "oauth"].includes(q) ? q : server.identity ?? "service") as IdentityMode;
    const url = `http://localhost:${server.port}/mcp`;

    // Claude Desktop speaks stdio, so mcp-remote bridges to the gateway's HTTP endpoint.
    const desktopEntry: Record<string, unknown> = { command: "npx", args: ["-y", "mcp-remote@0.16.5", url] };
    // Claude Code speaks HTTP (and MCP OAuth) natively.
    const codeEntry: Record<string, unknown> = { type: "http", url };
    const cliName = /^[\w.-]+$/.test(server.name) ? server.name : `"${server.name.replace(/"/g, '\\"')}"`;
    let claudeCode = `claude mcp add --transport http ${cliName} ${url}`;
    const notes: string[] = [];

    if (identity === "per-user") {
      desktopEntry["args"] = [...(desktopEntry["args"] as string[]), "--header", "Authorization:${SN_BASIC_AUTH}"];
      desktopEntry["env"] = { SN_BASIC_AUTH: "Basic <base64 of username:password>" };
      codeEntry["headers"] = { Authorization: "Basic <base64 of username:password>" };
      claudeCode += ` --header "Authorization: Basic <base64 of username:password>"`;
      notes.push("Replace <base64 of username:password> with your own ServiceNow login, base64-encoded (e.g. echo -n 'user:pass' | base64). PDI demos only.");
    } else if (identity === "oauth") {
      const creds = oauth.listCredentials();
      notes.push("No password in the config: the browser opens for ServiceNow sign-in the first time the client connects.");
      notes.push(`ServiceNow's OAuth app must allow the redirect URL ${oauth.redirectUrl()}.`);
      if (!creds.length) notes.push("No OAuth credential is saved yet: add one under OAuth sign-in, or users enter instance URL and client ID on the sign-in page.");
    } else {
      notes.push("Uses the gateway's service account from .env; no sign-in needed.");
    }

    const snippet = { mcpServers: { [server.name]: desktopEntry } };
    const codeJson = { mcpServers: { [server.name]: codeEntry } };
    res.json({
      identity,
      saved: (server.identity ?? "service") === identity,
      snippet,
      json: JSON.stringify(snippet, null, 2),
      claudeCode,
      claudeCodeJson: JSON.stringify(codeJson, null, 2),
      notes,
    });
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

// ── App Kit helpers ───────────────────────────────────────────────────────────

interface Draft {
  name?: string;
  slug?: string;
  description?: string;
  source?: "spec" | "html";
  spec?: AppSpec;
  html?: string;
  launcher?: boolean; // add an open_<slug> tool (default true)
  openWith?: string; // instead: link this existing tool to the app
  references?: UIAppReference[];
  permissions?: UIAppPermission[];
}

const PERMISSIONS = new Set(["camera", "microphone", "geolocation", "clipboardWrite"]);
const ORIGIN = /^(https|wss):\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i;

// Checks declared references and permissions; returns an error message or null.
function checkDeclarations(draft: Draft): string | null {
  for (const r of draft.references ?? []) {
    if (r.type !== "resource" && r.type !== "connection") return `Reference type must be resource or connection`;
    const url = String(r.url ?? "").replace(/\/+$/, "");
    if (!ORIGIN.test(url)) return `Reference "${r.url}" must be an https origin like https://esm.sh`;
  }
  for (const p of draft.permissions ?? []) if (!PERMISSIONS.has(p)) return `Unknown permission ${p}`;
  return null;
}

// CSP = declared references, plus any external origin validation found in the page (so a
// forgotten declaration doesn't silently break the app; the builder shows both).
function applyDeclarations(app: UIApp, draft: Draft, report: ValidationReport): void {
  const refs: UIAppReference[] = (draft.references ?? []).map((r) => ({
    type: r.type,
    url: String(r.url).replace(/\/+$/, ""),
    ...(r.name ? { name: String(r.name) } : {}),
  }));
  const has = (type: string, url: string) => refs.some((r) => r.type === type && r.url === url);
  for (const url of report.csp?.resourceDomains ?? []) if (!has("resource", url)) refs.push({ type: "resource", url, name: "detected" });
  for (const url of report.csp?.connectDomains ?? []) if (!has("connection", url)) refs.push({ type: "connection", url, name: "detected" });
  if (refs.length) {
    app.references = refs;
    app.csp = {
      resourceDomains: [...new Set(refs.filter((r) => r.type === "resource").map((r) => r.url))],
      connectDomains: [...new Set(refs.filter((r) => r.type === "connection").map((r) => r.url))],
    };
  } else {
    delete app.references;
    delete app.csp;
  }
  if (draft.permissions?.length) app.permissions = [...new Set(draft.permissions)];
  else delete app.permissions;
}

function validateDraft(server: MCPServer, draft: Draft): ValidationReport {
  if (draft.source === "spec") return validateSpec(draft.spec, server);
  if (draft.source === "html") return validateHtml(draft.html, server);
  return { ok: false, errors: ["source must be spec or html"], warnings: [], tools: [] };
}

function isKitApp(a: UIApp): boolean {
  return a.source === "spec" || a.source === "html" || !!a.spec || !!a.file;
}

function slugOf(a: UIApp): string {
  return a.uri.split("/").pop() ?? a.uri;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
}

function uniqueSlug(server: MCPServer, base: string): string {
  const taken = new Set((server.apps ?? []).map(slugOf));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

async function saveHtml(server: MCPServer, slug: string, html: string): Promise<string> {
  const file = `${server.id}/${slug}.html`;
  const path = join(storage.APPS_DATA_DIR, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html);
  return file;
}

// open_<slug>: the tool the model calls to show the app. A form's fields become optional
// arguments, so the model can prefill what it already knows.
function launcherTool(server: MCPServer, app: UIApp, draft: Draft): Omit<Tool, "id"> {
  let toolName = `open_${slugOf(app).replace(/-/g, "_")}`;
  for (let i = 2; server.tools.some((t) => t.name === toolName); i++) toolName = `open_${slugOf(app).replace(/-/g, "_")}_${i}`;
  const params: Parameter[] =
    draft.spec?.type === "form"
      ? draft.spec.fields.map((f) => ({
          name: f.name,
          description: f.label ?? f.name,
          type: f.type === "number" ? "number" : f.type === "checkbox" ? "boolean" : "string",
          required: false,
          in: "body",
        }))
      : [];
  const what = draft.spec?.type === "form" ? "form" : draft.spec?.type === "approval" ? "approval cards" : draft.spec?.type === "view" ? "view" : "app";
  return {
    name: toolName,
    description:
      `Open the "${app.name}" ${what} for the user.` +
      (app.description ? ` ${app.description}` : "") +
      (params.length ? " Prefill any fields you can infer from the conversation; all are optional, and the user reviews and submits." : ""),
    method: "POST",
    endpoint: "",
    apiType: "scripted",
    parameters: params,
    kind: "handler",
    handler: "app.open",
    ui: { resourceUri: app.uri, visibility: ["model", "app"] },
  };
}
