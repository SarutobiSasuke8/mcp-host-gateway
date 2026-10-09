import { createLocalJWKSet, errors as joseErrors } from "jose";
import type { FlattenedJWSInput, JSONWebKeySet, JWSHeaderParameters } from "jose";

export interface JwksCacheOptions {
  url: URL;
  /** Maximum age of the cached key set. A request that finds it older refetches before verifying. */
  refreshMs: number;
  /**
   * Minimum gap between fetches started by a token whose key id is not in the cache, and between
   * retries after a failed fetch. Bounds how hard a stream of unknown key ids can hit the issuer.
   */
  cooldownMs: number;
  /**
   * How long the last good key set may still be used while the issuer cannot be reached. Past
   * this, verification fails closed with JwksUnavailableError.
   */
  maxStaleMs: number;
  timeoutMs: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected in tests. Defaults to Date.now. */
  now?: () => number;
}

/** The issuer's key set cannot be fetched and the last good copy is too old (or never existed). */
export class JwksUnavailableError extends Error {
  override readonly name = "JwksUnavailableError";
}

/** The issuer answered, but not with a usable key set. */
export class JwksFetchError extends Error {
  override readonly name = "JwksFetchError";
}

/**
 * Short-lived cache of the issuer's JWKS.
 *
 * Revocation at the issuer means a key leaves its JWKS (JobScout Pro signs each personal access
 * token with its own key and drops that key on revoke). So the time a revoked token keeps working
 * is the age of the cached key set, and the time a new token takes to work is how long an
 * unknown key id waits for a refetch. This cache bounds both:
 *
 * - no token is verified against a key set older than `refreshMs`; the first request after that
 *   refetches (one fetch shared by every concurrent request) before it verifies;
 * - a token whose key id is unknown triggers an immediate refetch, unless one started within
 *   `cooldownMs`, so a newly issued token works on its first call;
 * - if the issuer is unreachable, the last good set is used for at most `maxStaleMs`, then every
 *   request fails closed until the issuer answers again.
 */
export class JwksCache {
  private readonly options: JwksCacheOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private local: ReturnType<typeof createLocalJWKSet> | undefined;
  private keyCount = 0;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;
  private fetches = 0;

  constructor(options: JwksCacheOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Number of fetches started so far (successful or not). For tests and diagnostics. */
  get fetchCount(): number {
    return this.fetches;
  }

  /** Keys in the current set. Zero before the first successful fetch. */
  get size(): number {
    return this.keyCount;
  }

  /**
   * Fetch the key set now. Concurrent callers share one fetch. Throws JwksFetchError (bad
   * status or body) or the underlying network error; the previous set is kept on failure.
   */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.attemptedAt = this.now();
    this.fetches += 1;
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async load(): Promise<void> {
    const response = await this.fetchImpl(this.options.url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new JwksFetchError(`JWKS endpoint ${this.options.url.href} returned HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!body || !Array.isArray(body.keys)) throw new JwksFetchError(`JWKS endpoint ${this.options.url.href} did not return a key set`);
    // createLocalJWKSet validates the shape and throws JWKSInvalid on a malformed set.
    let local: ReturnType<typeof createLocalJWKSet>;
    try {
      local = createLocalJWKSet(body as JSONWebKeySet);
    } catch (error) {
      throw new JwksFetchError(`JWKS endpoint ${this.options.url.href} returned an invalid key set: ${(error as Error).message}`);
    }
    this.local = local;
    this.keyCount = body.keys.length;
    this.fetchedAt = this.now();
  }

  private age(): number {
    return this.now() - this.fetchedAt;
  }

  /** True when a new fetch may start: one is already running, or the cooldown has passed. */
  private mayFetch(): boolean {
    return !!this.pending || this.now() - this.attemptedAt >= this.options.cooldownMs;
  }

  /** Refetch, swallowing the error: callers decide from the age of the set whether to proceed. */
  private async tryRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // Kept as the last good set until maxStaleMs; see usable().
    }
  }

  private usable(): ReturnType<typeof createLocalJWKSet> {
    if (!this.local || this.age() > this.options.maxStaleMs) {
      throw new JwksUnavailableError(`signing keys unavailable: ${this.options.url.href} could not be fetched`);
    }
    return this.local;
  }

  /** Key resolver for jose's jwtVerify. */
  readonly getKey = async (header: JWSHeaderParameters, token: FlattenedJWSInput): Promise<CryptoKey> => {
    if (this.age() >= this.options.refreshMs && this.mayFetch()) await this.tryRefresh();
    try {
      return await this.usable()(header, token);
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey) || !this.mayFetch()) throw error;
      // Unknown key id: probably a key minted since the last fetch. Look once more.
      await this.tryRefresh();
      return await this.usable()(header, token);
    }
  };
}
