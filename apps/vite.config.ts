import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "path";

// Builds one app (APP env var) into apps/<APP>/dist/index.html as a single self-contained
// file: the host loads it from resources/read, so nothing may be fetched externally.
const app = process.env["APP"];
if (!app) throw new Error("Set APP=<folder under apps/>");

export default defineConfig({
  root: resolve(import.meta.dirname, app),
  plugins: [viteSingleFile()],
  logLevel: "warn",
  build: {
    outDir: resolve(import.meta.dirname, app, "dist"),
    emptyOutDir: true,
    target: "es2022",
    minify: true,
  },
});
