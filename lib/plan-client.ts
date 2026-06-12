"use client"

/**
 * Plan summary client helper. Fetches GET /api/plan — the SAFE view of
 * the user's subscription (tier, allowed modes, manual permission,
 * remaining credits). No provider keys are ever returned.
 *
 * The UI uses this to disable Pro/Max/Manual the plan doesn't include,
 * show Hosted credits, and (Manual) only offer plan-allowed models.
 */

import { useEffect, useState } from "react"
import { apiFetch, clearCloudTokens, setCloudAuthToken, setCloudRefreshToken } from "./api-fetch"

export interface PlanSummary {
  tier: "free" | "starter" | "pro" | "team" | "enterprise"
  allowedModes: Array<"save" | "auto" | "pro" | "max" | "manual">
  allowManualModelSelection: boolean
  creditsTotal: number
  creditsUsed: number
  creditsRemaining: number
  subscriptionStatus?:
    | "active"
    | "trialing"
    | "past_due"
    | "canceled"
    | "incomplete"
    | "none"
  billingPeriodEnd?: string | null
}

export interface PlanResponse {
  plan: PlanSummary
  authenticated: boolean
  email?: string | null
  authSource?: string
  capabilities?: { stripeReady: boolean; hostedReady: boolean; billingBackend?: string }
}

export type AnalysisMode = "save" | "auto" | "pro" | "max" | "manual"

/**
 * The modes a user may actually select in the UI, given their auth +
 * plan state. This is the single source of truth the Scan Center toggle
 * consults; the server enforces the same rules independently.
 *
 * Mode access depends on login + subscription tier:
 *
 *   - Not signed in (anonymous): ONLY "save" (deterministic scan, no
 *     hosted AI). AI modes need an account → clicking prompts sign-in.
 *   - Signed in with a loaded plan: exactly `plan.allowedModes` (tier-gated:
 *     free/starter → save+auto, pro → +pro, team/enterprise → all).
 *   - Signed in but plan not yet loaded: conservative ["save"] so we never
 *     optimistically unlock a mode the server would reject. The server is
 *     always the source of truth.
 */
export function effectiveAllowedModes(
  authenticated: boolean,
  plan: PlanSummary | null,
): AnalysisMode[] {
  if (!authenticated) return ["save"]
  if (plan) return [...plan.allowedModes]
  return ["save"]
}

export async function fetchPlanSummary(signal?: AbortSignal): Promise<PlanSummary | null> {
  try {
    const res = await apiFetch("/api/plan", { signal })
    if (!res.ok) return null
    const json = (await res.json()) as { plan?: PlanSummary }
    return json.plan ?? null
  } catch {
    return null
  }
}

export function usePlanSummary(): { plan: PlanSummary | null; loading: boolean } {
  const [plan, setPlan] = useState<PlanSummary | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const c = new AbortController()
    fetchPlanSummary(c.signal)
      .then((p) => setPlan(p))
      .finally(() => setLoading(false))
    return () => c.abort()
  }, [])
  return { plan, loading }
}

export interface PlanAccess {
  authenticated: boolean
  email: string | null
  plan: PlanSummary | null
  allowedModes: AnalysisMode[]
  billingBackend?: string
  loading: boolean
}

/**
 * Richer than `usePlanSummary`: also exposes whether the caller is
 * authenticated and which modes are effectively selectable. The Scan
 * Center uses this to lock AI modes for anonymous users.
 */
export function usePlanAccess(): PlanAccess {
  const [state, setState] = useState<Omit<PlanAccess, "loading">>({
    authenticated: false,
    email: null,
    plan: null,
    allowedModes: ["save"],
  })
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const c = new AbortController()
    apiFetch("/api/plan", { signal: c.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: PlanResponse | null) => {
        if (!json) return
        const authenticated = Boolean(json.authenticated)
        const plan = json.plan ?? null
        setState({
          authenticated,
          email: json.email ?? null,
          plan,
          allowedModes: effectiveAllowedModes(authenticated, plan),
          billingBackend: json.capabilities?.billingBackend,
        })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    return () => c.abort()
  }, [])
  return { ...state, loading }
}

/** True when the plan permits this intelligence mode. Once the plan is
 *  loaded we trust `allowedModes` exactly (no optimistic unlocks). Before
 *  the plan loads only the deterministic "save" mode is assumed available;
 *  the server enforces the same rules regardless. */
export function modeAllowedByPlan(
  plan: PlanSummary | null,
  mode: "save" | "auto" | "pro" | "max" | "manual",
): boolean {
  if (!plan) return mode === "save"
  return plan.allowedModes.includes(mode)
}

/** Shown in the UI when mock billing is active (mirrors server label). */
export const DEMO_BILLING_LABEL = "Demo billing mode — no real payment charged."

/** Client-side: dummy billing UI + `/api/billing/dev-checkout` path. */
export function isBillingMockClient(): boolean {
  return process.env.NEXT_PUBLIC_BILLING_MOCK === "1"
}

/**
 * Kick off checkout for a tier. Uses dummy billing when
 * `NEXT_PUBLIC_BILLING_MOCK=1`, otherwise Stripe Checkout.
 */
export async function startCheckout(
  tier: "starter" | "pro" | "team",
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  if (isBillingMockClient()) {
    const mock = await selectPlanMock(tier)
    if (!mock.ok) return mock
    return { ok: true }
  }
  try {
    const res = await apiFetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    })
    const data = (await res.json()) as { url?: string; error?: string; code?: string }
    if (!res.ok || !data.url) {
      return { ok: false, error: data.error ?? `Checkout failed (HTTP ${res.status})`, code: data.code }
    }
    if (typeof window !== "undefined") window.location.assign(data.url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/**
 * DUMMY plan selection — hits `/api/billing/dev-checkout`, which upgrades
 * the subscription directly with no real payment. Works when the server has
 * `BILLING_MOCK=1` (local, staging, or Vercel demo deployments).
 *
 * On success the persisted plan changes immediately, so callers should
 * re-fetch `fetchPlanSummary()` to refresh the UI.
 */
export async function selectPlanMock(
  tier: "starter" | "pro" | "team",
): Promise<{ ok: true; tier: string; email: string | null } | { ok: false; error: string; code?: string }> {
  try {
    const res = await apiFetch("/api/billing/dev-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    })
    const data = (await res.json()) as {
      ok?: boolean
      tier?: string
      email?: string | null
      error?: string
      code?: string
    }
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `Plan selection failed (HTTP ${res.status})`, code: data.code }
    }
    return { ok: true, tier: data.tier ?? tier, email: data.email ?? null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** DUMMY email login — sets the session cookie via `/api/auth/dev-login`.
 *  Dev/demo only (`BILLING_MOCK=1`). Optional first/last name are stored
 *  in the session and persisted to the cloud billing row. */
export async function devLogin(
  email: string,
  opts?: { firstName?: string; lastName?: string },
): Promise<{ ok: true; email: string } | { ok: false; error: string; code?: string }> {
  try {
    const res = await apiFetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, firstName: opts?.firstName, lastName: opts?.lastName }),
    })
    const data = (await res.json()) as {
      ok?: boolean
      email?: string
      error?: string
      code?: string
      token?: string
    }
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `Login failed (HTTP ${res.status})`, code: data.code }
    }
    // Desktop/cloud split: persist the session token so cross-origin cloud
    // calls (and the local fix/patch routes that relay to the cloud) can
    // attach it as a Bearer. No-op on single-origin web (cookie suffices).
    if (typeof data.token === "string" && data.token) {
      setCloudAuthToken(data.token)
    }
    return { ok: true, email: data.email ?? email }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/**
 * PRODUCTION desktop login. After the user has signed in with GitHub
 * (`/api/github/auth/login`, which stores their token on disk), this asks the
 * local bridge (`/api/desktop/cloud-session`) to exchange that identity for a
 * signed session JWT at the cloud issuer. The returned token is stored via
 * `setCloudAuthToken`, so every subsequent cloud call carries it as a Bearer.
 *
 * The GitHub token never reaches the renderer; only the minted session token
 * (which contains identity claims, never a provider key) is returned here.
 */
export async function establishCloudSession(): Promise<
  | { ok: true; user: { userId: string; login: string; email: string | null } }
  | { ok: false; error: string; code?: string }
> {
  try {
    const res = await apiFetch("/api/desktop/cloud-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    const data = (await res.json()) as {
      ok?: boolean
      token?: string
      user?: { userId: string; login: string; email: string | null }
      error?: string
      code?: string
    }
    if (!res.ok || !data.ok || !data.token) {
      return { ok: false, error: data.error ?? `Cloud login failed (HTTP ${res.status})`, code: data.code }
    }
    setCloudAuthToken(data.token)
    return {
      ok: true,
      user: data.user ?? { userId: "", login: "", email: null },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Drop the stored cloud session + refresh tokens so subsequent cloud calls
 *  are anonymous. Call this on sign-out (alongside the GitHub logout route). */
export function clearCloudSession(): void {
  clearCloudTokens()
}

// ---------------------------------------------------------------------------
// Edge Agent AI account auth (email/password) — the identity of record.
//
// register/login return a signed session JWT carrying the account's
// userId/workspaceId. We store it via setCloudAuthToken() so apiFetch sends
// it as a Bearer to cloud routes. Subscriptions and credits attach to THIS
// account, not to a GitHub login.
// ---------------------------------------------------------------------------

export interface AccountUser {
  id: string
  email: string
  name?: string
  emailVerified?: boolean
  workspaceId: string
  role: string
}

export interface AccountPlan {
  tier: string
  creditsLimit: number
  creditsUsed: number
}

interface RawAccountResponse {
  ok?: boolean
  token?: string
  refreshToken?: string
  user?: AccountUser
  error?: string
  code?: string
  requiresVerification?: boolean
  email?: string
  /** Demo-only fallback (no provider / undeliverable): the 6-digit OTP code. */
  verificationCode?: string
}

/** Store the session JWT (+ refresh token) when the response carries one, so
 *  every subsequent cloud call sends the Bearer and can renew silently. */
function storeSessionFromResponse(data: RawAccountResponse): void {
  if (typeof data.token === "string" && data.token) {
    setCloudAuthToken(data.token)
    if (typeof data.refreshToken === "string" && data.refreshToken) {
      setCloudRefreshToken(data.refreshToken)
    }
  }
}

export type RegisterResult =
  | {
      ok: true
      requiresVerification: true
      email: string
      /** Present ONLY when the verification email couldn't be delivered (demo /
       *  no domain) so the UI can show the code. Absent when a real email was
       *  sent — the user reads the code from their inbox. */
      verificationCode?: string
    }
  | { ok: true; requiresVerification?: false; user: AccountUser }
  | { ok: false; error: string; code?: string }

/** Create an Edge Agent AI account. In production the account is created but
 *  NOT signed in — the user must verify their email first (requiresVerification
 *  is true). In dev (enforcement off) a session is returned and stored. */
export async function registerAccount(input: {
  email: string
  password: string
  name?: string
}): Promise<RegisterResult> {
  try {
    const res = await apiFetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    const data = (await res.json()) as RawAccountResponse
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `Request failed (HTTP ${res.status})`, code: data.code }
    }
    if (data.requiresVerification) {
      return {
        ok: true,
        requiresVerification: true,
        email: data.email ?? input.email,
        verificationCode: data.verificationCode,
      }
    }
    if (!data.token || !data.user) {
      return { ok: false, error: data.error ?? "Registration failed.", code: data.code }
    }
    storeSessionFromResponse(data)
    return { ok: true, user: data.user }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

export type LoginResult =
  | { ok: true; user: AccountUser }
  | {
      ok: false
      error: string
      code?: string
      /** Set when code === "email_not_verified". */
      email?: string
      verificationCode?: string
    }

/** Sign in to an existing Edge Agent AI account. Returns
 *  `code: "email_not_verified"` (HTTP 403) when the email hasn't been verified
 *  yet — the caller should prompt the user to verify. */
export async function loginAccount(input: {
  email: string
  password: string
}): Promise<LoginResult> {
  try {
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    const data = (await res.json()) as RawAccountResponse
    if (!res.ok || !data.ok || !data.token || !data.user) {
      return {
        ok: false,
        error: data.error ?? `Request failed (HTTP ${res.status})`,
        code: data.code,
        email: data.email,
        verificationCode: data.verificationCode,
      }
    }
    storeSessionFromResponse(data)
    return { ok: true, user: data.user }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Sign out: clear the server cookie and drop the local session token. */
export async function logoutAccount(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  } catch {
    /* ignore network errors on logout */
  } finally {
    clearCloudTokens()
  }
}

/** Sign out of every device: revoke all refresh tokens server-side and clear
 *  local tokens. */
export async function logoutAllAccount(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  } catch {
    /* ignore network errors on logout */
  } finally {
    clearCloudTokens()
  }
}

/** Request a fresh email-verification link for the signed-in account. In dev
 *  the raw token is returned so the flow is testable without email. */
export async function sendVerificationEmail(): Promise<{
  ok: boolean
  verificationCode?: string
  error?: string
}> {
  try {
    const res = await apiFetch("/api/auth/send-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    const data = (await res.json()) as { ok?: boolean; verificationCode?: string; error?: string }
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ok: true, verificationCode: data.verificationCode }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** (Re)send an email-verification link for an account that is not yet signed
 *  in (public path, keyed by email). Used by the "verify your email" screen.
 *  Always reports ok (no account enumeration); the link is surfaced only in
 *  demo mode (no email provider). */
export async function resendVerification(
  email: string,
): Promise<{ ok: boolean; verificationCode?: string; error?: string }> {
  try {
    const res = await apiFetch("/api/auth/send-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })
    const data = (await res.json()) as {
      ok?: boolean
      verificationCode?: string
      error?: string
    }
    return {
      ok: Boolean(data.ok),
      verificationCode: data.verificationCode,
      error: data.error,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Verify an account by the 6-digit OTP code the user received by email. On
 *  success the server auto-issues a session, which we store so the user is
 *  immediately signed in and verified. */
export async function verifyEmailCode(
  email: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    })
    const data = (await res.json()) as RawAccountResponse
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `Invalid or expired code.` }
    storeSessionFromResponse(data)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Confirm an email-verification link token (legacy). On success the server
 *  auto-issues a session, which we store so the user is signed in. */
export async function verifyEmail(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
    const data = (await res.json()) as RawAccountResponse
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    storeSessionFromResponse(data)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Start a password reset for an email. Always reports success (no account
 *  enumeration); the raw token is surfaced in dev only. */
export async function forgotPassword(
  email: string,
): Promise<{ ok: boolean; resetToken?: string; resetUrl?: string; message?: string }> {
  try {
    const res = await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })
    const data = (await res.json()) as {
      ok?: boolean
      resetToken?: string
      resetUrl?: string
      message?: string
    }
    return {
      ok: Boolean(data.ok),
      resetToken: data.resetToken,
      resetUrl: data.resetUrl,
      message: data.message,
    }
  } catch {
    return { ok: true }
  }
}

/** Complete a password reset with a token + new password. */
export async function resetPassword(
  token: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    })
    const data = (await res.json()) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Link a GitHub identity to the signed-in account (optional integration for
 *  repo/PR access). The GitHub token is verified server-side and never stored
 *  in the cloud — only the link record is kept. */
export async function linkGithubAccount(
  githubToken: string,
): Promise<{ ok: boolean; login?: string; error?: string }> {
  try {
    const res = await apiFetch("/api/auth/link/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: githubToken }),
    })
    const data = (await res.json()) as {
      ok?: boolean
      linked?: { login?: string }
      error?: string
    }
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ok: true, login: data.linked?.login }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}

/** Fetch the current account (identity + plan summary), or null when not
 *  signed in. */
export async function fetchAccount(
  signal?: AbortSignal,
): Promise<{ user: AccountUser; plan: AccountPlan | null } | null> {
  try {
    const res = await apiFetch("/api/auth/me", { signal })
    if (!res.ok) return null
    const data = (await res.json()) as {
      ok?: boolean
      user?: AccountUser
      plan?: AccountPlan | null
    }
    if (!data.ok || !data.user) return null
    return { user: data.user, plan: data.plan ?? null }
  } catch {
    return null
  }
}

/** Clear the dummy session cookie. */
export async function devLogout(): Promise<boolean> {
  try {
    const res = await apiFetch("/api/auth/dev-login?logout=1", { method: "POST" })
    // Drop the stored session token so subsequent cloud calls are anonymous.
    setCloudAuthToken(null)
    return res.ok
  } catch {
    setCloudAuthToken(null)
    return false
  }
}

/** Open the Stripe Customer Portal for the current user. */
export async function openBillingPortal(): Promise<
  { ok: true } | { ok: false; error: string; code?: string }
> {
  try {
    const res = await apiFetch("/api/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const data = (await res.json()) as { url?: string; error?: string; code?: string }
    if (!res.ok || !data.url) {
      return { ok: false, error: data.error ?? `Portal failed (HTTP ${res.status})`, code: data.code }
    }
    if (typeof window !== "undefined") window.location.assign(data.url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}
