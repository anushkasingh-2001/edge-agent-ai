/**
 * Stripe production readiness checks.
 *
 * Three classes of caller:
 *
 *   1. `stripeReadiness()` — pure, returns `{ ok, missing }`. Used by
 *      health endpoints and tests.
 *
 *   2. `assertStripeBillingConfigured()` / `assertStripeWebhookConfigured()`
 *      — throw `StripeConfigError` on missing env. Used by routes
 *      that need to fail fast with a structured response.
 *
 *   3. `hostedProviderReadiness()` — checks that AT LEAST one hosted
 *      provider key is configured. Routes use this so a misconfigured
 *      production never falls back to "ask user for an API key".
 *
 * The shape of the missing-key list is stable so the operator can
 * paste it directly into a runbook.
 */

export interface ReadinessReport {
  ok: boolean
  missing: string[]
  warnings?: string[]
}

export class StripeConfigError extends Error {
  readonly status = 503
  readonly code = "stripe_not_configured"
  readonly missing: string[]
  constructor(missing: string[]) {
    super(
      `Stripe is not fully configured on this server. Missing env vars: ${missing.join(", ")}`,
    )
    this.name = "StripeConfigError"
    this.missing = missing
  }
}

export class HostedProviderConfigError extends Error {
  readonly status = 503
  readonly code = "hosted_model_unconfigured"
  readonly missing: string[]
  constructor(missing: string[]) {
    super(
      `Hosted AI is not configured on this server. Missing provider env vars: ${missing.join(", ")}`,
    )
    this.name = "HostedProviderConfigError"
    this.missing = missing
  }
}

function nonempty(name: string): boolean {
  return ((process.env[name] ?? "").toString()).trim().length > 0
}

/** Stripe checkout / portal / webhook prerequisites. */
export function stripeReadiness(): ReadinessReport {
  const required = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_STARTER",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_TEAM",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_BILLING_SUCCESS_URL",
    "NEXT_PUBLIC_BILLING_CANCEL_URL",
  ]
  const missing = required.filter((k) => !nonempty(k))
  return { ok: missing.length === 0, missing }
}

/** Subset that only needs to be set on the *webhook* host. Checkout
 *  needs all of the above; the webhook host only needs the secret and
 *  the price→tier env vars. */
export function stripeWebhookReadiness(): ReadinessReport {
  const required = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_STARTER",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_TEAM",
  ]
  const missing = required.filter((k) => !nonempty(k))
  return { ok: missing.length === 0, missing }
}

export function assertStripeBillingConfigured(): void {
  const r = stripeReadiness()
  if (!r.ok) throw new StripeConfigError(r.missing)
}

export function assertStripeWebhookConfigured(): void {
  const r = stripeWebhookReadiness()
  if (!r.ok) throw new StripeConfigError(r.missing)
}

/** At least one hosted provider key is required for hosted AI to work.
 *  If `requiredProviders` is provided, ALL listed providers must be
 *  configured (this is the route-level check for a specific call). */
export function hostedProviderReadiness(
  requiredProviders?: Array<"openai" | "anthropic" | "gemini">,
): ReadinessReport {
  const map: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
  }
  if (requiredProviders && requiredProviders.length > 0) {
    const missing = requiredProviders.map((p) => map[p]).filter((k) => !nonempty(k))
    return { ok: missing.length === 0, missing }
  }
  // Any-one mode: every key absent is the only failure case.
  const all = Object.values(map)
  const present = all.filter((k) => nonempty(k))
  if (present.length === 0) return { ok: false, missing: all }
  return { ok: true, missing: [] }
}

/** Combined production-readiness sweep — convenient for the
 *  /api/system/health surface. */
export function productionReadiness(): ReadinessReport {
  const stripe = stripeReadiness()
  const hosted = hostedProviderReadiness()
  const auth: string[] = []
  if (
    !((process.env.JWT_SECRET ?? "").trim() ||
      (process.env.EDGE_AGENT_JWT_SECRET ?? "").trim())
  ) {
    auth.push("JWT_SECRET")
  }
  return {
    ok: stripe.ok && hosted.ok && auth.length === 0,
    missing: [...stripe.missing, ...hosted.missing, ...auth],
  }
}
