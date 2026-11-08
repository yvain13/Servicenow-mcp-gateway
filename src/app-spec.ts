// Validation, starter templates and the "write it with Claude" prompt for no-code apps.
// An app is either a JSON spec (form / view / approval, rendered by the App Kit) or one
// self-contained HTML file that uses `window.gw`. Both are checked against the server's
// real tools before they are saved.
import type { AppSpec, AppSpecType, FieldSpec } from "./app-spec-types.js";
import type { MCPServer, Tool } from "./types.js";
import { isWriteTool, visibilityOf } from "./mcp-instance.js";
import { htmlFormat, rewriteSdkImports, type HtmlFormat } from "./apps.js";

export type { AppSpec, AppSpecType };

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  notes?: string[]; // guidance that is not a problem
  tools: { name: string; write: boolean; appVisible: boolean }[]; // tools the app calls
  format?: HtmlFormat; // HTML apps: "standard" (official SDK) or "kit" (window.gw)
  csp?: { resourceDomains: string[]; connectDomains: string[] }; // HTML apps: external origins it uses
  showsResult?: boolean; // HTML apps: renders the result of the tool that opens it
}

export const MAX_HTML_BYTES = 1_500_000;
export const MAX_SPEC_BYTES = 100_000;

const FIELD_TYPES = new Set(["text", "textarea", "number", "select", "date", "datetime", "checkbox", "lookup"]);
const NAME = /^[A-Za-z_][\w]*$/;

class Report {
  errors: string[] = [];
  warnings: string[] = [];
  private used = new Map<string, Tool | undefined>();
  constructor(private readonly server: MCPServer) {}

  err(m: string) { this.errors.push(m); }
  warn(m: string) { this.warnings.push(m); }

  // A tool the app calls: must exist on this server and be callable from an app.
  tool(name: unknown, where: string, opts: { write?: "confirm" | "noconfirm" } = {}): Tool | undefined {
    if (typeof name !== "string" || !name) {
      this.err(`${where}: "tool" is required`);
      return undefined;
    }
    const tool = this.server.tools.find((t) => t.name === name);
    this.used.set(name, tool);
    if (!tool) {
      this.err(`${where}: tool "${name}" does not exist on server "${this.server.name}"`);
      return undefined;
    }
    if (!visibilityOf(tool).includes("app")) {
      this.err(`${where}: tool "${name}" is model-only (visibility ["model"]), so the app cannot call it`);
    }
    if (opts.write === "noconfirm" && isWriteTool(tool)) {
      this.warn(`${where}: "${name}" writes to ServiceNow but "confirm" is false, so the user gets no confirmation step`);
    }
    return tool;
  }

  done(): ValidationReport {
    return {
      ok: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      tools: [...this.used.entries()]
        .filter(([, t]) => t)
        .map(([name, t]) => ({ name, write: isWriteTool(t!), appVisible: visibilityOf(t!).includes("app") })),
    };
  }
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function paramNames(tool: Tool): Set<string> {
  const names = new Set(tool.parameters.map((p) => p.name));
  const extra = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  for (const k of Object.keys(extra ?? {})) names.add(k);
  return names;
}

// REST tools send only their declared parameters; anything else is silently dropped.
function checkArgs(r: Report, tool: Tool | undefined, args: unknown, where: string, extra: string[] = []) {
  if (!tool || !isObj(args) || tool.kind === "handler") return;
  const params = paramNames(tool);
  for (const k of [...Object.keys(args), ...extra]) {
    if (!params.has(k)) r.warn(`${where}: "${k}" is not a parameter of "${tool.name}", so it is not sent`);
  }
}

function checkShowFields(r: Report, list: unknown, where: string) {
  if (list === undefined) return;
  if (!Array.isArray(list)) return r.err(`${where} must be a list of { field, label }`);
  list.forEach((f, i) => {
    if (!isObj(f) || typeof f["field"] !== "string" || !f["field"]) r.err(`${where}[${i}]: "field" is required`);
  });
}

function checkSource(r: Report, src: unknown, where: string) {
  if (src === undefined) {
    r.warn(`${where}: no "source", so the app shows the result of the tool that opens it. Link a list tool to this app, or add a source`);
    return;
  }
  if (!isObj(src)) return r.err(`${where} must be an object { tool, args?, path? }`);
  const tool = r.tool(src["tool"], where);
  if (tool && isWriteTool(tool)) r.err(`${where}: "${tool.name}" writes to ServiceNow; a data source must be a read tool`);
  if (src["args"] !== undefined && !isObj(src["args"])) r.err(`${where}.args must be an object`);
  checkArgs(r, tool, src["args"], where);
}

function checkField(r: Report, f: unknown, i: number, seen: Set<string>) {
  const where = `fields[${i}]`;
  if (!isObj(f)) return r.err(`${where} must be an object`);
  const name = f["name"];
  if (typeof name !== "string" || !NAME.test(name)) return r.err(`${where}: "name" must be an identifier like short_description`);
  if (seen.has(name)) r.err(`${where}: duplicate field "${name}"`);
  seen.add(name);
  const type = (f["type"] ?? "text") as string;
  if (!FIELD_TYPES.has(type)) r.err(`${where} (${name}): unknown type "${type}". Use one of ${[...FIELD_TYPES].join(", ")}`);
  if (type === "select" && (!Array.isArray(f["options"]) || f["options"].length === 0)) {
    r.err(`${where} (${name}): a select needs "options"`);
  }
  if (type === "lookup") {
    if (!isObj(f["lookup"])) r.err(`${where} (${name}): a lookup needs "lookup": { tool, ... }`);
    else {
      const lk = f["lookup"];
      const t = r.tool(lk["tool"], `${where} (${name}) lookup`);
      if (t && isWriteTool(t)) r.err(`${where} (${name}) lookup: "${t.name}" writes to ServiceNow; lookups must be read tools`);
      const usesText = JSON.stringify(lk["args"] ?? {}).includes("{{text");
      checkArgs(r, t, lk["args"] ?? {}, `${where} (${name}) lookup`, usesText ? [] : [String(lk["textArg"] ?? "text")]);
    }
  }
}

export function validateSpec(spec: unknown, server: MCPServer): ValidationReport {
  const r = new Report(server);
  if (!isObj(spec)) {
    r.err("The spec must be a JSON object");
    return r.done();
  }
  if (JSON.stringify(spec).length > MAX_SPEC_BYTES) r.err(`The spec is larger than ${MAX_SPEC_BYTES / 1000} KB`);
  if (typeof spec["title"] !== "string" || !spec["title"].trim()) r.err(`"title" is required`);
  const type = spec["type"];

  if (type === "form") {
    const fields = spec["fields"];
    if (!Array.isArray(fields) || fields.length === 0) r.err(`A form needs at least one entry in "fields"`);
    const seen = new Set<string>();
    (Array.isArray(fields) ? fields : []).forEach((f, i) => checkField(r, f, i, seen));
    const submit = spec["submit"];
    if (!isObj(submit)) r.err(`A form needs "submit": { tool, label? }`);
    else {
      const tool = r.tool(submit["tool"], "submit", { write: submit["confirm"] === false ? "noconfirm" : "confirm" });
      if (tool) {
        const params = paramNames(tool);
        const given = new Set([...seen, ...Object.keys(isObj(submit["args"]) ? submit["args"] : {})]);
        if (params.size || tool.kind !== "handler") {
          for (const n of seen) if (!params.has(n)) r.warn(`Field "${n}" is not a parameter of "${tool.name}", so it is not sent`);
        }
        checkArgs(r, tool, submit["args"], "submit.args");
        for (const p of tool.parameters) {
          if (p.required && !given.has(p.name)) r.err(`"${tool.name}" requires "${p.name}", but no field or submit arg provides it`);
          const field = (fields as FieldSpec[] | undefined)?.find?.((f) => f?.name === p.name);
          if (p.required && field && !field.required) r.warn(`Field "${p.name}" is required by "${tool.name}"; mark it "required": true`);
        }
      }
    }
    checkShowFields(r, spec["result"]?.["fields"], "result.fields");
  } else if (type === "view") {
    if (!["table", "bar", "stats"].includes(spec["display"])) r.err(`"display" must be table, bar or stats`);
    if ((spec["display"] === "bar" || spec["display"] === "stats") && typeof spec["groupBy"] !== "string") {
      r.err(`A ${spec["display"]} view needs "groupBy": the field to count by, e.g. "priority"`);
    }
    checkSource(r, spec["source"], "source");
    checkShowFields(r, spec["columns"], "columns");
  } else if (type === "approval") {
    if (typeof spec["titleField"] !== "string" || !spec["titleField"]) r.err(`"titleField" is required, e.g. "number"`);
    checkSource(r, spec["source"], "source");
    checkShowFields(r, spec["fields"], "fields");
    const actions = spec["actions"];
    if (!Array.isArray(actions) || actions.length === 0) r.err(`An approval card needs at least one action`);
    (Array.isArray(actions) ? actions : []).forEach((a, i) => {
      const where = `actions[${i}]`;
      if (!isObj(a)) return r.err(`${where} must be an object`);
      if (typeof a["label"] !== "string" || !a["label"]) r.err(`${where}: "label" is required`);
      if (!isObj(a["args"])) r.err(`${where}: "args" is required, e.g. { "sys_id": "{{sys_id}}", "state": "approved" }`);
      if (a["comment"] !== undefined && !["none", "optional", "required"].includes(a["comment"])) {
        r.err(`${where}: "comment" must be none, optional or required`);
      }
      const t = r.tool(a["tool"], `${where} (${a["label"] ?? "?"})`, { write: a["confirm"] === false ? "noconfirm" : "confirm" });
      checkArgs(r, t, a["args"], where);
      if (/reject|deny|decline/i.test(String(a["label"])) && (a["comment"] ?? "none") !== "required") {
        r.warn(`${where}: rejections usually need a reason; consider "comment": "required"`);
      }
    });
  } else {
    r.err(`"type" must be form, view or approval`);
  }
  return r.done();
}

// Static checks on an uploaded single-file app. Two formats are accepted:
// - standard: the official SDK (new App(), app.connect(), app.ontoolresult, app.callServerTool),
//   exactly as in the MCP Apps docs and ServiceNow's MCP Server Console; the file is served as is.
// - kit: the gateway's window.gw helper.
// External origins the page loads from are allowed through the app's CSP (and reported);
// ServiceNow itself is only reached through tools.
function originOf(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith("//") ? `https:${url}` : url);
    return u.protocol === "https:" || u.protocol === "wss:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export function validateHtml(html: unknown, server: MCPServer): ValidationReport {
  const r = new Report(server);
  if (typeof html !== "string" || !html.trim()) {
    r.err("The HTML is empty");
    return r.done();
  }
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_HTML_BYTES) r.err(`The file is ${(bytes / 1e6).toFixed(1)} MB; the limit is ${MAX_HTML_BYTES / 1e6} MB`);
  if (!/<(html|body|div|main|form|script)\b/i.test(html)) r.err("This does not look like an HTML page");
  const format = htmlFormat(html);
  const notes: string[] = [];

  if (/service-now\.com|\/api\/now\/|\/api\/sn_/i.test(html)) {
    r.err("The page refers to ServiceNow URLs directly. Apps never hold credentials; call a tool instead (app.callServerTool or gw.call)");
  }

  // The SDK import is served from a bundled copy, so it is not an external load.
  const body = format === "standard" ? rewriteSdkImports(html).html : html;
  const resource = new Set<string>();
  const connect = new Set<string>();
  const add = (set: Set<string>, url: string) => {
    const o = originOf(url);
    if (o) set.add(o);
    else if (/^http:/i.test(url)) r.err(`${url}: only https resources can be loaded`);
  };
  for (const m of body.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    if (/^(https?:)?\/\//i.test(m[1]!)) add(resource, m[1]!);
    else r.err(`<script src="${m[1]}">: a relative file cannot be loaded; inline it, since the app is one file`);
  }
  for (const m of body.matchAll(/<link\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi)) {
    if (/^(https?:)?\/\//i.test(m[1]!)) add(resource, m[1]!);
  }
  for (const m of body.matchAll(/\bimport\s*(?:[\w$*{},\s]+from\s*)?["']((?:https?:)?\/\/[^"']+)["']/g)) add(resource, m[1]!);
  for (const m of body.matchAll(/\bimport\s*\(\s*["']((?:https?:)?\/\/[^"']+)["']/g)) add(resource, m[1]!);
  for (const m of body.matchAll(/<(?:img|source|video|audio)\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) add(resource, m[1]!);
  for (const m of body.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/gi)) add(resource, m[1]!);
  for (const m of body.matchAll(/@import\s+["'](https?:\/\/[^"']+)/gi)) add(resource, m[1]!);
  for (const m of body.matchAll(/\b(?:fetch|new\s+WebSocket|new\s+EventSource)\s*\(\s*["'`]((?:https?|wss):\/\/[^"'`]+)/g)) add(connect, m[1]!);
  if (/\bfetch\s*\(\s*[^"'`\s]|XMLHttpRequest/.test(body)) {
    r.warn("The page makes network calls to URLs computed at runtime. Only domains listed in the app's CSP are reachable; prefer calling tools");
  }
  for (const o of resource) r.warn(`Loads from ${o}: allowed for this app through its CSP. Users' machines must be able to reach it`);
  for (const o of connect) r.warn(`Connects to ${o}: allowed for this app through its CSP. Prefer a tool, so the gateway holds any credentials`);

  let calls: string[] = [];
  let showsResult = false;
  // Scan code, not comments (HTML comments and whole-line // comments).
  const code = html.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
  if (format === "standard") {
    const unsupported = [...html.matchAll(/["']([^"']*@modelcontextprotocol\/ext-apps[^"']*)["']/g)]
      .map((m) => m[1]!)
      .filter((spec) => /\/(react|app-bridge|server)/.test(spec));
    for (const spec of unsupported) r.err(`"${spec}" is not supported in uploaded apps; use the main @modelcontextprotocol/ext-apps entry`);
    if (!/\.connect\s*\(/.test(html)) r.warn("The page never calls app.connect(), so it cannot talk to the host");
    calls = [...code.matchAll(/\bcallServerTool\s*\(\s*\{[^}]*?\bname\s*:\s*["'`]([\w.-]+)["'`]/g)].map((m) => m[1]!);
    showsResult = /\.ontoolresult\s*=|addEventListener\(\s*["']toolresult/.test(code);
    notes.push("Standard MCP Apps format (official SDK): the file is served as written, so it also works on other MCP Apps hosts and platforms such as ServiceNow's MCP Server Console.");
    if (/callServerTool\s*\(\s*[^{\s]/.test(code)) r.warn("Some app.callServerTool(...) calls use a computed tool name, so they cannot be checked");
  } else {
    calls = [...code.matchAll(/\bgw\.call\(\s*["'`]([\w.-]+)["'`]/g)].map((m) => m[1]!);
    showsResult = /\bgw\.onResult\s*\(/.test(code);
    notes.push("Gateway format (window.gw). It only runs on this gateway; for portability, use the official SDK (import { App } from \"@modelcontextprotocol/ext-apps\").");
  }
  for (const name of new Set(calls)) r.tool(name, format === "standard" ? "app.callServerTool" : "gw.call");
  if (showsResult) {
    notes.push("The page renders the result of the tool that opens it. Open it with a data tool (e.g. a list tool) rather than a new open_ tool.");
  } else if (calls.length === 0 && !/\bgw\.mount\(/.test(html)) {
    r.warn("The page never calls a tool or reads a tool result, so it shows only static content");
  }

  return {
    ...r.done(),
    notes,
    format,
    csp: { resourceDomains: [...resource], connectDomains: [...connect] },
    showsResult,
  };
}

// ── Starter templates ─────────────────────────────────────────────────────────

export function templates(): Record<AppSpecType | "html", unknown> {
  return {
    form: {
      type: "form",
      title: "Report an incident",
      description: "Creates an incident in ServiceNow.",
      fields: [
        { name: "short_description", label: "Short description", required: true },
        { name: "description", type: "textarea" },
        { name: "urgency", type: "select", options: [{ value: "1", label: "High" }, { value: "2", label: "Medium" }, { value: "3", label: "Low" }], default: "3" },
      ],
      submit: { tool: "create_incident", label: "Create incident" },
      result: { title: "Created {{result.number}}", fields: [{ field: "result.number", label: "Number" }, { field: "result.state", label: "State" }] },
    },
    view: {
      type: "view",
      title: "Open incidents by priority",
      source: { tool: "list_incidents", args: { sysparm_query: "active=true" } },
      display: "bar",
      groupBy: "priority",
    },
    approval: {
      type: "approval",
      title: "My approvals",
      source: { tool: "list_my_approvals" },
      titleField: "sysapproval",
      subtitleField: "sys_created_on",
      fields: [{ field: "state", label: "State" }],
      actions: [
        { label: "Approve", style: "primary", tool: "decide_approval", args: { sys_id: "{{sys_id}}", state: "approved", comments: "{{comment}}" }, comment: "optional" },
        { label: "Reject", style: "danger", tool: "decide_approval", args: { sys_id: "{{sys_id}}", state: "rejected", comments: "{{comment}}" }, comment: "required" },
      ],
    },
    html: `<!doctype html>
<!-- Standard MCP App (official SDK). The same file works on this gateway, in the MCP Apps docs
     examples and on ServiceNow's MCP Server Console. Open it with a data tool such as
     list_incidents: the host passes that tool's result to app.ontoolresult. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Incident list</title>
  <style>
    body { font: 13px system-ui, sans-serif; margin: 12px; background: var(--color-background-primary, #fff); color: var(--color-text-primary, #111); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8884; }
  </style>
</head>
<body>
  <div id="app">Loading…</div>
  <script type="module">
    import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps";

    const app = new App({ name: "Incident list", version: "1.0.0" });

    // Table API results arrive as { result: [...] }; other platforms may use { records: [...] }.
    function rows(data) {
      if (Array.isArray(data)) return data;
      for (const v of Object.values(data || {})) {
        if (Array.isArray(v)) return v;
        if (v && typeof v === "object") for (const w of Object.values(v)) if (Array.isArray(w)) return w;
      }
      return [];
    }
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

    app.ontoolresult = (result) => {
      let data = result.structuredContent;
      if (!data) { try { data = JSON.parse(result.content?.find((c) => c.type === "text")?.text ?? ""); } catch {} }
      const list = rows(data);
      document.getElementById("app").innerHTML = list.length
        ? "<table><tr><th>Number</th><th>Priority</th><th>Short description</th></tr>" +
          list.map((r) => \`<tr><td>\${esc(r.number)}</td><td>\${esc(r.priority)}</td><td>\${esc(r.short_description)}</td></tr>\`).join("") +
          "</table>"
        : "No incidents.";
    };

    app.connect();
  </script>
</body>
</html>
`,
  };
}

// ── Prompt for Claude ─────────────────────────────────────────────────────────

function describeTool(t: Tool): string {
  const vis = visibilityOf(t).join("+");
  const kind = isWriteTool(t) ? "write" : "read";
  const params = t.parameters.map((p) => `${p.name}${p.required ? "*" : ""}: ${p.type}${p.description ? ` (${p.description})` : ""}`);
  return `- ${t.name} [${kind}; visible to ${vis}]${t.description ? `: ${t.description}` : ""}${params.length ? `\n    params: ${params.join("; ")}` : ""}`;
}

const SPEC_DOC = `Spec formats (JSON):
- form: { "type":"form", "title", "description"?, "fields":[ { "name", "label"?, "type"?: text|textarea|number|select|date|datetime|checkbox|lookup, "required"?, "placeholder"?, "help"?, "default"?, "options"?: [ "a" | { "value", "label" } ] (select), "lookup"?: { "tool", "args"?: { "sysparm_query": "nameLIKE{{text}}" }, "textArg"?: "text", "path"?, "value"?: "sys_id", "label"?: "name", "detail"? } } ], "submit": { "tool", "label"?, "confirm"?: true, "args"?: {} }, "result"?: { "title"?: "Created {{result.number}}", "fields"?: [ { "field", "label"? } ] } }
  Field names are sent as the submit tool's arguments.
- view: { "type":"view", "title", "description"?, "source"?: { "tool", "args"?, "path"? }, "display": table|bar|stats, "columns"?: [ { "field", "label"? } ], "groupBy"? (required for bar/stats), "limit"? }
- approval: { "type":"approval", "title", "description"?, "source"?: { "tool", "args"?, "path"? }, "titleField", "subtitleField"?, "fields"?: [ { "field", "label"? } ], "actions": [ { "label", "tool", "args": { ... }, "style"?: primary|danger, "comment"?: none|optional|required, "confirm"?: true } ], "empty"? }
Templates: strings in args may use {{field}} (current row or form value), {{input.x}} (argument passed to the tool that opened the app), {{comment}} (approval comment) and {{text}} (what the user typed in a lookup; without it the text is sent as the "textArg" argument). "path" is a dot path to the rows array in the tool's result; when omitted the first array is used (Table API results are { "result": [...] }). ServiceNow values may be strings or { value, display_value } objects; both display correctly.`;

const HTML_DOC = `HTML format: one self-contained HTML file (inline <style> and <script>) using the official MCP Apps SDK, so it runs on any MCP Apps host (this gateway, Claude, ServiceNow's MCP Server Console):
  <script type="module">
    import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps";
    const app = new App({ name: "My app", version: "1.0.0" });
    app.ontoolinput = (params) => { /* params.arguments: what the model passed to the tool that opened the app */ };
    app.ontoolresult = (result) => { /* result.structuredContent (or JSON in result.content[0].text): that tool's result */ };
    const res = await app.callServerTool({ name: "tool_name", arguments: { ... } }); // res.structuredContent, res.isError
    await app.updateModelContext({ content: [{ type: "text", text: "what the user did" }] });
    app.connect();
  </script>
- Call only the tools listed below; never call ServiceNow URLs directly (the app holds no credentials).
- Ask the user to confirm (your own dialog) before calling a write tool, and show errors (res.isError).
- Table API results arrive as { result: [...] } (a record: { result: {...} }); read rows tolerantly.
- No other external URLs unless necessary; any you use are allowed through the app's CSP.
- Style with the host's CSS variables where possible: var(--color-background-primary), var(--color-text-primary), var(--color-text-secondary), var(--font-sans).`;

export function buildPrompt(server: MCPServer, format: AppSpecType | "html", goal: string): string {
  const tools = server.tools.map(describeTool).join("\n");
  const example = templates()[format];
  const out = format === "html" ? "Reply with only the HTML file." : `Reply with only the JSON spec (type "${format}").`;
  return `Write an MCP App for my ServiceNow MCP gateway server "${server.name}".

What I want: ${goal.trim() || "(describe the app here)"}

${format === "html" ? HTML_DOC : SPEC_DOC}

Rules:
- Use only these tools from the server. The app can call tools that are visible to "app"; write tools must go through a confirmation.
- Prefer existing read tools for data and lookups. If a tool you need is missing, say which one (name, ServiceNow endpoint, params) instead of inventing it.

Tools on "${server.name}":
${tools || "(none yet)"}

Example (${format}):
${typeof example === "string" ? example : JSON.stringify(example, null, 2)}

${out}`;
}
