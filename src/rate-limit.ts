// Sliding-window limiter, one per session, to contain a runaway loop of write calls.
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max = Number(process.env["WRITE_RATE_LIMIT"] ?? 30),
    private readonly windowMs = 60_000
  ) {}

  take(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
