// Builds the App Kit (apps/_kit → apps/_kit/dist/kit.js, used by spec and uploaded HTML apps)
// and every app under apps/ (each folder with an index.html, except _*) into a single-file
// bundle. `--watch` rebuilds on change.
import { build } from "vite";
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const appsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps");
const watch = process.argv.includes("--watch");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const apps = readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(appsDir, d.name, "index.html")))
  .map((d) => d.name)
  .filter((n) => only.length === 0 || only.includes(n));

if (only.length === 0 || only.includes("_kit")) {
  const kitDir = join(appsDir, "_kit");
  await build({
    configFile: false,
    root: kitDir,
    logLevel: "warn",
    build: {
      lib: { entry: join(kitDir, "kit.ts"), formats: ["iife"], name: "GatewayKit", fileName: () => "kit.js" },
      outDir: join(kitDir, "dist"),
      emptyOutDir: true,
      target: "es2022",
      minify: true,
      watch: watch ? {} : undefined,
    },
  });
  // The official SDK for standard HTML apps, as window.McpExtApps.
  await build({
    configFile: false,
    root: kitDir,
    logLevel: "warn",
    build: {
      lib: { entry: join(kitDir, "ext-apps.ts"), formats: ["iife"], name: "McpExtAppsBuild", fileName: () => "ext-apps.js" },
      outDir: join(kitDir, "dist"),
      emptyOutDir: false,
      target: "es2022",
      minify: true,
      watch: watch ? {} : undefined,
    },
  });
  console.log("[apps] built App Kit → apps/_kit/dist/kit.js, ext-apps.js");
}

for (const app of apps) {
  process.env.APP = app;
  await build({
    configFile: join(appsDir, "vite.config.ts"),
    build: watch ? { watch: {} } : undefined,
  });
  console.log(`[apps] built ${app} → apps/${app}/dist/index.html`);
}
if (watch) console.log("[apps] watching for changes…");
