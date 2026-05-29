#!/usr/bin/env tsx
/**
 * Production readiness check for the Edge Agent AI cloud backend.
 *
 *   pnpm prod:check
 *   PROD_CHECK=1 DATABASE_URL="postgres://…" pnpm prod:check
 *   PROD_CHECK_DESKTOP=1 NEXT_PUBLIC_CLOUD_API_BASE=https://… pnpm prod:check
 *
 * Validates env vars, optional Postgres schema, and flags BYOK/dev leaks.
 * Never prints secret values. Exits 0 when ready (warnings OK), 1 on failure.
 */
import { runProdCheck } from "../lib/server-prod-check"

async function main(): Promise<void> {
  const skipDb = process.argv.includes("--skip-db")
  const desktop = process.env.PROD_CHECK_DESKTOP === "1" || process.argv.includes("--desktop")

  const report = await runProdCheck({ skipDb, desktop })

  const summary = {
    ok: report.ok,
    pass: report.checks.filter((c) => c.status === "ok").length,
    warn: report.checks.filter((c) => c.status === "warn").length,
    fail: report.checks.filter((c) => c.status === "fail").length,
    skip: report.checks.filter((c) => c.status === "skip").length,
    checks: report.checks,
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2))
  if (!report.ok) process.exit(1)
}

void main()
