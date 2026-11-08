// Validation, starter templates and the "write it with Claude" prompt for no-code apps.
// An app is either a JSON spec (form / view / approval, rendered by the App Kit) or one
// self-contained HTML file that uses `window.gw`. Both are checked against the server's
// real tools before they are saved.
import type { AppSpec, AppSpecType, FieldSpec } from "./app-spec-types.js";
import type { MCPServer, Tool } from "./types.js";
import { isWriteTool, visibilityOf } from "./mcp-instance.js";

export type { AppSpec, AppSpecType };

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  tools: { name: string; write: boolean; appVisible: boolean }[]; // tools the app calls
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

// Static checks on an uploaded single-file app. The host sandboxes it with an empty CSP, so
// anything loaded from elsewhere will not work; ServiceNow is reached only via gw.call().
export function validateHtml(html: unknown, server: MCPServer): ValidationReport {
  const r = new Report(server);
  if (typeof html !== "string" || !html.trim()) {
    r.err("The HTML is empty");
    return r.done();
  }
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_HTML_BYTES) r.err(`The file is ${(bytes / 1e6).toFixed(1)} MB; the limit is ${MAX_HTML_BYTES / 1e6} MB`);
  if (!/<(html|body|div|main|form|script)\b/i.test(html)) r.err("This does not look like an HTML page");

  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    r.err(`<script src="${m[1]}">: apps must be one self-contained file; inline the script`);
  }
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']?(https?:[^"'\s>]+|\/\/[^"'\s>]+)/gi)) {
    r.err(`<link href="${m[1]}">: external stylesheets are blocked; inline the CSS`);
  }
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
    if (/<a\b/i.test(html.slice(Math.max(0, m.index! - 200), m.index))) continue; // links are fine
    r.warn(`${m[1]} is loaded from outside; the host blocks external resources`);
  }
  if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/.test(html)) {
    r.warn("The page uses fetch/XHR/WebSocket. Network access is blocked; call tools with gw.call(name, args) instead");
  }
  if (/service-now\.com|\/api\/now\//i.test(html)) {
    r.err("The page refers to ServiceNow URLs directly. Apps never hold credentials; call a tool with gw.call()");
  }
  if (/<script\b[^>]*type\s*=\s*["']?module/i.test(html) && /\bimport\s+[^(]/.test(html)) {
    r.warn("ES module imports will not resolve in the sandbox; use the injected window.gw instead");
  }

  const calls = [...html.matchAll(/\bgw\.call\(\s*["'`]([\w.-]+)["'`]/g)].map((m) => m[1]!);
  const specs = [...html.matchAll(/\bgw\.mount\(/g)];
  if (calls.length === 0 && specs.length === 0) {
    r.warn("The page never calls gw.call(...), so it shows only static content");
  }
  for (const name of new Set(calls)) r.tool(name, "gw.call");
  return r.done();
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
<html>
<body>
  <h1>My app</h1>
  <button id="go" class="primary">Load</button>
  <pre id="out" class="card mono"></pre>
  <script>
    // window.gw is injected by the gateway: gw.call(tool, args), gw.onInput(fn),
    // gw.onResult(fn), gw.confirm({title}), gw.setContext(text), gw.mount(el, spec).
    document.getElementById("go").onclick = async () => {
      const res = await gw.call("list_incidents", { sysparm_limit: 5 });
      document.getElementById("out").textContent = JSON.stringify(res, null, 2);
    };
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

const HTML_DOC = `HTML format: one self-contained HTML file (inline <style> and <script>, no external URLs, no fetch). The gateway injects window.gw before your scripts:
- await gw.call(toolName, args) → the tool's structuredContent (throws an Error with .message on failure)
- gw.onInput(fn(args)) / gw.onResult(fn(structured, isError)): what the model passed to / got back from the tool that opened the app
- await gw.confirm({ title, details?: [[label, value]], confirmLabel?, danger? }) → boolean; always confirm before a write
- gw.setContext(text): tell the model what the user did
- gw.mount(element, spec): render a form/view/approval spec inside your page
- gw.data.rowsOf(result, path?), gw.data.textOf(value): helpers for Table API results
Built-in CSS classes: .card .muted .row .field .banner(.error|.ok|.warn) .actions button.primary button.danger table.grid .pill. The page follows the host's light/dark theme automatically.`;

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
