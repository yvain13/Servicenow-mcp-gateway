import { readFile, stat } from "fs/promises";
import { isAbsolute, join, normalize } from "path";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ROOT } from "./paths.js";
import type { UIApp } from "./types.js";

export { RESOURCE_MIME_TYPE };

function bundlePath(app: UIApp): string {
  const p = normalize(app.bundle);
  if (isAbsolute(p) || p.startsWith("..")) {
    throw new Error(`App bundle must be a path inside the project: ${app.bundle}`);
  }
  return join(ROOT, p);
}

export async function bundleStatus(app: UIApp): Promise<{ built: boolean; bytes?: number; builtAt?: string }> {
  try {
    const s = await stat(bundlePath(app));
    return { built: true, bytes: s.size, builtAt: s.mtime.toISOString() };
  } catch {
    return { built: false };
  }
}

export async function readBundle(app: UIApp): Promise<string> {
  try {
    return await readFile(bundlePath(app), "utf8");
  } catch {
    // Keep resources/read working so the host shows something useful.
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:16px">
<p><strong>${escapeHtml(app.name)}</strong> is not built.</p>
<p>Run <code>npm run build:apps</code> on the gateway.</p></body>`;
  }
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
