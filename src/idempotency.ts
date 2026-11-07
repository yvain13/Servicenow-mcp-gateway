// Remembers the result of a keyed operation for a TTL, so a repeated submit (double click,
// host retry) returns the first result instead of creating a second record. Concurrent
// calls with the same key share one in-flight promise.
export class IdempotencyCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private readonly ttlMs = 10 * 60_000) {}

  async run(key: string, fn: () => Promise<T>, keep: (v: T) => boolean = () => true): Promise<T> {
    const now = Date.now();
    for (const [k, e] of this.entries) if (now - e.at > this.ttlMs) this.entries.delete(k);

    const hit = this.entries.get(key);
    if (hit) return hit.value;

    const value = fn();
    this.entries.set(key, { at: now, value });
    try {
      const v = await value;
      // Don't pin failures (validation errors etc.): the user fixes the form and resubmits.
      if (!keep(v)) this.entries.delete(key);
      return v;
    } catch (err) {
      this.entries.delete(key);
      throw err;
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
