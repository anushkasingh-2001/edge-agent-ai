#!/usr/bin/env tsx
/**
 * Delete spent/expired auth tokens (verification, reset, refresh).
 *
 *   pnpm auth:cleanup
 *   DATABASE_URL="postgres://…" pnpm auth:cleanup   # against Postgres
 *
 * Idempotent — safe to run on a daily cron. Prints per-table delete counts as
 * JSON and exits 0 on success, 1 on failure (so CI / cron can alert).
 *
 * Optional: REFRESH_RETENTION_DAYS overrides how long revoked refresh tokens
 * are kept for audit (default 30).
 */
import { cleanupAuthTokens } from "../lib/server-auth-token-cleanup"

async function main(): Promise<void> {
  const days = Number(process.env.REFRESH_RETENTION_DAYS ?? "")
  const refreshRetentionMs = Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : undefined
  try {
    const result = await cleanupAuthTokens({ refreshRetentionMs })
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, deleted: result }, null, 2))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2))
    process.exit(1)
  }
}

void main()
