/**
 * Fixed-window failure counter for sign-in. In memory, so it resets on restart
 * and is per instance; a multi-instance deployment would back this with Redis
 * or Postgres.
 */
export class FailureThrottle {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  isLocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) return false;
    return h.count >= this.maxFailures;
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}
