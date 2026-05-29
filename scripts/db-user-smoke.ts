#!/usr/bin/env tsx
/**
 * Smoke-test Postgres billing + account stores against a live `DATABASE_URL`.
 *
 *   DATABASE_URL=postgres://… pnpm db:user-smoke
 *
 * Non-destructive: verifies connectivity, that all migration tables exist,
 * and that auth tables are reachable via read-only store calls. Exits 0 on
 * success, 1 on failure.
 *
 * Run `pnpm db:migrate` first.
 */

import { checkPostgresSchema } from "../lib/server-prod-check"
import {
  bootstrapUserStore,
  getAsyncUserStore,
  UserStoreMisconfiguredError,
  _resetUserBootstrapForTests,
} from "../lib/server-user-bootstrap"

async function main(): Promise<void> {
  const url = (process.env.DATABASE_URL ?? "").trim()
  if (!url) {
    console.error("DATABASE_URL is empty. Set DATABASE_URL=postgres://… to smoke-test Postgres.")
    process.exit(1)
  }
  delete process.env.USER_STORE
  delete process.env.BILLING_STORE

  const schemaChecks = await checkPostgresSchema(url)
  const schemaFail = schemaChecks.find((c) => c.status === "fail")
  if (schemaFail) {
    console.error(JSON.stringify({ ok: false, checks: schemaChecks }, null, 2))
    process.exit(1)
  }

  await bootstrapUserStore()
  const store = getAsyncUserStore()
  const probe = "smoke-probe@edge-agent-ai.invalid"

  try {
    const user = await store.getUserByEmail(probe)
    await store.findVerificationToken("0".repeat(64))
    await store.findResetToken("0".repeat(64))
    await store.findRefreshToken("0".repeat(64))
    if (user) await store.getLinkedAccounts(user.id)
    console.log(
      JSON.stringify(
        {
          ok: true,
          backend: "postgres",
          tablesReachable: true,
          tables: schemaChecks.find((c) => c.id === "postgres_migrations")?.message,
        },
        null,
        2,
      ),
    )
  } catch (e) {
    if (e instanceof UserStoreMisconfiguredError) {
      console.error(JSON.stringify({ ok: false, code: e.code, error: e.message }, null, 2))
    } else {
      console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2))
    }
    await _resetUserBootstrapForTests().catch(() => undefined)
    process.exit(1)
  }
  await _resetUserBootstrapForTests().catch(() => undefined)
}

void main()
