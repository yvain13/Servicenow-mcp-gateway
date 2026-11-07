import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeSN } from "./fake-sn.js";
import { ctxFor, hoursFromNow } from "./helpers.js";
import { approvalHandlers } from "../src/handlers/approvals.js";
import { toSNDateTime } from "../src/handlers/util.js";

const sn = new FakeSN();
let alice: any, bob: any, carol: any, chg1: any, chg2: any, apA: any, apB: any, apC: any;

beforeAll(() => sn.start());
afterAll(() => sn.stop());
beforeEach(() => {
  sn.tables = {};
  sn.calls = [];
  sn.users = { admin: "admin", alice: "pw-a", bob: "pw-b", carol: "pw-c" };
  alice = sn.insert("sys_user", { user_name: "alice", name: "Alice A" });
  bob = sn.insert("sys_user", { user_name: "bob", name: "Bob B" });
  carol = sn.insert("sys_user", { user_name: "carol", name: "Carol C" });
  const at = (h: number) => toSNDateTime(new Date(hoursFromNow(h)));
  chg1 = sn.insert("change_request", { number: "CHG0040012", short_description: "Patch db", type: "normal", risk: "3", start_date: at(48), end_date: at(50) });
  chg2 = sn.insert("change_request", { number: "CHG0040013", short_description: "Firewall", type: "normal", risk: "2", start_date: at(24), end_date: at(25) });
  apA = sn.insert("sysapproval_approver", { approver: alice.sys_id, approver__display: "Alice A", sysapproval: chg1.sys_id, state: "requested", source_table: "change_request" });
  apB = sn.insert("sysapproval_approver", { approver: bob.sys_id, approver__display: "Bob B", sysapproval: chg2.sys_id, state: "requested", source_table: "change_request" });
  apC = sn.insert("sysapproval_approver", { approver: alice.sys_id, sysapproval: chg2.sys_id, state: "approved", source_table: "change_request" });
});

const user = (name: string) => ctxFor(sn, { username: name, mode: "user" });

describe("approvals.list", () => {
  it("shows only the caller's requested change approvals", async () => {
    const r = await approvalHandlers["approvals.list"]!.fn({}, user("alice"));
    const rows = r.structured!["approvals"] as any[];
    expect(rows.map((x) => x.approval_sys_id)).toEqual([apA.sys_id]);
    expect(rows[0]).toMatchObject({ number: "CHG0040012", change_sys_id: chg1.sys_id });
    expect(r.structured!["identity"]).toMatchObject({ mode: "user", decisions_enabled: true });
  });

  it("includes active delegations, labelled on behalf of", async () => {
    sn.insert("sys_user_delegate", {
      user: bob.sys_id, user__display: "Bob B", delegate: alice.sys_id, approvals: "true",
      starts: toSNDateTime(new Date(Date.now() - 3600_000)), ends: toSNDateTime(new Date(Date.now() + 3600_000)),
    });
    const r = await approvalHandlers["approvals.list"]!.fn({}, user("alice"));
    const rows = r.structured!["approvals"] as any[];
    expect(rows.map((x) => x.number)).toEqual(["CHG0040013", "CHG0040012"]); // sorted by planned start
    expect(rows[0].on_behalf_of).toBe("Bob B");
  });

  it("links to ServiceNow for text-only clients", async () => {
    const r = await approvalHandlers["approvals.list"]!.fn({}, ctxFor(sn, { username: "alice", mode: "user", apps: false }));
    expect(r.text).toContain(`sysapproval_approver.do?sys_id=${apA.sys_id}`);
  });
});

describe("approvals.decide", () => {
  const decide = (args: Record<string, unknown>, ctx = user("alice")) => approvalHandlers["approvals.decide"]!.fn(args, ctx);

  it("records the decision as the approver", async () => {
    const r = await decide({ approval_sys_id: apA.sys_id, decision: "approved", comments: "ok" });
    expect(r.structured).toMatchObject({ number: "CHG0040012", decision: "approved" });
    expect(sn.find("sysapproval_approver", apA.sys_id)).toMatchObject({ state: "approved", comments: "ok", sys_updated_by: "alice" });
  });

  it("refuses on a shared service account", async () => {
    const r = await decide({ approval_sys_id: apA.sys_id, decision: "approved" }, ctxFor(sn));
    expect(r.structured!["error"]).toBe("identity_required");
    expect(sn.find("sysapproval_approver", apA.sys_id)!["state"]).toBe("requested");
  });

  it("requires a comment to reject", async () => {
    const r = await decide({ approval_sys_id: apA.sys_id, decision: "rejected" });
    expect(r.structured!["error"]).toBe("comments_required");
  });

  it("returns stale for an approval decided elsewhere", async () => {
    const r = await decide({ approval_sys_id: apC.sys_id, decision: "approved" });
    expect(r.structured!["error"]).toBe("stale");
  });

  it("returns not_yours for someone else's approval", async () => {
    const r = await decide({ approval_sys_id: apB.sys_id, decision: "approved" });
    expect(r.structured!["error"]).toBe("not_yours");
    expect(sn.find("sysapproval_approver", apB.sys_id)!["state"]).toBe("requested");
  });

  it("allows an active delegate and writes with the delegate's identity", async () => {
    sn.insert("sys_user_delegate", {
      user: bob.sys_id, delegate: carol.sys_id, approvals: "true",
      starts: toSNDateTime(new Date(Date.now() - 3600_000)), ends: toSNDateTime(new Date(Date.now() + 3600_000)),
    });
    const r = await decide({ approval_sys_id: apB.sys_id, decision: "rejected", comments: "not this week" }, user("carol"));
    expect(r.isError).toBeFalsy();
    expect(sn.find("sysapproval_approver", apB.sys_id)).toMatchObject({ state: "rejected", sys_updated_by: "carol" });
  });

  it("ignores expired delegations", async () => {
    sn.insert("sys_user_delegate", {
      user: bob.sys_id, delegate: carol.sys_id, approvals: "true",
      starts: toSNDateTime(new Date(Date.now() - 7200_000)), ends: toSNDateTime(new Date(Date.now() - 3600_000)),
    });
    const r = await decide({ approval_sys_id: apB.sys_id, decision: "approved" }, user("carol"));
    expect(r.structured!["error"]).toBe("not_yours");
  });
});

describe("approvals.detail", () => {
  it("returns change, CIs and history for the caller's approval", async () => {
    sn.insert("task_ci", { task: chg1.sys_id, ci_item: "abc", ci_item__display: "db-prod-01" });
    const r = await approvalHandlers["approvals.detail"]!.fn({ approval_sys_id: apA.sys_id }, user("alice"));
    expect(r.structured!["change"]).toMatchObject({ number: "CHG0040012" });
    expect(r.structured!["affected_cis"]).toEqual([{ sys_id: "abc", name: "db-prod-01" }]);
    expect((r.structured!["history"] as any[]).length).toBe(1);
  });

  it("refuses another approver's record", async () => {
    const r = await approvalHandlers["approvals.detail"]!.fn({ approval_sys_id: apB.sys_id }, user("alice"));
    expect(r.structured!["error"]).toBe("not_yours");
  });
});
