import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

// Isolated store, set before the gateway modules load.
const dir = mkdtempSync(join(tmpdir(), "gw-kit-"));
process.env["STORE_FILE"] = join(dir, "store.json");
process.env["AUDIT_LOG"] = join(dir, "audit.log");

const P = (name: string, required = false, inn = "body") => ({ name, description: name, type: "string", required, in: inn });
const server = {
  id: "s1",
  name: "Incident Ops",
  description: "",
  port: 47860,
  tools: [
    { id: "t1", name: "list_incidents", description: "List incidents", method: "GET", endpoint: "/api/now/table/incident", apiType: "table", parameters: [P("sysparm_query", false, "query")] },
    { id: "t2", name: "create_incident", description: "Create", method: "POST", endpoint: "/api/now/table/incident", apiType: "table", parameters: [P("short_description", true), P("urgency")] },
    { id: "t3", name: "update_incident", description: "Update", method: "PATCH", endpoint: "/api/now/table/incident/{sys_id}", apiType: "table", parameters: [P("sys_id", true, "path"), P("state")] },
    { id: "t4", name: "secret_write", description: "Model only", method: "POST", endpoint: "/api/now/table/x", apiType: "table", parameters: [], ui: { visibility: ["model"] } },
  ],
};
writeFileSync(process.env["STORE_FILE"], JSON.stringify({ instance: null, servers: [server] }));

const { validateSpec, validateHtml, buildPrompt, templates } = await import("../src/app-spec.js");
const { injectKit, renderSpecPage, htmlFormat, rewriteSdkImports, prepareStandard } = await import("../src/apps.js");
const { fill, rowsOf, textOf, countBy } = await import("../apps/_kit/data.js");

const form = {
  type: "form",
  title: "Report an incident",
  fields: [{ name: "short_description", required: true }, { name: "urgency", type: "select", options: ["1", "2", "3"] }],
  submit: { tool: "create_incident" },
};

describe("validateSpec", () => {
  it("accepts a valid form and lists the tools it calls", () => {
    const r = validateSpec(form, server as any);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tools).toEqual([{ name: "create_incident", write: true, appVisible: true }]);
  });

  it("rejects unknown tools, model-only tools and missing required params", () => {
    const r = validateSpec({ ...form, fields: [{ name: "urgency" }], submit: { tool: "nope" } }, server as any);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/"nope" does not exist/);
    const r2 = validateSpec({ ...form, submit: { tool: "secret_write" } }, server as any);
    expect(r2.errors.join("\n")).toMatch(/model-only/);
    const r3 = validateSpec({ ...form, fields: [{ name: "urgency" }] }, server as any);
    expect(r3.errors.join("\n")).toMatch(/requires "short_description"/);
  });

  it("checks field shapes", () => {
    const r = validateSpec({ ...form, fields: [{ name: "a b" }, { name: "x", type: "select" }, { name: "x", type: "colour" }] }, server as any);
    expect(r.errors.join("\n")).toMatch(/identifier/);
    expect(r.errors.join("\n")).toMatch(/select needs "options"/);
    expect(r.errors.join("\n")).toMatch(/duplicate field "x"/);
    expect(r.errors.join("\n")).toMatch(/unknown type "colour"/);
  });

  it("warns on unconfirmed writes and rejects write tools as data sources", () => {
    const r = validateSpec({ ...form, submit: { tool: "create_incident", confirm: false } }, server as any);
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/no confirmation/);
    const v = validateSpec({ type: "view", title: "x", display: "bar", source: { tool: "create_incident" } }, server as any);
    expect(v.errors.join("\n")).toMatch(/groupBy/);
    expect(v.errors.join("\n")).toMatch(/must be a read tool/);
  });

  it("warns about arguments a REST tool would drop", () => {
    const r = validateSpec({ type: "view", title: "x", display: "table", source: { tool: "list_incidents", args: { sysparm_query: "active=true", colour: "red" } } }, server as any);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([`source: "colour" is not a parameter of "list_incidents", so it is not sent`]);
    const f = validateSpec({ ...form, fields: [...form.fields, { name: "ci", type: "lookup", lookup: { tool: "list_incidents" } }] }, server as any);
    expect(f.warnings.join("\n")).toMatch(/"text" is not a parameter of "list_incidents"/);
    const g = validateSpec({ ...form, fields: [{ name: "short_description", required: true }, { name: "ci", type: "lookup", lookup: { tool: "list_incidents", args: { sysparm_query: "nameLIKE{{text}}" } } }] }, server as any);
    expect(g.warnings.join("\n")).not.toMatch(/lookup/);
  });

  it("validates approval cards", () => {
    const ok = validateSpec(
      {
        type: "approval", title: "Approve", source: { tool: "list_incidents" }, titleField: "number",
        actions: [{ label: "Reject", tool: "update_incident", args: { sys_id: "{{sys_id}}", state: "7" }, comment: "required" }],
      },
      server as any
    );
    expect(ok.errors).toEqual([]);
    const bad = validateSpec({ type: "approval", title: "Approve", actions: [{ label: "Reject", tool: "update_incident" }] }, server as any);
    expect(bad.errors.join("\n")).toMatch(/titleField/);
    expect(bad.errors.join("\n")).toMatch(/"args" is required/);
    expect(bad.warnings.join("\n")).toMatch(/no "source"/);
    expect(bad.warnings.join("\n")).toMatch(/comment": "required/);
  });

  it("starter templates for incidents validate against an incident server", () => {
    expect(validateSpec(templates().form, server as any).ok).toBe(true);
    expect(validateSpec(templates().view, server as any).ok).toBe(true);
  });
});

describe("validateHtml", () => {
  it("accepts a self-contained page and checks gw.call tools", () => {
    const r = validateHtml(`<html><body><script>gw.call("list_incidents", {})</script></body></html>`, server as any);
    expect(r.ok).toBe(true);
    expect(r.tools.map((t) => t.name)).toEqual(["list_incidents"]);
    const r2 = validateHtml(`<body><script>gw.call('missing_tool')</script></body>`, server as any);
    expect(r2.errors.join("\n")).toMatch(/"missing_tool" does not exist/);
  });

  it("allows external scripts and styles through the app's CSP, but never ServiceNow URLs", () => {
    const r = validateHtml(
      `<html><head><script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="https://fonts.example.com/a.css"></head>
       <body><script>fetch("https://dev1.service-now.com/api/now/table/incident"); gw.call("list_incidents")</script></body></html>`,
      server as any
    );
    expect(r.errors.join("\n")).toMatch(/ServiceNow URLs directly/);
    expect(r.csp!.resourceDomains.sort()).toEqual(["https://cdn.example.com", "https://fonts.example.com"]);
    expect(r.csp!.connectDomains).toEqual(["https://dev1.service-now.com"]);
    const rel = validateHtml(`<body><script src="./app.js"></script><script>gw.call("list_incidents")</script></body>`, server as any);
    expect(rel.errors.join("\n")).toMatch(/relative file/);
  });
});

describe("standard (official SDK) HTML apps", () => {
  const STD = `<!doctype html><html><head><title>x</title></head><body><div id="app"></div>
<script type="module">
  import { App, applyDocumentTheme as theme } from 'https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps';
  const app = new App({ name: 'x', version: '1' });
  app.ontoolresult = (r) => { document.getElementById('app').textContent = JSON.stringify(r.structuredContent) };
  document.body.onclick = () => app.callServerTool({ name: 'create_incident', arguments: {} });
  app.connect();
</script></body></html>`;

  it("detects the format and checks callServerTool names", () => {
    expect(htmlFormat(STD)).toBe("standard");
    expect(htmlFormat(`<script>gw.call("x")</script>`)).toBe("kit");
    const r = validateHtml(STD, server as any);
    expect(r).toMatchObject({ ok: true, format: "standard", showsResult: true, csp: { resourceDomains: [], connectDomains: [] } });
    expect(r.tools.map((t) => t.name)).toEqual(["create_incident"]);
    const bad = validateHtml(STD.replace("create_incident", "nope"), server as any);
    expect(bad.errors.join("\n")).toMatch(/"nope" does not exist/);
    const react = validateHtml(STD.replace("/app-with-deps", "/react"), server as any);
    expect(react.errors.join("\n")).toMatch(/not supported/);
  });

  it("serves the file as written, with only the SDK import pointed at the bundled copy", () => {
    const { html, rewritten } = rewriteSdkImports(STD);
    expect(rewritten).toBe(1);
    expect(html).toContain("const { App, applyDocumentTheme: theme } = window.McpExtApps;");
    expect(html.replace("const { App, applyDocumentTheme: theme } = window.McpExtApps;", "")).toBe(
      STD.replace("import { App, applyDocumentTheme as theme } from 'https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps';", "")
    );
    const page = prepareStandard(STD, "window.McpExtApps={App:function(){}}");
    expect(page.indexOf("window.McpExtApps={")).toBeLessThan(page.indexOf("new App("));
    expect(page).not.toContain("esm.sh");
    expect(page).not.toContain("window.gw");
    expect(rewriteSdkImports(`import * as M from "@modelcontextprotocol/ext-apps"\nimport x from "./y";`).html).toBe(`const M = window.McpExtApps;\nimport x from "./y";`);
  });

  it("starter HTML is the standard format and validates", () => {
    const r = validateHtml(templates().html, server as any);
    expect(r.ok && r.format).toBe("standard");
  });
});

describe("rendering", () => {
  it("injects the kit before the page's scripts and escapes closing tags", () => {
    const out = injectKit(`<html><head><title>x</title></head><body><script>use(gw)</script></body></html>`, `var s="</script>";window.gw={}`);
    expect(out.indexOf("window.gw")).toBeLessThan(out.indexOf("use(gw)"));
    expect(out).toContain(`"<\\/script>"`);
    expect(injectKit("<p>hi</p>", "k()")).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><script>k\(\)<\/script><\/head><body><p>hi<\/p>/);
  });

  it("embeds the spec as JSON that cannot break out of its script tag", () => {
    const page = renderSpecPage({ uri: "ui://x/y", name: "Y", spec: { ...form, title: "</script><b>" } as any }, "kit()");
    expect(page).not.toContain("</script><b>");
    const json = page.match(/<script type="application\/json" id="app-spec">(.*?)<\/script>/s)![1]!;
    expect(JSON.parse(json).title).toBe("</script><b>");
  });

  it("builds a prompt that lists the server's tools", () => {
    const p = buildPrompt(server as any, "approval", "approve P1s");
    expect(p).toContain("approve P1s");
    expect(p).toContain("- list_incidents [read; visible to model+app]");
    expect(p).toContain("- create_incident [write");
    expect(p).toMatch(/Reply with only the JSON spec \(type "approval"\)/);
  });
});

describe("kit data helpers", () => {
  it("fills templates, keeping types and dropping empty values", () => {
    expect(fill({ sys_id: "{{sys_id}}", n: "{{count}}", note: "by {{user.name}}", gone: "{{missing}}" }, { sys_id: { value: "abc", display_value: "ABC" }, count: 3, user: { name: "Ann" } }))
      .toEqual({ sys_id: "abc", n: 3, note: "by Ann" });
  });
  it("finds rows in Table API results and shows display values", () => {
    const rows = rowsOf({ result: [{ priority: { value: "1", display_value: "1 - Critical" } }, { priority: "2" }] });
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0]!["priority"])).toBe("1 - Critical");
    expect(countBy([...rows, { priority: "2" }], "priority")).toEqual([["2", 2], ["1 - Critical", 1]]);
    expect(rowsOf({ data: { items: [{ a: 1 }] } })).toEqual([{ a: 1 }]);
    expect(rowsOf({ a: 1 })).toEqual([{ a: 1 }]);
  });
});

// ── management API: create → served as a ui:// resource with a launcher tool ──

let http: Server;
let base = "";
let manager: any;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { buildRouter } = await import("../src/routes.js");
  const { MCPManager } = await import("../src/mcp-manager.js");
  manager = new MCPManager({ instanceUrl: "", username: "admin", password: "admin" });
  const app = express();
  app.use(express.json({ limit: "3mb" }));
  app.use("/api", buildRouter(manager, () => manager.getCreds()));
  http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
});
afterAll(async () => {
  await manager.stopAll();
  http.close();
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
};

describe("app routes", () => {
  it("refuses to save an app with errors", async () => {
    const r = await call("POST", "/servers/s1/apps", { name: "Bad", source: "spec", spec: { ...form, submit: { tool: "nope" } } });
    expect(r.status).toBe(400);
    expect(r.body.report.errors[0]).toMatch(/nope/);
  });

  it("creates a spec app with a launcher whose params are the form fields", async () => {
    const r = await call("POST", "/servers/s1/apps", { name: "Report an incident", description: "Raise one", source: "spec", spec: form });
    expect(r.status).toBe(201);
    expect(r.body.app.uri).toBe("ui://incident-ops/report-an-incident");
    expect(r.body.launcher).toMatchObject({ name: "open_report_an_incident", handler: "app.open", ui: { resourceUri: "ui://incident-ops/report-an-incident", visibility: ["model", "app"] } });
    expect(r.body.launcher.parameters.map((p: any) => [p.name, p.required])).toEqual([["short_description", false], ["urgency", false]]);
    const list = await call("GET", "/servers/s1/apps");
    expect(list.body.appsEnabled).toBe(true);
    expect(list.body.apps[0]).toMatchObject({ slug: "report-an-incident", editable: true, tools: ["open_report_an_incident"] });
  });

  it("stores an uploaded HTML file, edits it and deletes it with its launcher", async () => {
    const html = `<html><body><h1>Board</h1><script>gw.call("list_incidents",{})</script></body></html>`;
    const r = await call("POST", "/servers/s1/apps", { name: "Board", source: "html", html });
    expect(r.status).toBe(201);
    const { APPS_DATA_DIR } = await import("../src/storage.js");
    const file = join(APPS_DATA_DIR, r.body.app.file);
    expect(existsSync(file)).toBe(true);
    const src = await call("GET", "/servers/s1/apps/board/source");
    expect(src.body).toEqual({ source: "html", html, references: [], permissions: [] });
    const upd = await call("PUT", "/servers/s1/apps/board", { html: html.replace("Board", "Board v2") });
    expect(upd.status).toBe(200);
    expect((await call("GET", "/servers/s1/apps/board/source")).body.html).toContain("Board v2");
    const del = await call("DELETE", "/servers/s1/apps/board");
    expect(del.body).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
    const tools = (await call("GET", "/servers/s1/tools")).body.map((t: any) => t.name);
    expect(tools).not.toContain("open_board");
  });

  it("links an existing tool as the opener and stores the page's CSP", async () => {
    const html = `<html><body><img src="https://img.example.com/logo.png"><script type="module">
      import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps";
      const app = new App({ name: "l", version: "1" }); app.ontoolresult = () => {}; app.connect();</script></body></html>`;
    const r = await call("POST", "/servers/s1/apps", { name: "Incident list", source: "html", html, openWith: "list_incidents" });
    expect(r.status).toBe(201);
    expect(r.body.launcher).toMatchObject({ name: "list_incidents", ui: { resourceUri: "ui://incident-ops/incident-list" } });
    expect(r.body.app.csp).toEqual({ resourceDomains: ["https://img.example.com"], connectDomains: [] });
    expect(r.body.app.references).toEqual([{ type: "resource", url: "https://img.example.com", name: "detected" }]);
    const tools = (await call("GET", "/servers/s1/tools")).body.map((t: any) => t.name);
    expect(tools).not.toContain("open_incident_list");
    await call("DELETE", "/servers/s1/apps/incident-list");
    const after = (await call("GET", "/servers/s1/tools")).body.find((t: any) => t.name === "list_incidents");
    expect(after.ui?.resourceUri).toBeUndefined();
  });

  it("stores declared references and permissions like ServiceNow's console, and serves them as _meta.ui", async () => {
    const html = `<html><body><script type="module">
      import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps";
      const app = new App({ name: "t", version: "1" }); app.ontoolresult = () => {}; app.connect();</script></body></html>`;
    const bad = await call("POST", "/servers/s1/apps", { name: "T", source: "html", html, references: [{ type: "resource", url: "esm.sh" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/https origin/);
    const r = await call("POST", "/servers/s1/apps", {
      name: "Incident table", source: "html", html, openWith: "list_incidents",
      references: [{ type: "resource", url: "https://esm.sh/", name: "MCP Apps SDK" }, { type: "connection", url: "https://api.example.com" }],
      permissions: ["clipboardWrite"],
    });
    expect(r.status).toBe(201);
    expect(r.body.app.references).toEqual([{ type: "resource", url: "https://esm.sh", name: "MCP Apps SDK" }, { type: "connection", url: "https://api.example.com" }]);
    expect(r.body.app.csp).toEqual({ resourceDomains: ["https://esm.sh"], connectDomains: ["https://api.example.com"] });
    const { appMeta } = await import("../src/apps.js");
    expect(appMeta(r.body.app)).toEqual({
      ui: { csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://esm.sh"] }, prefersBorder: true, permissions: { clipboardWrite: {} } },
    });
    const src = await call("GET", "/servers/s1/apps/incident-table/source");
    expect(src.body.permissions).toEqual(["clipboardWrite"]);
    // Editing the HTML keeps the declarations.
    await call("PUT", "/servers/s1/apps/incident-table", { html: html.replace('"t"', '"t2"') });
    expect((await call("GET", "/servers/s1/apps")).body.apps.find((a: any) => a.slug === "incident-table").permissions).toEqual(["clipboardWrite"]);
    await call("DELETE", "/servers/s1/apps/incident-table");
  });

  it("preview calls dry-run writes", async () => {
    const r = await call("POST", "/servers/s1/apps/preview-call", { name: "create_incident", arguments: { short_description: "x" } });
    expect(r.body.structuredContent).toMatchObject({ preview: true, tool: "create_incident" });
    const m = await call("POST", "/servers/s1/apps/preview-call", { name: "secret_write", arguments: {} });
    expect(m.body.isError).toBe(true);
  });
});
