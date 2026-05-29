/**
 * Production readiness checks for the Edge Agent AI **cloud backend**.
 *
 * Used by `pnpm prod:check` before `vercel --prod`. Validates env vars,
 * optional Postgres connectivity + schema, and flags BYOK/user-key config
 * that must not appear in production.
 *
 * SECURITY: never prints secret values — only presence/absence and safe
 * prefixes (e.g. `sk_…`, `re_…`).
 */

import { DESKTOP_FORBIDDEN_ENV_KEYS } from "./desktop-secret-denylist"
import { billingMockEnabled, STRIPE_CLOUD_ENV } from "./server-billing-mock"
import { emailConfigured } from "./server-email"
import { rateLimiterKind } from "./server-rate-limit"

export type CheckStatus = "ok" | "fail" | "warn" | "skip"

export interface CheckItem {
  id: string
  status: CheckStatus
  message: string
}

export interface ProdCheckReport {
  ok: boolean
  checks: CheckItem[]
}

/** Every Postgres table created by migrations/00*.sql */
export const EXPECTED_PG_TABLES = [
  "subscriptions",
  "credit_usage",
  "billing_events",
  "audit_logs",
  "users",
  "workspaces",
  "linked_accounts",
  "email_verification_tokens",
  "password_reset_tokens",
  "refresh_tokens",
] as const

/** Required on the Vercel cloud deployment (always). */
export const REQUIRED_CLOUD_ENV = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "JWT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "AUTH_CLEANUP_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "EDGE_AGENT_CLOUD_ALLOWED_ORIGINS",
] as const

/** Required only when `BILLING_MOCK` is not enabled (real Stripe payments). */
export const STRIPE_REQUIRED_CLOUD_ENV = [...STRIPE_CLOUD_ENV] as const

/** Strongly recommended for production (warn when missing). */
export const RECOMMENDED_CLOUD_ENV = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const

/** Must NOT be enabled in production cloud (fail or warn). */
export const BYOK_FORBIDDEN_ENV = [
  "EDGE_AGENT_CUSTOM_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "EDGE_AGENT_RETURN_AUTH_TOKENS",
] as const

function envSet(key: string): boolean {
  return Boolean((process.env[key] ?? "").trim())
}

function push(checks: CheckItem[], id: string, status: CheckStatus, message: string): void {
  checks.push({ id, status, message })
}

function isProdMode(): boolean {
  return process.env.NODE_ENV === "production" || process.env.PROD_CHECK === "1"
}

function cleanupSecretPresent(): boolean {
  return envSet("AUTH_CLEANUP_SECRET") || envSet("CRON_SECRET")
}

/** Validate required/recommended env vars (no network I/O). */
export function checkCloudEnv(): CheckItem[] {
  const checks: CheckItem[] = []
  const mockBilling = billingMockEnabled()

  if (mockBilling) {
    push(
      checks,
      "BILLING_MOCK",
      "ok",
      "BILLING_MOCK=1 — dummy billing active; Stripe env vars are optional.",
    )
  } else if (isProdMode()) {
    push(
      checks,
      "BILLING_MOCK",
      "warn",
      "BILLING_MOCK is off — real Stripe payments expected; Stripe env vars are required.",
    )
  }

  for (const key of REQUIRED_CLOUD_ENV) {
    if (key === "AUTH_CLEANUP_SECRET") {
      if (cleanupSecretPresent()) {
        push(checks, key, "ok", "AUTH_CLEANUP_SECRET or CRON_SECRET is set.")
      } else {
        push(checks, key, "fail", "Set AUTH_CLEANUP_SECRET (or Vercel CRON_SECRET) for token cleanup cron.")
      }
      continue
    }
    if (envSet(key)) {
      push(checks, key, "ok", `${key} is set.`)
    } else {
      push(checks, key, "fail", `${key} is missing.`)
    }
  }

  for (const key of STRIPE_REQUIRED_CLOUD_ENV) {
    if (mockBilling) {
      if (envSet(key)) {
        push(checks, key, "ok", `${key} is set (optional while BILLING_MOCK=1).`)
      } else {
        push(checks, key, "skip", `${key} not required while BILLING_MOCK=1.`)
      }
      continue
    }
    if (envSet(key)) {
      push(checks, key, "ok", `${key} is set.`)
    } else {
      push(checks, key, "fail", `${key} is missing (required when BILLING_MOCK is off).`)
    }
  }

  // Resend pair — emailConfigured also accepts SMTP; prod expects Resend.
  if (emailConfigured()) {
    push(checks, "email_provider", "ok", "Email provider configured (Resend or SMTP).")
  } else if (envSet("RESEND_API_KEY") || envSet("EMAIL_FROM")) {
    push(checks, "email_provider", "fail", "RESEND_API_KEY and EMAIL_FROM must both be set for email.")
  }

  const jwt = (process.env.JWT_SECRET ?? process.env.EDGE_AGENT_JWT_SECRET ?? "").trim()
  if (jwt && jwt.length < 16) {
    push(checks, "JWT_SECRET_length", "fail", "JWT_SECRET must be at least 16 characters.")
  }

  const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim()
  if (stripeKey && !stripeKey.startsWith("sk_")) {
    push(checks, "STRIPE_SECRET_KEY_format", "warn", "STRIPE_SECRET_KEY should start with sk_.")
  }
  const wh = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim()
  if (wh && !wh.startsWith("whsec_")) {
    push(checks, "STRIPE_WEBHOOK_SECRET_format", "warn", "STRIPE_WEBHOOK_SECRET should start with whsec_.")
  }
  for (const k of ["STRIPE_PRICE_STARTER", "STRIPE_PRICE_PRO", "STRIPE_PRICE_TEAM"] as const) {
    const v = (process.env[k] ?? "").trim()
    if (v && !v.startsWith("price_")) {
      push(checks, `${k}_format`, "warn", `${k} should start with price_.`)
    }
  }
  const resend = (process.env.RESEND_API_KEY ?? "").trim()
  if (resend && !resend.startsWith("re_")) {
    push(checks, "RESEND_API_KEY_format", "warn", "RESEND_API_KEY should start with re_.")
  }

  // Recommended Upstash pair.
  const hasUrl = envSet("UPSTASH_REDIS_REST_URL")
  const hasToken = envSet("UPSTASH_REDIS_REST_TOKEN")
  if (hasUrl && hasToken) {
    push(checks, "upstash_redis", "ok", "Upstash Redis configured — shared auth rate limits enabled.")
  } else if (hasUrl || hasToken) {
    push(
      checks,
      "upstash_redis",
      "fail",
      "Set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    )
  } else if (isProdMode()) {
    push(
      checks,
      "upstash_redis",
      "warn",
      "Upstash Redis not configured — auth rate limits are per-instance only in production.",
    )
  } else {
    push(
      checks,
      "upstash_redis",
      "warn",
      "Upstash Redis not configured — using in-memory rate limits (OK for local/dev).",
    )
  }

  // Rate limiter backend (informational).
  push(checks, "rate_limiter_backend", "ok", `Rate limiter backend: ${rateLimiterKind()}.`)

  // BYOK / user-key / dev-only flags.
  for (const key of BYOK_FORBIDDEN_ENV) {
    if (!envSet(key)) continue
    if (key === "EDGE_AGENT_RETURN_AUTH_TOKENS" && (process.env[key] ?? "").trim() !== "1") continue
    const severity: CheckStatus = isProdMode() ? "fail" : "warn"
    push(
      checks,
      `forbidden_${key}`,
      severity,
      `${key} must not be set in production cloud (BYOK/dev-token leak risk).`,
    )
  }

  // Secrets must never be exposed via NEXT_PUBLIC_ prefix.
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "JWT_SECRET",
    "RESEND_API_KEY",
  ]) {
    const pub = `NEXT_PUBLIC_${key}`
    if (envSet(pub)) {
      push(checks, pub, "fail", `${pub} must not exist — server secrets must not be public.`)
    }
  }

  return checks
}

/** Verify desktop build env does not bundle cloud secrets (when PROD_CHECK_DESKTOP=1). */
export function checkDesktopBuildEnv(): CheckItem[] {
  const checks: CheckItem[] = []
  if (!envSet("NEXT_PUBLIC_CLOUD_API_BASE")) {
    push(
      checks,
      "NEXT_PUBLIC_CLOUD_API_BASE",
      "warn",
      "NEXT_PUBLIC_CLOUD_API_BASE not set — required when building the desktop app.",
    )
  } else {
    push(checks, "NEXT_PUBLIC_CLOUD_API_BASE", "ok", "NEXT_PUBLIC_CLOUD_API_BASE is set for desktop builds.")
  }

  for (const key of DESKTOP_FORBIDDEN_ENV_KEYS) {
    if (envSet(key)) {
      push(
        checks,
        `desktop_forbidden_${key}`,
        "fail",
        `${key} must not be present in desktop build env — cloud-only secret.`,
      )
    }
  }
  return checks
}

/** Connect to Postgres, ping, and verify migration tables exist. */
export async function checkPostgresSchema(connectionString?: string): Promise<CheckItem[]> {
  const checks: CheckItem[] = []
  const url = (connectionString ?? process.env.DATABASE_URL ?? "").trim()
  if (!url) {
    push(checks, "postgres_connection", "skip", "DATABASE_URL not set — skipping Postgres checks.")
    return checks
  }

  const dynImport = new Function("p", "return import(p)") as (p: string) => Promise<unknown>
  let pgModule: {
    Client: new (cfg: { connectionString: string; ssl?: unknown }) => {
      connect(): Promise<void>
      query(text: string, params?: unknown[]): Promise<{ rows: Array<{ tablename?: string; exists?: boolean }> }>
      end(): Promise<void>
    }
  }
  try {
    pgModule = (await dynImport("pg")) as typeof pgModule
  } catch (e) {
    push(
      checks,
      "postgres_pg_module",
      "fail",
      `Could not load pg: ${e instanceof Error ? e.message : String(e)}`,
    )
    return checks
  }

  const wantSsl = (process.env.PGSSLMODE ?? "").toLowerCase() !== "disable"
  const client = new pgModule.Client({
    connectionString: url,
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
  })

  try {
    await client.connect()
    push(checks, "postgres_connection", "ok", "Postgres connection succeeded.")

    await client.query("SELECT 1 AS ping")
    push(checks, "postgres_ping", "ok", "Postgres ping (SELECT 1) succeeded.")

    const res = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [EXPECTED_PG_TABLES as unknown as string[]],
    )
    const found = new Set(res.rows.map((r) => r.tablename).filter(Boolean))
    const missing = EXPECTED_PG_TABLES.filter((t) => !found.has(t))
    if (missing.length === 0) {
      push(
        checks,
        "postgres_migrations",
        "ok",
        `All ${EXPECTED_PG_TABLES.length} expected tables exist.`,
      )
    } else {
      push(
        checks,
        "postgres_migrations",
        "fail",
        `Missing tables (run pnpm db:migrate): ${missing.join(", ")}`,
      )
    }
  } catch (e) {
    push(
      checks,
      "postgres_connection",
      "fail",
      `Postgres check failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }

  return checks
}

export interface RunProdCheckOptions {
  /** Skip Postgres connectivity / schema checks. */
  skipDb?: boolean
  /** Also validate desktop build env (NEXT_PUBLIC_CLOUD_API_BASE, no cloud secrets). */
  desktop?: boolean
}

export async function runProdCheck(opts: RunProdCheckOptions = {}): Promise<ProdCheckReport> {
  const checks: CheckItem[] = [...checkCloudEnv()]
  if (opts.desktop) checks.push(...checkDesktopBuildEnv())
  if (!opts.skipDb) checks.push(...(await checkPostgresSchema()))

  const ok = !checks.some((c) => c.status === "fail")
  return { ok, checks }
}
