import { readFile, stat } from "fs/promises";
import { isAbsolute, join, normalize } from "path";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ROOT } from "./paths.js";
import { APPS_DATA_DIR } from "./storage.js";
import type { UIApp } from "./types.js";

export { RESOURCE_MIME_TYPE };

export const KIT_PATH = "apps/_kit/dist/kit.js";

function inside(base: string, rel: string, what: string): string {
  const p = normalize(rel);
  if (isAbsolute(p) || p.startsWith("..")) throw new Error(`${what} must be a path inside ${base}: ${rel}`);
  return join(base, p);
}

function sourceOf(app: UIApp): "bundle" | "spec" | "html" {
  return app.source ?? (app.spec ? "spec" : app.file ? "html" : "bundle");
}

// The file whose presence/mtime is the app's "built" status.
function statusPath(app: UIApp): string {
  const src = sourceOf(app);
  if (src === "html") return inside(APPS_DATA_DIR, app.file ?? "", "App file");
  if (src === "spec") return join(ROOT, KIT_PATH);
  return inside(ROOT, app.bundle ?? "", "App bundle");
}

export async function bundleStatus(app: UIApp): Promise<{ built: boolean; bytes?: number; builtAt?: string; source: string }> {
  const source = sourceOf(app);
  try {
    const s = await stat(statusPath(app));
    return { built: true, bytes: s.size, builtAt: s.mtime.toISOString(), source };
  } catch {
    return { built: false, source };
  }
}

let kitCache: { mtime: number; js: string } | undefined;

async function kitScript(): Promise<string | undefined> {
  const p = join(ROOT, KIT_PATH);
  try {
    const s = await stat(p);
    if (!kitCache || kitCache.mtime !== s.mtimeMs) {
      kitCache = { mtime: s.mtimeMs, js: await readFile(p, "utf8") };
    }
    return kitCache.js;
  } catch {
    return undefined;
  }
}

// Inline <script> content must not close the tag early.
function scriptSafe(s: string): string {
  return s.replace(/<\/(script)/gi, "<\\/$1");
}

function notBuilt(app: UIApp, what: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:16px">
<p><strong>${escapeHtml(app.name)}</strong> cannot be shown: ${escapeHtml(what)}.</p>
<p>Run <code>npm run build:apps</code> on the gateway.</p></body>`;
}

export function renderSpecPage(app: UIApp, kit: string): string {
  const spec = JSON.stringify(app.spec ?? {}).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(app.name)}</title></head>
<body><div id="root"></div>
<script type="application/json" id="app-spec">${spec}</script>
<script>${scriptSafe(kit)}</script>
</body></html>`;
}

// Puts the kit first in <head>, so window.gw exists before the page's own scripts run.
export function injectKit(html: string, kit: string): string {
  const tag = `<script>${scriptSafe(kit)}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head><meta charset="utf-8">${tag}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${tag}</head><body>${html}</body></html>`;
}

export async function readBundle(app: UIApp): Promise<string> {
  const src = sourceOf(app);
  if (src === "bundle") {
    try {
      return await readFile(inside(ROOT, app.bundle ?? "", "App bundle"), "utf8");
    } catch {
      // Keep resources/read working so the host shows something useful.
      return notBuilt(app, "its bundle is not built");
    }
  }
  const kit = await kitScript();
  if (!kit) return notBuilt(app, "the App Kit is not built");
  if (src === "spec") return renderSpecPage(app, kit);
  try {
    return injectKit(await readFile(inside(APPS_DATA_DIR, app.file ?? "", "App file"), "utf8"), kit);
  } catch {
    return notBuilt(app, "its HTML file is missing");
  }
}

// Preview of an HTML app that is not saved yet.
export async function renderDraftHtml(html: string): Promise<string> {
  const kit = await kitScript();
  return kit ? injectKit(html, kit) : notBuilt({ uri: "", name: "Preview" }, "the App Kit is not built");
}

export function appMeta(app: UIApp): Record<string, unknown> {
  return {
    ui: {
      csp: {
        connectDomains: app.csp?.connectDomains ?? [],
        resourceDomains: app.csp?.resourceDomains ?? [],
      },
      prefersBorder: true,
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
