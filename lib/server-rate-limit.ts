/**
 * Rate limiter with a pluggable backend (fixed window).
 *
 * Backends:
 *   - in-memory (default): per-process counters. Great for local/dev and as an
 *     abuse brake, but NOT shared across serverless instances.
 *   - Upstash Redis (production): shared counters across every instance. Used
 *     automatically when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
 *     are set. In production without Redis we warn once and fall back to
 *     in-memory (fail-safe: the endpoint still enforces a per-instance limit).
 *
 * Keys are namespaced by bucket (e.g. "login:fail"). No PII beyond the derived
 * key is stored, and nothing here logs tokens, links, or secrets.
 *
 * Primitives:
 *   - `take(bucket, key, windowMs)`  → increment + return the window count.
 *   - `peek(bucket, key, windowMs)`  → read the window count without consuming.
 *
 * Consume-style routes (register/forgot/etc.) call `take` and block when the
 * returned count exceeds `max`. Login blocks on `peek` (so successful logins
 * don't burn the budget) and only `take`s on a failed attempt.
 */

interface Counter {
  count: number
  resetAt: number
}

interface RateBackend {
  readonly kind: "memory" | "redis"
  take(fullKey: string, windowMs: number, now: number): Promise<Counter>
  peek(fullKey: string, windowMs: number, now: number): Promise<Counter>
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

const counters = new Map<string, Counter>()

function memCurrent(key: string, windowMs: number, now: number): Counter {
  const existing = counters.get(key)
  if (!existing || existing.resetAt <= now) {
    return { count: 0, resetAt: now + windowMs }
  }
  return existing
}

const memoryBackend: RateBackend = {
  kind: "memory",
  async take(key, windowMs, now) {
    const c = memCurrent(key, windowMs, now)
    c.count += 1
    counters.set(key, c)
    return c
  },
  async peek(key, windowMs, now) {
    return memCurrent(key, windowMs, now)
  },
}

// ---------------------------------------------------------------------------
// Upstash Redis backend (REST)
// ---------------------------------------------------------------------------

type Pipe = Array<Array<string | number>>

class RedisBackend implements RateBackend {
  readonly kind = "redis" as const
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async pipeline(commands: Pipe): Promise<unknown[]> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    })
    if (!res.ok) throw new Error(`upstash HTTP ${res.status}`)
    const json = (await res.json()) as Array<{ result?: unknown; error?: string }>
    return json.map((r) => {
      if (r && typeof r === "object" && "error" in r && r.error) throw new Error(String(r.error))
      return r?.result
    })
  }

  async take(key: string, windowMs: number, now: number): Promise<Counter> {
    try {
      const [count, ttl] = (await this.pipeline([
        ["INCR", key],
        ["PTTL", key],
      ])) as [number, number]
      let resetMs = ttl
      if (ttl < 0) {
        // First hit in this window (or no expiry yet) — set the TTL.
        await this.pipeline([["PEXPIRE", key, windowMs]])
        resetMs = windowMs
      }
      return { count: Number(count) || 0, resetAt: now + Math.max(1, resetMs) }
    } catch (e) {
      warnRedisError(e)
      return memoryBackend.take(key, windowMs, now)
    }
  }

  async peek(key: string, windowMs: number, now: number): Promise<Counter> {
    try {
      const [val, ttl] = (await this.pipeline([
        ["GET", key],
        ["PTTL", key],
      ])) as [string | null, number]
      const resetMs = ttl > 0 ? ttl : windowMs
      return { count: val == null ? 0 : Number(val) || 0, resetAt: now + resetMs }
    } catch (e) {
      warnRedisError(e)
      return memoryBackend.peek(key, windowMs, now)
    }
  }
}

let warnedRedisError = false
function warnRedisError(e: unknown): void {
  if (warnedRedisError) return
  warnedRedisError = true
  console.warn(
    `[rate-limit] Upstash Redis unavailable — falling back to in-memory limits: ${e instanceof Error ? e.message : String(e)}`,
  )
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

const KEY_PREFIX = "eaai:rl:"

function redisConfigured(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL ?? "").trim() &&
      (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim(),
  )
}

let cachedBackend: RateBackend | null = null
let warnedProdNoRedis = false

function getBackend(): RateBackend {
  if (cachedBackend) return cachedBackend
  if (redisConfigured()) {
    cachedBackend = new RedisBackend(
      (process.env.UPSTASH_REDIS_REST_URL ?? "").trim().replace(/\/+$/, ""),
      (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim(),
    )
  } else {
    if (process.env.NODE_ENV === "production" && !warnedProdNoRedis) {
      warnedProdNoRedis = true
      console.warn(
        "[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set in production — " +
          "auth rate limits are per-instance only. Configure Upstash Redis for shared limits.",
      )
    }
    cachedBackend = memoryBackend
  }
  return cachedBackend
}

/** Which backend is active ("redis" when Upstash env is present, else "memory"). */
export function rateLimiterKind(): "memory" | "redis" {
  return getBackend().kind
}

function fullKey(bucket: string, key: string): string {
  return `${KEY_PREFIX}${bucket}:${key}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Increment the counter for (bucket,key) and return the new window state. */
export function take(bucket: string, key: string, windowMs: number, now = Date.now()): Promise<Counter> {
  return getBackend().take(fullKey(bucket, key), windowMs, now)
}

/** Read the counter without incrementing. */
export function peek(bucket: string, key: string, windowMs: number, now = Date.now()): Promise<Counter> {
  return getBackend().peek(fullKey(bucket, key), windowMs, now)
}

/** Seconds until the window resets (>= 1). */
export function retryAfterSeconds(resetAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000))
}

/** Derive a best-effort client IP from proxy headers (Vercel/edge set these). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  return req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || "0.0.0.0"
}

export interface RateLimitDecision {
  ok: boolean
  retryAfterSec: number
}

/**
 * Consume-and-check: increment the window and block when the count exceeds
 * `max`. Use for register / forgot-password / send-verification / reset /
 * refresh.
 */
export async function enforceRateLimit(
  bucket: string,
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const c = await take(bucket, key, windowMs, now)
  if (c.count > max) return { ok: false, retryAfterSec: retryAfterSeconds(c.resetAt, now) }
  return { ok: true, retryAfterSec: 0 }
}

/**
 * Check WITHOUT consuming. Use for login (peek before verifying credentials so
 * successful logins don't count against the budget; the route calls
 * `recordFailure` on a bad attempt).
 */
export async function isRateLimited(
  bucket: string,
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const c = await peek(bucket, key, windowMs, now)
  if (c.count >= max) return { ok: false, retryAfterSec: retryAfterSeconds(c.resetAt, now) }
  return { ok: true, retryAfterSec: 0 }
}

/** Record one failed attempt (increment the window). */
export async function recordFailure(
  bucket: string,
  key: string,
  windowMs: number,
  now = Date.now(),
): Promise<void> {
  await take(bucket, key, windowMs, now)
}

export function _resetRateLimitsForTests(): void {
  counters.clear()
  cachedBackend = null
  warnedProdNoRedis = false
  warnedRedisError = false
}

// Common window constants.
export const MIN = 60 * 1000
export const HOUR = 60 * MIN
