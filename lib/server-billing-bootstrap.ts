/**
 * Billing-store bootstrap.
 *
 * Backend selection rules:
 *
 *   - `NODE_ENV === "production"` AND `DATABASE_URL` present →
 *     `SqlBillingStore` over `pg.Pool`. This is the only path that
 *     ships to the SaaS deployment; everything else fails closed.
 *
 *   - `NODE_ENV === "production"` AND `DATABASE_URL` missing →
 *     `BillingMisconfiguredStore`. Every method throws
 *     `BillingMisconfiguredError`; the API routes catch it and surface
 *     a 503 with `code: "billing_db_unconfigured"`. We deliberately
 *     refuse to fall back to file storage in production because that
 *     would silently lose subscription writes on multi-replica hosts.
 *
 *   - Non-production (dev / desktop / electron) →
 *       * if `DATABASE_URL` is set, use Postgres
 *       * otherwise `FileBillingStore` (the default for the desktop
 *         edition).
 *
 *   - `BILLING_STORE=file` env override forces the file backend even
 *     in production. Use this ONLY for self-hosted desktop builds.
 *
 * `bootstrapBillingStore()` is the side-effecting initializer. It's
 * called once from `instrumentation.ts` (Next.js server hook) and
 * defensively from the route layer on first request (`ensureBootstrap`).
 * Subsequent calls are no-ops.
 *
 * Tests inject a mock by calling `setAsyncBillingStore(...)`; the
 * mock is treated as already-bootstrapped.
 */

import {
  FileBillingStore,
  setBillingStore,
  type BillingEventRecord,
  type BillingStore,
  type CreditUsageRecord,
  type SubscriptionRecord,
} from "./server-billing-store"
import {
  SqlBillingStore,
  type SqlClient,
  syncProxy as makeSyncProxy,
} from "./server-postgres-billing-store"

// ---------------------------------------------------------------------------
// AsyncBillingStore — the surface routes consume
// ---------------------------------------------------------------------------

export interface AsyncBillingStore {
  loadSubscription(userId: string, workspaceId: string): Promise<SubscriptionRecord>
  upsertSubscription(
    userId: string,
    workspaceId: string,
    patch: Partial<SubscriptionRecord>,
  ): Promise<SubscriptionRecord>
  consume(args: {
    userId: string
    workspaceId: string
    credits: number
    usage: Omit<CreditUsageRecord, "id" | "createdAt">
  }): Promise<{ creditsUsed: number; record: CreditUsageRecord }>
  canConsume(
    userId: string,
    workspaceId: string,
    credits: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; remaining: number }>
  recentUsage(
    userId: string,
    workspaceId: string,
    limit?: number,
  ): Promise<CreditUsageRecord[]>
  claimEvent(record: Omit<BillingEventRecord, "processedAt">): Promise<boolean>
  hasProcessedEvent(stripeEventId: string): Promise<boolean>
  _resetForTests(): Promise<void>
}

// ---------------------------------------------------------------------------
// Misconfiguration sentinel
// ---------------------------------------------------------------------------

export class BillingMisconfiguredError extends Error {
  readonly status = 503
  readonly code = "billing_db_unconfigured"
  constructor(message: string) {
    super(message)
    this.name = "BillingMisconfiguredError"
  }
}

function misconfiguredStore(reason: string): AsyncBillingStore {
  // Each method returns a REJECTED promise (not a sync throw) so
  // call sites can `await` and `try/catch` uniformly. A sync throw
  // inside an async-typed signature breaks Promise composition (e.g.
  // `Promise.all`, `assert.rejects`).
  const reject = async (): Promise<never> => {
    throw new BillingMisconfiguredError(reason)
  }
  return {
    loadSubscription: reject,
    upsertSubscription: reject,
    consume: reject,
    canConsume: reject,
    recentUsage: reject,
    claimEvent: reject,
    hasProcessedEvent: reject,
    _resetForTests: async () => {
      /* nothing to reset */
    },
  }
}

// ---------------------------------------------------------------------------
// File adapter → AsyncBillingStore
// ---------------------------------------------------------------------------

function fileAsync(store: BillingStore): AsyncBillingStore {
  return {
    async loadSubscription(u, w) {
      return store.loadSubscription(u, w)
    },
    async upsertSubscription(u, w, p) {
      return store.upsertSubscription(u, w, p)
    },
    async consume(args) {
      return store.consume(args)
    },
    async canConsume(u, w, c) {
      return store.canConsume(u, w, c)
    },
    async recentUsage(u, w, limit) {
      return store.recentUsage(u, w, limit)
    },
    async claimEvent(record) {
      return store.claimEvent(record)
    },
    async hasProcessedEvent(id) {
      return store.hasProcessedEvent(id)
    },
    async _resetForTests() {
      store._resetForTests()
    },
  }
}

// ---------------------------------------------------------------------------
// Singleton + status tag
// ---------------------------------------------------------------------------

export type BillingBackend = "postgres" | "file" | "misconfigured" | "test"

export interface BillingBootstrapReport {
  backend: BillingBackend
  ok: boolean
  error?: string
}

let asyncStore: AsyncBillingStore = fileAsync(new FileBillingStore())
let backendTag: BillingBackend = "file"
let lastReport: BillingBootstrapReport = { backend: "file", ok: true }
let bootstrapped = false
let bootstrapPromise: Promise<BillingBootstrapReport> | null = null

export function getAsyncBillingStore(): AsyncBillingStore {
  return asyncStore
}

export function getBillingBackendTag(): BillingBackend {
  return backendTag
}

export function getBillingBootstrapReport(): BillingBootstrapReport {
  return lastReport
}

/** Test seam — replaces both the singleton and the bootstrap latch so
 *  later `ensureBootstrap` calls don't undo the injection. */
export function setAsyncBillingStore(next: AsyncBillingStore, tag: BillingBackend = "test"): void {
  asyncStore = next
  backendTag = tag
  bootstrapped = true
  lastReport = { backend: tag, ok: true }
}

// ---------------------------------------------------------------------------
// Postgres pool — lazy-singleton
// ---------------------------------------------------------------------------

interface PgPoolLike {
  query: SqlClient["query"]
  end(): Promise<void>
}

let pgPool: PgPoolLike | null = null

type PgModule = {
  Pool: new (cfg: { connectionString: string; max?: number; ssl?: unknown }) => {
    query: SqlClient["query"]
    end(): Promise<void>
  }
}

async function createPgPool(connectionString: string): Promise<PgPoolLike> {
  // Lazy dynamic import so the optional `pg` peer dep doesn't load at
  // module-evaluation time (tests / edge / desktop never touch Postgres).
  // We use a plain `import("pg")` — NOT a `new Function(...)` trick — so
  // Next.js's dependency tracer can see it and ship `pg` in the serverless
  // bundle. `serverExternalPackages: ["pg"]` keeps it un-bundled at runtime.
  const mod = (await import("pg")) as unknown as PgModule & { default?: PgModule }
  const pg: PgModule = mod.Pool ? mod : (mod.default as PgModule)
  // SSL on by default for hosted Postgres (Neon / Supabase / RDS).
  // `PGSSLMODE=disable` opts out for local dev against plain Postgres.
  const wantSsl = (process.env.PGSSLMODE ?? "").toLowerCase() !== "disable"
  return new pg.Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
  })
}

// ---------------------------------------------------------------------------
// bootstrapBillingStore — picks + wires the backend
// ---------------------------------------------------------------------------

function isProd(): boolean {
  return process.env.NODE_ENV === "production"
}

function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim()
}

export async function bootstrapBillingStore(): Promise<BillingBootstrapReport> {
  // BILLING_STORE=file forces the local backend (desktop / self-host).
  if ((process.env.BILLING_STORE ?? "").toLowerCase() === "file") {
    const file = new FileBillingStore()
    setBillingStore(file)
    asyncStore = fileAsync(file)
    backendTag = "file"
    lastReport = { backend: "file", ok: true }
    bootstrapped = true
    return lastReport
  }

  // Production hard rule: a real Postgres URL is required. Anything
  // else returns a misconfigured store that 503s on first use.
  if (isProd() && !databaseUrl()) {
    const reason =
      "Production billing store requires DATABASE_URL. Set DATABASE_URL=postgres://… or BILLING_STORE=file (desktop only)."
    asyncStore = misconfiguredStore(reason)
    backendTag = "misconfigured"
    lastReport = { backend: "misconfigured", ok: false, error: reason }
    bootstrapped = true
    return lastReport
  }

  // If we have a URL, use Postgres in any environment (so staging /
  // preview deployments behave identically to prod).
  if (databaseUrl()) {
    try {
      if (!pgPool) pgPool = await createPgPool(databaseUrl())
      const sql = new SqlBillingStore(pgPool)
      asyncStore = sql
      // The legacy sync singleton becomes a throwing proxy; sync
      // callers in Postgres mode are an error.
      setBillingStore(makeSyncProxy(sql))
      backendTag = "postgres"
      lastReport = { backend: "postgres", ok: true }
      bootstrapped = true
      return lastReport
    } catch (e) {
      const reason = `Failed to initialize Postgres billing store: ${e instanceof Error ? e.message : String(e)}`
      if (isProd()) {
        asyncStore = misconfiguredStore(reason)
        backendTag = "misconfigured"
        lastReport = { backend: "misconfigured", ok: false, error: reason }
        bootstrapped = true
        return lastReport
      }
      // Non-prod: log and fall through to file backend so local dev
      // doesn't break on a typo in DATABASE_URL.
      // eslint-disable-next-line no-console
      console.warn(`[billing] ${reason} — falling back to file store (dev only).`)
    }
  }

  // Non-prod default: file-backed.
  const file = new FileBillingStore()
  setBillingStore(file)
  asyncStore = fileAsync(file)
  backendTag = "file"
  lastReport = { backend: "file", ok: true }
  bootstrapped = true
  return lastReport
}

/** Defensive guard: every async route caller can `await ensureBootstrap()`
 *  to make sure the backend is configured before touching the store.
 *  Bootstrap runs exactly once per process. */
export async function ensureBootstrap(): Promise<BillingBootstrapReport> {
  if (bootstrapped && backendTag !== "file") return lastReport
  if (bootstrapped && backendTag === "file" && !databaseUrl() && !isProd()) {
    return lastReport
  }
  if (!bootstrapPromise) bootstrapPromise = bootstrapBillingStore()
  try {
    return await bootstrapPromise
  } finally {
    // Allow re-run after a transient failure clears.
    if (!lastReport.ok) bootstrapPromise = null
  }
}

/** Test-only: shut down the pool and reset the singleton so other
 *  tests can run with a different backend. */
export async function _resetBillingBootstrapForTests(): Promise<void> {
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
  asyncStore = fileAsync(new FileBillingStore())
  backendTag = "file"
  lastReport = { backend: "file", ok: true }
}
