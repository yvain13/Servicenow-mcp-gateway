import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeSN } from "./fake-sn.js";

// Isolated store and a fixed management port, set before the gateway modules load.
const dir = mkdtempSync(join(tmpdir(), "gw-oauth-"));
process.env["STORE_FILE"] = join(dir, "store.json");
process.env["AUDIT_LOG"] = join(dir, "audit.log");
const MGMT_PORT = 47880;
const MCP_PORT = 47881;
process.env["MANAGEMENT_PORT"] = String(MGMT_PORT);
const REDIRECT = `http://localhost:${MGMT_PORT}/oauth/callback`;
const CLIENT_CB = "http://127.0.0.1:47999/callback"; // the MCP client's own redirect (mcp-remote)

const P = (name: string, required = false, inn = "query") => ({ name, description: name, type: "string", required, in: inn });
writeFileSync(
  process.env["STORE_FILE"],
  JSON.stringify({
    instance: null,
    servers: [
      {
        id: "srv-oauth", name: "change-ops", description: "", port: MCP_PORT, identity: "oauth", tools: [
          { id: "t1", name: "get_change", description: "Get a change", method: "GET", endpoint: "/api/now/table/change_request", apiType: "table", parameters: [P("number", true)] },
        ],
      },
    ],
  })
);

const sn = new FakeSN();
let manager: any;
let mgmt: Server;
let oauth: typeof import("../src/oauth.js");

const base = `http://localhost:${MCP_PORT}`;
const b64url = (b: Buffer) => b.toString("base64url");

beforeAll(async () => {
  await sn.start();
  sn.users["alice"] = "pw";
  sn.insert("sys_user", { user_name: "alice", name: "Alice Approver" });
  sn.insert("change_request", { number: "CHG0001", short_description: "Patch" });
  sn.oauthApps["sn-client"] = { redirectUri: REDIRECT };
  sn.oauthLoginAs = "alice";
  oauth = await import("../src/oauth.js");
  const { MCPManager } = await import("../src/mcp-manager.js");
  const storage = await import("../src/storage.js");
  manager = new MCPManager({ instanceUrl: sn.url, username: "admin", password: "admin" });
  await manager.start(storage.getServer("srv-oauth"));
  const express = (await import("express")).default;
  const app = express();
  app.use(oauth.callbackRouter());
  mgmt = app.listen(MGMT_PORT, "127.0.0.1");
  await new Promise((r) => mgmt.once("listening", r));
});

afterAll(async () => {
  await manager.stopAll();
  mgmt.close();
  await sn.stop();
});

// Runs the whole browser flow the way mcp-remote does, returning gateway tokens.
async function signIn(form: Record<string, string>): Promise<{ access_token: string; refresh_token: string; clientId: string }> {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLIENT_CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "test" }),
  }).then((r) => r.json());
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authz = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: CLIENT_CB, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" })) authz.searchParams.set(k, v);
  const page = await fetch(authz).then((r) => r.text());
  const pid = /name="pid" value="([^"]+)"/.exec(page)![1]!;

  // Login page form → ServiceNow authorize → the gateway's one callback → back to the client.
  const start = await fetch(`${base}/oauth/start`, { method: "POST", redirect: "manual", body: new URLSearchParams({ pid, ...form }) });
  expect(start.status).toBe(302);
  const snAuth = new URL(start.headers.get("location")!);
  expect(snAuth.searchParams.get("redirect_uri")).toBe(REDIRECT);
  expect(snAuth.searchParams.get("code_challenge_method")).toBe("S256");
  const snBack = await fetch(snAuth, { redirect: "manual" });
  const cb = await fetch(snBack.headers.get("location")!, { redirect: "manual" });
  expect(cb.status).toBe(302);
  const toClient = new URL(cb.headers.get("location")!);
  expect(toClient.origin + toClient.pathname).toBe(CLIENT_CB);
  expect(toClient.searchParams.get("state")).toBe("xyz");

  const tok = await fetch(`${base}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: toClient.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CLIENT_CB }),
  }).then((r) => r.json());
  expect(tok.access_token).toBeTruthy();
  return { ...tok, clientId: reg.client_id };
}

async function mcp(token?: string): Promise<Client> {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
  return c;
}

describe("OAuth sign-in", () => {
  it("lets clients connect and list tools without a token, and asks for sign-in on a tool call", async () => {
    const c = await mcp(); // no token: no browser pops up when Claude starts
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["get_change"]);
    await expect(c.callTool({ name: "get_change", arguments: { number: "CHG0001" } })).rejects.toThrow(/invalid_token/);
    await c.close();

    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_change", arguments: {} } }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
    expect(prm.authorization_servers).toEqual([`${base}/`]);
    const asm = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
    expect(asm).toMatchObject({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ["S256"] });
  });

  it("binds a session opened before sign-in to the user who signs in", async () => {
    const guestHeaders: Record<string, string> = {};
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(guestHeaders)) headers.set(k, v);
        return fetch(url, { ...init, headers });
      },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(transport);
    await c.listTools();
    const tok = await signIn({ mode: "new", instanceUrl: sn.url, clientId: "sn-client", label: "Early PDI", save: "" });
    guestHeaders["Authorization"] = `Bearer ${tok.access_token}`; // what mcp-remote does after the browser sign-in
    const res: any = await c.callTool({ name: "get_change", arguments: { number: "CHG0001" } });
    expect(res.structuredContent.result[0].number).toBe("CHG0001");
    expect(sn.calls.at(-1)!.user).toBe("alice");
    expect(oauth.listCredentials()).toHaveLength(0); // "save" unticked
    await c.close();
  });

  it("ignores a stale token until a tool runs (e.g. after a gateway restart)", async () => {
    const c = await mcp("stale-token-from-before-restart");
    expect((await c.listTools()).tools).toHaveLength(1);
    await expect(c.callTool({ name: "get_change", arguments: { number: "CHG0001" } })).rejects.toThrow(/invalid_token/);
    await c.close();
  });

  it("signs in with a new credential, saves it, and calls ServiceNow as that user", async () => {
    const tok = await signIn({ mode: "new", instanceUrl: sn.url, clientId: "sn-client", label: "Fake PDI", save: "on" });
    const saved = oauth.listCredentials();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ label: "Fake PDI", instanceUrl: sn.url, clientId: "sn-client" });
    expect(existsSync(join(dir, "oauth-credentials.json"))).toBe(true);

    const c = await mcp(tok.access_token);
    const res: any = await c.callTool({ name: "get_change", arguments: { number: "CHG0001" } });
    expect(res.structuredContent.result[0].number).toBe("CHG0001");
    const last = sn.calls.at(-1)!;
    expect(last.user).toBe("alice"); // the user's own token, not the service account
    const session = oauth.broker.listSessions()[0]!;
    expect(session.user).toMatchObject({ userName: "alice", name: "Alice Approver" });
    await c.close();
  });

  it("offers the saved credential on the next sign-in", async () => {
    const reg = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLIENT_CB], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: CLIENT_CB, code_challenge: "x".repeat(43), code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const page = await fetch(u).then((r) => r.text());
    expect(page).toContain("Fake PDI");
    expect(page).toContain(`value="${oauth.listCredentials()[0]!.id}" checked`);
    expect(page).toContain(REDIRECT);
    const tok = await signIn({ mode: "saved", credentialId: oauth.listCredentials()[0]!.id });
    expect(oauth.listCredentials()).toHaveLength(1);
    const c = await mcp(tok.access_token);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["get_change"]);
    await c.close();
  });

  it("edits a saved credential from the login page", async () => {
    const id = oauth.listCredentials()[0]!.id;
    await signIn({ mode: "edit", credentialId: id, instanceUrl: sn.url, clientId: "sn-client", label: "Renamed PDI" });
    expect(oauth.listCredentials()).toEqual([expect.objectContaining({ id, label: "Renamed PDI" })]);
  });

  it("refreshes the gateway token and the ServiceNow token, and rejects bad tokens", async () => {
    sn.tokenTtl = 30; // ServiceNow token expires within the refresh window
    const tok = await signIn({ mode: "saved", credentialId: oauth.listCredentials()[0]!.id });
    sn.tokenTtl = 1800;
    const session = [...oauth.broker.sessions.values()].at(-1)!;
    const oldSnToken = session.access;
    const c = await mcp(tok.access_token);
    const res: any = await c.callTool({ name: "get_change", arguments: { number: "CHG0001" } });
    expect(res.isError).toBeFalsy();
    expect(session.access).not.toBe(oldSnToken); // refreshed with ServiceNow before use
    expect(sn.bearer[session.access]!.expires - Date.now()).toBeGreaterThan(1000 * 1000);
    await c.close();

    const ref = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.clientId }) }).then((r) => r.json());
    expect(ref.access_token).toBeTruthy();
    const reuse = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.clientId }) });
    expect(reuse.status).toBe(400); // refresh tokens rotate

    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_change", arguments: {} } }) });
    expect(bad.status).toBe(401);
  });

  it("rejects a wrong PKCE verifier and a reused code", async () => {
    const reg = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLIENT_CB], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
    const verifier = b64url(randomBytes(32));
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: CLIENT_CB, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const pid = /name="pid" value="([^"]+)"/.exec(await fetch(u).then((r) => r.text()))![1]!;
    const start = await fetch(`${base}/oauth/start`, { method: "POST", redirect: "manual", body: new URLSearchParams({ pid, mode: "saved", credentialId: oauth.listCredentials()[0]!.id }) });
    const snBack = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = await fetch(snBack.headers.get("location")!, { redirect: "manual" });
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    const wrong = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: b64url(randomBytes(32)), client_id: reg.client_id }) });
    expect(wrong.status).toBe(400);
    const ok = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }) });
    expect(ok.status).toBe(200);
    const replay = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }) });
    expect(replay.status).toBe(400); // codes are single-use
    // The callback's state is single-use.
    const again = await fetch(snBack.headers.get("location")!, { redirect: "manual" });
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/expired or was already used/);
  });

  it("validates the instance URL on the login page", async () => {
    const reg = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLIENT_CB], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: CLIENT_CB, code_challenge: "y".repeat(43), code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const pid = /name="pid" value="([^"]+)"/.exec(await fetch(u).then((r) => r.text()))![1]!;
    const r = await fetch(`${base}/oauth/start`, { method: "POST", redirect: "manual", body: new URLSearchParams({ pid, mode: "new", instanceUrl: "http://evil.example.com", clientId: "x" }) });
    expect(r.status).toBe(303); // errors go to a GET page, so a reload never hits the POST-only URL
    const page = await fetch(new URL(r.headers.get("location")!, base)).then((x) => x.text());
    expect(page).toContain("must use https");
    expect(page).toContain(`name="pid" value="${pid}"`);
    // A GET on the form target (reload, Back, or a referrer redirect) returns to the sign-in page.
    const again = await fetch(`${base}/oauth/start?pid=${encodeURIComponent(pid)}`, { redirect: "manual" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`/oauth/login?pid=${encodeURIComponent(pid)}`);
    expect(again.headers.get("referrer-policy")).toBe("no-referrer");
    const gone = await fetch(`${base}/oauth/start`);
    expect(gone.status).toBe(400);
    expect(await gone.text()).toMatch(/run the tool again in Claude/);
  });

  it("signing out ends the session", async () => {
    const tok = await signIn({ mode: "saved", credentialId: oauth.listCredentials()[0]!.id });
    const session = oauth.broker.listSessions().at(-1)!;
    expect(oauth.broker.signOut(session.id)).toBe(true);
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_change", arguments: {} } }) });
    expect(r.status).toBe(401);
  });

  it("keeps OAuth off for servers in other identity modes", async () => {
    const storage = await import("../src/storage.js");
    storage.updateServer("srv-oauth", { identity: "service" });
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(404);
    const c = await mcp();
    expect((await c.listTools()).tools).toHaveLength(1);
    await c.close();
    storage.updateServer("srv-oauth", { identity: "oauth" });
    const secretFree = JSON.parse(readFileSync(join(dir, "oauth-credentials.json"), "utf8"));
    expect(secretFree[0].clientSecret).toBeUndefined();
  });
});
