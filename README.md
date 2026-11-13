<p align="center">
  <img src="docs/img/banner.svg" alt="ServiceNow MCP Gateway: your ServiceNow, as MCP tools for Claude" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/servicenow-mcp-gateway"><img alt="npm" src="https://img.shields.io/npm/v/servicenow-mcp-gateway?label=npm&color=2E8B57"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-1B5E3F">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-143F2C?labelColor=555">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Attribution%20required-E8590C"></a>
</p>

<h1 align="center">ServiceNow MCP Gateway</h1>

<p align="center"><b>Turn any ServiceNow Table API or Scripted REST API into an MCP tool in a minute, and show real ServiceNow forms right inside the chat.</b></p>

<p align="center">Works with Claude, Cursor, Copilot, Gemini CLI, or any MCP client.</p>

<p align="center"><a href="https://yvain13.github.io/Servicenow-mcp-gateway/"><b>Full tour, guides and agent setup skill →</b></a></p>

## How it works

1. **Point it at your instance.** One `npx` command starts the gateway and its web UI.
2. **Turn an API into a tool.** Pick a table (`incident`, `change_request`, any custom table) or paste a Scripted REST endpoint, name the tool and its parameters. No code.
3. **Connect your AI.** Copy the config snippet into Claude or any MCP client. The tool is live, and later edits reach the client without a restart.
4. **Show forms in the chat.** Attach a form to a server and the AI opens it in the conversation, prefilled from what you said. Submitting it creates the record in ServiceNow.

## Features

- **Any API, as a tool:** Table API (get, list, create, update) and Scripted REST endpoints, built and edited live from the web UI.
- **ServiceNow forms in the chat (MCP Apps):** incident and change forms with reference lookups and choice lists from your instance, plus approval inboxes. Build your own from a JSON spec or one HTML file.
- **8 ready-made servers:** incidents, changes, problems, CMDB, servers, business rules, script includes, client scripts.
- **OAuth sign-in** through ServiceNow's own login (SSO works), so ACLs and approvals apply to the real user.
- **Governance:** write rate limits, a JSON audit log, and a management UI bound to localhost.

## Install

Requires Node.js 20+.

```bash
SN_INSTANCE_URL=https://devXXXXXX.service-now.com SN_USERNAME=... SN_PASSWORD=... npx servicenow-mcp-gateway
```

Open <http://localhost:3001>, pick a server, click **Config snippet**, and paste the config into your client. You can also set the instance in the UI instead of env vars. Run `npx servicenow-mcp-gateway --help` for options.

No instance? Get a free Personal Developer Instance at [developer.servicenow.com](https://developer.servicenow.com).

## Connect a client

Claude Code:

```bash
claude mcp add --transport http incident-mcp http://localhost:7801/mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "incident-mcp": { "command": "npx", "args": ["mcp-remote", "http://localhost:7801/mcp"] }
  }
}
```

Then just ask: "How many P1 incidents are open?", "Open the incident form for a VPN outage", "Open the change form for tonight's DB patch", "Show my pending approvals".

## Develop from source

```bash
git clone https://github.com/yvain13/Servicenow-mcp-gateway.git
cd Servicenow-mcp-gateway
npm install
cp .env.example .env   # add your instance and credentials
npm run dev
```

`npm test` runs the test suite. The [website](https://yvain13.github.io/Servicenow-mcp-gateway/) walks through servers and tools, apps inside the chat, connecting clients, and an agent skill that sets it all up for you.

## License

Free to use, modify and share under the [ServiceNow MCP Gateway Attribution License](LICENSE). If you fork it, ship it, offer it as a service, or show it in a blog, video or talk, credit the author:

> Built with [ServiceNow MCP Gateway](https://github.com/yvain13/Servicenow-mcp-gateway) by **Tushar Mishra**

---

<p align="center">
  Made by <b>Tushar Mishra</b> · <a href="https://www.youtube.com/@AIbyTusharM">AI by Tushar M on YouTube</a><br>
  <sub>ServiceNow is a trademark of ServiceNow, Inc. This project is independent and not affiliated with it.</sub>
</p>
