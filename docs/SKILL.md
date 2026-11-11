---
name: servicenow-mcp-gateway
description: Install and run the ServiceNow MCP Gateway locally, connect it to the user's ServiceNow instance, and hand back the MCP server names, URLs and client config. Use when the user wants ServiceNow tools (incidents, changes, CMDB, business rules, script includes, client scripts, problems) available in Claude Code, Claude Desktop or another MCP client.
---

# ServiceNow MCP Gateway

The gateway is a local Node.js app. It turns ServiceNow REST APIs into MCP tools and serves several
MCP servers, each on its own port, plus a management UI on port 3001.

Package: `servicenow-mcp-gateway` on npm · Source: https://github.com/yvain13/Servicenow-mcp-gateway

Work through the steps in order. Do the work yourself; only stop to ask the user for what is listed
in step 2.

## 1. Check prerequisites

```bash
node --version
```

Node 20 or newer is required. If it is missing or older, tell the user and stop.

Check whether a gateway is already running:

```bash
curl -s http://localhost:3001/api/servers
```

If that returns a JSON list, the gateway is already up: skip to step 5.

## 2. Get the ServiceNow details

Ask the user for:

- **Instance URL**, e.g. `https://dev12345.service-now.com`
- **Username** and **password** of the account the gateway should call ServiceNow as
  (a least-privilege service account, or their own PDI admin for a personal dev instance)

Do not echo the password back in chat or put it in any file other than the `.env` below.
If the user would rather enter credentials in the browser, skip this step and use the UI in step 4.

Write them to the gateway's data directory (create it if needed):

```bash
mkdir -p ~/.servicenow-mcp-gateway
cat > ~/.servicenow-mcp-gateway/.env <<'EOF'
SN_INSTANCE_URL=https://dev12345.service-now.com
SN_USERNAME=the_username
SN_PASSWORD=the_password
EOF
chmod 600 ~/.servicenow-mcp-gateway/.env
```

On Windows use `%USERPROFILE%\.servicenow-mcp-gateway\.env` with the same three lines.

## 3. Start the gateway

Start it in the background so it keeps running, and log to a file:

```bash
nohup npx -y servicenow-mcp-gateway > ~/.servicenow-mcp-gateway/gateway.log 2>&1 &
```

Then wait until it is up (up to ~60 s on the first run while npm downloads it):

```bash
for i in $(seq 1 30); do curl -sf http://localhost:3001/api/servers >/dev/null && break; sleep 2; done
tail -n 20 ~/.servicenow-mcp-gateway/gateway.log
```

The log lists one line per MCP server, e.g. `[mcp] incident-mcp → http://localhost:7801/mcp`.

If port 3001 is taken, start it with another port and use that port everywhere below:
`MANAGEMENT_PORT=3002 npx -y servicenow-mcp-gateway`.

If `npx` cannot find the package, run it from source instead:

```bash
git clone https://github.com/yvain13/Servicenow-mcp-gateway.git
cd Servicenow-mcp-gateway && npm install && npm run build
nohup npm start > gateway.log 2>&1 &
```

## 4. Make sure ServiceNow is connected

```bash
curl -s http://localhost:3001/api/instance
```

If it returns `{}` the instance is not configured. Either set it through the API:

```bash
curl -s -X PUT http://localhost:3001/api/instance \
  -H 'content-type: application/json' \
  -d '{"url":"https://dev12345.service-now.com","username":"the_username","password":"the_password"}'
```

or tell the user to open http://localhost:3001 and click **Instance** in the sidebar.
A `Cannot reach instance` error means the URL or credentials are wrong, or the instance is
hibernating (wake a PDI at developer.servicenow.com).

## 5. Collect the MCP servers

```bash
curl -s http://localhost:3001/api/servers
```

Each entry has `name`, `id`, `port`, `endpointUrl`, `running` and `tools`. By default there are:

| Server | Port | What it covers |
|---|---|---|
| incident-mcp | 7801 | Get and create incidents |
| change-ops | 7820 | Change requests, approvals, change forms (MCP Apps) |
| cmdb_server | 7850 | CMDB CI lookup |
| server_mcp | 7890 | Server CIs |
| business_rule_mcp | 8110 | Business rules |
| script_include_mcp | 8120 | Script includes |
| client_script_mcp | 8140 | Client scripts |
| problem-mcp-server | 8900 | Problems |

The user may have changed these, so trust the API output over this table. If a server shows
`"running": false`, start it: `curl -s -X POST http://localhost:3001/api/servers/<id>/start`.

For the exact client config of one server:

```bash
curl -s http://localhost:3001/api/servers/<id>/config-snippet
```

It returns `claudeCode` (a `claude mcp add` command), `claudeCodeJson` (for `.mcp.json`) and
`json` (for Claude Desktop).

## 6. Connect the client

Ask which servers the user wants if they did not say; default to all of them.

**Claude Code** — run each server's `claudeCode` command, for example:

```bash
claude mcp add --transport http incident-mcp http://localhost:7801/mcp
claude mcp add --transport http change-ops http://localhost:7820/mcp
```

Add `--scope user` to make them available in every project. Verify with `claude mcp list`.

**Claude Desktop** — merge each server's `json` snippet into `mcpServers` in the config file
(do not overwrite other entries), then tell the user to restart Claude Desktop:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Other MCP clients** — give the Streamable HTTP URL from `endpointUrl`
(`http://localhost:<port>/mcp`).

## 7. Report back

Finish with a short summary:

- The management UI link: http://localhost:3001
- A table of the servers you connected: name, URL, number of tools
- Where settings live: `~/.servicenow-mcp-gateway` (servers, tools, `.env`, `audit.log`)
- How to stop it: `pkill -f servicenow-mcp-gateway` (or stop the `npm start` process when run from source), and how to start it again (step 3)
- That tools and apps can be added or edited in the UI and take effect without restarting the client
