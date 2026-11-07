import { describe, expect, it } from "vitest";
import { encodedQueryFields, parseDateTime, sanitizeQueryText, toSNDateTime } from "../src/handlers/util.js";
import { IdempotencyCache } from "../src/idempotency.js";
import { RateLimiter } from "../src/rate-limit.js";

describe("sanitizeQueryText", () => {
  it("strips encoded-query separators and operators", () => {
    expect(sanitizeQueryText("db^ORactive=false")).toBe("db ORactive false");
    expect(sanitizeQueryText("a^NQsys_id!=x")).not.toMatch(/[\^=]/);
  });
  it("drops control characters and trims", () => {
    expect(sanitizeQueryText("  db\nprod\u0000 ")).toBe("db prod");
  });
  it("caps length", () => {
    expect(sanitizeQueryText("x".repeat(500)).length).toBe(100);
  });
});

describe("dates", () => {
  it("honours offsets and treats bare times as UTC", () => {
    expect(parseDateTime("2026-11-14T22:00:00+01:00")!.toISOString()).toBe("2026-11-14T21:00:00.000Z");
    expect(parseDateTime("2026-11-14 22:00")!.toISOString()).toBe("2026-11-14T22:00:00.000Z");
    expect(parseDateTime("not a date")).toBeUndefined();
  });
  it("formats ServiceNow internal date-times", () => {
    expect(toSNDateTime(new Date("2026-11-14T21:00:00Z"))).toBe("2026-11-14 21:00:00");
  });
});

describe("encodedQueryFields", () => {
  it("parses template values", () => {
    expect(encodedQueryFields("short_description=Patch^risk=4^EQ")).toEqual({ short_description: "Patch", risk: "4" });
  });
});

describe("IdempotencyCache", () => {
  it("shares one in-flight call per key and does not pin failures", async () => {
    const cache = new IdempotencyCache<number>();
    let n = 0;
    const fn = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return ++n;
    };
    const [a, b] = await Promise.all([cache.run("k", fn), cache.run("k", fn)]);
    expect([a, b]).toEqual([1, 1]);
    expect(await cache.run("k", fn)).toBe(1);
    expect(await cache.run("bad", fn, () => false)).toBe(2);
    expect(await cache.run("bad", fn, () => false)).toBe(3);
  });
});

describe("RateLimiter", () => {
  it("allows max calls per window", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.take(0)).toBe(true);
    expect(rl.take(1)).toBe(true);
    expect(rl.take(2)).toBe(false);
    expect(rl.take(1001)).toBe(true);
  });
});
