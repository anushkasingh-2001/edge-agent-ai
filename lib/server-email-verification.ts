/**
 * Email-verification enforcement policy.
 *
 * Unverified accounts may use the FREE tier only. Paid checkout and hosted AI
 * beyond the free allowance are blocked until the email is verified — EXCEPT
 * in dev mode, where enforcement is off so local/desktop development isn't
 * gated on email delivery.
 *
 * "Dev mode" = not production, OR the dev-auth stub is enabled. Self-hosted
 * single-user builds can also opt out explicitly with
 * `EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION=0`.
 */

import type { Session } from "./server-auth"

export function emailVerificationEnforced(): boolean {
  // Explicit override wins (force-on for staging/tests, force-off for
  // self-hosted single-user builds).
  const flag = (process.env.EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION ?? "").trim()
  if (flag === "1") return true
  if (flag === "0") return false
  // Default: enforce in production, skip in dev.
  if (process.env.NODE_ENV !== "production") return false
  if (process.env.EDGE_AGENT_DEV_AUTH === "1") return false
  return true
}

/**
 * True when the caller is allowed to take a paid action (checkout / paid AI).
 * A session whose `emailVerified` is `undefined` (legacy / GitHub-derived) is
 * treated as verified for backward compatibility — only an explicit `false`
 * blocks, and only when enforcement is on.
 */
export function isPaidEligible(session: Pick<Session, "emailVerified">): boolean {
  if (!emailVerificationEnforced()) return true
  return session.emailVerified !== false
}

export const EMAIL_UNVERIFIED_MESSAGE =
  "Verify your email to unlock paid plans and AI modes beyond the free tier. Check your inbox or resend the verification link from your account."
