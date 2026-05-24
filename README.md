# snow-mcp-gateway

> Built by **[@AIbyTusharM](https://www.youtube.com/@AIbyTusharM)** — subscribe for more such tools, learning and walkthroughs.

A local gateway that turns ServiceNow REST APIs into MCP (Model Context Protocol) tools, so they can be used by Claude Desktop, Claude Code, or any MCP-compatible client.

You point the gateway at a ServiceNow instance, declare tools in a web UI (each tool wraps a Table API or Scripted REST endpoint), and the gateway exposes them as MCP servers over **Streamable HTTP**. Each MCP server runs on its own port and can be hot-edited without restarting clients.

## Architecture

```
Claude Desktop ──stdio──▶ mcp-remote ──HTTP──▶ snow-mcp-gateway ──REST──▶ ServiceNow
                                                  │
                                                  ├─ Management UI (port 3001)
                                                  ├─ MCP server "incident-mcp" (port 7801)
                                                  └─ MCP server "change-ops"   (port 7820)
```

- **Management process** serves the web UI on `MANAGEMENT_PORT` (default `3001`) and a REST API at `/api`.
- **Each MCP server** is its own Express app on its own port, mounting `POST/GET/DELETE /mcp` via the official MCP TypeScript SDK's `StreamableHTTPServerTransport`.
- **Tools** are persisted to `data/store.json` and read live on every `tools/list` and `tools/call`, so adding or editing a tool takes effect immediately without restarting clients.

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

Open the management UI at <http://localhost:3001>. From there:

1. Click **Connect Instance** and paste your ServiceNow URL, username, and password. The gateway will test the connection before saving.
2. Click **Create MCP Server**, give it a name (e.g. `incident-mcp`) and a port (e.g. `7801`).
3. Click **Add Tool** on the server, fill in the name/description/method/endpoint, and declare parameters.
4. Click the **Config snippet** button — copy the JSON it generates.

## Wiring into Claude Desktop

The gateway speaks Streamable HTTP. Claude Desktop speaks stdio. Bridge them with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "incident-mcp": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:7801/mcp"]
    }
  }
}
```

Restart Claude Desktop. The tools you defined in the UI will appear as native MCP tools.

The **Config snippet** button in the UI generates this JSON for you with the correct port.

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
  store.json        # persisted server + tool definitions (gitignored)
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with `tsx watch` (auto-reload) |
| `npm run build` | TypeScript compile to `dist/` |
| `npm start` | Run the compiled output |

## Notes

- Each MCP session gets its own SDK `Server` instance, because the SDK's `Protocol` class allows only one transport attachment per `Server`. Handlers read live from `storage`, so tool edits propagate to all sessions immediately.
- The data file (`data/store.json`) and your `.env` are gitignored.
- Authentication to ServiceNow is HTTP Basic auth using the credentials you configure. Use a least-privilege service account, not a personal admin login, for any non-toy use.

---

### Stay in the loop

If this was useful, follow **[AI by Tushar M on YouTube](https://www.youtube.com/@AIbyTusharM)** — subscribe for more such tools, learning and walkthroughs.
