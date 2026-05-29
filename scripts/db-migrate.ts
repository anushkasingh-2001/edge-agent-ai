#!/usr/bin/env tsx
/**
 * Apply the Edge Agent AI billing schema to the Postgres database
 * pointed at by `DATABASE_URL`. Idempotent — safe to re-run.
 *
 *   pnpm add -D tsx                       # one-time
 *   DATABASE_URL=postgres://… \
 *     npx tsx scripts/db-migrate.ts
 *
 * The script exits 0 on success, 1 on failure (so CI can gate on it).
 */
import { runBillingMigrations } from "../lib/server-postgres-migrate"

async function main(): Promise<void> {
  const result = await runBillingMigrations()
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        applied: result.applied,
        error: result.error,
        databaseUrl: result.databaseUrlMasked,
      },
      null,
      2,
    ),
  )
  if (!result.ok) process.exit(1)
}

void main()
