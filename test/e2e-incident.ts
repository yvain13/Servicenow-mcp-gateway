// Browser check for examples/incident-form.html, installed the way a user would: the gateway
// runs, scripts/add-incident-app.mjs adds the tools and the app over the management API, and a
// minimal MCP Apps host drives the form against FakeSN.
// Run: npx tsx test/e2e-incident.ts [screenshotDir]   (needs Playwright + Chromium installed)
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import { FakeSN } from "./fake-sn.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const shots = process.argv[2];

const sn = new FakeSN();
await sn.start();
const david = sn.insert("sys_user", { name: "David Miller", email: "david.miller@example.com", active: "true" });
sn.insert("sys_user", { name: "Beth Anglin", email: "beth.anglin@example.com", active: "true" });
const group = sn.insert("sys_user_group", { name: "Service Desk", active: "true" });
const svc = sn.insert("cmdb_ci_service", { name: "File Services" });
sn.insert("cmdb_ci_service", { name: "Email" });
const offering = sn.insert("service_offering", { name: "Shared folders", parent: svc.sys_id });
sn.insert("service_offering", { name: "Mailboxes", parent: "other" });
const ci = sn.insert("cmdb_ci", { name: "fs-share-01", sys_class_name: "cmdb_ci_server", install_status: "1" });
// The instance's own choices: incident overrides category; impact comes from task.
for (const [name, element, value, label, dep] of [
  ["incident", "category", "inquiry", "Inquiry / Help", ""], ["incident", "category", "network", "Network", ""],
  ["incident", "subcategory", "vpn", "VPN", "network"], ["incident", "subcategory", "antivirus", "Antivirus", "inquiry"],
  ["task", "category", "should-not-show", "Task category", ""],
  ["task", "impact", "1", "1 - High", ""], ["task", "impact", "2", "2 - Medium", ""], ["task", "impact", "3", "3 - Low", ""],
]) {
  sn.insert("sys_choice", { name, element, value, label, dependent_value: dep, inactive: "false", language: "en", sequence: "0" });
}

const dir = mkdtempSync(join(tmpdir(), "gw-inc-"));
const real = JSON.parse(readFileSync("data/store.json", "utf8"));
const MCP_PORT = 47911, MGMT_PORT = 47912;
const incidentServer = { ...real.servers.find((s: any) => s.name === "incident-mcp"), port: MCP_PORT };
writeFileSync(join(dir, "store.json"), JSON.stringify({ instance: null, servers: [incidentServer] }));
Object.assign(process.env, {
  STORE_FILE: join(dir, "store.json"), AUDIT_LOG: join(dir, "audit.log"), MANAGEMENT_PORT: String(MGMT_PORT),
  SN_INSTANCE_URL: sn.url, SN_USERNAME: "admin", SN_PASSWORD: "admin",
});
await import("../src/index.js");
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

// Async: the gateway runs in this process and must keep serving while the script talks to it.
const run = async () => (await promisify(execFile)("node", ["scripts/add-incident-app.mjs", "incident-mcp"], { env: { ...process.env, GATEWAY_URL: `http://127.0.0.1:${MGMT_PORT}` }, encoding: "utf8" })).stdout;
console.log((await run()).trim());
const out2 = await run(); // idempotent
check(!out2.includes("added"), "second run updates in place");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const client = new Client({ name: "e2e", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } as any });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)));
const tools = (await client.listTools()).tools as any[];
const names = tools.map((t) => t.name);
check(["create_incident", "open_incident_form", "search_users", "search_cis", "get_incident_choices"].every((n) => names.includes(n)), "tools listed");
check(Object.keys(tools.find((t) => t.name === "create_incident").inputSchema.properties).length === 14, "create_incident takes the form's fields");
const uri = tools.find((t) => t.name === "open_incident_form")._meta.ui.resourceUri;
check(uri === "ui://incident-mcp/incident-form", "launcher opens the app");

const HOST = `<!doctype html><body style="margin:0"><iframe id="f" style="width:100%;height:100vh;border:0"></iframe><script>
const f = document.getElementById('f');
window.modelContext = [];
window.addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') return reply({ protocolVersion: m.params.protocolVersion, hostInfo: { name: 'e2e', version: '1' },
    hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'light' } });
  if (m.method === 'ui/notifications/initialized') return window.__initialized();
  if (m.method === 'tools/call') return reply(JSON.parse(await window.mcpCall(JSON.stringify(m.params))));
  if (m.method === 'ui/update-model-context') { window.modelContext.push(m.params); return reply({}); }
  if (m.id !== undefined) reply({});
});
window.load = (html) => new Promise((r) => { window.__initialized = r; f.srcdoc = html; });
window.notify = (method, params) => f.contentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*');
</script></body>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
  page.on("pageerror", (e: Error) => { console.log("pageerror:", e.message); failures++; });
  page.setDefaultTimeout(8000);
  await page.exposeFunction("mcpCall", async (p: string) => JSON.stringify(await client.callTool(JSON.parse(p))));
  await page.route(/esm\.sh/, (route: any) => route.abort());
  await page.setContent(HOST);
  const res = await client.readResource({ uri });
  await page.evaluate((html: string) => (window as any).load(html), (res.contents[0] as any).text);
  const args = { short_description: "Unable to access the shared folder.", description: "Unable to access the shared folder. Please provide access.", caller: "David Miller", category: "inquiry", impact: "3", urgency: "2", service: "File Services" };
  const result = await client.callTool({ name: "open_incident_form", arguments: args });
  await page.evaluate(([a, r]: any) => {
    (window as any).notify("ui/notifications/tool-input", { arguments: a });
    (window as any).notify("ui/notifications/tool-result", r);
  }, [args, result]);
  const frame = page.frameLocator("#f");
  await frame.locator(".ref.picked #caller_id").waitFor();
  await frame.locator(".ref.picked #business_service").waitFor();
  check((await frame.locator("#short_description").inputValue()) === args.short_description, "prefilled short description");
  check((await frame.locator("#priority").inputValue()) === "4 - Low", "priority from impact 3 / urgency 2");
  const cats = await frame.locator("#category option").allTextContents();
  check(cats.includes("Network") && !cats.includes("Task category"), "instance choices, incident over task");
  check((await frame.locator("#impact option").count()) === 3, "impact choices inherited from task");

  await frame.locator("#category").selectOption("network");
  check((await frame.locator("#subcategory option").allTextContents()).join() === "-- None --,VPN", "subcategory follows category");
  await frame.locator("#subcategory").selectOption("vpn");
  await frame.locator("#service_offering").fill("sha");
  await frame.locator(".menu div", { hasText: "Shared folders" }).click();
  await frame.locator("#cmdb_ci").fill("fs-");
  await frame.locator(".menu div", { hasText: "fs-share-01" }).click();
  await frame.locator("#assignment_group").fill("Service");
  await frame.locator(".menu div", { hasText: "Service Desk" }).click();
  await frame.locator("#assigned_to").fill("Beth");
  await frame.locator(".menu div", { hasText: "Beth Anglin" }).waitFor();
  check((await frame.locator(".menu div").count()) === 1, "assignee search");
  await frame.locator("#assigned_to").fill("");
  await frame.locator("#contact_type").selectOption("phone");
  if (shots) await page.screenshot({ path: join(shots, "incident-form.png") });

  await frame.locator("#submit").click();
  await frame.locator(".confirm").waitFor();
  if (shots) await page.screenshot({ path: join(shots, "incident-confirm.png") });
  await frame.locator("#yes").click();
  await frame.locator(".banner.ok").waitFor();
  const inc = sn.tables["incident"]!.find((r) => r["short_description"] === args.short_description)!;
  check(!!inc, "incident created");
  check(inc["caller_id"] === david.sys_id && inc["business_service"] === svc.sys_id && inc["service_offering"] === offering.sys_id
    && inc["cmdb_ci"] === ci.sys_id && inc["assignment_group"] === group.sys_id, "reference fields sent as sys_ids");
  check(inc["category"] === "network" && inc["subcategory"] === "vpn" && inc["impact"] === "3" && inc["urgency"] === "2" && inc["contact_type"] === "phone", "choice values sent");
  check(inc["assigned_to"] === undefined, "cleared reference not sent");
  check((await frame.locator("#number").inputValue()) === inc["number"], "number shown after save");
  const ctx = await page.evaluate(() => (window as any).modelContext);
  check(ctx.some((c: any) => c.content[0].text.includes(inc["number"])), "number posted to model context");
  if (shots) await page.screenshot({ path: join(shots, "incident-done.png") });
} finally {
  await browser.close();
  await sn.stop();
}
console.log(failures ? `${failures} check(s) failed` : "all incident form checks passed");
process.exit(failures ? 1 : 0);
