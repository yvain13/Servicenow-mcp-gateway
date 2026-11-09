// Browser sign-in for MCP clients ("oauth" identity), brokered to ServiceNow OAuth.
//
//   MCP client (mcp-remote / Claude)          gateway (this file)                ServiceNow
//   ── 401 + resource metadata ──▶ discovers /authorize, /token, /register (SDK router)
//   ── /authorize ───────────────▶ login page: pick a saved credential or add one
//                                  ── /oauth_auth.do (PKCE) ───────────────────▶ user signs in
//                                  ◀── one fixed redirect URL: /oauth/callback ── code
//                                  ── /oauth_token.do ─────────────────────────▶ user's token
//   ◀── redirect with gateway code ─
//   ── /token (PKCE) ────────────▶ gateway access + refresh token
//   ── /mcp, Bearer ─────────────▶ tool calls run in ServiceNow with the user's token
//
// Tokens live in memory only: after a gateway restart users sign in again. Saved OAuth
// credentials (instance URL, client ID, optional secret) and registered MCP clients are kept in
// gitignored files next to the store.
import { createHash, randomBytes, randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Request, Response, Router } from "express";
import express from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { STORE_DIR } from "./storage.js";
import type { MCPServer } from "./types.js";

// ── Configuration ────────────────────────────────────────────────────────────

// The one redirect URL registered in ServiceNow for every server: the management port's
// callback. OAUTH_REDIRECT_URL overrides it (e.g. a different host name).
export function redirectUrl(): string {
  return process.env["OAUTH_REDIRECT_URL"] ?? `http://localhost:${process.env["MANAGEMENT_PORT"] ?? 3001}/oauth/callback`;
}

const ACCESS_TTL_S = 3600;
const PENDING_TTL_MS = 10 * 60_000;
export const FAILURE_PAUSE_MS = 2 * 60_000;

export interface OAuthCredential {
  id: string;
  label: string;
  instanceUrl: string; // https://dev12345.service-now.com
  clientId: string;
  clientSecret?: string; // optional: PKCE public clients need none
  scope?: string;
}

const credFile = () => join(STORE_DIR, "oauth-credentials.json");
const clientFile = () => join(STORE_DIR, "oauth-clients.json");

function readJson<T>(file: string, empty: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : empty;
  } catch {
    return empty;
  }
}

export function listCredentials(): OAuthCredential[] {
  return readJson<OAuthCredential[]>(credFile(), []);
}

export function getCredential(id: string | undefined): OAuthCredential | undefined {
  return id ? listCredentials().find((c) => c.id === id) : undefined;
}

export function normalizeInstanceUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

// Returns an error message, or null when the credential is usable.
export function checkCredential(c: Partial<OAuthCredential>): string | null {
  if (!c.instanceUrl || !c.clientId?.trim()) return "Instance URL and client ID are required";
  let u: URL;
  try {
    u = new URL(normalizeInstanceUrl(c.instanceUrl));
  } catch {
    return "The instance URL is not valid";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) return "The instance URL must use https";
  if (u.pathname !== "/" && u.pathname !== "") return "Use the instance's base URL, e.g. https://dev12345.service-now.com";
  return null;
}

export function saveCredential(input: Partial<OAuthCredential>): OAuthCredential {
  const err = checkCredential(input);
  if (err) throw new Error(err);
  const all = listCredentials();
  const existing = input.id ? all.find((c) => c.id === input.id) : undefined;
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl!);
  const cred: OAuthCredential = {
    id: existing?.id ?? randomUUID(),
    label: (input.label ?? "").trim() || new URL(instanceUrl).hostname,
    instanceUrl,
    clientId: input.clientId!.trim(),
    // An empty secret on edit keeps the stored one; "-" clears it.
    ...(input.clientSecret === "-" ? {} : input.clientSecret ? { clientSecret: input.clientSecret } : existing?.clientSecret ? { clientSecret: existing.clientSecret } : {}),
    ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}),
  };
  writeFileSync(credFile(), JSON.stringify(existing ? all.map((c) => (c.id === cred.id ? cred : c)) : [...all, cred], null, 2));
  return cred;
}

export function deleteCredential(id: string): boolean {
  const all = listCredentials();
  const next = all.filter((c) => c.id !== id);
  writeFileSync(credFile(), JSON.stringify(next, null, 2));
  return next.length < all.length;
}

// For the management UI: never send the secret back.
export function publicCredential(c: OAuthCredential) {
  const { clientSecret, ...rest } = c;
  return { ...rest, hasSecret: !!clientSecret };
}

// MCP clients registered through dynamic client registration (public PKCE clients). Kept on
// disk so a client that cached its registration still works after a gateway restart.
class FileClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return readJson<OAuthClientInformationFull[]>(clientFile(), []).find((c) => c.client_id === clientId);
  }
  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
    const all = readJson<OAuthClientInformationFull[]>(clientFile(), []);
    writeFileSync(clientFile(), JSON.stringify([...all.slice(-200), full], null, 2));
    return full;
  }
}

// ── In-memory broker ─────────────────────────────────────────────────────────

export interface SNUser {
  sysId?: string;
  userName: string;
  name?: string;
}

// A signed-in user's ServiceNow token for one server.
export interface SNSession {
  id: string;
  serverId: string;
  credentialId: string;
  instanceUrl: string;
  clientId: string;
  clientSecret?: string;
  access: string;
  refresh?: string;
  expiresAt: number; // ms
  user: SNUser;
  createdAt: number;
}

interface Pending {
  serverId: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  created: number;
}

interface Upstream {
  pid: string;
  cred: OAuthCredential;
  verifier: string;
  created: number;
}

interface Grant {
  snSessionId: string;
  clientId: string;
  serverId: string;
  expiresAt: number;
}

const b64url = (b: Buffer) => b.toString("base64url");
const token = () => b64url(randomBytes(32));

export class OAuthBroker {
  private pending = new Map<string, Pending>();
  private upstream = new Map<string, Upstream>();
  private codes = new Map<string, Grant & { challenge: string; redirectUri: string }>();
  private access = new Map<string, Grant>();
  private refresh = new Map<string, Grant>();
  readonly sessions = new Map<string, SNSession>();
  // Last failed sign-in per server: for a short while, tool calls report it instead of
  // opening yet another sign-in tab.
  private failures = new Map<string, { message: string; until: number }>();

  recentFailure(serverId: string): string | undefined {
    const f = this.failures.get(serverId);
    if (f && f.until > Date.now()) return f.message;
    this.failures.delete(serverId);
    return undefined;
  }

  clearFailure(serverId: string): void {
    this.failures.delete(serverId);
  }

  private fail(serverId: string, message: string): void {
    this.failures.set(serverId, { message, until: Date.now() + FAILURE_PAUSE_MS });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.created > PENDING_TTL_MS) this.pending.delete(k);
    for (const [k, v] of this.upstream) if (now - v.created > PENDING_TTL_MS) this.upstream.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.access) if (v.expiresAt < now) this.access.delete(k);
  }

  begin(serverId: string, client: OAuthClientInformationFull, params: AuthorizationParams): string {
    this.sweep();
    const pid = token();
    this.pending.set(pid, { serverId, client, params, created: Date.now() });
    return pid;
  }

  pendingFor(pid: string): Pending | undefined {
    return this.pending.get(pid);
  }

  // Step 2: send the browser to ServiceNow's authorize endpoint with our own PKCE pair.
  upstreamUrl(pid: string, cred: OAuthCredential): string {
    if (!this.pending.has(pid)) throw new Error("This sign-in request has expired. Start again from your MCP client.");
    const verifier = b64url(randomBytes(48));
    const state = token();
    this.upstream.set(state, { pid, cred, verifier, created: Date.now() });
    const u = new URL(`${cred.instanceUrl}/oauth_auth.do`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cred.clientId);
    u.searchParams.set("redirect_uri", redirectUrl());
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    u.searchParams.set("code_challenge_method", "S256");
    if (cred.scope) u.searchParams.set("scope", cred.scope);
    return u.href;
  }

  // Step 3: ServiceNow redirected back. Exchange its code, resolve the user, and send the
  // browser back to the MCP client with a gateway authorization code.
  async complete(query: Record<string, unknown>): Promise<{ redirect: string } | { error: string; hint?: string; notify?: string }> {
    const state = String(query["state"] ?? "");
    const up = this.upstream.get(state);
    if (!up) return { error: "This sign-in request has expired or was already used. Start again from your MCP client." };
    this.upstream.delete(state);
    const pend = this.pending.get(up.pid);
    if (!pend) return { error: "This sign-in request has expired. Start again from your MCP client." };
    this.pending.delete(up.pid);
    const back = (params: Record<string, string>) => {
      const u = new URL(pend.params.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (pend.params.state) u.searchParams.set("state", pend.params.state);
      return { redirect: u.href };
    };
    if (query["error"]) {
      const why = String(query["error_description"] ?? query["error"]);
      this.fail(pend.serverId, `ServiceNow sign-in was cancelled or refused (${why}).`);
      return back({ error: "access_denied", error_description: why });
    }
    const code = String(query["code"] ?? "");
    if (!code) return { error: "ServiceNow did not return an authorization code." };

    let tok: { access_token: string; refresh_token?: string; expires_in?: number };
    try {
      tok = await tokenRequest(up.cred, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUrl(),
        code_verifier: up.verifier,
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const hint = tokenHint(why, up.cred);
      this.fail(pend.serverId, `ServiceNow did not issue a token (${why}). ${hint}`);
      // Tell the MCP client the sign-in failed, so it stops waiting instead of retrying.
      return { error: `ServiceNow did not issue a token: ${why}`, hint, notify: back({ error: "access_denied", error_description: why }).redirect };
    }
    const user = await whoAmI(up.cred.instanceUrl, tok.access_token);
    const session: SNSession = {
      id: randomUUID(),
      serverId: pend.serverId,
      credentialId: up.cred.id,
      instanceUrl: up.cred.instanceUrl,
      clientId: up.cred.clientId,
      clientSecret: up.cred.clientSecret,
      access: tok.access_token,
      refresh: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in ?? 1800) * 1000,
      user,
      createdAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.clearFailure(pend.serverId);
    const gwCode = token();
    this.codes.set(gwCode, {
      snSessionId: session.id,
      clientId: pend.client.client_id,
      serverId: pend.serverId,
      challenge: pend.params.codeChallenge,
      redirectUri: pend.params.redirectUri,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return back({ code: gwCode });
  }

  challenge(clientId: string, code: string): string {
    const c = this.codes.get(code);
    if (!c || c.clientId !== clientId || c.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.challenge;
  }

  redeem(clientId: string, serverId: string, code: string, redirectUri?: string): OAuthTokens {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!c || c.clientId !== clientId || c.serverId !== serverId || c.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    return this.issue({ snSessionId: c.snSessionId, clientId, serverId, expiresAt: 0 });
  }

  rotate(clientId: string, serverId: string, refreshToken: string): OAuthTokens {
    const g = this.refresh.get(refreshToken);
    if (!g || g.clientId !== clientId || g.serverId !== serverId || !this.sessions.has(g.snSessionId)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    this.refresh.delete(refreshToken);
    return this.issue(g);
  }

  private issue(g: Grant): OAuthTokens {
    const access = token();
    const refresh = token();
    this.access.set(access, { ...g, expiresAt: Date.now() + ACCESS_TTL_S * 1000 });
    this.refresh.set(refresh, { ...g, expiresAt: 0 });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh };
  }

  // Every MCP request: check the gateway token, and refresh the ServiceNow token if it is
  // about to expire.
  async verify(serverId: string, accessToken: string): Promise<AuthInfo> {
    const g = this.access.get(accessToken);
    const s = g && this.sessions.get(g.snSessionId);
    if (!g || !s || g.serverId !== serverId || g.expiresAt < Date.now()) throw new InvalidTokenError("Invalid or expired token");
    if (s.expiresAt - Date.now() < 60_000) await this.refreshUpstream(s);
    return { token: accessToken, clientId: g.clientId, scopes: [], expiresAt: Math.floor(g.expiresAt / 1000), extra: { snSessionId: s.id } };
  }

  private async refreshUpstream(s: SNSession): Promise<void> {
    if (!s.refresh) throw new InvalidTokenError("ServiceNow session expired; sign in again");
    try {
      const tok = await tokenRequest(
        { id: s.credentialId, label: "", instanceUrl: s.instanceUrl, clientId: s.clientId, clientSecret: s.clientSecret },
        { grant_type: "refresh_token", refresh_token: s.refresh }
      );
      s.access = tok.access_token;
      if (tok.refresh_token) s.refresh = tok.refresh_token;
      s.expiresAt = Date.now() + (tok.expires_in ?? 1800) * 1000;
    } catch {
      this.signOut(s.id);
      throw new InvalidTokenError("ServiceNow session expired; sign in again");
    }
  }

  revoke(tokenValue: string): void {
    this.access.delete(tokenValue);
    this.refresh.delete(tokenValue);
  }

  signOut(snSessionId: string): boolean {
    for (const m of [this.access, this.refresh]) for (const [k, v] of m) if (v.snSessionId === snSessionId) m.delete(k);
    return this.sessions.delete(snSessionId);
  }

  listSessions(): Omit<SNSession, "access" | "refresh" | "clientSecret">[] {
    return [...this.sessions.values()].map(({ access, refresh, clientSecret, ...rest }) => rest);
  }
}

export const broker = new OAuthBroker();

// The usual reasons ServiceNow's token endpoint refuses an authorization code.
export function tokenHint(why: string, cred: OAuthCredential): string {
  if (/access_denied|invalid_client|unauthorized|401/i.test(why) && !cred.clientSecret) {
    return "This credential has no client secret, so the ServiceNow OAuth app must be a public client. In ServiceNow, open System OAuth → Application Registry → your app and tick Public Client (and Use PKCE if shown). Or paste the app's Client Secret into the credential (OAuth sign-in → Edit).";
  }
  if (/access_denied|invalid_client|unauthorized|401/i.test(why)) {
    return `Check that the client secret is current, the app is Active, and its Redirect URL includes ${redirectUrl()} exactly.`;
  }
  if (/invalid_grant/i.test(why)) {
    return `The code was rejected: check that the app's Redirect URL includes ${redirectUrl()} exactly, then sign in again.`;
  }
  return "Check the OAuth app in ServiceNow (System OAuth → Application Registry) and the system log for details.";
}

async function tokenRequest(
  cred: OAuthCredential,
  params: Record<string, string>
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({ ...params, client_id: cred.clientId });
  if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
  const res = await fetch(`${cred.instanceUrl}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok || !json.access_token) throw new Error(json.error_description || json.error || `HTTP ${res.status}`);
  return json;
}

// Who the token belongs to (sys_user), so approvals and the audit log name the real user.
async function whoAmI(instanceUrl: string, accessToken: string): Promise<SNUser> {
  try {
    const u = new URL(`${instanceUrl}/api/now/table/sys_user`);
    u.searchParams.set("sysparm_query", "sys_id=javascript:gs.getUserID()");
    u.searchParams.set("sysparm_fields", "sys_id,user_name,name");
    u.searchParams.set("sysparm_limit", "1");
    const res = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    const row = ((await res.json()) as { result?: Record<string, string>[] }).result?.[0];
    if (row?.user_name) return { sysId: row.sys_id, userName: row.user_name, name: row.name };
  } catch {
    /* fall through */
  }
  return { userName: "oauth-user" };
}

// ── SDK provider (one per MCP server) ────────────────────────────────────────

const clientsStore = new FileClientsStore();

export class GatewayOAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly server: () => MCPServer,
    private readonly b: OAuthBroker = broker
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pid = this.b.begin(this.server().id, client, params);
    res.status(200).type("html").set("Cache-Control", "no-store").send(loginPage(this.server(), pid));
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.b.challenge(client.client_id, code);
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    return this.b.redeem(client.client_id, this.server().id, code, redirectUri);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    return this.b.rotate(client.client_id, this.server().id, refreshToken);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    return this.b.verify(this.server().id, accessToken);
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    this.b.revoke(request.token);
  }
}

// POST /oauth/start on the MCP server: the login page's form. Uses a saved credential, or
// saves / edits one, then redirects to ServiceNow.
const EXPIRED = "This sign-in request has expired or was already completed. Close this tab and run the tool again in Claude; a new sign-in page will open.";

export function startRouter(b: OAuthBroker = broker): Router {
  const r = express.Router();
  // Never leak these URLs to ServiceNow as a referrer (its login could send the browser back here).
  r.use("/oauth", (_req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    res.set("Cache-Control", "no-store");
    next();
  });

  // The sign-in page by GET, so errors and reloads never leave the browser on a POST-only URL.
  r.get("/oauth/login", (req: Request, res: Response) => {
    const pid = String(req.query["pid"] ?? "");
    const pend = b.pendingFor(pid);
    if (!pend) {
      res.status(400).type("html").send(messagePage("Sign-in expired", EXPIRED));
      return;
    }
    const error = typeof req.query["error"] === "string" ? req.query["error"] : undefined;
    res.status(200).type("html").send(loginPage(currentServer(pend.serverId), pid, error));
  });

  // A reload or Back on the form's target lands here: send it to the sign-in page if it is still open.
  r.get("/oauth/start", (req: Request, res: Response) => {
    const pid = String(req.query["pid"] ?? "");
    if (pid && b.pendingFor(pid)) {
      res.redirect(303, `/oauth/login?pid=${encodeURIComponent(pid)}`);
      return;
    }
    res.status(400).type("html").send(messagePage("Sign-in expired", EXPIRED));
  });

  r.post("/oauth/start", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const f = req.body as Record<string, string | undefined>;
    const pid = String(f["pid"] ?? "");
    const pend = b.pendingFor(pid);
    if (!pend) {
      res.status(400).type("html").send(messagePage("Sign-in expired", EXPIRED));
      return;
    }
    try {
      let cred: OAuthCredential | undefined;
      if (f["mode"] === "saved") {
        cred = getCredential(f["credentialId"]);
        if (!cred) throw new Error("Choose a saved credential");
      } else {
        const input: Partial<OAuthCredential> = {
          id: f["mode"] === "edit" ? f["credentialId"] : undefined,
          label: f["label"],
          instanceUrl: f["instanceUrl"],
          clientId: f["clientId"],
          clientSecret: f["clientSecret"],
          scope: f["scope"],
        };
        const err = checkCredential(input);
        if (err) throw new Error(err);
        if (f["save"] === "on" || f["mode"] === "edit") cred = saveCredential(input);
        else {
          cred = {
            id: "unsaved",
            label: "",
            instanceUrl: normalizeInstanceUrl(input.instanceUrl!),
            clientId: input.clientId!.trim(),
            clientSecret: input.clientSecret || undefined,
            scope: input.scope?.trim() || undefined,
          };
        }
      }
      res.redirect(302, b.upstreamUrl(pid, cred));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.redirect(303, `/oauth/login?pid=${encodeURIComponent(pid)}&error=${encodeURIComponent(msg)}`);
    }
  });
  return r;
}

let serverLookup: (id: string) => MCPServer | undefined = () => undefined;
export function setServerLookup(fn: (id: string) => MCPServer | undefined): void {
  serverLookup = fn;
}
function currentServer(id: string): MCPServer {
  return serverLookup(id) ?? ({ id, name: "MCP server", description: "", port: 0, tools: [] } as MCPServer);
}

// GET /oauth/callback on the management port: the one redirect URL registered in ServiceNow.
export function callbackRouter(b: OAuthBroker = broker): Router {
  const r = express.Router();
  r.get("/oauth/callback", async (req: Request, res: Response) => {
    res.set("Referrer-Policy", "no-referrer");
    const out = await b.complete(req.query as Record<string, unknown>);
    if ("redirect" in out) {
      res.redirect(302, out.redirect);
      return;
    }
    const extra =
      (out.hint ? `<p class="sub"><b>How to fix:</b> ${esc(out.hint)}</p>` : "") +
      `<p class="sub">Claude won't open another sign-in for ${FAILURE_PAUSE_MS / 60_000} minutes. Fix the setting, then run the tool again.</p>` +
      // Let the MCP client (mcp-remote) know, so it stops waiting for this sign-in.
      (out.notify ? `<script>fetch(${JSON.stringify(out.notify).replace(/</g, "\\u003c")}, { mode: "no-cors" }).catch(() => {});</script>` : "");
    res.status(400).type("html").send(messagePage("Sign-in failed", out.error, extra));
  });
  return r;
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const PAGE_CSS = `
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f5f2;color:#16201a}
main{max-width:560px;margin:48px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e3e1d8;border-radius:14px;padding:22px 24px;box-shadow:0 10px 30px -18px rgba(20,40,28,.3)}
h1{font-size:19px;margin:0 0 4px}p.sub{color:#516056;margin:0 0 18px;font-size:13px}
.cred{display:flex;gap:10px;align-items:flex-start;border:1px solid #e3e1d8;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.cred:has(input:checked){border-color:#2e8b57;background:#f1f8f3}
.cred b{display:block}.cred small{color:#516056;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all}
.cred .edit{margin-left:auto;font-size:12px;color:#1b5e3f;background:none;border:none;cursor:pointer;text-decoration:underline}
label.f{display:block;font-size:12px;font-weight:600;margin:12px 0 5px}
input[type=text],input[type=password],input[type=url]{width:100%;font:inherit;padding:9px 11px;border:1px solid #d7d4c9;border-radius:8px;background:#fbfaf7}
.row{display:flex;gap:10px}.row>*{flex:1}
button.primary{width:100%;margin-top:16px;font:600 14px system-ui;background:#1b5e3f;color:#fff;border:none;border-radius:9px;padding:11px;cursor:pointer}
.link{background:none;border:none;color:#1b5e3f;font-weight:600;cursor:pointer;padding:6px 0;font-size:13px}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:9px 12px;margin-bottom:12px;font-size:13px}
.note{font-size:12px;color:#516056;margin-top:16px;border-top:1px solid #ecebe4;padding-top:12px}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#f1f0ea;padding:1px 5px;border-radius:5px;word-break:break-all}
.hidden{display:none}`;

function loginPage(server: MCPServer, pid: string, error?: string): string {
  const creds = listCredentials();
  const preferred = getCredential(server.oauthCredential)?.id ?? creds[0]?.id;
  const list = creds
    .map(
      (c) => `<label class="cred"><input type="radio" name="credentialId" value="${esc(c.id)}" ${c.id === preferred ? "checked" : ""}>
      <span><b>${esc(c.label)}</b><small>${esc(c.instanceUrl)}<br>client ${esc(c.clientId)}${c.clientSecret ? " · secret saved" : ""}</small></span>
      <button type="button" class="edit" data-cred='${esc(JSON.stringify({ id: c.id, label: c.label, instanceUrl: c.instanceUrl, clientId: c.clientId, scope: c.scope ?? "" }))}'>Edit</button></label>`
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Sign in · ${esc(server.name)}</title><style>${PAGE_CSS}</style></head><body><main><div class="card">
<h1>Sign in to ServiceNow</h1>
<p class="sub">for the MCP server <b>${esc(server.name)}</b>. You'll be sent to your instance's login page; tools then run as you.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/oauth/start?pid=${encodeURIComponent(pid)}" id="f">
  <input type="hidden" name="pid" value="${esc(pid)}">
  <input type="hidden" name="mode" id="mode" value="${creds.length ? "saved" : "new"}">
  <div id="saved" class="${creds.length ? "" : "hidden"}">${list}
    <button type="button" class="link" id="addBtn">+ Use a different instance or client ID</button>
  </div>
  <div id="form" class="${creds.length ? "hidden" : ""}">
    <label class="f" for="instanceUrl">Instance URL</label>
    <input type="url" id="instanceUrl" name="instanceUrl" placeholder="https://dev12345.service-now.com">
    <div class="row">
      <div><label class="f" for="clientId">Client ID</label><input type="text" id="clientId" name="clientId" autocomplete="off"></div>
      <div><label class="f" for="clientSecret">Client secret <span style="font-weight:400;color:#8a988e">(unless Public Client)</span></label><input type="password" id="clientSecret" name="clientSecret" autocomplete="off" placeholder="empty if the app is a Public Client"></div>
    </div>
    <div class="row">
      <div><label class="f" for="label">Name</label><input type="text" id="label" name="label" placeholder="My PDI"></div>
      <div><label class="f" for="scope">Scope <span style="font-weight:400;color:#8a988e">(optional)</span></label><input type="text" id="scope" name="scope" placeholder="useraccount"></div>
    </div>
    <label style="display:flex;gap:7px;align-items:center;margin-top:12px;font-size:13px"><input type="checkbox" name="save" id="save" checked> Save for next time</label>
    <input type="hidden" name="credentialId" id="editId" disabled>
    ${creds.length ? `<button type="button" class="link" id="backBtn">← Back to saved credentials</button>` : ""}
  </div>
  <button class="primary" type="submit">Continue to ServiceNow</button>
</form>
<div class="note">The ServiceNow OAuth app must allow this redirect URL:<br><code>${esc(redirectUrl())}</code><br>
Only this one. The port in this page's address bar belongs to Claude's own temporary sign-in listener; it changes each time and isn't registered in ServiceNow.<br>
No client secret? Tick <b>Public Client</b> on the app in ServiceNow.</div>
</div></main>
<script>
  const $ = (id) => document.getElementById(id);
  const show = (saved) => { $('saved').classList.toggle('hidden', !saved); $('form').classList.toggle('hidden', saved); };
  const reset = () => { for (const k of ['instanceUrl','clientId','clientSecret','label','scope']) $(k).value = ''; $('save').checked = true; $('editId').disabled = true; };
  $('addBtn') && ($('addBtn').onclick = () => { reset(); $('mode').value = 'new'; show(false); $('instanceUrl').focus(); });
  $('backBtn') && ($('backBtn').onclick = () => { $('mode').value = 'saved'; show(true); });
  document.querySelectorAll('.edit').forEach((b) => b.onclick = (e) => {
    e.preventDefault();
    const c = JSON.parse(b.dataset.cred);
    reset();
    $('instanceUrl').value = c.instanceUrl; $('clientId').value = c.clientId; $('label').value = c.label; $('scope').value = c.scope;
    $('clientSecret').placeholder = 'leave empty to keep the saved secret';
    $('editId').disabled = false; $('editId').value = c.id; $('mode').value = 'edit';
    show(false);
  });
  $('f').onsubmit = () => { if ($('mode').value !== 'saved') document.querySelectorAll('#saved input[type=radio]').forEach((r) => r.disabled = true); };
</script></body></html>`;
}

export function messagePage(title: string, message: string, extraHtml = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main><div class="card"><h1>${esc(title)}</h1><p class="sub">${esc(message)}</p>${extraHtml}</div></main></body></html>`;
}
