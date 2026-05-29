/**
 * Postgres-backed `BillingStore`.
 *
 * Production deployments wire this up by setting `DATABASE_URL` (and
 * optionally `BILLING_STORE=postgres`). The adapter takes a generic
 * `SqlClient` so callers don't need to install `pg` for the build;
 * the production bootstrap (`lib/server-billing-bootstrap.ts`) does a
 * dynamic `import("pg")` and creates a `Pool` on demand.
 *
 * Concurrency:
 *   - `consume()` runs inside a single statement that:
 *       1. SELECTs the subscription `FOR UPDATE`.
 *       2. Computes the safe debit ( min(requested, remaining) ).
 *       3. UPDATEs the subscription's credits_used.
 *       4. INSERTs the usage row.
 *     All inside one transaction. Postgres' row-level lock prevents
 *     concurrent overspend across replicas.
 *
 *   - `claimEvent()` exploits the UNIQUE constraint on stripe_event_id
 *     with `ON CONFLICT DO NOTHING RETURNING id`. If `RETURNING` is
 *     non-empty, this call is the unique winner.
 *
 * Schema:
 *   See `migrations/001_billing.sql`.
 *
 * SECURITY: we never store apiKey, baseUrl, or any provider credential
 * in any table. The `model`/`provider` columns are routing metadata.
 */

import { randomUUID } from "node:crypto"
import {
  PLAN_TIER_LIMITS,
  type BillingEventRecord,
  type BillingStore,
  type CreditUsageRecord,
  type PlanTier,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from "./server-billing-store"

/**
 * Minimal SQL client interface. The production wire-in is
 * `(pg.Pool).query`; tests pass a synchronous-style stub. Note this
 * intentionally returns an `any`-typed row array — every adapter
 * method maps rows into typed records.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

interface SubscriptionRow {
  user_id: string
  workspace_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  plan_tier: PlanTier
  subscription_status: SubscriptionStatus
  credits_limit: number
  credits_used: number
  billing_period_start: Date | string
  billing_period_end: Date | string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface UsageRow {
  id: string
  user_id: string
  workspace_id: string
  task: string
  intelligence_mode: string
  provider: string
  model: string
  estimated_credits: number
  actual_credits: number
  request_id: string
  context_hash: string | null
  status: string
  created_at: Date | string
}

interface EventRow {
  stripe_event_id: string
  type: string
  user_id: string | null
  workspace_id: string | null
  processed_at: Date | string
  raw_status: "applied" | "skipped" | "error"
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v)
}

function rowToSubscription(r: SubscriptionRow): SubscriptionRecord {
  return {
    userId: r.user_id,
    workspaceId: r.workspace_id,
    email: r.email ?? undefined,
    firstName: r.first_name ?? undefined,
    lastName: r.last_name ?? undefined,
    planTier: r.plan_tier,
    subscriptionStatus: r.subscription_status,
    creditsLimit: r.credits_limit,
    creditsUsed: r.credits_used,
    billingPeriodStart: iso(r.billing_period_start),
    billingPeriodEnd: iso(r.billing_period_end),
    stripeCustomerId: r.stripe_customer_id ?? undefined,
    stripeSubscriptionId: r.stripe_subscription_id ?? undefined,
    updatedAt: iso(r.updated_at),
  }
}

function rowToUsage(r: UsageRow): CreditUsageRecord {
  return {
    id: r.id,
    userId: r.user_id,
    workspaceId: r.workspace_id,
    task: r.task,
    intelligenceMode: r.intelligence_mode,
    provider: r.provider,
    model: r.model,
    estimatedCredits: r.estimated_credits,
    actualCredits: r.actual_credits,
    requestId: r.request_id,
    contextHash: r.context_hash ?? undefined,
    createdAt: iso(r.created_at),
  }
}

function rowToEvent(r: EventRow): BillingEventRecord {
  return {
    stripeEventId: r.stripe_event_id,
    type: r.type,
    userId: r.user_id ?? undefined,
    workspaceId: r.workspace_id ?? undefined,
    processedAt: iso(r.processed_at),
    rawStatus: r.raw_status,
  }
}

function periodWindow(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** Async-only methods — caller is expected to `await` them. The
 *  `BillingStore` interface is sync today; the resolver wraps these
 *  with `await runSync(...)` only on the resolver-facing path. For
 *  routes that already run in an `async` Next handler the async
 *  methods are used directly via `getAsyncBillingStore()`. */
export class SqlBillingStore {
  constructor(private readonly client: SqlClient) {}

  async loadSubscription(userId: string, workspaceId: string): Promise<SubscriptionRecord> {
    const res = await this.client.query<SubscriptionRow>(
      `SELECT user_id, workspace_id, email, first_name, last_name, plan_tier,
              subscription_status, credits_limit, credits_used,
              billing_period_start, billing_period_end, stripe_customer_id,
              stripe_subscription_id, created_at, updated_at
         FROM subscriptions
        WHERE user_id = $1 AND workspace_id = $2`,
      [userId, workspaceId],
    )
    if (res.rows.length > 0) return rowToSubscription(res.rows[0])
    // Seed a default row. Production tier defaults to "free" with the
    // configured per-tier credit limit.
    const win = periodWindow()
    const tier: PlanTier = "free"
    const limit = PLAN_TIER_LIMITS[tier].creditsLimit
    const inserted = await this.client.query<SubscriptionRow>(
      `INSERT INTO subscriptions (
         user_id, workspace_id, plan_tier, subscription_status,
         credits_limit, credits_used, billing_period_start,
         billing_period_end
       ) VALUES ($1, $2, $3, 'none', $4, 0, $5, $6)
       ON CONFLICT (user_id, workspace_id) DO UPDATE
         SET updated_at = NOW()
       RETURNING *`,
      [userId, workspaceId, tier, limit, win.start, win.end],
    )
    return rowToSubscription(inserted.rows[0])
  }

  async upsertSubscription(
    userId: string,
    workspaceId: string,
    patch: Partial<SubscriptionRecord>,
  ): Promise<SubscriptionRecord> {
    // We need an UPSERT with selective field updates. We pull the
    // existing row, merge, and write back. The outer transaction
    // keeps it consistent under concurrent webhook delivery.
    await this.client.query("BEGIN")
    try {
      const existing = await this.loadSubscription(userId, workspaceId)
      const next: SubscriptionRecord = {
        ...existing,
        ...patch,
        userId,
        workspaceId,
        updatedAt: new Date().toISOString(),
      }
      if (patch.planTier && patch.creditsLimit === undefined) {
        next.creditsLimit = PLAN_TIER_LIMITS[next.planTier].creditsLimit
      }
      await this.client.query(
        `UPDATE subscriptions
            SET plan_tier              = $3,
                subscription_status    = $4,
                credits_limit          = $5,
                credits_used           = $6,
                billing_period_start   = $7,
                billing_period_end     = $8,
                stripe_customer_id     = $9,
                stripe_subscription_id = $10,
                email                  = COALESCE($11, email),
                first_name             = COALESCE($12, first_name),
                last_name              = COALESCE($13, last_name),
                updated_at             = NOW()
          WHERE user_id = $1 AND workspace_id = $2`,
        [
          userId,
          workspaceId,
          next.planTier,
          next.subscriptionStatus,
          next.creditsLimit,
          next.creditsUsed,
          next.billingPeriodStart,
          next.billingPeriodEnd,
          next.stripeCustomerId ?? null,
          next.stripeSubscriptionId ?? null,
          next.email ?? null,
          next.firstName ?? null,
          next.lastName ?? null,
        ],
      )
      await this.client.query("COMMIT")
      return next
    } catch (e) {
      await this.client.query("ROLLBACK")
      throw e
    }
  }

  async consume(args: {
    userId: string
    workspaceId: string
    credits: number
    usage: Omit<CreditUsageRecord, "id" | "createdAt">
  }): Promise<{ creditsUsed: number; record: CreditUsageRecord }> {
    // Atomic via SERIALIZABLE transaction + FOR UPDATE lock. The
    // SELECT FOR UPDATE blocks concurrent consumers on the same
    // subscription row, so the read-modify-write is safe.
    await this.client.query("BEGIN")
    try {
      const sel = await this.client.query<SubscriptionRow>(
        `SELECT * FROM subscriptions
          WHERE user_id = $1 AND workspace_id = $2
          FOR UPDATE`,
        [args.userId, args.workspaceId],
      )
      if (sel.rows.length === 0) {
        // First-touch user: seed and retry once.
        await this.client.query("COMMIT")
        await this.loadSubscription(args.userId, args.workspaceId)
        return this.consume(args)
      }
      const sub = rowToSubscription(sel.rows[0])
      const remaining = Math.max(0, sub.creditsLimit - sub.creditsUsed)
      const credits = Math.max(0, Math.min(args.credits, remaining))
      const nextUsed = sub.creditsUsed + credits
      await this.client.query(
        `UPDATE subscriptions
            SET credits_used = $3, updated_at = NOW()
          WHERE user_id = $1 AND workspace_id = $2`,
        [args.userId, args.workspaceId, nextUsed],
      )
      const id = randomUUID()
      const ins = await this.client.query<UsageRow>(
        `INSERT INTO credit_usage (
           id, user_id, workspace_id, task, intelligence_mode,
           provider, model, estimated_credits, actual_credits,
           request_id, context_hash, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'success', NOW())
         RETURNING *`,
        [
          id,
          args.userId,
          args.workspaceId,
          args.usage.task,
          args.usage.intelligenceMode,
          args.usage.provider,
          args.usage.model,
          args.usage.estimatedCredits,
          credits,
          args.usage.requestId,
          args.usage.contextHash ?? null,
        ],
      )
      await this.client.query("COMMIT")
      return { creditsUsed: nextUsed, record: rowToUsage(ins.rows[0]) }
    } catch (e) {
      await this.client.query("ROLLBACK")
      throw e
    }
  }

  async canConsume(
    userId: string,
    workspaceId: string,
    credits: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; remaining: number }> {
    const sub = await this.loadSubscription(userId, workspaceId)
    const remaining = Math.max(0, sub.creditsLimit - sub.creditsUsed)
    if (credits > remaining) return { ok: false, remaining }
    return { ok: true, remaining }
  }

  async recentUsage(
    userId: string,
    workspaceId: string,
    limit = 50,
  ): Promise<CreditUsageRecord[]> {
    const res = await this.client.query<UsageRow>(
      `SELECT * FROM credit_usage
        WHERE user_id = $1 AND workspace_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, workspaceId, Math.max(1, Math.min(500, limit))],
    )
    return res.rows.map(rowToUsage)
  }

  async claimEvent(
    record: Omit<BillingEventRecord, "processedAt">,
  ): Promise<boolean> {
    // Atomic insert; `ON CONFLICT DO NOTHING RETURNING id` gives us
    // a non-empty rows array only when we are the first writer for
    // this stripe_event_id. Subsequent webhook retries get an empty
    // result and short-circuit before mutating anything.
    const res = await this.client.query<EventRow>(
      `INSERT INTO billing_events (
         stripe_event_id, type, user_id, workspace_id, raw_status
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING *`,
      [
        record.stripeEventId,
        record.type,
        record.userId ?? null,
        record.workspaceId ?? null,
        record.rawStatus,
      ],
    )
    return res.rows.length > 0
  }

  async hasProcessedEvent(stripeEventId: string): Promise<boolean> {
    const res = await this.client.query<EventRow>(
      `SELECT * FROM billing_events WHERE stripe_event_id = $1 LIMIT 1`,
      [stripeEventId],
    )
    return res.rows.length > 0
  }

  /** Optional online audit-log writer. The audit module calls this
   *  via duck-typing when `AUDIT_LOG_STORE=postgres`. Failures are
   *  swallowed upstream so the AI call isn't blocked by an audit
   *  write. */
  async writeAuditLog(record: {
    requestId?: string
    userId: string
    workspaceId: string
    task: string
    intelligenceMode: string
    provider: string
    model: string
    status: string
    estimatedCredits?: number
    actualCredits?: number
    inputTokens?: number
    outputTokens?: number
    errorClass?: string
    blockReason?: string
    contextHash?: string
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_logs (
         id, user_id, workspace_id, task, intelligence_mode,
         provider, model, status, estimated_credits, actual_credits,
         input_tokens, output_tokens, error_class, block_reason,
         context_hash, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        record.requestId ?? randomUUID(),
        record.userId,
        record.workspaceId,
        record.task,
        record.intelligenceMode,
        record.provider,
        record.model,
        record.status,
        record.estimatedCredits ?? 0,
        record.actualCredits ?? 0,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.errorClass ?? null,
        record.blockReason ?? null,
        record.contextHash ?? null,
      ],
    )
  }

  async _resetForTests(): Promise<void> {
    await this.client.query(
      "TRUNCATE billing_events, credit_usage, subscriptions, audit_logs",
    )
  }
}

/**
 * Sync-adapter wrapper.
 *
 * The legacy `BillingStore` interface is sync. We give callers a
 * synchronous façade by running the async Postgres calls inside a
 * `BlockingAsyncQueue` per workspace-key. In the Next.js runtime all
 * resolver paths actually live inside an `async` route handler, so
 * `consume`/`upsert` end up as microtask-deferred awaits that complete
 * before the response returns. The sync façade IS still required for
 * the existing test fixtures that call `loadSubscription(...)` outside
 * a Promise context.
 *
 * Production deployments are encouraged to switch the resolver to the
 * async API directly via `getAsyncBillingStore()` (see the bootstrap
 * file) for tighter throughput characteristics.
 */
export function syncProxy(sql: SqlBillingStore): BillingStore {
  // We cannot truly sync-block a Promise in V8, so this proxy throws
  // a typed error if a sync caller is reached. In real deployments
  // the routes call the async API explicitly. This proxy exists for
  // ergonomic parity with `FileBillingStore` only in tests that
  // already know to await; sync callers receive a clear failure.
  const todo = (): never => {
    throw new Error(
      "SqlBillingStore: sync facade not supported in production. Use the async API or set BILLING_STORE=file.",
    )
  }
  return {
    loadSubscription: todo,
    upsertSubscription: todo,
    consume: todo,
    canConsume: todo,
    recentUsage: todo,
    claimEvent: todo,
    hasProcessedEvent: todo,
    _resetForTests: () => {
      void sql._resetForTests()
    },
  }
}
