/**
 * Auth-token maintenance — deletes spent/expired tokens so the tables don't
 * grow without bound.
 *
 * What it removes:
 *   - email_verification_tokens: used OR expired.
 *   - password_reset_tokens:     used OR expired.
 *   - refresh_tokens:            expired, OR revoked longer than the retention
 *                                window ago (kept briefly for audit).
 *
 * Safe to run repeatedly (idempotent). Active, unexpired tokens are preserved.
 *
 * Run via `pnpm auth:cleanup` (scripts/auth-cleanup.ts) on a daily cron, or
 * call `cleanupAuthTokens()` from a scheduled function / cron-safe route.
 */

import { ensureUserBootstrap, getAsyncUserStore } from "./server-user-bootstrap"
import {
  DEFAULT_REFRESH_RETENTION_MS,
  type TokenCleanupOptions,
  type TokenCleanupResult,
} from "./server-user-store"

export { DEFAULT_REFRESH_RETENTION_MS }

export async function cleanupAuthTokens(
  opts?: TokenCleanupOptions,
): Promise<TokenCleanupResult> {
  await ensureUserBootstrap()
  return getAsyncUserStore().cleanupExpiredTokens(opts)
}
