import { rateLimited } from "../edge/errors.js";

/**
 * Token bucket rate limiting behind a pluggable store.
 *
 * Capacity equals the plan's requests per minute and refills continuously at that rate, so a
 * caller can burst up to one minute's quota and then sustain exactly rpm. The bucket arithmetic
 * lives in `stepBucket` so every store applies identical rules; a store only decides where the
 * bucket state lives and how concurrent writers are serialised.
 *
 * Stores:
 * - `TokenBucketLimiter`: in-memory, one process. Used by tests and single-process dev runs.
 * - `SqliteRateStore` (./sqlite.ts): SQLite in WAL mode. Survives restarts and is shared by every
 *   gateway process on the same host that points at the same file.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface BucketState {
  tokens: number;
  updatedAt: number;
  capacity: number;
}

/** A shared or local store of token buckets. `take` consumes one request against `key`. */
export interface RateStore {
  readonly kind: string;
  take(key: string, rpm: number): RateDecision | Promise<RateDecision>;
  close?(): void | Promise<void>;
}

/** Buckets idle for this long have refilled completely (refill is at most one minute) and can be dropped. */
export const IDLE_EVICT_MS = 120_000;

/** Pure bucket step: refill to `now`, then try to consume one token. */
export function stepBucket(previous: BucketState | undefined, now: number, rpm: number): { next: BucketState; decision: RateDecision } {
  const refillPerMs = rpm / 60_000;
  let tokens: number;
  if (!previous || previous.capacity !== rpm) {
    tokens = rpm;
  } else {
    const elapsed = Math.max(0, now - previous.updatedAt);
    tokens = Math.min(rpm, previous.tokens + elapsed * refillPerMs);
  }
  if (tokens >= 1) {
    tokens -= 1;
    return { next: { tokens, updatedAt: now, capacity: rpm }, decision: { allowed: true, remaining: Math.floor(tokens), retryAfterSeconds: 0 } };
  }
  const deficit = 1 - tokens;
  const retryAfterSeconds = Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
  return { next: { tokens, updatedAt: now, capacity: rpm }, decision: { allowed: false, remaining: 0, retryAfterSeconds } };
}

/** Consume one request against the store and throw the MCP-facing error when over quota. */
export async function enforceRate(store: RateStore, key: string, rpm: number): Promise<RateDecision> {
  const decision = await store.take(key, rpm);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds, { limit_rpm: rpm });
  return decision;
}

/** In-memory token bucket store. Buckets are evicted once full and idle so the map stays bounded. */
export class TokenBucketLimiter implements RateStore {
  readonly kind = "memory";
  private readonly buckets = new Map<string, BucketState>();
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
    const { next, decision } = stepBucket(this.buckets.get(key), now, rpm);
    this.buckets.set(key, next);
    return decision;
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
      if (refilled >= bucket.capacity && now - bucket.updatedAt > IDLE_EVICT_MS) this.buckets.delete(key);
    }
  }
}
