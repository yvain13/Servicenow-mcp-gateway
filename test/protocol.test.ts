import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeSN } from "./fake-sn.js";

// Isolated store + audit log, set before the gateway modules load.
const dir = mkdtempSync(join(tmpdir(), "gw-test-"));
const STORE = join(dir, "store.json");
const AUDIT = join(dir, "audit.log");
process.env["STORE_FILE"] = STORE;
process.env["AUDIT_LOG"] = AUDIT;
delete process.env["MCP_APPS_ASSUME_SUPPORT"];

const APP_EXT = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
const sn = new FakeSN();
const PORT = 47820;
const LEGACY_PORT = 47821;
const USER_PORT = 47822;

const P = (name: string, required = false, inn = "body") => ({ name, description: name, type: "string", required, in: inn });
const store = {
  instance: null,
  servers: [
    {
      id: "srv-apps",
      name: "change-ops",
      description: "",
      port: PORT,
      appsEnabled: true,
      apps: [{ uri: "ui://apps-demo/hello", name: "Hello", bundle: "apps/hello/dist/index.html" }],
      tools: [
        { id: "t1", name: "get_change", description: "Get a change", method: "GET", endpoint: "/api/now/table/change_request", apiType: "table", parameters: [P("number", true, "query")] },
        { id: "t2", name: "open_hello", description: "Open hello", method: "POST", endpoint: "", apiType: "scripted", parameters: [P("name")], kind: "handler", handler: "demo.open_hello", ui: { resourceUri: "ui://apps-demo/hello", visibility: ["model", "app"] } },
        { id: "t3", name: "hello_echo", description: "Echo", method: "POST", endpoint: "", apiType: "scripted", parameters: [P("message", true)], kind: "handler", handler: "demo.echo", ui: { resourceUri: "ui://apps-demo/hello", visibility: ["app"] } },
        { id: "t4", name: "change_approval_decide", description: "Decide", method: "POST", endpoint: "", apiType: "scripted", parameters: [P("approval_sys_id", true), P("decision", true)], kind: "handler", handler: "approvals.decide", ui: { visibility: ["app"] } },
        { id: "t5", name: "update_change", description: "Update", method: "PATCH", endpoint: "/api/now/table/change_request/{sys_id}", apiType: "table", parameters: [P("work_notes", true), P("sys_id", true, "path")] },
      ],
    },
    {
      id: "srv-user",
      name: "change-ops-user",
      description: "",
      port: USER_PORT,
      appsEnabled: true,
      identity: "per-user",
      tools: [
        { id: "u1", name: "change_approval_decide", description: "Decide", method: "POST", endpoint: "", apiType: "scripted", parameters: [P("approval_sys_id", true), P("decision", true)], kind: "handler", handler: "approvals.decide", ui: { visibility: ["app"] } },
      ],
    },
    {
      id: "srv-legacy",
      name: "incident-mcp",
      description: "",
      port: LEGACY_PORT,
      tools: [
        { id: "l1", name: "get_change", description: "Get a change", method: "GET", endpoint: "/api/now/table/change_request", apiType: "table", parameters: [P("number", true, "query")] },
        { id: "l2", name: "hello_echo", description: "Echo", method: "POST", endpoint: "", apiType: "scripted", parameters: [P("message", true)], kind: "handler", handler: "demo.echo", ui: { visibility: ["app"] } },
      ],
    },
  ],
};
writeFileSync(STORE, JSON.stringify(store));

let manager: any;
let creds = { instanceUrl: "", username: "admin", password: "admin" };

async function connect(port: number, apps: boolean, headers?: Record<string, string>): Promise<Client> {
  const client = new Client(
    { name: apps ? "apps-host" : "plain-client", version: "1.0.0" },
    { capabilities: apps ? ({ extensions: APP_EXT } as any) : {} }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } })
  );
  return client;
}

beforeAll(async () => {
  await sn.start();
  sn.insert("change_request", { number: "CHG0001", short_description: "x" });
  creds = { instanceUrl: sn.url, username: "admin", password: "admin" };
  const { MCPManager } = await import("../src/mcp-manager.js");
  manager = new MCPManager(creds);
  for (const s of store.servers) await manager.start(s);
});
afterAll(async () => {
  await manager?.stopAll();
  await sn.stop();
});

describe("MCP Apps-capable client", () => {
  it("advertises resources and lists the app bundle", async () => {
    const c = await connect(PORT, true);
    expect(c.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    const { resources } = await c.listResources();
    expect(resources).toEqual([
      expect.objectContaining({ uri: "ui://apps-demo/hello", mimeType: "text/html;profile=mcp-app" }),
    ]);
    const read = await c.readResource({ uri: "ui://apps-demo/hello" });
    const content = read.contents[0] as any;
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("<");
    expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
    await c.close();
  });

  it("carries _meta.ui on tools and includes app-only tools", async () => {
    const c = await connect(PORT, true);
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["open_hello"]!._meta).toEqual({
      ui: { resourceUri: "ui://apps-demo/hello", visibility: ["model", "app"] },
      "ui/resourceUri": "ui://apps-demo/hello",
    });
    expect((byName["hello_echo"]!._meta as any).ui.visibility).toEqual(["app"]);
    expect(byName["get_change"]!._meta).toBeUndefined();
    await c.close();
  });

  it("app-only tools return structuredContent", async () => {
    const c = await connect(PORT, true);
    const r = await c.callTool({ name: "hello_echo", arguments: { message: "abc" } });
    expect(r.structuredContent).toMatchObject({ message: "abc", reversed: "cba" });
    await c.close();
  });

  it("decisions are refused on the service account even from the app", async () => {
    const c = await connect(PORT, true);
    const r = await c.callTool({ name: "change_approval_decide", arguments: { approval_sys_id: "a".repeat(32), decision: "approved" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "identity_required" });
    await c.close();
  });
});

describe("Client without MCP Apps support", () => {
  it("hides app-only tools and _meta.ui, and has no resources", async () => {
    const c = await connect(PORT, false);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_change", "open_hello", "update_change"]);
    expect(tools.every((t) => t._meta === undefined)).toBe(true);
    expect((await c.listResources()).resources).toEqual([]);
    await c.close();
  });

  it("cannot call app-only tools", async () => {
    const c = await connect(PORT, false);
    const r = await c.callTool({ name: "hello_echo", arguments: { message: "x" } });
    expect(r.isError).toBe(true);
    expect((r.content as any)[0].text).toContain("only be called from its MCP App");
    await c.close();
  });

  it("gets a text fallback from UI tools", async () => {
    const c = await connect(PORT, false);
    const r = await c.callTool({ name: "open_hello", arguments: { name: "Ann" } });
    expect((r.content as any)[0].text).toContain("text fallback");
    await c.close();
  });

  it("sees today's tool list and results on a server without apps (regression)", async () => {
    const c = await connect(LEGACY_PORT, true); // even an apps host sees nothing new when apps are off
    const { tools } = await c.listTools();
    expect(tools).toEqual([
      {
        name: "get_change",
        description: "Get a change",
        inputSchema: { type: "object", properties: { number: { type: "string", description: "number" } }, required: ["number"] },
      },
    ]);
    const r = await c.callTool({ name: "get_change", arguments: { number: "CHG0001" } });
    const text = (r.content as any)[0].text as string;
    const body = JSON.parse(text);
    expect(body.result[0].number).toBe("CHG0001");
    expect(text).toBe(JSON.stringify(body, null, 2)); // same text format as before
    expect(r.structuredContent).toEqual(body); // only addition
    await c.close();
  });
});

describe("credentials and governance", () => {
  it("credentials updated in the manager apply to running servers", async () => {
    const c = await connect(LEGACY_PORT, false);
    manager.updateCreds({ ...creds, password: "wrong" });
    const bad = await c.callTool({ name: "get_change", arguments: { number: "CHG0001" } });
    expect(bad.isError).toBe(true);
    manager.updateCreds(creds);
    const good = await c.callTool({ name: "get_change", arguments: { number: "CHG0001" } });
    expect(good.isError).toBeFalsy();
    await c.close();
  });

  it("audits write tools", async () => {
    const c = await connect(PORT, false);
    const id = sn.tables["change_request"]![0]!["sys_id"];
    await c.callTool({ name: "update_change", arguments: { sys_id: id, work_notes: "hi" } });
    const lines = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ caller: "service:admin", server: "change-ops", tool: "update_change", ok: true });
    await c.close();
  });
});

describe("per-user identity", () => {
  const basic = (u: string, p: string) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });

  it("refuses sessions without the caller's own login", async () => {
    await expect(connect(USER_PORT, true)).rejects.toThrow();
    await expect(connect(USER_PORT, true, basic("alice", "bad"))).rejects.toThrow();
  });

  it("records the decision as the approver, not the service account", async () => {
    sn.users["alice"] = "pw-a";
    const alice = sn.insert("sys_user", { user_name: "alice", name: "Alice" });
    const chg = sn.insert("change_request", { number: "CHG0002" });
    const ap = sn.insert("sysapproval_approver", { approver: alice["sys_id"], sysapproval: chg["sys_id"], state: "requested", source_table: "change_request" });
    const c = await connect(USER_PORT, true, basic("alice", "pw-a"));
    const r = await c.callTool({ name: "change_approval_decide", arguments: { approval_sys_id: ap["sys_id"], decision: "approved" } });
    expect(r.structuredContent).toMatchObject({ number: "CHG0002", decision: "approved" });
    expect(sn.find("sysapproval_approver", ap["sys_id"])).toMatchObject({ state: "approved", sys_updated_by: "alice" });
    const lines = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ caller: "user:alice", record: "CHG0002", decision: "approved" });
    await c.close();
  });
});
