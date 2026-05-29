/**
 * Postgres schema migrator.
 *
 * Runs `migrations/001_billing.sql` (and any future numbered files)
 * against the configured `DATABASE_URL`. Idempotent: the SQL uses
 * `CREATE TABLE IF NOT EXISTS`, so re-running is safe.
 *
 * Two entry points:
 *
 *   - `runBillingMigrations()` — programmatic. Used by
 *     `bootstrapBillingStore()` when `AUTO_MIGRATE_BILLING=1` (default
 *     off in production so DDL doesn't run on every boot).
 *
 *   - `scripts/db-migrate.ts` — CLI runner. The deployment runs this
 *     once as part of release:
 *       npx tsx scripts/db-migrate.ts
 *
 * Schema:
 *   migrations/001_billing.sql       (subscriptions, credit_usage,
 *                                     billing_events, audit_logs)
 *
 * Output is structured (`{ applied: string[] }`) so the CLI can print
 * a human summary and CI can verify the expected file ran.
 */

import fs from "node:fs"
import path from "node:path"

export interface MigrationResult {
  ok: boolean
  applied: string[]
  error?: string
  databaseUrlMasked?: string
}

function maskDbUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = "***"
    return u.toString()
  } catch {
    return "(invalid DATABASE_URL)"
  }
}

function migrationsDir(): string {
  // Resolve relative to the repo root; tsx + Next both run from there.
  return path.resolve(process.cwd(), "migrations")
}

function listMigrationFiles(): string[] {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(migrationsDir())
  } catch {
    return []
  }
  return entries
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b))
}

/** Run pending migrations. Safe to re-run because each script uses
 *  `CREATE TABLE IF NOT EXISTS`. */
export async function runBillingMigrations(
  connectionString = process.env.DATABASE_URL ?? "",
): Promise<MigrationResult> {
  if (!connectionString.trim()) {
    return {
      ok: false,
      applied: [],
      error:
        "DATABASE_URL is empty. Set DATABASE_URL=postgres://… before running migrations.",
    }
  }
  const files = listMigrationFiles()
  if (files.length === 0) {
    return {
      ok: true,
      applied: [],
      databaseUrlMasked: maskDbUrl(connectionString),
    }
  }

  // Dynamic import keeps `pg` an optional peer dep at build time. We
  // installed it as a real dep so this resolves in normal deployments.
  const dynImport = new Function("p", "return import(p)") as (
    p: string,
  ) => Promise<unknown>
  let pgModule: { Client: new (cfg: { connectionString: string; ssl?: unknown }) => {
    connect(): Promise<void>
    query(text: string): Promise<unknown>
    end(): Promise<void>
  } }
  try {
    pgModule = (await dynImport("pg")) as typeof pgModule
  } catch (e) {
    return {
      ok: false,
      applied: [],
      error: `Could not load the 'pg' module: ${e instanceof Error ? e.message : String(e)}. Run 'pnpm add pg'.`,
    }
  }

  const wantSsl = (process.env.PGSSLMODE ?? "").toLowerCase() !== "disable"
  const client = new pgModule.Client({
    connectionString,
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
  })

  try {
    await client.connect()
    const applied: string[] = []
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir(), file), "utf8")
      // Postgres can handle multiple statements in a single query
      // string. We wrap each file in BEGIN/COMMIT so a partial file
      // doesn't leave the schema half-applied.
      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query("COMMIT")
        applied.push(file)
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw e
      }
    }
    return {
      ok: true,
      applied,
      databaseUrlMasked: maskDbUrl(connectionString),
    }
  } catch (e) {
    return {
      ok: false,
      applied: [],
      error: e instanceof Error ? e.message : String(e),
      databaseUrlMasked: maskDbUrl(connectionString),
    }
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}
