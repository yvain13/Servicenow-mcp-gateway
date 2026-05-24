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
                                                   ├─ change-ops          (port 7820)
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
| `change-ops` | 7820 | `change_request` | `get_change`, `create_change`, `update_change` |
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
| `SN_INSTANCE_URL` | yes | e.g. `https://devXXXXXX.service-now.com` |
| `SN_USERNAME` | yes | ServiceNow user the gateway calls as |
| `SN_PASSWORD` | yes | Password for that user |

Credentials can also be set/updated live via the UI; the running process picks them up immediately.

## Project layout

```
src/
  index.ts          # bootstraps management API + auto-starts saved MCP servers
  routes.ts         # REST API for instance/servers/tools (under /api)
  mcp-manager.ts    # tracks running MCPInstance per server
  mcp-instance.ts   # Express + StreamableHTTPServerTransport per MCP server
  servicenow.ts     # REST client + tool dispatcher (Table API / Scripted REST)
  storage.ts        # JSON file persistence
  types.ts          # shared types
public/
  index.html        # single-file management UI
data/
  store.json        # persisted server + tool definitions (checked in)
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with `tsx watch` (auto-reload) |
| `npm run build` | TypeScript compile to `dist/` |
| `npm start` | Run the compiled output |

## Notes

- Each MCP session gets its own SDK `Server` instance, because the SDK's `Protocol` class allows only one transport attachment per `Server`. Handlers read live from `storage`, so tool edits propagate to all sessions immediately.
- `data/store.json` is checked in so the bundled server + tool catalog ships with the repo. Your `.env` (with the password) is gitignored.
- Authentication to ServiceNow is HTTP Basic auth using the credentials you configure. Use a least-privilege service account, not a personal admin login, for any non-toy use.

---

### Stay in the loop

If this was useful, follow **[AI by Tushar M on YouTube](https://www.youtube.com/@AIbyTusharM)** — subscribe for more such tools, learning and walkthroughs.
