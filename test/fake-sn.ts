// Minimal in-memory ServiceNow for tests: Table API (list/get/insert/patch with a subset of
// encoded-query operators) and the Change Management API create/patch endpoints.
import express from "express";
import type { Server } from "http";
import { randomBytes } from "crypto";

export type Row = Record<string, any>;

export function sysId(): string {
  return randomBytes(16).toString("hex");
}

function matches(row: Row, query: string): boolean {
  for (const raw of query.split("^")) {
    if (!raw || raw === "EQ" || raw.startsWith("ORDERBY")) continue;
    const m = /^([a-z0-9_.]+)(!=|<=|>=|=|IN|LIKE)(.*)$/.exec(raw);
    if (!m) throw new Error(`fake-sn: unsupported clause ${raw}`);
    const [, field, op, value] = m as unknown as [string, string, string, string];
    if (field.includes(".")) continue; // dot-walks are ignored by the fake
    const v = row[field] === undefined ? "" : String(row[field]);
    if (op === "=" && v !== value) return false;
    if (op === "!=" && v === value) return false;
    if (op === "IN" && !value.split(",").includes(v)) return false;
    if (op === "LIKE" && !v.toLowerCase().includes(value.toLowerCase())) return false;
    if (op === "<=" && !(v <= value)) return false;
    if (op === ">=" && !(v >= value)) return false;
  }
  return true;
}

export class FakeSN {
  tables: Record<string, Row[]> = {};
  calls: { method: string; path: string; query: Record<string, any>; body?: any; user: string }[] = [];
  users: Record<string, string> = { admin: "admin" }; // username → password
  private server: Server | null = null;
  url = "";

  insert(table: string, row: Row): Row {
    const r = { sys_id: sysId(), ...row };
    (this.tables[table] ??= []).push(r);
    return r;
  }

  find(table: string, id: string): Row | undefined {
    return this.tables[table]?.find((r) => r.sys_id === id);
  }

  private view(row: Row, fields: string | undefined, display: string | undefined): Row {
    const keys = fields ? fields.split(",") : Object.keys(row);
    const out: Row = {};
    for (const k of keys) {
      const v = row[k] ?? "";
      if (display === "all") out[k] = { value: v, display_value: row[`${k}__display`] ?? v };
      else if (display === "true") out[k] = row[`${k}__display`] ?? v;
      else out[k] = v;
    }
    return out;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const auth = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const [u, p] = [auth.slice(0, auth.indexOf(":")), auth.slice(auth.indexOf(":") + 1)];
      if (this.users[u] !== p) return res.status(401).json({ error: { message: "User Not Authenticated" } });
      (req as any).user = u;
      this.calls.push({ method: req.method, path: req.path, query: req.query, body: req.body, user: u });
      next();
    });
    app.get("/api/now/table/:table", (req, res) => {
      const q = String(req.query["sysparm_query"] ?? "");
      const rows = (this.tables[req.params.table] ?? []).filter((r) => matches(r, q));
      const limit = Number(req.query["sysparm_limit"] ?? 10000);
      res.json({
        result: rows
          .slice(0, limit)
          .map((r) => this.view(r, req.query["sysparm_fields"] as string, req.query["sysparm_display_value"] as string)),
      });
    });
    app.get("/api/now/table/:table/:id", (req, res) => {
      const r = this.find(req.params.table, req.params.id);
      if (!r) return res.status(404).json({ error: { message: "No Record found" } });
      res.json({ result: this.view(r, req.query["sysparm_fields"] as string, req.query["sysparm_display_value"] as string) });
    });
    app.patch("/api/now/table/:table/:id", (req, res) => {
      const r = this.find(req.params.table, req.params.id);
      if (!r) return res.status(404).json({ error: { message: "No Record found" } });
      Object.assign(r, req.body, { sys_updated_by: (req as any).user });
      res.json({ result: r });
    });
    let incSeq = 10000;
    app.post("/api/now/table/:table", (req, res) => {
      const r = this.insert(req.params.table, { ...req.body, number: `${req.params.table.slice(0, 3).toUpperCase()}00${++incSeq}`, state: "1", sys_created_by: (req as any).user });
      res.status(201).json({ result: r });
    });
    let seq = 40000;
    const createChange = (type: string, body: Row, extra: Row = {}) => {
      const r = this.insert("change_request", { ...body, ...extra, type, state: type === "standard" ? "scheduled" : "new", number: `CHG00${++seq}` });
      return { result: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v, display_value: k === "state" ? String(v)[0]!.toUpperCase() + String(v).slice(1) : v }])) };
    };
    app.post("/api/sn_chg_rest/change/normal", (req, res) => res.json(createChange("normal", req.body)));
    app.post("/api/sn_chg_rest/change/emergency", (req, res) => res.json(createChange("emergency", req.body)));
    app.post("/api/sn_chg_rest/change/standard/:tpl", (req, res) => {
      const producer = this.find("std_change_record_producer", req.params.tpl);
      const ver = producer && this.find("std_change_producer_version", producer["current_version"]);
      if (!ver) return res.status(404).json({ error: { message: "Standard Change Template not found" } });
      const proposal = this.find("std_change_proposal", ver["std_change_proposal"]);
      const fromTemplate: Row = {};
      for (const part of String(proposal?.["template_value"] ?? "").split("^")) {
        const i = part.indexOf("=");
        if (i > 0) fromTemplate[part.slice(0, i)] = part.slice(i + 1);
      }
      res.json(createChange("standard", req.body, fromTemplate));
    });
    app.patch("/api/sn_chg_rest/change/:id", (req, res) => {
      const r = this.find("change_request", req.params.id);
      if (!r) return res.status(404).json({ error: { message: "not found" } });
      Object.assign(r, req.body);
      res.json({ result: { number: { value: r["number"], display_value: r["number"] }, state: { value: r["state"], display_value: "Assess" } } });
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server!.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
