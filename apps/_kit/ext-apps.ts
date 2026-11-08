// The official MCP Apps client SDK as a classic script that sets window.McpExtApps. The gateway
// inlines it into standard (SDK-based) HTML apps and points their
// `import { App } from ".../@modelcontextprotocol/ext-apps..."` at it, so those apps run
// without fetching the SDK from a CDN, and the uploaded file stays exactly as written.
import * as ExtApps from "@modelcontextprotocol/ext-apps";

(window as any).McpExtApps = ExtApps;
