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

let store: UserStore = new FileUserStore()
let bootstrapped = false
let bootstrapPromise: Promise<void> | null = null

export function getAsyncUserStore(): UserStore {
  return store
}

/** Test seam — inject a mock and mark bootstrap complete. */
export function setAsyncUserStore(next: UserStore): void {
  store = next
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

async function createPgPool(connectionString: string): Promise<PgPoolLike> {
  const dynImport = new Function("p", "return import(p)") as (p: string) => Promise<unknown>
  const pg = (await dynImport("pg")) as {
    Pool: new (cfg: { connectionString: string; max?: number; ssl?: unknown }) => PgPoolLike
  }
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
    bootstrapped = true
    return
  }
  if (isProd() && !databaseUrl()) {
    store = misconfiguredStore(
      "Production account store requires DATABASE_URL. Set DATABASE_URL=postgres://… or USER_STORE=file (desktop only).",
    )
    bootstrapped = true
    return
  }
  if (databaseUrl()) {
    try {
      if (!pgPool) pgPool = await createPgPool(databaseUrl())
      store = new SqlUserStore(pgPool)
      bootstrapped = true
      return
    } catch (e) {
      const reason = `Failed to initialize Postgres user store: ${e instanceof Error ? e.message : String(e)}`
      if (isProd()) {
        store = misconfiguredStore(reason)
        bootstrapped = true
        return
      }
      // eslint-disable-next-line no-console
      console.warn(`[users] ${reason} — falling back to file store (dev only).`)
    }
  }
  store = new FileUserStore()
  bootstrapped = true
}

export async function ensureUserBootstrap(): Promise<void> {
  if (bootstrapped && !databaseUrl() && !isProd()) return
  if (bootstrapped && databaseUrl()) return
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
}
