/**
 * User-store bootstrap — picks the account backend the same way billing does.
 *
 *   - production + DATABASE_URL → Postgres (`SqlUserStore`).
 *   - production without DATABASE_URL → misconfigured store (503 on use).
 *   - non-production → Postgres if DATABASE_URL set, else FileUserStore.
 *   - USER_STORE=file / BILLING_STORE=file → force file backend.
 *
 * Tests inject a mock via `setAsyncUserStore(...)`.
 */

import { FileUserStore, type UserStore } from "./server-user-store"
import { SqlUserStore } from "./server-postgres-user-store"
import type { SqlClient } from "./server-postgres-billing-store"

export class UserStoreMisconfiguredError extends Error {
  readonly status = 503
  readonly code = "user_db_unconfigured"
  constructor(message: string) {
    super(message)
    this.name = "UserStoreMisconfiguredError"
  }
}

function misconfiguredStore(reason: string): UserStore {
  const reject = async (): Promise<never> => {
    throw new UserStoreMisconfiguredError(reason)
  }
  return {
    createUser: reject,
    getUserByEmail: reject,
    getUserById: reject,
    getWorkspaceForUser: reject,
    createPendingRegistration: reject,
    getPendingRegistration: reject,
    deletePendingRegistration: reject,
    updatePassword: reject,
    markEmailVerified: reject,
    createVerificationToken: reject,
    findVerificationToken: reject,
    consumeVerificationToken: reject,
    createResetToken: reject,
    findResetToken: reject,
    consumeResetToken: reject,
    createRefreshToken: reject,
    findRefreshToken: reject,
    revokeRefreshToken: reject,
    revokeAllRefreshTokens: reject,
    cleanupExpiredTokens: reject,
    linkAccount: reject,
    getLinkedAccounts: reject,
    _resetForTests: async () => {
      /* nothing to reset */
    },
  }
}

export type UserBackend = "postgres" | "file" | "misconfigured" | "test"

let store: UserStore = new FileUserStore()
let backendTag: UserBackend = "file"
let bootstrapped = false
let bootstrapPromise: Promise<void> | null = null

export function getAsyncUserStore(): UserStore {
  return store
}

export function getUserBackendTag(): UserBackend {
  return backendTag
}

/** Test seam — inject a mock and mark bootstrap complete. */
export function setAsyncUserStore(next: UserStore, tag: UserBackend = "test"): void {
  store = next
  backendTag = tag
  bootstrapped = true
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production"
}

function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim()
}

function forceFile(): boolean {
  const v = (k: string) => (process.env[k] ?? "").toLowerCase() === "file"
  return v("USER_STORE") || v("BILLING_STORE")
}

interface PgPoolLike {
  query: SqlClient["query"]
  end(): Promise<void>
}

let pgPool: PgPoolLike | null = null

type PgModule = {
  Pool: new (cfg: { connectionString: string; max?: number; ssl?: unknown }) => PgPoolLike
}

async function createPgPool(connectionString: string): Promise<PgPoolLike> {
  // Plain dynamic import (not a `new Function(...)` trick) so Next.js's
  // tracer ships `pg` in the serverless bundle. Still lazy: it only loads
  // when a Postgres-backed store is actually constructed at runtime.
  const mod = (await import("pg")) as unknown as PgModule & { default?: PgModule }
  const pg: PgModule = mod.Pool ? mod : (mod.default as PgModule)
  const wantSsl = (process.env.PGSSLMODE ?? "").toLowerCase() !== "disable"
  return new pg.Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
  })
}

export async function bootstrapUserStore(): Promise<void> {
  if (forceFile()) {
    store = new FileUserStore()
    backendTag = "file"
    bootstrapped = true
    return
  }
  if (isProd() && !databaseUrl()) {
    store = misconfiguredStore(
      "Production account store requires DATABASE_URL. Set DATABASE_URL=postgres://… or USER_STORE=file (desktop only).",
    )
    backendTag = "misconfigured"
    bootstrapped = true
    return
  }
  if (databaseUrl()) {
    try {
      if (!pgPool) pgPool = await createPgPool(databaseUrl())
      store = new SqlUserStore(pgPool)
      backendTag = "postgres"
      bootstrapped = true
      return
    } catch (e) {
      const reason = `Failed to initialize Postgres user store: ${e instanceof Error ? e.message : String(e)}`
      if (isProd()) {
        store = misconfiguredStore(reason)
        backendTag = "misconfigured"
        bootstrapped = true
        return
      }
      // eslint-disable-next-line no-console
      console.warn(`[users] ${reason} — falling back to file store (dev only).`)
    }
  }
  store = new FileUserStore()
  backendTag = "file"
  bootstrapped = true
}

export async function ensureUserBootstrap(): Promise<void> {
  // Already on Postgres (or a test mock) — nothing to do.
  if (bootstrapped && backendTag !== "file" && backendTag !== "misconfigured") return
  // Dev file backend with no DATABASE_URL — stable, skip re-bootstrap.
  if (bootstrapped && backendTag === "file" && !databaseUrl() && !isProd()) return
  // Recover from an earlier misconfigured boot once DATABASE_URL appears.
  if (bootstrapped && backendTag === "misconfigured" && databaseUrl()) {
    bootstrapped = false
    bootstrapPromise = null
  }
  // Promote dev file → Postgres when DATABASE_URL is added without restart.
  if (bootstrapped && backendTag === "file" && databaseUrl()) {
    bootstrapped = false
    bootstrapPromise = null
  }
  if (!bootstrapPromise) bootstrapPromise = bootstrapUserStore()
  await bootstrapPromise
}

export async function _resetUserBootstrapForTests(): Promise<void> {
  if (pgPool) {
    try {
      await pgPool.end()
    } catch {
      /* ignore */
    }
    pgPool = null
  }
  bootstrapped = false
  bootstrapPromise = null
  store = new FileUserStore()
  backendTag = "file"
}
