// Builds every app under apps/ (each folder with an index.html, except _shared) into a
// single-file bundle. `--watch` rebuilds on change.
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

for (const app of apps) {
  process.env.APP = app;
  await build({
    configFile: join(appsDir, "vite.config.ts"),
    build: watch ? { watch: {} } : undefined,
  });
  console.log(`[apps] built ${app} → apps/${app}/dist/index.html`);
}
if (watch) console.log("[apps] watching for changes…");
