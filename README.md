# snow-mcp-gateway

> Built by **[@AIbyTusharM](https://www.youtube.com/@AIbyTusharM)** — subscribe for more such tools, learning and walkthroughs.

A local gateway that turns ServiceNow REST APIs into MCP (Model Context Protocol) tools, so they can be used by Claude Desktop, Claude Code, or any MCP-compatible client.

You point the gateway at a ServiceNow instance, declare tools in a web UI (each tool wraps a Table API or Scripted REST endpoint), and the gateway exposes them as MCP servers over **Streamable HTTP**. Each MCP server runs on its own port and can be hot-edited without restarting clients.

## Architecture

```
Claude Desktop ──stdio──▶ mcp-remote ──HTTP──▶ snow-mcp-gateway ──REST──▶ ServiceNow
Claude Code  ──────────────HTTP────────────▶       │
                                                   ├─ Management UI (port 3001)
                                                   ├─ incident-mcp        (port 7801)
                                                   ├─ change-ops          (port 7820)  ← MCP Apps
                                                   ├─ cmdb_server         (port 7850)
                                                   ├─ server_mcp          (port 7890)
                                                   ├─ business_rule_mcp   (port 8110)
                                                   ├─ script_include_mcp  (port 8120)
                                                   ├─ client_script_mcp   (port 8140)
                                                   └─ problem-mcp-server  (port 8900)
```

- **Management process** serves the web UI on `MANAGEMENT_PORT` (default `3001`) and a REST API at `/api`.
- **Each MCP server** is its own Express app on its own port, mounting `POST/GET/DELETE /mcp` via the official MCP TypeScript SDK's `StreamableHTTPServerTransport`.
- **Servers and tools** are saved in `data/store.json` (local, not tracked; it starts from `data/store.seed.json`) and read live on every `tools/list` and `tools/call`, so adding or editing a tool takes effect immediately without restarting clients.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file
cp .env.example .env
# then edit .env with your ServiceNow instance + credentials

# 3. Run the gateway
npm run dev          # tsx watch — hot reload on file changes
# or
npm run build && npm start
```

Open the management UI at <http://localhost:3001>. The repo ships with eight MCP servers pre-configured (see [Bundled MCP servers](#bundled-mcp-servers)) — they auto-start on launch. From the UI you can:

1. Click **Connect Instance** and paste your ServiceNow URL, username, and password. The gateway tests the connection before saving.
2. Browse the pre-bundled servers in the sidebar — click any tool to edit, or click **Add Tool** to extend a server.
3. Click **Create MCP Server** to spin up a new one on a fresh port.
4. Click **Config snippet** on any server to get the JSON to paste into Claude Desktop / Claude Code.

## Bundled MCP servers

These ship in `data/store.seed.json`, which is copied to your local `data/store.json` on the first save, and start automatically. Tool definitions are live-editable from the UI.

| Server | Port | Target table | Tools |
|---|---|---|---|
| `incident-mcp` | 7801 | `incident` | `get_incident`, `list_incidents`, `create_incident`, `update_incident` |
| `change-ops` | 7820 | `change_request` | `get_change`, `create_change`, `update_change`, plus the change apps below |
| `cmdb_server` | 7850 | `cmdb_ci` | `get_cmdb_ci` |
| `server_mcp` | 7890 | `cmdb_ci_server` | `get_server_details`, `get_server_by_name` |
| `business_rule_mcp` | 8110 | `sys_script` | `create_business_rule`, `list_business_rules`, `get_business_rule`, `update_business_rule` |
| `script_include_mcp` | 8120 | `sys_script_include` | `create_script_include`, `list_script_includes`, `get_script_include`, `update_script_include` |
| `client_script_mcp` | 8140 | `sys_script_client` | `create_client_script`, `list_client_scripts`, `get_client_script`, `update_client_script` |
| `problem-mcp-server` | 8900 | `problem` | `get_problem`, `create_problem` |

Convention across CRUD tools:
- **`create_*`** — POST to the table collection URL; required fields go in the body.
- **`list_*`** — GET; takes `sysparm_query`, `sysparm_limit`, `sysparm_fields`. No `script` parameter — pass `sysparm_fields='sys_id,name,description'` for a lean list view.
- **`get_*`** — GET to `/{table}/{sys_id}`; returns the full record including script body.
- **`update_*`** — PATCH to `/{table}/{sys_id}`; pass only the fields you want to change.

ServiceNow's boolean fields (`active`, `action_insert`, etc.) are declared as `string` so they're sent as `"true"`/`"false"` — the Table API rejects raw JSON booleans for these columns.

## MCP Apps (interactive UIs)

Servers with `appsEnabled: true` serve [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps): `ui://` resources the host renders in a sandboxed iframe next to the chat. `change-ops` ships two:

| App | Opened by (model) | App-only tools the iframe calls |
|---|---|---|
| `ui://change-ops/change-create` — change form | `open_change_form` (prefilled from the conversation) | `change_choices`, `change_search`, `change_submit`, `change_request_approval` |
| `ui://change-ops/change-approvals` — approval inbox | `open_change_approvals` | `change_approval_detail`, `change_approval_decide` |

How it works:

- **Every read and write is a `tools/call` back through the gateway.** ServiceNow credentials never reach the iframe; apps declare no `connectDomains` and load nothing external.
- **Visibility.** A tool's `ui.visibility` is `["model","app"]` (default), `["model"]` or `["app"]`. App-only tools are hidden from the model by the host. That is *not* access control: real enforcement is ServiceNow ACLs on the caller's identity plus the gateway's own checks.
- **Clients without MCP Apps** (no `extensions["io.modelcontextprotocol/ui"]` capability at initialize) see the same tool list and results as before: no `_meta.ui`, no app-only tools, no resources. `open_change_form` returns the field list, current choice values and what's missing so the model can collect the change in chat and call `create_change`; `open_change_approvals` returns the list with links to approve in ServiceNow. Set `MCP_APPS_ASSUME_SUPPORT=1` for a host that renders apps without declaring the capability.
- **Structured results.** Every tool now returns `structuredContent` (the parsed JSON) next to the unchanged text content.
- **Code-backed handlers.** Tools with `"kind": "handler"` run a function from `src/handlers/` instead of a single REST call, so they can validate input and make several ServiceNow calls.

### Change creation

`change_submit` (and `create_change`, which now shares the same handler) creates the change through the **Change Management API** (`/api/sn_chg_rest/change/{normal|emergency}`, `/standard/{template_version_sys_id}`) so change models, state rules and defaults apply. Before creating it checks required fields per type, that the start is in the future and the end after it, and that the CI and assignment group are active records; errors come back as `{ errors: [{ field, message }] }` and the form highlights the fields. Standard changes need a template; template-defined fields are locked in the form and ignored on submit. The form sends an idempotency key, so a double click (or host retry within 10 minutes) returns the first change instead of a second one. Choice lists come from `sys_choice` on the instance. Dates are sent to ServiceNow in UTC.

> `create_change` gained optional `cmdb_ci`, `assignment_group`, `start_date`, `end_date`, `category`, `risk`, `impact` and `std_change_template` parameters, and now enforces the same validation, so calls that omit a CI, group or window are rejected with field errors instead of creating an incomplete record. `cmdb_ci` and `assignment_group` accept a sys_id or an exact name.

After **Request approval**, the form shows the approvals ServiceNow generated for the change (via the app-only `change_approval_status` tool), refreshing until they appear. If one of them is the caller's, the form shows Approve and Reject in place, using the same `change_approval_decide` tool as the inbox, and then shows the change move on. To demo it on a PDI as `admin`, assign the change to a group admin belongs to (on a stock PDI, **Team Development Code Reviewers**), set change-ops identity to **Per-user login (demo)**, and connect with admin's login as shown below.

### Change approval and identity

`change_approval_decide` writes `state` and `comments` to `sysapproval_approver`; ServiceNow's workflow moves the change on from there. It re-reads the approval first and returns `stale` if it was decided or reassigned elsewhere, or `not_yours` if the caller isn't the approver or an active delegate. It is app-only, so the model can open the inbox and discuss risk but not record a decision.

Decisions must be recorded as the real approver, so **they are refused on a shared service account** (`identity_required`). Per server, choose the identity in the UI:

| Identity | How | Use |
|---|---|---|
| Service account (default) | `SN_USERNAME`/`SN_PASSWORD` from `.env` | Creation, browsing approvals |
| Per-user login (demo) | Each client sends its own ServiceNow login as `Authorization: Basic …` on the MCP endpoint; the gateway verifies it at initialize and uses it for that session | Approval demos on a PDI only |
| OAuth sign-in (browser) | The user signs in on ServiceNow's own login page the first time a tool runs (connecting and listing tools need no sign-in); tools run with their OAuth token | Anyone; no passwords in client config |

With `mcp-remote`, pass the header like this (keep the credentials in an env var, not in the config file you share):

```json
"change-ops": {
  "command": "npx",
  "args": ["mcp-remote", "http://localhost:7820/mcp", "--header", "Authorization:${SN_BASIC_AUTH}"],
  "env": { "SN_BASIC_AUTH": "Basic <base64 of user:password>" }
}
```

### OAuth sign-in

With identity **OAuth sign-in**, a server follows the [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) flow, and the gateway brokers it to ServiceNow OAuth:

1. The client (mcp-remote, or Claude's own connector) connects and lists tools without a token, so opening Claude doesn't pop a browser. The first **tool call** gets `401` with the protected-resource metadata URL. The client then discovers the gateway's `/authorize`, `/token` and `/register` endpoints, registers itself, and retries the call after sign-in. The MCP session is then bound to that user.
2. The browser opens the gateway's sign-in page. The user picks a saved credential (instance URL + client ID), edits one, or adds a new one.
3. The gateway redirects to the instance's `/oauth_auth.do` with PKCE. The user signs in (SSO works), and ServiceNow redirects to the gateway's **one** redirect URL.
4. The gateway exchanges the code at `/oauth_token.do`, looks up the user (`sys_user`), and hands the client its own short-lived token (1 hour, with a rotating refresh token).
5. Every tool call goes to ServiceNow with the user's Bearer token, refreshed shortly before it expires. Approvals, the audit log and ACLs all apply to the real user.

**The redirect URL** is the management port's callback, `http://localhost:3001/oauth/callback` (it follows `MANAGEMENT_PORT`; `OAUTH_REDIRECT_URL` overrides it). It is shown, with a copy button, in **OAuth sign-in** in the sidebar and on the sign-in page. Register it once; it serves every server.

**ServiceNow setup** (once per instance):

1. **System OAuth → Application Registry → New → Create an OAuth API endpoint for external clients**.
2. Set **Redirect URL** to the URL above.
3. Tick **Public Client** (and **Use PKCE** if your release shows it), then save the credential without a secret. If the app isn't a public client, ServiceNow requires its **Client Secret** on the token request (otherwise the token request fails with `access_denied`), so paste the secret into the credential instead.
   Register only the gateway's redirect URL. The port you may see in the sign-in page's address (e.g. `localhost:34355`) is mcp-remote's temporary listener, not something ServiceNow needs.
4. Copy the **Client ID** into a saved credential in the gateway (**OAuth sign-in → Add a credential**), or let users enter it on the sign-in page.

**If sign-in fails**, the page explains why and how to fix it, and tells the client the sign-in ended. For the next 2 minutes, tool calls on that server return the reason instead of opening more sign-in tabs.

**Tokens are kept in memory.** After a gateway restart, the next tool call gets `401` and users sign in again. **OAuth sign-in** in the sidebar lists who is signed in, with **Sign out**.

**Files:** saved credentials (`data/oauth-credentials.json`, including any client secret) and registered MCP clients (`data/oauth-clients.json`) are gitignored. Registered clients are kept on disk so a client that cached its registration keeps working after a restart.

The server page's **Config snippet** button opens **Connect a client**. Pick the sign-in mode there (Service account, OAuth sign-in or Per-user login; it's saved on the server) and copy the matching Claude Desktop config, Claude Code command or `.mcp.json`. In Claude Desktop, an OAuth server needs no header or password:

```json
"change-ops": { "command": "npx", "args": ["-y", "mcp-remote@0.16.5", "http://localhost:7820/mcp"] }
```

### Governance

- Write tools (handlers marked `write`, and REST tools that aren't `GET`) are rate-limited per session (`WRITE_RATE_LIMIT`, default 30/min) and appended to `data/audit.log` as JSON lines: `{ time, caller, server, tool, record, decision, ok }`.
- Search text is stripped of `^` and `=` before it goes into `sysparm_query`, so typed text can't add encoded-query clauses.
- The management UI binds to `127.0.0.1` by default (`MANAGEMENT_HOST` to change), since it can edit tools and credentials.

### Creating apps without code (App Kit)

Most apps don't need a build. In the management UI, open a server's **Apps** tab and choose **+ New app**. Pick one of four types:

| Type | What it is | You write |
|---|---|---|
| **Form** | Fields → one submit tool (e.g. create an incident) | JSON spec |
| **Table / chart** | Rows from a read tool as a table, bar chart (count by a field) or stat tiles | JSON spec |
| **Approval cards** | One card per row with buttons that call a tool (approve, reject, close…) | JSON spec |
| **HTML file** | Anything else: attach one self-contained `.html` | A standard MCP App (official SDK), or HTML that calls `gw.call()` |

The builder gives you:

- **Starter templates** for each type.
- **Copy prompt for Claude**: describe the app in a sentence, and the button copies a prompt containing the spec format and this server's real tools (names, params, read/write). Paste it into Claude and paste the answer back into the editor.
- **Validate**: checks the spec or HTML against the server before saving. It catches unknown tools, model-only tools, required params no field provides, write tools used as data sources, arguments a REST tool would drop, writes without confirmation, external scripts or styles, and direct ServiceNow URLs.
- **Live preview**: the app runs in a built-in host. Reads go to your instance. Writes are dry-run and never sent. Use **Tool input** to test prefill.
- **Save**: stores the app (spec in `store.json`, HTML in `data/apps/<server>/<slug>.html`), serves it as `ui://<server>/<slug>`, turns on MCP Apps for the server, and adds an `open_<slug>` tool the model calls to open it. For forms, that tool takes the form's fields as optional arguments, so the model can prefill them.

Example form spec:

```json
{
  "type": "form",
  "title": "Report an incident",
  "fields": [
    { "name": "short_description", "required": true },
    { "name": "urgency", "type": "select", "options": [{ "value": "1", "label": "High" }, { "value": "3", "label": "Low" }] },
    { "name": "cmdb_ci", "label": "Configuration item", "type": "lookup",
      "lookup": { "tool": "list_cis", "args": { "sysparm_query": "nameLIKE{{text}}" } } }
  ],
  "submit": { "tool": "create_incident", "label": "Create incident" },
  "result": { "title": "Created {{result.number}}" }
}
```

Templates in `args`:

- `{{field}}`: a form value or a field of the card's row.
- `{{input.x}}`: what the model passed to the open tool.
- `{{comment}}`: the comment typed on an approval card.
- `{{text}}`: what the user typed in a lookup.

ServiceNow `{ value, display_value }` pairs display correctly, and the raw value is what gets sent. The full format is in `src/app-spec-types.ts`.

#### Uploaded HTML: the standard MCP Apps format

Upload the same file you would use with any MCP Apps host: the [MCP Apps docs](https://modelcontextprotocol.io/extensions/apps/build) pattern, or an app from ServiceNow's MCP Server Console. The format is one HTML file that imports the official SDK:

```html
<script type="module">
  import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps";
  const app = new App({ name: "Incident list", version: "1.0.0" });
  app.ontoolresult = (result) => render(result.structuredContent); // the opening tool's result
  // app.callServerTool({ name, arguments }), app.updateModelContext({ content }) …
  app.connect();
</script>
```

How the gateway serves it:

- **The file stays as written.** The only change at serve time is that the SDK import points at a copy bundled with the gateway, so no CDN is needed and the host's empty CSP doesn't block it. The stored file is untouched and still runs on other hosts.
- **Other external domains** the page loads from (scripts, styles, images, `fetch`) are detected and allowed through the app's CSP. Validation lists them. ServiceNow URLs are refused, because apps reach ServiceNow only through tools.
- **Opened by an existing tool.** An app that renders `ontoolresult` (like a list) is opened by an existing data tool, such as `list_incidents`, rather than a new `open_` tool. The builder suggests one when it sees `ontoolresult`. The preview's **Tool result** runs that tool, so you see real rows.
- **Tool calls are checked.** Validation checks every `app.callServerTool({ name: "…" })` against the server's tools.

The builder follows the same steps as ServiceNow's MCP Server Console (v1.6), and each field maps to the MCP Apps spec:

| ServiceNow console | Gateway builder | MCP Apps |
|---|---|---|
| Label, Description | Name, Description | resource `name`, `description` |
| App source → Add file | HTML file → attach .html | `resources/read` HTML |
| Add reference → External Resources | External references → External resources | `_meta.ui.csp.resourceDomains` |
| Add reference → External Connection | External references → External connection | `_meta.ui.csp.connectDomains` |
| Permissions | Permissions (microphone, camera, geolocation, clipboard write) | `_meta.ui.permissions` |
| Tool → MCP app field | Opened by (or the tool card's **App** picker) | tool `_meta.ui.resourceUri` |

Validation also adds any external domain it finds in the page that isn't declared (named "detected"), so a forgotten reference doesn't silently break the app.

The gateway's own helper is still available. Pages without the SDK get `window.gw` injected before their scripts:

- `gw.call(tool, args)`, `gw.onInput(fn)`, `gw.onResult(fn)`
- `gw.confirm({ title })`, `gw.setContext(text)`
- `gw.mount(el, spec)`
- the shared CSS

It's shorter to write, but it only runs on this gateway. For apps you want to share, use the standard format.

All of this runs on two prebuilt scripts, which `npm run build:apps` builds once: `apps/_kit/dist/kit.js` (spec apps and `gw`) and `apps/_kit/dist/ext-apps.js` (the bundled SDK for standard apps). Code apps like the change form are still the way to go for heavier logic.

#### Example: the full incident form

`examples/incident-form.html` is a standard MCP App laid out like ServiceNow's incident form:

- **Reference fields:** Caller, Service, Service offering, Configuration item, Assignment group and Assigned to. You type and pick a record; the form sends its sys_id.
- **Choice fields:** Category (with Subcategory filtered by it), Channel, State, Impact and Urgency, loaded from the instance's `sys_choice`.
- **Priority:** shown from the Impact x Urgency matrix. ServiceNow calculates the stored value.
- **Prefill:** Claude can fill any field, passing names for the reference fields.

With the gateway running, install it on the `incident-mcp` server (or name another server):

```bash
node scripts/add-incident-app.mjs incident-mcp
```

The script does three things:

1. Extends `create_incident` with all the form's fields.
2. Adds the lookup tools: `search_users`, `search_groups`, `search_services`, `search_service_offerings`, `search_cis` and `get_incident_choices`.
3. Adds the app with an `open_incident_form` launcher.

You can run it again safely; it updates in place. It goes through the management API, so it works on your existing setup. Restart Claude afterwards so it picks up the new tools.

### Building code apps

Apps live under `apps/<name>/` (an `index.html` + TypeScript) and are built with Vite and `vite-plugin-singlefile` into one self-contained `apps/<name>/dist/index.html`. `apps/_shared/` holds the shell every app uses: host connection, theme, loading and error states, a confirm dialog, and `call(tool, args)`.

To add an app: create `apps/<name>/`, add `{ uri, name, bundle }` to the server's `apps` in `data/store.json` (and in `data/store.seed.json` to ship it), add a handler in `src/handlers/` and register it in `src/handlers/index.ts`, then link tools to the app from the UI (tool card → **App** and **Visible to**). The server's **Apps** tab shows each `ui://` resource, its bundle status and linked tools.

## Wiring into Claude Desktop

The gateway speaks Streamable HTTP. Claude Desktop speaks stdio. Bridge them with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "incident-mcp":       { "command": "npx", "args": ["mcp-remote", "http://localhost:7801/mcp"] },
    "change-ops":         { "command": "npx", "args": ["mcp-remote", "http://localhost:7820/mcp"] },
    "cmdb-server":        { "command": "npx", "args": ["mcp-remote", "http://localhost:7850/mcp"] },
    "business-rule-mcp":  { "command": "npx", "args": ["mcp-remote", "http://localhost:8110/mcp"] },
    "script-include-mcp": { "command": "npx", "args": ["mcp-remote", "http://localhost:8120/mcp"] },
    "client-script-mcp":  { "command": "npx", "args": ["mcp-remote", "http://localhost:8140/mcp"] }
  }
}
```

Restart Claude Desktop — the tools appear as native MCP tools.

The **Config snippet** button in the UI generates the per-server JSON for you with the correct port.

## Wiring into Claude Code

Claude Code speaks Streamable HTTP natively — no `mcp-remote` wrapper needed.

**CLI (one server at a time):**

```bash
claude mcp add --transport http incident-mcp       http://localhost:7801/mcp
claude mcp add --transport http change-ops         http://localhost:7820/mcp
claude mcp add --transport http cmdb-server        http://localhost:7850/mcp
claude mcp add --transport http business-rule-mcp  http://localhost:8110/mcp
claude mcp add --transport http script-include-mcp http://localhost:8120/mcp
claude mcp add --transport http client-script-mcp  http://localhost:8140/mcp
```

Add `--scope user` to make them available across all projects.

**Or drop a `.mcp.json` in your project root:**

```json
{
  "mcpServers": {
    "incident-mcp":       { "type": "http", "url": "http://localhost:7801/mcp" },
    "change-ops":         { "type": "http", "url": "http://localhost:7820/mcp" },
    "cmdb-server":        { "type": "http", "url": "http://localhost:7850/mcp" },
    "business-rule-mcp":  { "type": "http", "url": "http://localhost:8110/mcp" },
    "script-include-mcp": { "type": "http", "url": "http://localhost:8120/mcp" },
    "client-script-mcp":  { "type": "http", "url": "http://localhost:8140/mcp" }
  }
}
```

Run `claude mcp list` to verify, or `/mcp` inside an interactive session for live status.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MANAGEMENT_PORT` | no (default `3001`) | Port for the management UI / REST API |
| `MANAGEMENT_HOST` | no (default `127.0.0.1`) | Bind address for the management UI |
| `OAUTH_REDIRECT_URL` | no (default `http://localhost:<MANAGEMENT_PORT>/oauth/callback`) | The one redirect URL registered in ServiceNow for OAuth sign-in |
| `MCP_HOST` | no (default all interfaces) | Bind address for the MCP server ports |
| `MCP_APPS_ASSUME_SUPPORT` | no | `1` treats every client as MCP Apps-capable |
| `WRITE_RATE_LIMIT` | no (default `30`) | Write tool calls per session per minute |
| `AUDIT_LOG` | no (default `data/audit.log`) | Audit log path |
| `SN_INSTANCE_URL` | yes | e.g. `https://devXXXXXX.service-now.com` |
| `SN_USERNAME` | yes | ServiceNow user the gateway calls as |
| `SN_PASSWORD` | yes | Password for that user |

Credentials can also be set/updated live via the UI; running MCP servers pick them up immediately, no restart needed.

## Project layout

```
src/
  index.ts          # bootstraps management API + auto-starts saved MCP servers
  routes.ts         # REST API for instance/servers/tools (under /api)
  mcp-manager.ts    # tracks running MCPInstance per server
  mcp-instance.ts   # Express + StreamableHTTPServerTransport per MCP server (tools, ui:// resources)
  servicenow.ts     # REST client + tool dispatcher (Table API / Scripted REST)
  sn-client.ts      # ServiceNow client used by code-backed handlers
  handlers/         # code-backed tools: change.*, approvals.*, app.open
  apps.ts           # ui:// resource HTML: built bundles, spec apps, uploaded HTML (+ App Kit)
  app-spec.ts       # no-code app validation, starter templates, Claude prompt
  app-spec-types.ts # the form / view / approval spec format
  preview.ts        # tool calls from the builder preview (reads live, writes dry-run)
  audit.ts, rate-limit.ts, idempotency.ts
  oauth.ts          # OAuth sign-in: saved credentials, login page, broker to ServiceNow OAuth
  storage.ts        # JSON file persistence
  types.ts          # shared types
apps/
  _kit/             # App Kit: renders specs, injects window.gw into uploaded HTML
  _shared/          # app shell (connect, theme, confirm dialog, call helper)
  change-create/    # change form app
  change-approvals/ # approval inbox app
examples/
  incident-form.html # standard MCP App, installed by scripts/add-incident-app.mjs
scripts/            # build-apps.mjs, add-incident-app.mjs
test/               # vitest suites + fake ServiceNow; e2e-*.ts drive the apps in Chromium
public/
  index.html        # single-file management UI
data/
  store.seed.json   # starter servers and tools (tracked)
  store.json        # your servers, tools and apps (local, gitignored)
  apps/             # uploaded HTML apps (local, gitignored)
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Build apps, then watch apps and run the server with `tsx watch` |
| `npm run build:apps` | Build the App Kit and every app under `apps/` into single-file bundles |
| `npm run build` | Build apps, then TypeScript compile to `dist/` |
| `npm test` | Unit and protocol tests (vitest) |
| `npm run test:e2e` | Drive the app bundles in headless Chromium through a minimal host (needs Playwright) |
| `npx tsx test/e2e-incident.ts` | Install the incident form with its script and drive it in headless Chromium |
| `npm start` | Run the compiled output |

## Notes

- Each MCP session gets its own SDK `Server` instance, because the SDK's `Protocol` class allows only one transport attachment per `Server`. Handlers read live from `storage`, so tool edits propagate to all sessions immediately.
- `data/store.seed.json` ships the bundled servers and tools. Your own changes go to `data/store.json`, which is gitignored, so `git pull` never conflicts with them. `.env` (with the password) is gitignored too.
- Authentication to ServiceNow is HTTP Basic auth using the credentials you configure. Use a least-privilege service account, not a personal admin login, for any non-toy use.

---

### Stay in the loop

If this was useful, follow **[AI by Tushar M on YouTube](https://www.youtube.com/@AIbyTusharM)** — subscribe for more such tools, learning and walkthroughs.
