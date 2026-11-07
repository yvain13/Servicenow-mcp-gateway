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
const real = JSON.parse(readFileSync("data/store.json", "utf8"));
const changeOps = real.servers.find((s: any) => s.name === "change-ops");
const PORTS = { service: 47901, user: 47902 };
writeFileSync(
  process.env["STORE_FILE"],
  JSON.stringify({
    instance: null,
    servers: [
      { ...changeOps, id: "co", port: PORTS.service },
      { ...changeOps, id: "co-user", name: "change-ops-user", port: PORTS.user, identity: "per-user" },
    ],
  })
);

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
} finally {
  await browser.close();
  await manager.stopAll();
  await sn.stop();
}
console.log(failures ? `${failures} check(s) failed` : "all browser checks passed");
process.exit(failures ? 1 : 0);
