#!/usr/bin/env node
// Adds the incident form app (examples/incident-form.html) to a server on a running gateway:
// - updates create_incident to take the form's fields (caller, category, impact, ...)
// - adds the lookup tools the form uses (users, groups, services, offerings, CIs, choices)
// - adds the app and its open_incident_form launcher
// Safe to run again: existing tools and the app are updated in place.
//
// Usage: node scripts/add-incident-app.mjs [server name]       (default: incident-mcp)
// Env:   GATEWAY_URL (default http://localhost:$MANAGEMENT_PORT or 3001)
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = `${process.env.GATEWAY_URL ?? `http://localhost:${process.env.MANAGEMENT_PORT ?? 3001}`}/api`;
const SERVER = process.argv[2] ?? "incident-mcp";

const body = (name, description, required = false) => ({ name, description, type: "string", required, in: "body" });
const query = (name, description) => ({ name, description, type: "string", required: false, in: "query" });
const searchParams = (fields) => [
  query("sysparm_query", `Encoded query, e.g. nameLIKEnet^ORDERBYname`),
  query("sysparm_fields", `Comma-separated fields to return, e.g. ${fields}`),
  query("sysparm_limit", "Maximum rows (e.g. 10)"),
];
const search = (name, table, what, fields) => ({
  name,
  description: `Search ${what} (${table}) to find sys_ids for incident fields. Example sysparm_query: nameLIKEtext^ORDERBYname.`,
  method: "GET",
  endpoint: `/api/now/table/${table}`,
  apiType: "table",
  parameters: searchParams(fields),
});

const TOOLS = [
  {
    name: "create_incident",
    description:
      "Create an incident. Reference fields (caller_id, business_service, service_offering, cmdb_ci, assignment_group, " +
      "assigned_to) take sys_ids: find them with search_users, search_services, search_service_offerings, search_cis and " +
      "search_groups. Choice fields take values, not labels (get_incident_choices lists them). Priority is calculated by " +
      "ServiceNow from impact and urgency. To let the user fill in and review the form, call open_incident_form instead.",
    method: "POST",
    endpoint: "/api/now/table/incident",
    apiType: "table",
    parameters: [
      body("short_description", "Short description of the incident", true),
      body("description", "Full description of the incident"),
      body("caller_id", "Caller: sys_user sys_id"),
      body("category", "Category value, e.g. inquiry, software, hardware, network, database"),
      body("subcategory", "Subcategory value (depends on category), e.g. email, vpn, disk"),
      body("contact_type", "Channel value, e.g. email, phone, self-service, walk-in, virtual_agent"),
      body("state", "State value: 1 New, 2 In Progress, 3 On Hold (default 1)"),
      body("impact", "Impact: 1 High, 2 Medium, 3 Low"),
      body("urgency", "Urgency: 1 High, 2 Medium, 3 Low"),
      body("business_service", "Service: cmdb_ci_service sys_id"),
      body("service_offering", "Service offering: service_offering sys_id"),
      body("cmdb_ci", "Configuration item: cmdb_ci sys_id"),
      body("assignment_group", "Assignment group: sys_user_group sys_id"),
      body("assigned_to", "Assigned to: sys_user sys_id"),
    ],
  },
  {
    name: "get_incident_choices",
    description:
      "List the choice values for incident fields (sys_choice). Example sysparm_query: " +
      "nameINincident,task^elementINcategory,subcategory^inactive=false^language=en",
    method: "GET",
    endpoint: "/api/now/table/sys_choice",
    apiType: "table",
    parameters: searchParams("name,element,value,label,dependent_value"),
  },
  search("search_users", "sys_user", "users, for the caller or assignee", "sys_id,name,email"),
  search("search_groups", "sys_user_group", "assignment groups", "sys_id,name"),
  search("search_services", "cmdb_ci_service", "services", "sys_id,name"),
  search("search_service_offerings", "service_offering", "service offerings (filter by service with parent=<service sys_id>)", "sys_id,name"),
  search("search_cis", "cmdb_ci", "configuration items", "sys_id,name,sys_class_name"),
];

// Arguments Claude can pass to prefill the form. References take names; the form looks them up.
const LAUNCHER = {
  description:
    "Open the incident form for the user to review and submit. Prefill any fields you can infer from the conversation; " +
    "all are optional. Reference fields take names (the form finds the record), choice fields take values.",
  parameters: [
    body("short_description", "Short description"),
    body("description", "Description"),
    body("caller", "Caller's name"),
    body("category", "Category value, e.g. inquiry, software, hardware, network, database"),
    body("subcategory", "Subcategory value, e.g. email, vpn, disk"),
    body("contact_type", "Channel value, e.g. email, phone, self-service, walk-in"),
    body("impact", "Impact: 1 High, 2 Medium, 3 Low"),
    body("urgency", "Urgency: 1 High, 2 Medium, 3 Low"),
    body("service", "Service name"),
    body("service_offering", "Service offering name"),
    body("configuration_item", "Configuration item name"),
    body("assignment_group", "Assignment group name"),
    body("assigned_to", "Assignee's name"),
  ],
};

async function api(method, path, data) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach the gateway at ${API}. Start it first (npm run dev), or set GATEWAY_URL.`);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = out.report ? `\n  ${[...out.report.errors].join("\n  ")}` : "";
    throw new Error(`${method} ${path}: ${out.error ?? res.status}${detail}`);
  }
  return out;
}

const servers = await api("GET", "/servers");
const server = servers.find((s) => s.name === SERVER);
if (!server) {
  console.error(`No server named "${SERVER}". Servers: ${servers.map((s) => s.name).join(", ")}`);
  process.exit(1);
}
const sid = server.id;
let tools = await api("GET", `/servers/${sid}/tools`);

async function upsertTool(def) {
  const existing = tools.find((t) => t.name === def.name);
  if (existing) {
    await api("PUT", `/servers/${sid}/tools/${existing.id}`, def);
    console.log(`  updated ${def.name}`);
  } else {
    await api("POST", `/servers/${sid}/tools`, def);
    console.log(`  added   ${def.name}`);
  }
}

console.log(`Server ${server.name} (${API})`);
for (const def of TOOLS) await upsertTool(def);

const html = await readFile(join(ROOT, "examples/incident-form.html"), "utf8");
const apps = await api("GET", `/servers/${sid}/apps`);
const list = Array.isArray(apps) ? apps : apps.apps ?? [];
const existing = list.find((a) => String(a.uri).endsWith("/incident-form"));
const app = { name: "Incident form", description: "Create an incident with the full incident form.", source: "html", html };
if (existing) {
  await api("PUT", `/servers/${sid}/apps/incident-form`, app);
  console.log(`  updated app ${existing.uri}`);
} else {
  const out = await api("POST", `/servers/${sid}/apps`, { ...app, slug: "incident-form" });
  console.log(`  added   app ${out.app.uri}`);
}

tools = await api("GET", `/servers/${sid}/tools`);
const launcher = tools.find((t) => t.handler === "app.open" && String(t.ui?.resourceUri).endsWith("/incident-form"));
if (launcher) {
  await api("PUT", `/servers/${sid}/tools/${launcher.id}`, LAUNCHER);
  console.log(`  updated ${launcher.name}`);
}
console.log(`Done. Restart Claude (or reconnect the server) so it picks up the new tools.`);
