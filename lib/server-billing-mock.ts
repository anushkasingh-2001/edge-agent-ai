/**
 * Dummy / mock billing mode — instant plan upgrades with no Stripe.
 *
 * Enable on the cloud backend with `BILLING_MOCK=1` and on the client
 * (desktop/web build) with `NEXT_PUBLIC_BILLING_MOCK=1`. Works in
 * production deployments for testing/staging; set both flags to `0` (or
 * unset) when switching to real Stripe payments.
 *
 * SECURITY: mock mode never accepts user-supplied API keys. Upgrades are
 * server-side only, tied to the authenticated account session.
 */

/** Shown in the UI when mock billing is active. */
export const DEMO_BILLING_LABEL = "Demo billing mode — no real payment charged."

/** Server-side: dummy checkout + dev-login routes are enabled. */
export function billingMockEnabled(): boolean {
  return (process.env.BILLING_MOCK ?? "").trim() === "1"
}

/** Stripe env vars required only when mock billing is off. */
export const STRIPE_CLOUD_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_TEAM",
  "NEXT_PUBLIC_BILLING_SUCCESS_URL",
  "NEXT_PUBLIC_BILLING_CANCEL_URL",
] as const
