import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeSN } from "./fake-sn.js";
import { ctxFor, hoursFromNow } from "./helpers.js";
import { changeHandlers, resetIdempotency } from "../src/handlers/change.js";

const sn = new FakeSN();
let ci: any, group: any, retired: any, tplVersion: any;

beforeAll(async () => {
  await sn.start();
});
afterAll(async () => {
  await sn.stop();
});
beforeEach(() => {
  sn.tables = {};
  sn.calls = [];
  resetIdempotency();
  ci = sn.insert("cmdb_ci", { name: "db-prod-01", install_status: "1", sys_class_name: "cmdb_ci_db" });
  retired = sn.insert("cmdb_ci", { name: "old-box", install_status: "7" });
  group = sn.insert("sys_user_group", { name: "Database", active: "true" });
  sn.insert("sys_user_group", { name: "Retired group", active: "false" });
  const proposal = sn.insert("std_change_proposal", {
    template_value: "short_description=Reboot server^implementation_plan=Reboot^backout_plan=None^test_plan=Ping^EQ",
  });
  tplVersion = sn.insert("std_change_producer_version", { name: "Reboot server", version: "1", std_change_proposal: proposal.sys_id });
  for (const [element, value, label] of [
    ["risk", "2", "High"],
    ["risk", "3", "Moderate"],
    ["category", "software", "Software"],
  ]) {
    sn.insert("sys_choice", { name: "change_request", element, value, label, inactive: "false", language: "en" });
  }
});

function normal(extra: Record<string, unknown> = {}) {
  return {
    type: "normal",
    short_description: "Patch db-prod-01",
    description: "Monthly patching",
    cmdb_ci: ci.sys_id,
    assignment_group: group.sys_id,
    start_date: hoursFromNow(48),
    end_date: hoursFromNow(50),
    justification: "Security fixes",
    implementation_plan: "Apply patches",
    risk_impact_analysis: "Low",
    backout_plan: "Restore snapshot",
    test_plan: "Smoke test",
    ...extra,
  };
}

const submit = (args: Record<string, unknown>, ctx = ctxFor(sn)) => changeHandlers["change.submit"]!.fn(args, ctx);

describe("change.submit", () => {
  it("creates a normal change through the Change Management API", async () => {
    const r = await submit(normal());
    expect(r.isError).toBeFalsy();
    expect(r.structured).toMatchObject({ type: "normal", state: "New" });
    expect(String(r.structured!["number"])).toMatch(/^CHG/);
    const call = sn.calls.find((c) => c.method === "POST")!;
    expect(call.path).toBe("/api/sn_chg_rest/change/normal");
    expect(call.body.cmdb_ci).toBe(ci.sys_id);
    expect(call.body.start_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(call.body).not.toHaveProperty("type");
  });

  it("reports a missing plan as a field error and creates nothing", async () => {
    const r = await submit(normal({ backout_plan: "" }));
    expect(r.isError).toBe(true);
    expect(r.structured!["errors"]).toEqual([{ field: "backout_plan", message: "Backout plan is required" }]);
    expect(sn.tables["change_request"]).toBeUndefined();
  });

  it("rejects a past start and an end before start", async () => {
    const r = await submit(normal({ start_date: hoursFromNow(-1), end_date: hoursFromNow(-2) }));
    const fields = (r.structured!["errors"] as any[]).map((e) => e.field).sort();
    expect(fields).toEqual(["end_date", "start_date"]);
    expect(sn.tables["change_request"]).toBeUndefined();
  });

  it("requires active CI and group records", async () => {
    const inactiveGroup = sn.tables["sys_user_group"]!.find((g) => g["active"] === "false")!;
    const r = await submit(normal({ cmdb_ci: retired.sys_id, assignment_group: inactiveGroup["sys_id"] }));
    expect((r.structured!["errors"] as any[]).map((e) => e.field).sort()).toEqual(["assignment_group", "cmdb_ci"]);
  });

  it("resolves names on the model path (create_change)", async () => {
    const r = await submit(normal({ cmdb_ci: undefined, ci_name: "db-prod-01", assignment_group: "Database" }));
    expect(r.isError).toBeFalsy();
    expect(sn.tables["change_request"]![0]!["assignment_group"]).toBe(group.sys_id);
  });

  it("does not require justification or risk analysis for standard, and ignores locked fields", async () => {
    const r = await submit({
      type: "standard",
      std_change_template: tplVersion.sys_id,
      short_description: "user edit to a locked field",
      description: "Reboot for kernel update",
      cmdb_ci: ci.sys_id,
      assignment_group: group.sys_id,
      start_date: hoursFromNow(5),
      end_date: hoursFromNow(6),
    });
    expect(r.isError).toBeFalsy();
    const call = sn.calls.find((c) => c.method === "POST")!;
    expect(call.path).toBe(`/api/sn_chg_rest/change/standard/${tplVersion.sys_id}`);
    expect(call.body).not.toHaveProperty("short_description");
    expect(sn.tables["change_request"]![0]!["short_description"]).toBe("Reboot server");
  });

  it("requires a template for standard changes", async () => {
    const r = await submit(normal({ type: "standard" }));
    expect((r.structured!["errors"] as any[]).map((e) => e.field)).toContain("std_change_template");
  });

  it("creates one change on a double submit with the same idempotency key", async () => {
    const args = normal({ idempotency_key: "form-1" });
    const [a, b] = await Promise.all([submit(args), submit(args)]);
    const c = await submit(args);
    expect(sn.tables["change_request"]).toHaveLength(1);
    expect(a.structured!["number"]).toBe(b.structured!["number"]);
    expect(c.structured!["number"]).toBe(a.structured!["number"]);
  });

  it("lets a corrected form resubmit after a validation error with the same key", async () => {
    const bad = await submit(normal({ test_plan: "", idempotency_key: "form-2" }));
    expect(bad.isError).toBe(true);
    const good = await submit(normal({ idempotency_key: "form-2" }));
    expect(good.isError).toBeFalsy();
  });
});

describe("change lookups", () => {
  it("loads choices from sys_choice", async () => {
    const r = await changeHandlers["change.choices"]!.fn({ fields: ["risk", "category"] }, ctxFor(sn));
    expect(r.structured).toEqual({
      risk: [
        { value: "2", label: "High" },
        { value: "3", label: "Moderate" },
      ],
      category: [{ value: "software", label: "Software" }],
    });
  });

  it("rejects bad field names", async () => {
    const r = await changeHandlers["change.choices"]!.fn({ fields: ["risk^ORname=x"] }, ctxFor(sn));
    expect(r.isError).toBe(true);
  });

  it("searches CIs without letting text inject query clauses", async () => {
    const r = await changeHandlers["change.search"]!.fn({ kind: "ci", text: "db" }, ctxFor(sn));
    expect((r.structured!["results"] as any[]).map((x) => x.label)).toEqual(["db-prod-01"]);
    const inj = await changeHandlers["change.search"]!.fn({ kind: "ci", text: "x^NQinstall_status=7" }, ctxFor(sn));
    const last = sn.calls.at(-1)!;
    expect(last.path).toBe("/api/now/table/cmdb_ci");
    expect(last.query["sysparm_query"]).toBe("install_status!=7^nameLIKEx NQinstall_status 7^ORDERBYname");
    expect(inj.structured!["results"]).toEqual([]);
  });

  it("returns template locks with template search results", async () => {
    const r = await changeHandlers["change.search"]!.fn({ kind: "template", text: "Reboot" }, ctxFor(sn));
    const t = (r.structured!["results"] as any[])[0];
    expect(t.locked).toMatchObject({ short_description: "Reboot server" });
  });
});

describe("change.open_form", () => {
  it("returns prefill and missing fields for app clients", async () => {
    const r = await changeHandlers["change.open_form"]!.fn(
      { type: "Normal", short_description: "Patch", ci_name: "db-prod-01" },
      ctxFor(sn)
    );
    expect(r.structured!["prefill"]).toMatchObject({ type: "normal", ci_name: "db-prod-01" });
    expect(r.structured!["missing"]).toContain("backout_plan");
    expect(r.structured!["missing"]).not.toContain("cmdb_ci");
  });

  it("gives text clients the field list and choices", async () => {
    const r = await changeHandlers["change.open_form"]!.fn({}, ctxFor(sn, { apps: false }));
    expect(r.text).toContain("create_change");
    expect(r.text).toContain("risk: Risk");
    expect(r.text).toContain("2 (High)");
  });
});

describe("change.request_approval", () => {
  it("moves a normal change to assess", async () => {
    const created = await submit(normal());
    const r = await changeHandlers["change.request_approval"]!.fn({ sys_id: created.structured!["sys_id"] }, ctxFor(sn));
    expect(r.structured).toMatchObject({ state: "Assess" });
    expect(sn.tables["change_request"]![0]!["state"]).toBe("assess");
  });
});
