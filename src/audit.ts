import { appendFile } from "fs/promises";
import { join } from "path";
import { DATA_DIR } from "./paths.js";

export interface AuditEntry {
  time: string;
  caller: string;
  server: string;
  tool: string;
  record?: string;
  decision?: string;
  ok: boolean;
}

let auditFile = process.env["AUDIT_LOG"] ?? join(DATA_DIR, "audit.log");

export function setAuditFile(path: string): void {
  auditFile = path;
}

// Append-only JSON-lines log of every write tool call. ServiceNow's own history stays
// the system of record; this records what the gateway did on whose behalf.
export async function audit(entry: Omit<AuditEntry, "time">): Promise<void> {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n";
  try {
    await appendFile(auditFile, line);
  } catch (err) {
    console.warn(`[audit] could not write ${auditFile}: ${err}`);
  }
}
