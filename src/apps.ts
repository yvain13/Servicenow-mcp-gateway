import { readFile, stat } from "fs/promises";
import { isAbsolute, join, normalize } from "path";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ROOT } from "./paths.js";
import { APPS_DATA_DIR } from "./storage.js";
import type { UIApp } from "./types.js";

export { RESOURCE_MIME_TYPE };

export const KIT_PATH = "apps/_kit/dist/kit.js";
export const EXT_APPS_PATH = "apps/_kit/dist/ext-apps.js";

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

const cache = new Map<string, { mtime: number; js: string }>();

async function builtScript(rel: string): Promise<string | undefined> {
  const p = join(ROOT, rel);
  try {
    const s = await stat(p);
    const hit = cache.get(rel);
    if (hit && hit.mtime === s.mtimeMs) return hit.js;
    const js = await readFile(p, "utf8");
    cache.set(rel, { mtime: s.mtimeMs, js });
    return js;
  } catch {
    return undefined;
  }
}

const kitScript = () => builtScript(KIT_PATH);

// ── Uploaded HTML: two formats ───────────────────────────────────────────────
// "standard": written against the official SDK (import { App } from "@modelcontextprotocol/ext-apps"),
//   as in the MCP Apps docs and ServiceNow's MCP Server Console. Served as written; only the
//   SDK import is pointed at a bundled copy, so no CDN is needed and the same file works on
//   either platform.
// "kit": uses the gateway's window.gw helper, which is injected before the page's scripts.
export type HtmlFormat = "standard" | "kit";

const EXT_SPEC = String.raw`[^'"]*@modelcontextprotocol\/ext-apps(?:@[\w.^~-]+)?(?:\/app-with-deps|\/app|\/\+esm|\/dist\/src\/app(?:-with-deps)?\.js)?(?:\?[^'"]*)?`;
const EXT_IMPORT = new RegExp(String.raw`import\s*(\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s*from\s*(['"])(${EXT_SPEC})\2[ \t]*;?`, "g");
const EXT_DYNAMIC = new RegExp(String.raw`import\(\s*(['"])${EXT_SPEC}\1\s*\)`, "g");

export function htmlFormat(html: string): HtmlFormat {
  return /@modelcontextprotocol\/ext-apps|\bnew\s+App\s*\(/.test(html) && !/\bgw\.(call|onInput|onResult|mount)\b/.test(html)
    ? "standard"
    : "kit";
}

function bindingsFor(clause: string): string {
  const c = clause.trim();
  if (c.startsWith("{")) return c.replace(/\b([\w$]+)\s+as\s+([\w$]+)/g, "$1: $2");
  if (c.startsWith("*")) return c.replace(/^\*\s*as\s+/, "");
  return c; // default import: the namespace
}

// Rewrites SDK imports to read window.McpExtApps. Returns the html unchanged if there are none.
export function rewriteSdkImports(html: string): { html: string; rewritten: number } {
  let rewritten = 0;
  const out = html
    .replace(EXT_IMPORT, (_m, clause: string) => {
      rewritten++;
      return `const ${bindingsFor(clause)} = window.McpExtApps;`;
    })
    .replace(EXT_DYNAMIC, () => {
      rewritten++;
      return "Promise.resolve(window.McpExtApps)";
    });
  return { html: out, rewritten };
}

function injectHead(html: string, tag: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head><meta charset="utf-8">${tag}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${tag}</head><body>${html}</body></html>`;
}

export function prepareStandard(html: string, sdk: string): string {
  const { html: out, rewritten } = rewriteSdkImports(html);
  return rewritten ? injectHead(out, `<script>${scriptSafe(sdk)}</script>`) : html;
}

async function renderHtml(html: string): Promise<string> {
  if (htmlFormat(html) === "standard") {
    const sdk = await builtScript(EXT_APPS_PATH);
    return sdk ? prepareStandard(html, sdk) : notBuilt({ uri: "", name: "This app" }, "the bundled MCP Apps SDK is not built");
  }
  const kit = await kitScript();
  return kit ? injectKit(html, kit) : notBuilt({ uri: "", name: "This app" }, "the App Kit is not built");
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
  return injectHead(html, `<script>${scriptSafe(kit)}</script>`);
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
  if (src === "spec") {
    const kit = await kitScript();
    return kit ? renderSpecPage(app, kit) : notBuilt(app, "the App Kit is not built");
  }
  let html: string;
  try {
    html = await readFile(inside(APPS_DATA_DIR, app.file ?? "", "App file"), "utf8");
  } catch {
    return notBuilt(app, "its HTML file is missing");
  }
  return renderHtml(html);
}

// Preview of an HTML app that is not saved yet.
export async function renderDraftHtml(html: string): Promise<string> {
  return renderHtml(html);
}

export function appMeta(app: UIApp): Record<string, unknown> {
  const ui: Record<string, unknown> = {
    csp: {
      connectDomains: app.csp?.connectDomains ?? [],
      resourceDomains: app.csp?.resourceDomains ?? [],
    },
    prefersBorder: true,
  };
  if (app.permissions?.length) ui["permissions"] = Object.fromEntries(app.permissions.map((p) => [p, {}]));
  return { ui };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
