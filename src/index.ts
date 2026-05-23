import "dotenv/config";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { MCPManager } from "./mcp-manager.js";
import { buildRouter } from "./routes.js";
import * as storage from "./storage.js";
import type { SNCredentials } from "./servicenow.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MANAGEMENT_PORT = Number(process.env["MANAGEMENT_PORT"] ?? 3001);

function credsFromEnv(): SNCredentials {
  return {
    instanceUrl: process.env["SN_INSTANCE_URL"] ?? "",
    username: process.env["SN_USERNAME"] ?? "",
    password: process.env["SN_PASSWORD"] ?? "",
  };
}

async function main(): Promise<void> {
  const manager = new MCPManager(credsFromEnv());

  // Auto-start servers that were running before (all stored servers on startup)
  const stored = storage.listServers();
  await Promise.all(
    stored.map((s) =>
      manager.start(s).catch((err) =>
        console.warn(`[mcp] could not auto-start ${s.name}: ${err}`)
      )
    )
  );

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Management REST API
  app.use("/api", buildRouter(manager, credsFromEnv));

  // Serve the UI
  app.use(express.static(join(__dir, "../public")));
  app.get("*", (_req, res) => {
    res.sendFile(join(__dir, "../public/index.html"));
  });

  app.listen(MANAGEMENT_PORT, () => {
    console.log(`\n  Management UI  →  http://localhost:${MANAGEMENT_PORT}`);
    console.log(`  API base       →  http://localhost:${MANAGEMENT_PORT}/api\n`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await manager.stopAll();
    process.exit(0);
  });
}

main().catch(console.error);
