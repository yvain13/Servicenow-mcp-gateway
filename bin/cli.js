#!/usr/bin/env node
// CLI entry for `npx servicenow-mcp-gateway` / a global install. Keeps all writable state
// (store, OAuth files, uploaded apps, audit log) in a per-user data directory instead of
// inside node_modules, then starts the compiled gateway.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`${pkg.name} ${pkg.version}
${pkg.description}

Usage: npx ${pkg.name} [--data-dir <path>]

Options:
  --data-dir <path>  Where servers, tools, OAuth files and the audit log are stored
                     (default: $SERVICENOW_MCP_DATA_DIR or ~/.servicenow-mcp-gateway)
  -v, --version      Print the version
  -h, --help         Show this help

Configuration is read from environment variables, a .env in the current directory,
or a .env in the data directory. See the README for the full list
(SN_INSTANCE_URL, SN_USERNAME, SN_PASSWORD, MANAGEMENT_PORT, ...).`);
  process.exit(0);
}

const flag = args.indexOf("--data-dir");
const dataDir = resolve(
  (flag >= 0 && args[flag + 1]) || process.env["SERVICENOW_MCP_DATA_DIR"] || join(homedir(), ".servicenow-mcp-gateway"),
);
mkdirSync(dataDir, { recursive: true });
process.env["SERVICENOW_MCP_DATA_DIR"] = dataDir;

// .env in the working directory wins, then the data directory's; real env vars win over both.
dotenv.config({ quiet: true });
dotenv.config({ path: join(dataDir, ".env"), quiet: true });

console.log(`Data directory: ${dataDir}`);
await import("../dist/index.js");
