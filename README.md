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
                                                   ├─ apps-demo           (port 7830)  ← MCP Apps sample
                                                   ├─ cmdb-server         (port 7850)
                                                   ├─ business-rule-mcp   (port 8110)
                                                   ├─ script-include-mcp  (port 8120)
                                                   └─ client-script-mcp   (port 8140)
```

- **Management process** serves the web UI on `MANAGEMENT_PORT` (default `3001`) and a REST API at `/api`.
- **Each MCP server** is its own Express app on its own port, mounting `POST/GET/DELETE /mcp` via the official MCP TypeScript SDK's `StreamableHTTPServerTransport`.
- **Tools** are persisted to `data/store.json` (checked in — see [Bundled MCP servers](#bundled-mcp-servers)) and read live on every `tools/list` and `tools/call`, so adding or editing a tool takes effect immediately without restarting clients.

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

Open the management UI at <http://localhost:3001>. The repo ships with six MCP servers pre-configured (see [Bundled MCP servers](#bundled-mcp-servers)) — they auto-start on launch. From the UI you can:

1. Click **Connect Instance** and paste your ServiceNow URL, username, and password. The gateway tests the connection before saving.
2. Browse the pre-bundled servers in the sidebar — click any tool to edit, or click **Add Tool** to extend a server.
3. Click **Create MCP Server** to spin up a new one on a fresh port.
4. Click **Config snippet** on any server to get the JSON to paste into Claude Desktop / Claude Code.

## Bundled MCP servers

These ship in `data/store.json` and start automatically. Tool definitions are live-editable from the UI.

| Server | Port | Target table | Tools |
|---|---|---|---|
| `incident-mcp` | 7801 | `incident` | `get_incident`, `list_incidents`, `create_incident`, `update_incident` |
| `change-ops` | 7820 | `change_request` | `get_change`, `create_change`, `update_change`, plus the change apps below |
| `apps-demo` | 7830 | — | `open_hello`, `hello_echo` (Phase 1 sample app) |
| `cmdb-server` | 7850 | `cmdb_ci` | `get_cmdb_ci` |
| `business-rule-mcp` | 8110 | `sys_script` | `create_business_rule`, `list_business_rules`, `get_business_rule`, `update_business_rule` |
| `script-include-mcp` | 8120 | `sys_script_include` | `create_script_include`, `list_script_includes`, `get_script_include`, `update_script_include` |
| `client-script-mcp` | 8140 | `sys_script_client` | `create_client_script`, `list_client_scripts`, `get_client_script`, `update_client_script` |

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

With `mcp-remote`, pass the header like this (keep the credentials in an env var, not in the config file you share):

```json
"change-ops": {
  "command": "npx",
  "args": ["mcp-remote", "http://localhost:7820/mcp", "--header", "Authorization:${SN_BASIC_AUTH}"],
  "env": { "SN_BASIC_AUTH": "Basic <base64 of user:password>" }
}
```

Per-user OAuth (ServiceNow as authorization server, the gateway forwarding each user's token) is the target for any shared deployment and is not built yet.

### Governance

- Write tools (handlers marked `write`, and REST tools that aren't `GET`) are rate-limited per session (`WRITE_RATE_LIMIT`, default 30/min) and appended to `data/audit.log` as JSON lines: `{ time, caller, server, tool, record, decision, ok }`.
- Search text is stripped of `^` and `=` before it goes into `sysparm_query`, so typed text can't add encoded-query clauses.
- The management UI binds to `127.0.0.1` by default (`MANAGEMENT_HOST` to change), since it can edit tools and credentials.

### Building and authoring apps

Apps live under `apps/<name>/` (an `index.html` + TypeScript) and are built with Vite and `vite-plugin-singlefile` into one self-contained `apps/<name>/dist/index.html`. `apps/_shared/` holds the shell every app uses: host connection, theme, loading and error states, a confirm dialog, and `call(tool, args)`.

To add an app: create `apps/<name>/`, add `{ uri, name, bundle }` to the server's `apps` in `data/store.json`, add a handler in `src/handlers/` and register it in `src/handlers/index.ts`, then link tools to the app from the UI (tool card → **App** and **Visible to**). The server's **Apps** tab shows each `ui://` resource, its bundle status and linked tools.

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
  handlers/         # code-backed tools: demo.*, change.*, approvals.*
  apps.ts           # ui:// bundle loading
  audit.ts, rate-limit.ts, idempotency.ts
  storage.ts        # JSON file persistence
  types.ts          # shared types
apps/
  _shared/          # app shell (connect, theme, confirm dialog, call helper)
  change-create/    # change form app
  change-approvals/ # approval inbox app
  hello/            # Phase 1 sample app
test/               # vitest suites + fake ServiceNow; e2e-host.ts drives the apps in Chromium
public/
  index.html        # single-file management UI
data/
  store.json        # persisted server + tool definitions (checked in)
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Build apps, then watch apps and run the server with `tsx watch` |
| `npm run build:apps` | Build every app under `apps/` into single-file bundles |
| `npm run build` | Build apps, then TypeScript compile to `dist/` |
| `npm test` | Unit and protocol tests (vitest) |
| `npm run test:e2e` | Drive the app bundles in headless Chromium through a minimal host (needs Playwright) |
| `npm start` | Run the compiled output |

## Notes

- Each MCP session gets its own SDK `Server` instance, because the SDK's `Protocol` class allows only one transport attachment per `Server`. Handlers read live from `storage`, so tool edits propagate to all sessions immediately.
- `data/store.json` is checked in so the bundled server + tool catalog ships with the repo. Your `.env` (with the password) is gitignored.
- Authentication to ServiceNow is HTTP Basic auth using the credentials you configure. Use a least-privilege service account, not a personal admin login, for any non-toy use.

---

### Stay in the loop

If this was useful, follow **[AI by Tushar M on YouTube](https://www.youtube.com/@AIbyTusharM)** — subscribe for more such tools, learning and walkthroughs.
