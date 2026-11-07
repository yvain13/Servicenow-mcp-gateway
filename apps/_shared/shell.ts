// Shared shell for gateway MCP Apps: connects to the host, applies its theme, and provides
// loading/error states, a confirm dialog and a typed call(tool, args) helper. Every read and
// write is a tools/call back through the gateway, which alone holds ServiceNow credentials.
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import "./shell.css";

export class ToolError extends Error {
  constructor(
    message: string,
    readonly structured: Record<string, any> | undefined
  ) {
    super(message);
  }
  get code(): string | undefined {
    return this.structured?.["error"];
  }
  get fieldErrors(): { field: string; message: string }[] {
    return Array.isArray(this.structured?.["errors"]) ? this.structured!["errors"] : [];
  }
}

export interface ShellOptions {
  name: string;
  version?: string;
  onToolInput?: (args: Record<string, unknown>) => void;
  onToolResult?: (structured: Record<string, any> | undefined, isError: boolean) => void;
}

export interface Shell {
  app: App;
  call<T = Record<string, any>>(tool: string, args?: Record<string, unknown>): Promise<T>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  setModelContext(text: string, structured?: Record<string, unknown>): Promise<void>;
  openLink(url: string): void;
}

export interface ConfirmOptions {
  title: string;
  details?: [string, string][];
  confirmLabel?: string;
  danger?: boolean;
}

function applyContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

export async function createShell(opts: ShellOptions): Promise<Shell> {
  // Fallback theme until the host tells us.
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    document.documentElement.dataset["theme"] = "dark";
  }
  const app = new App({ name: opts.name, version: opts.version ?? "1.0.0" });

  // Register handlers before connect() so the initial notifications aren't missed.
  app.ontoolinput = (p) => opts.onToolInput?.((p.arguments ?? {}) as Record<string, unknown>);
  app.ontoolresult = (p) =>
    opts.onToolResult?.(p.structuredContent as Record<string, any> | undefined, p.isError === true);
  app.onhostcontextchanged = (ctx) => applyContext(ctx);
  app.onteardown = async () => ({});

  await app.connect();
  applyContext(app.getHostContext());

  return {
    app,
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = await app.callServerTool({ name: tool, arguments: args });
      const structured = res.structuredContent as Record<string, any> | undefined;
      if (res.isError) {
        const text = res.content?.find((c) => c.type === "text") as { text?: string } | undefined;
        throw new ToolError(structured?.["message"] ?? text?.text ?? `${tool} failed`, structured);
      }
      return (structured ?? {}) as T;
    },
    confirm,
    async setModelContext(text: string, structured?: Record<string, unknown>) {
      try {
        await app.updateModelContext({ content: [{ type: "text", text }], structuredContent: structured });
      } catch {
        /* host may not support model context updates */
      }
    },
    openLink(url: string) {
      app.openLink({ url }).catch(() => window.open(url, "_blank", "noopener"));
    },
  };
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "shell-overlay" });
    const dlg = el("div", { class: "shell-dialog", role: "dialog", "aria-modal": "true" });
    dlg.append(el("h1", {}, opts.title));
    if (opts.details?.length) {
      const dl = el("dl");
      for (const [k, v] of opts.details) dl.append(el("dt", {}, k), el("dd", {}, v || "—"));
      dlg.append(dl);
    }
    const cancel = el("button", { type: "button" }, "Cancel");
    const ok = el("button", { type: "button", class: opts.danger ? "danger" : "primary" }, opts.confirmLabel ?? "Confirm");
    const actions = el("div", { class: "actions" });
    actions.append(cancel, ok);
    dlg.append(actions);
    overlay.append(dlg);
    const done = (v: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done(false);
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    ok.focus();
  });
}

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

export function loading(target: HTMLElement, message = "Loading…"): void {
  target.replaceChildren(el("div", { class: "shell-loading" }, el("span", { class: "spinner" }), message));
}

export function banner(target: HTMLElement, kind: "error" | "ok" | "warn", message: string | Node): HTMLElement {
  const b = el("div", { class: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  target.replaceChildren(b);
  return b;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
