import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeSN } from "./fake-sn.js";
import { ctxFor } from "./helpers.js";
import { catalogHandlers, clearDisplayCache, formatDuration, resetCatalogIdempotency } from "../src/handlers/catalog.js";
import { mergeNewSeeds as mergeNewSeedsForTest } from "../src/storage.js";

const sn = new FakeSN();
let item: any, contact: any, costVar: any, purposeVar: any, contactVar: any, me: any, cc: any;

beforeAll(async () => {
  await sn.start();
});
afterAll(async () => {
  await sn.stop();
});

// Mirrors the OOB "Provision a Database" item: two references and a multiple choice.
beforeEach(() => {
  sn.tables = {};
  sn.calls = [];
  resetCatalogIdempotency();
  clearDisplayCache();
  me = sn.insert("sys_user", { user_name: "admin", name: "System Administrator", email: "admin@example.com", active: "true" });
  contact = sn.insert("sys_user", { user_name: "abel.tuter", name: "Abel Tuter", email: "abel@example.com", active: "true" });
  sn.insert("sys_user", { user_name: "old", name: "Abel Former", active: "false" });
  cc = sn.insert("cmn_cost_center", { name: "Finance", code: "FIN" });
  sn.insert("cmn_cost_center", { name: "Engineering", code: "ENG" });
  sn.insert("sys_dictionary", { name: "sys_user", element: "name", display: "true" });
  sn.insert("sys_dictionary", { name: "cmn_cost_center", element: "name", display: "true" });
  item = sn.insert("sc_cat_item", {
    name: "Provision a Database",
    short_description: "Request to provision a new database",
    description: "<ul><li>Backup services</li></ul><script>alert(1)</script>",
    active: "true",
    price: "0",
    delivery_time: "1970-01-03 00:00:00",
    no_quantity: "false",
    sys_class_name: "sc_cat_item",
  });
  contactVar = sn.insert("item_option_new", {
    cat_item: item.sys_id, name: "primary_contact", question_text: "Who is the primary contact?", type: "8",
    reference: "sys_user", mandatory: "true", read_only: "false", order: "100", active: "true",
  });
  costVar = sn.insert("item_option_new", {
    cat_item: item.sys_id, name: "cost_center", question_text: "What cost center will be billed?", type: "8",
    reference: "cmn_cost_center", mandatory: "true", read_only: "false", order: "200", active: "true",
  });
  purposeVar = sn.insert("item_option_new", {
    cat_item: item.sys_id, name: "business_purpose", question_text: "What is the business purpose", type: "3",
    mandatory: "true", read_only: "false", order: "300", active: "true",
  });
  ["KTLO", "Special Projects", "Testing", "Other"].forEach((t, i) =>
    sn.insert("question_choice", { question: purposeVar.sys_id, text: t, value: t.toLowerCase().replace(" ", "_"), order: String(i * 100), inactive: "false" })
  );
  sn.insert("item_option_new", {
    cat_item: item.sys_id, name: "inactive_one", question_text: "Gone", type: "6", active: "false", order: "50",
  });
  sn.insert("item_option_new", {
    cat_item: item.sys_id, name: "widget", question_text: "Custom widget", type: "14", active: "true", order: "400",
  });
});

const call = (name: string, args: Record<string, unknown>, ctx = ctxFor(sn)) => catalogHandlers[name]!.fn(args, ctx);

describe("catalog form", () => {
  it("builds the form from the item's variables, in order, with choices", async () => {
    const r = await call("catalog.item_form", { item_sys_id: item.sys_id });
    expect(r.isError).toBeFalsy();
    const f = r.structured as any;
    expect(f.item).toMatchObject({ name: "Provision a Database", delivery_time: "2 days", quantity_allowed: true });
    expect(f.variables.map((v: any) => [v.name, v.kind, v.mandatory])).toEqual([
      ["primary_contact", "reference", true],
      ["cost_center", "reference", true],
      ["business_purpose", "radio", true],
    ]);
    expect(f.variables[1].reference_table).toBe("cmn_cost_center");
    expect(f.variables[2].choices.map((c: any) => c.label)).toEqual(["KTLO", "Special Projects", "Testing", "Other"]);
    expect(f.unsupported).toEqual([{ name: "widget", label: "Custom widget", reason: "Custom (macro)" }]);
  });

  it("includes variables from single-row variable sets at the set's position", async () => {
    const set = sn.insert("item_option_new_set", { title: "Requester", type: "one_to_one" });
    sn.insert("io_set_item", { sc_cat_item: item.sys_id, variable_set: set.sys_id, order: "150" });
    sn.insert("item_option_new", { variable_set: set.sys_id, name: "phone", question_text: "Phone", type: "6", order: "1", active: "true" });
    const r = await call("catalog.item_form", { item_sys_id: item.sys_id });
    expect((r.structured as any).variables.map((v: any) => v.name)).toEqual(["primary_contact", "phone", "cost_center", "business_purpose"]);
  });

  it("opens by name, passes prefill through and lists what is missing", async () => {
    const r = await call("catalog.open_form", { item: "provision a database", values: { business_purpose: "Testing" } });
    expect(r.isError).toBeFalsy();
    expect(r.structured).toMatchObject({
      item_sys_id: item.sys_id,
      item_name: "Provision a Database",
      prefill: { business_purpose: "Testing" },
      missing: ["primary_contact", "cost_center"],
    });
  });

  it("describes the variables in text for clients without apps", async () => {
    const r = await call("catalog.open_form", { item: "Provision a Database" }, ctxFor(sn, { apps: false }));
    expect(r.text).toContain("catalog_order");
    expect(r.text).toContain("cost_center: What cost center will be billed? [required] (reference → cmn_cost_center");
    expect(r.text).toContain("ktlo (KTLO)");
  });

  it("reports an unknown item", async () => {
    const r = await call("catalog.open_form", { item: "Nope" });
    expect(r.isError).toBe(true);
  });

  it("searches a reference variable's table by its display field", async () => {
    const r = await call("catalog.reference_search", { variable_id: contactVar.sys_id, text: "abel" });
    expect((r.structured as any).results).toEqual([{ sys_id: contact.sys_id, label: "Abel Tuter", detail: "abel@example.com" }]);
    const cost = await call("catalog.reference_search", { variable_id: costVar.sys_id, text: "fin" });
    expect((cost.structured as any).results.map((x: any) => x.label)).toEqual(["Finance"]);
  });

  it("formats delivery durations", () => {
    expect(formatDuration("1970-01-01 04:30:00")).toBe("4 hours 30 min");
    expect(formatDuration("1970-01-02 00:00:00")).toBe("1 day");
  });
});

describe("catalog order", () => {
  const vars = () => ({ primary_contact: contact.sys_id, cost_center: cc.sys_id, business_purpose: "ktlo" });

  it("orders through order_now and returns the REQ and RITM", async () => {
    const r = await call("catalog.order", { item_sys_id: item.sys_id, variables: vars(), quantity: 2 });
    expect(r.isError).toBeFalsy();
    const out = r.structured as any;
    expect(out.request_number).toMatch(/^REQ/);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ stage: "Request Approved", state: "Open" });
    const post = sn.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(`/api/sn_sc/servicecatalog/items/${item.sys_id}/order_now`);
    expect(post.body).toEqual({ sysparm_quantity: "2", variables: vars() });
  });

  it("resolves names and choice labels on the model path", async () => {
    const r = await call("catalog.order", {
      item: "Provision a Database",
      variables: { primary_contact: "Abel Tuter", cost_center: "Finance", business_purpose: "Special Projects" },
    });
    expect(r.isError).toBeFalsy();
    const post = sn.calls.find((c) => c.method === "POST")!;
    expect(post.body.variables).toEqual({ primary_contact: contact.sys_id, cost_center: cc.sys_id, business_purpose: "special_projects" });
  });

  it("returns field errors for missing and invalid values and orders nothing", async () => {
    const r = await call("catalog.order", {
      item_sys_id: item.sys_id,
      variables: { primary_contact: "Nobody", business_purpose: "Fun" },
    });
    expect(r.isError).toBe(true);
    expect((r.structured as any).errors).toEqual([
      { field: "primary_contact", message: 'No match for "Nobody"' },
      { field: "cost_center", message: "What cost center will be billed? is required" },
      { field: "business_purpose", message: "Choose one of: KTLO, Special Projects, Testing, Other" },
    ]);
    expect(sn.tables["sc_request"]).toBeUndefined();
  });

  it("drops variables the item doesn't have", async () => {
    await call("catalog.order", { item_sys_id: item.sys_id, variables: { ...vars(), injected: "x" } });
    expect(sn.calls.find((c) => c.method === "POST")!.body.variables).not.toHaveProperty("injected");
  });

  it("orders once per idempotency key", async () => {
    const a = await call("catalog.order", { item_sys_id: item.sys_id, variables: vars(), idempotency_key: "k1" });
    const b = await call("catalog.order", { item_sys_id: item.sys_id, variables: vars(), idempotency_key: "k1" });
    expect(b.structured).toEqual(a.structured);
    expect(sn.tables["sc_request"]).toHaveLength(1);
  });

  it("reports request status with its requested items", async () => {
    const o = await call("catalog.order", { item_sys_id: item.sys_id, variables: vars() });
    const r = await call("catalog.request_status", { request: (o.structured as any).request_number });
    expect(r.structured).toMatchObject({ request_number: (o.structured as any).request_number, items: [{ stage: "Request Approved" }] });
  });
});

describe("seed upgrades", () => {
  const seed = {
    instance: null,
    servers: [
      { id: "a", name: "incident-mcp", port: 1, description: "", tools: [] },
      { id: "old", name: "change-ops", port: 3, description: "", tools: [] },
      { id: "cat", name: "service-catalog", port: 2, description: "", tools: [], addedIn: "0.2.0" },
    ],
  } as any;
  const existing = () => ({ instance: null, servers: [{ id: "a", name: "incident-mcp", port: 1, description: "", tools: [] }] }) as any;

  it("adds a new built-in server to an existing store, without its seed metadata", () => {
    const store = existing();
    expect(mergeNewSeedsForTest(store, seed)).toBe(true);
    expect(store.servers.map((s: any) => s.id)).toEqual(["a", "cat"]); // the user's deleted change-ops stays gone
    expect(store.servers[1]).not.toHaveProperty("addedIn");
    expect(mergeNewSeedsForTest(store, seed)).toBe(false);
  });

  it("does not bring back a built-in server the user deleted", () => {
    const store = { ...existing(), removedSeeds: ["cat"] };
    expect(mergeNewSeedsForTest(store, seed)).toBe(false);
    expect(store.servers).toHaveLength(1);
  });

  it("moves to the next free port when the seed port is taken", () => {
    const store = { instance: null, servers: [{ id: "x", name: "apps-demo", port: 2, description: "", tools: [] }, { id: "y", name: "y", port: 3, description: "", tools: [] }] } as any;
    mergeNewSeedsForTest(store, seed);
    expect(store.servers.find((s: any) => s.id === "cat")?.port).toBe(4);
  });

  it("recovers a store that the earlier version marked as seeded but skipped", () => {
    const store = { ...existing(), seeded: ["a", "cat"] };
    expect(mergeNewSeedsForTest(store, seed)).toBe(true);
    expect(store).not.toHaveProperty("seeded");
    expect(store.servers.map((s: any) => s.id)).toEqual(["a", "cat"]);
  });

  it("skips a new server whose name is taken", () => {
    const store = { instance: null, servers: [{ id: "x", name: "service-catalog", port: 9, description: "", tools: [] }] } as any;
    mergeNewSeedsForTest(store, seed);
    expect(store.servers.map((s: any) => s.id)).toEqual(["x"]);
  });
});
