import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Project root (src/ in dev via tsx, dist/ when built — both one level below the root).
export const ROOT = join(__dir, "..");
// Shipped, read-only data (the seed store).
export const SEED_DIR = join(ROOT, "data");
// Writable data: store, OAuth files, uploaded apps, audit log. Defaults to data/ in a clone;
// the npx/global CLI points it at ~/.servicenow-mcp-gateway so nothing is written into node_modules.
export const DATA_DIR = process.env["SERVICENOW_MCP_DATA_DIR"]
  ? resolve(process.env["SERVICENOW_MCP_DATA_DIR"])
  : SEED_DIR;
