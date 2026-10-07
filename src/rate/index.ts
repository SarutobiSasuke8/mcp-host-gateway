import { rateLimited } from "../edge/errors.js";

/**
 * In-memory token bucket keyed by an arbitrary string (identity, or identity plus upstream).
 *
 * Capacity equals the plan's requests per minute and refills continuously at that rate, so a
 * caller can burst up to one minute's quota and then sustain exactly rpm. Buckets are evicted
 * when they have been full and idle for a while so the map does not grow without bound.
 *
 * v0 scope: single process. A multi-instance deployment needs a shared store; see README.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  capacity: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private lastSweep: number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.lastSweep = this.now();
  }

  /** Consume one request against `key` with the given per-minute quota. */
  take(key: string, rpm: number): RateDecision {
    const now = this.now();
    this.sweep(now);
    const refillPerMs = rpm / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.capacity !== rpm) {
      bucket = { tokens: rpm, updatedAt: now, capacity: rpm };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(rpm, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    }
    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  /** Like take() but throws the MCP-facing error when over quota. */
  enforce(key: string, rpm: number): RateDecision {
    const decision = this.take(key, rpm);
    if (!decision.allowed) {
      throw rateLimited(decision.retryAfterSeconds, { limit_rpm: rpm });
    }
    return decision;
  }

  size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * (bucket.capacity / 60_000);
      if (refilled >= bucket.capacity && now - bucket.updatedAt > 120_000) this.buckets.delete(key);
    }
  }
}
