// Browser smoke test for the app bundles: a minimal MCP Apps host (iframe + postMessage
// JSON-RPC) driven by Playwright, talking to a real gateway instance backed by FakeSN.
// Run: npx tsx test/e2e-host.ts [screenshotDir]   (needs Playwright + Chromium installed)
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { FakeSN } from "./fake-sn.js";
import { hoursFromNow } from "./helpers.js";
import { toSNDateTime } from "../src/handlers/util.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const shots = process.argv[2];

const dir = mkdtempSync(join(tmpdir(), "gw-e2e-"));
process.env["STORE_FILE"] = join(dir, "store.json");
process.env["AUDIT_LOG"] = join(dir, "audit.log");
const real = JSON.parse(readFileSync("data/store.seed.json", "utf8"));
const changeOps = real.servers.find((s: any) => s.name === "change-ops");
const PORTS = { service: 47901, user: 47902, kit: 47903 };
// No-code App Kit apps on a plain Table API server.
const Q = (name: string, required = false, inn = "query") => ({ name, description: name, type: "string", required, in: inn });
const launcher = (name: string, uri: string, params: any[] = []) => ({ id: name, name, description: name, method: "POST", endpoint: "", apiType: "scripted", parameters: params, kind: "handler", handler: "app.open", ui: { resourceUri: uri, visibility: ["model", "app"] } });
const kitServer = {
  id: "kit", name: "incident-kit", description: "", port: PORTS.kit, appsEnabled: true,
  apps: [
    { uri: "ui://incident-kit/report", name: "Report an incident", source: "spec", spec: {
      type: "form", title: "Report an incident",
      fields: [
        { name: "short_description", label: "Short description", required: true },
        { name: "urgency", type: "select", options: [{ value: "1", label: "High" }, { value: "3", label: "Low" }], default: "3" },
        { name: "cmdb_ci", label: "Configuration item", type: "lookup", lookup: { tool: "list_cis", args: { sysparm_query: "nameLIKE{{text}}" } } },
      ],
      submit: { tool: "create_incident", label: "Create incident" },
      result: { title: "Created {{result.number}}", fields: [{ field: "result.urgency", label: "Urgency" }] } } },
    // A standard MCP App (official SDK, CDN import), opened by list_incidents.
    { uri: "ui://incident-kit/std-list", name: "Incident list", source: "html", file: "kit/std-list.html" },
    { uri: "ui://incident-kit/board", name: "Board", source: "spec", spec: {
      type: "view", title: "Open incidents by priority", display: "bar", groupBy: "priority",
      source: { tool: "list_incidents", args: { sysparm_query: "active=true", sysparm_display_value: "true" } } } },
    { uri: "ui://incident-kit/approve", name: "Resolve queue", source: "spec", spec: {
      type: "approval", title: "Waiting for sign-off", titleField: "number", subtitleField: "short_description",
      source: { tool: "list_incidents", args: { sysparm_query: "state=6" } },
      actions: [
        { label: "Close", style: "primary", tool: "update_incident", args: { sys_id: "{{sys_id}}", state: "7", work_notes: "{{comment}}" }, comment: "optional" },
        { label: "Reopen", style: "danger", tool: "update_incident", args: { sys_id: "{{sys_id}}", state: "2", work_notes: "{{comment}}" }, comment: "required" },
      ] } },
  ],
  tools: [
    { id: "k1", name: "list_incidents", ui: { resourceUri: "ui://incident-kit/std-list" }, description: "", method: "GET", endpoint: "/api/now/table/incident", apiType: "table", parameters: [Q("sysparm_query"), Q("sysparm_display_value")] },
    { id: "k2", name: "list_cis", description: "", method: "GET", endpoint: "/api/now/table/cmdb_ci", apiType: "table", parameters: [Q("sysparm_query")] },
    { id: "k3", name: "create_incident", description: "", method: "POST", endpoint: "/api/now/table/incident", apiType: "table", parameters: [Q("short_description", true, "body"), Q("urgency", false, "body"), Q("cmdb_ci", false, "body")] },
    { id: "k4", name: "update_incident", description: "", method: "PATCH", endpoint: "/api/now/table/incident/{sys_id}", apiType: "table", parameters: [Q("sys_id", true, "path"), Q("state", false, "body"), Q("work_notes", false, "body")] },
    launcher("open_report", "ui://incident-kit/report", [Q("short_description", false, "body")]),
    launcher("open_board", "ui://incident-kit/board"),
    launcher("open_queue", "ui://incident-kit/approve"),
  ],
};
writeFileSync(
  process.env["STORE_FILE"],
  JSON.stringify({
    instance: null,
    servers: [
      { ...changeOps, id: "co", port: PORTS.service },
      { ...changeOps, id: "co-user", name: "change-ops-user", port: PORTS.user, identity: "per-user" },
      kitServer,
    ],
  })
);

// Uploaded HTML lives next to the store.
const { mkdirSync } = await import("fs");
mkdirSync(join(dir, "apps", "kit"), { recursive: true });
writeFileSync(join(dir, "apps", "kit", "std-list.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Incident list</title></head><body>
<div id="app">Loading…</div><button id="refresh">Refresh</button>
<script type="module">
  import { App } from 'https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps';
  const app = new App({ name: 'Incident list', version: '1.0.0' });
  const show = (data) => {
    const rows = Array.isArray(data?.result) ? data.result : [];
    document.getElementById('app').innerHTML = rows.map((r) => '<div class="row">' + r.number + '</div>').join('');
  };
  app.ontoolresult = (result) => show(result.structuredContent);
  document.getElementById('refresh').onclick = async () => {
    const res = await app.callServerTool({ name: 'list_incidents', arguments: { sysparm_query: 'priority=1' } });
    show(res.structuredContent);
    await app.updateModelContext({ content: [{ type: 'text', text: 'refreshed P1s' }] });
  };
  app.connect();
</script></body></html>`);

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { MCPManager } = await import("../src/mcp-manager.js");

const sn = new FakeSN();
await sn.start();
sn.users["alice"] = "pw-a";
const alice = sn.insert("sys_user", { user_name: "alice", name: "Alice Approver" });
sn.insert("cmdb_ci", { name: "db-prod-01", install_status: "1", sys_class_name: "cmdb_ci_db_instance" });
sn.insert("sys_user_group", { name: "Database", active: "true" });
for (const [element, value, label] of [["risk", "3", "Moderate"], ["risk", "4", "Low"], ["impact", "2", "Medium"], ["category", "software", "Software"]]) {
  sn.insert("sys_choice", { name: "change_request", element, value, label, inactive: "false", language: "en" });
}
const at = (h: number) => toSNDateTime(new Date(hoursFromNow(h)));
const chg = sn.insert("change_request", {
  number: "CHG0040012", short_description: "Upgrade firewall firmware", type: "normal", type__display: "Normal",
  risk: "3", risk__display: "Moderate", state: "authorize", state__display: "Authorize", start_date: at(30), end_date: at(32),
  description: "Upgrade to 9.1.4", implementation_plan: "1. Failover\n2. Upgrade\n3. Failback", backout_plan: "Reinstall 9.1.3",
  test_plan: "Ping + VPN", cmdb_ci__display: "fw-edge-01",
});
const ap = sn.insert("sysapproval_approver", { approver: alice.sys_id, sysapproval: chg.sys_id, state: "requested", source_table: "change_request" });

const manager = new MCPManager({ instanceUrl: sn.url, username: "admin", password: "admin" });
await manager.start({ ...changeOps, id: "co", port: PORTS.service });
await manager.start({ ...changeOps, id: "co-user", name: "change-ops-user", port: PORTS.user, identity: "per-user" });
await manager.start(kitServer as any);
for (const [p, d] of [["1", "1 - Critical"], ["2", "2 - High"], ["2", "2 - High"], ["4", "4 - Low"]]) {
  sn.insert("incident", { number: `INC00${sn.tables["incident"]?.length ?? 0}`, priority: p, priority__display: d, active: "true", state: "2" });
}
const resolved = sn.insert("incident", { number: "INC0099", short_description: "Mail queue stuck", priority: "3", active: "true", state: "6" });

async function mcp(port: number, headers?: Record<string, string>) {
  const c = new Client({ name: "e2e-host", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } as any });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
  return c;
}

const HOST = `<!doctype html><body style="margin:0"><iframe id="f" style="width:100%;height:100vh;border:0"></iframe><script>
const f = document.getElementById('f');
window.modelContext = [];
window.addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') return reply({ protocolVersion: m.params.protocolVersion, hostInfo: { name: 'e2e', version: '1' },
    hostCapabilities: { serverTools: {}, updateModelContext: { text: {} }, openLinks: {} }, hostContext: { theme: window.__theme || 'light' } });
  if (m.method === 'ui/notifications/initialized') return window.__initialized();
  if (m.method === 'tools/call') return reply(JSON.parse(await window.mcpCall(JSON.stringify(m.params))));
  if (m.method === 'ui/update-model-context') { window.modelContext.push(m.params); return reply({}); }
  if (m.method === 'ui/open-link') return reply({});
  if (m.id !== undefined) reply({});
});
window.load = (html) => new Promise((r) => { window.__initialized = r; f.srcdoc = html; });
window.notify = (method, params) => f.contentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*');
</script></body>`;

const browser = await chromium.launch();
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

async function openApp(client: any, uri: string, tool: string, args: Record<string, unknown>, theme = "light") {
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  page.on("pageerror", (e: Error) => console.log("pageerror:", e.message));
  page.on("console", (m: any) => console.log("console:", m.text()));
  page.setDefaultTimeout(8000);
  await page.exposeFunction("mcpCall", async (p: string) => JSON.stringify(await client.callTool(JSON.parse(p))));
  // Apps must not need a CDN: block esm.sh so a standard app only works if the gateway bundles the SDK.
  await page.route(/esm\.sh/, (route: any) => route.abort());
  await page.setContent(HOST);
  await page.evaluate((t: string) => ((window as any).__theme = t), theme);
  const res = await client.readResource({ uri });
  await page.evaluate((html: string) => (window as any).load(html), (res.contents[0] as any).text);
  const result = await client.callTool({ name: tool, arguments: args });
  await page.evaluate(([a, r]: any) => {
    (window as any).notify("ui/notifications/tool-input", { arguments: a });
    (window as any).notify("ui/notifications/tool-result", r);
  }, [args, result]);
  return { page, frame: page.frameLocator("#f") };
}

try {
  // ── change creation ──
  const svc = await mcp(PORTS.service);
  const { page, frame } = await openApp(svc, "ui://change-ops/change-create", "open_change_form", {
    type: "normal", short_description: "Patch db-prod-01", ci_name: "db-prod-01", group_name: "Database",
    start_date: hoursFromNow(72), end_date: hoursFromNow(74),
  });
  await frame.locator("#f_short_description").waitFor();
  await page.waitForTimeout(500);
  check((await frame.locator("#f_short_description").inputValue()) === "Patch db-prod-01", "prefill short description");
  check((await frame.locator("#f_cmdb_ci").inputValue()) === "db-prod-01", "CI resolved from name");
  check((await frame.locator("#f_risk option").count()) === 3, "risk choices loaded from instance");

  await frame.locator("button[type=submit]").click();
  await frame.locator(".field.invalid").first().waitFor();
  check((await frame.locator(".field.invalid").count()) >= 5, "missing plans highlighted before submit");
  if (shots) await page.screenshot({ path: join(shots, "change-create-errors.png") });

  for (const [f, v] of [["description", "Monthly OS patching"], ["justification", "CVE fixes"], ["implementation_plan", "1. Drain\n2. Patch\n3. Reboot"],
    ["risk_impact_analysis", "Low; replica takes reads"], ["backout_plan", "Restore snapshot"], ["test_plan", "Health checks"]]) {
    await frame.locator(`#f_${f}`).fill(v!);
  }
  await frame.locator("#f_risk").selectOption("4");
  await frame.locator("button[type=submit]").click();
  await frame.locator(".shell-dialog").waitFor();
  if (shots) await page.screenshot({ path: join(shots, "change-create-confirm.png") });
  // Double-click the confirm button: must create exactly one change.
  await frame.locator(".shell-dialog button.primary").dblclick();
  await frame.locator(".card h1").waitFor();
  check((sn.tables["change_request"] ?? []).filter((c) => c["short_description"] === "Patch db-prod-01").length === 1, "one change created");
  const created = sn.tables["change_request"]!.find((c) => c["short_description"] === "Patch db-prod-01")!;
  check(created["risk"] === "4" && created["cmdb_ci"] === sn.tables["cmdb_ci"]![0]!["sys_id"], "submitted values stored with sys_ids");
  const ctx = await page.evaluate(() => (window as any).modelContext);
  check(ctx.some((c: any) => c.content[0].text.includes(created["number"])), "number posted to model context");
  await frame.locator("button", { hasText: "Request approval" }).click();
  await frame.locator(".banner.ok").waitFor();
  check(created["state"] === "assess", "request approval moved change to assess");
  if (shots) await page.screenshot({ path: join(shots, "change-create-done.png") });
  await page.close();

  // ── approvals (per-user) ──
  const asAlice = await mcp(PORTS.user, { Authorization: "Basic " + Buffer.from("alice:pw-a").toString("base64") });
  const a = await openApp(asAlice, "ui://change-ops/change-approvals", "open_change_approvals", {}, "dark");
  await a.frame.locator(".item").first().waitFor();
  check((await a.frame.locator(".item").count()) === 1, "alice sees her approval");
  await a.frame.locator(".item").first().click();
  await a.frame.locator(".decide").waitFor();
  const ctx2 = await a.page.evaluate(() => (window as any).modelContext);
  check(ctx2.some((c: any) => c.content[0].text.includes("CHG0040012")), "selected change kept in model context");
  await a.frame.locator(".decide button.danger").click();
  check(await a.frame.locator(".decide .banner.error").isVisible(), "reject without comment blocked");
  await a.frame.locator(".decide textarea").fill("Looks good, proceed in window");
  if (shots) await a.page.screenshot({ path: join(shots, "approvals-detail.png") });
  await a.frame.locator(".decide button.primary").click();
  await a.frame.locator(".shell-dialog button.primary").click();
  await a.frame.locator(".banner.ok").waitFor();
  check(sn.find("sysapproval_approver", ap.sys_id)!["state"] === "approved", "approval recorded");
  check(sn.find("sysapproval_approver", ap.sys_id)!["sys_updated_by"] === "alice", "recorded as alice");
  if (shots) await a.page.screenshot({ path: join(shots, "approvals-done.png") });
  await a.page.close();

  // ── service account: decisions disabled ──
  const s = await openApp(svc, "ui://change-ops/change-approvals", "open_change_approvals", {});
  await s.frame.locator(".banner.warn").waitFor();
  check(true, "service account shows decisions-disabled banner");
  await s.page.close();

  // ── App Kit: no-code form / view / approval cards ──
  const kit = await mcp(PORTS.kit);
  const listed = (await kit.listTools()).tools.map((t: any) => t.name);
  check(["open_report", "open_board", "open_queue"].every((n) => listed.includes(n)), "kit launchers listed");
  const f = await openApp(kit, "ui://incident-kit/report", "open_report", { short_description: "Printer on fire" });
  await f.frame.locator("#f_short_description").waitFor();
  check((await f.frame.locator("#f_short_description").inputValue()) === "Printer on fire", "kit form prefilled from tool input");
  check((await f.frame.locator("#f_urgency").inputValue()) === "3", "kit form default applied");
  await f.frame.locator("#f_urgency").selectOption("1");
  await f.frame.locator("#f_cmdb_ci").fill("db-prod");
  await f.frame.locator(".typeahead .menu div", { hasText: "db-prod-01" }).click();
  await f.frame.locator("button[type=submit]").click();
  await f.frame.locator(".shell-dialog").waitFor();
  if (shots) await f.page.screenshot({ path: join(shots, "kit-form-confirm.png") });
  await f.frame.locator(".shell-dialog button.primary").click();
  await f.frame.locator(".card h1").waitFor();
  const inc = sn.tables["incident"]!.find((r) => r["short_description"] === "Printer on fire");
  check(!!inc && inc["urgency"] === "1" && inc["cmdb_ci"] === sn.tables["cmdb_ci"]![0]!["sys_id"], "kit form created the incident with the CI sys_id");
  check((await f.frame.locator(".card h1").textContent())!.includes(inc?.["number"] ?? "??"), "kit form shows the result title");
  if (shots) await f.page.screenshot({ path: join(shots, "kit-form-done.png") });
  await f.page.close();

  // Standard SDK app: the gateway serves the SDK itself; the page never reaches esm.sh.
  const std = await openApp(kit, "ui://incident-kit/std-list", "list_incidents", { sysparm_query: "active=true" });
  await std.frame.locator(".row").first().waitFor();
  check((await std.frame.locator(".row").count()) === 5, "standard SDK app renders its opener's result");
  await std.frame.locator("#refresh").click();
  await std.page.waitForFunction(() => (window as any).modelContext.length > 0);
  check((await std.frame.locator(".row").count()) === 1, "standard SDK app calls tools with app.callServerTool");
  const lt = (await kit.listTools()).tools.find((t: any) => t.name === "list_incidents") as any;
  check(lt?._meta?.ui?.resourceUri === "ui://incident-kit/std-list", "existing data tool links to the standard app");
  await std.page.close();

  const v = await openApp(kit, "ui://incident-kit/board", "open_board", {});
  await v.frame.locator(".bar-row").first().waitFor();
  const labels = await v.frame.locator(".bar-label").allTextContents();
  check(labels[0] === "2 - High" && labels.length >= 3, "kit view counts by display value");
  if (shots) await v.page.screenshot({ path: join(shots, "kit-view.png") });
  await v.page.close();

  const q = await openApp(kit, "ui://incident-kit/approve", "open_queue", {}, "dark");
  await q.frame.locator(".appr").first().waitFor();
  check((await q.frame.locator(".appr").count()) === 1, "kit approval cards loaded from source");
  await q.frame.locator(".appr button.danger").click();
  check(await q.frame.locator(".appr .banner.error").isVisible(), "kit approval requires a comment to reopen");
  await q.frame.locator(".appr textarea").fill("Confirmed fixed with the user");
  await q.frame.locator(".appr button.primary").click();
  await q.frame.locator(".shell-dialog button.primary").click();
  await q.frame.locator(".appr .banner.ok").waitFor();
  check(sn.find("incident", resolved.sys_id)!["state"] === "7" && sn.find("incident", resolved.sys_id)!["work_notes"] === "Confirmed fixed with the user", "kit approval action sent templated args");
  if (shots) await q.page.screenshot({ path: join(shots, "kit-approval.png") });
  await q.page.close();
} finally {
  await browser.close();
  await manager.stopAll();
  await sn.stop();
}
console.log(failures ? `${failures} check(s) failed` : "all browser checks passed");
process.exit(failures ? 1 : 0);
