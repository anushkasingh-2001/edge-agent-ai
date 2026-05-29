/**
 * Stripe REST helper.
 *
 * We deliberately avoid the `stripe` SDK (zero new dependencies) and
 * talk to Stripe's HTTPS API directly via `fetch` + `application/x-www-
 * form-urlencoded`. Three small primitives are enough:
 *
 *   - `stripeRequest(path, params)` — signed POST to api.stripe.com
 *   - `verifyStripeSignature(payload, header, secret)` — webhook HMAC
 *   - `mapStripePriceToTier(priceId)` — env-driven plan mapping
 *
 * STRIPE_SECRET_KEY is read at call time (not at module load) so tests
 * can override per-test.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

const STRIPE_API_BASE = "https://api.stripe.com/v1"
const STRIPE_API_VERSION = "2024-06-20"

export class StripeError extends Error {
  readonly status: number
  readonly type: string
  constructor(status: number, type: string, message: string) {
    super(message)
    this.name = "StripeError"
    this.status = status
    this.type = type
  }
}

function secretKey(): string {
  const k = process.env.STRIPE_SECRET_KEY ?? ""
  if (!k.trim()) {
    throw new StripeError(
      500,
      "stripe_not_configured",
      "STRIPE_SECRET_KEY is not set on this server.",
    )
  }
  return k
}

function encodeFormParams(
  params: Record<string, unknown>,
  prefix = "",
): string[] {
  const pairs: string[] = []
  for (const [rawKey, rawVal] of Object.entries(params)) {
    const k = prefix ? `${prefix}[${rawKey}]` : rawKey
    if (rawVal === undefined || rawVal === null) continue
    if (Array.isArray(rawVal)) {
      rawVal.forEach((v, i) => {
        const subKey = `${k}[${i}]`
        if (v !== null && typeof v === "object") {
          pairs.push(...encodeFormParams(v as Record<string, unknown>, subKey))
        } else {
          pairs.push(`${encodeURIComponent(subKey)}=${encodeURIComponent(String(v))}`)
        }
      })
    } else if (typeof rawVal === "object") {
      pairs.push(...encodeFormParams(rawVal as Record<string, unknown>, k))
    } else {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(rawVal))}`)
    }
  }
  return pairs
}

export async function stripeRequest<T = Record<string, unknown>>(
  path: string,
  params: Record<string, unknown> = {},
  init: { method?: "GET" | "POST" } = {},
): Promise<T> {
  const method = init.method ?? "POST"
  const body = encodeFormParams(params).join("&")
  const url = method === "GET" && body ? `${STRIPE_API_BASE}${path}?${body}` : `${STRIPE_API_BASE}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Stripe-Version": STRIPE_API_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? body : undefined,
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* non-JSON, leave empty */
  }
  if (!res.ok) {
    const err = (parsed.error as { type?: string; message?: string }) ?? {}
    throw new StripeError(
      res.status,
      err.type ?? "api_error",
      err.message ?? `Stripe ${path} failed with ${res.status}`,
    )
  }
  return parsed as T
}

/**
 * Verify a Stripe webhook signature header. Implements the standard
 * `t=<timestamp>,v1=<hmac>` scheme. Returns the parsed event payload
 * on success and throws `StripeError` otherwise.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSec = 300,
): Record<string, unknown> {
  if (!signatureHeader) {
    throw new StripeError(400, "missing_signature", "Missing Stripe-Signature header.")
  }
  if (!secret) {
    throw new StripeError(
      500,
      "stripe_not_configured",
      "STRIPE_WEBHOOK_SECRET is not set on this server.",
    )
  }
  const parts = signatureHeader.split(",").map((p) => p.trim())
  let timestamp = 0
  const sigs: string[] = []
  for (const p of parts) {
    if (p.startsWith("t=")) timestamp = Number(p.slice(2))
    else if (p.startsWith("v1=")) sigs.push(p.slice(3))
  }
  if (!timestamp || sigs.length === 0) {
    throw new StripeError(400, "invalid_signature", "Malformed Stripe-Signature header.")
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")
  const expectedBuf = Buffer.from(expected, "hex")
  let ok = false
  for (const s of sigs) {
    const buf = Buffer.from(s, "hex")
    if (buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf)) {
      ok = true
      break
    }
  }
  if (!ok) {
    throw new StripeError(400, "invalid_signature", "Stripe signature mismatch.")
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    throw new StripeError(400, "stale_timestamp", "Webhook timestamp outside tolerance.")
  }
  try {
    return JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    throw new StripeError(400, "invalid_payload", "Webhook body is not valid JSON.")
  }
}

import type { PlanTier } from "./server-billing-store"

/**
 * Resolve a Stripe price id → PlanTier by reading the env vars set on
 * the operator side. We intentionally don't hardcode prices.
 */
export function mapStripePriceToTier(priceId: string | null | undefined): PlanTier {
  if (!priceId) return "free"
  const map: Record<string, PlanTier> = {
    [process.env.STRIPE_PRICE_STARTER ?? ""]: "starter",
    [process.env.STRIPE_PRICE_PRO ?? ""]: "pro",
    [process.env.STRIPE_PRICE_TEAM ?? ""]: "team",
    [process.env.STRIPE_PRICE_ENTERPRISE ?? ""]: "enterprise",
  }
  return map[priceId] ?? "free"
}

/** Plan tier → Stripe price (used by the checkout route). */
export function priceForTier(tier: PlanTier): string | null {
  switch (tier) {
    case "starter":
      return process.env.STRIPE_PRICE_STARTER ?? null
    case "pro":
      return process.env.STRIPE_PRICE_PRO ?? null
    case "team":
      return process.env.STRIPE_PRICE_TEAM ?? null
    case "enterprise":
      return process.env.STRIPE_PRICE_ENTERPRISE ?? null
    default:
      return null
  }
}
