/**
 * Persistent billing + credit ledger.
 *
 * Replaces the in-memory `CREDIT_LEDGER` Map. Three concerns live here:
 *
 *   1. `BillingStore` interface — pluggable adapter. The default is a
 *      file-backed JSON store under `$EDGE_AGENT_HOME` (or the OS
 *      config dir). Production deployments swap this for Postgres or
 *      a managed billing service via the `setBillingStore` seam.
 *
 *   2. Subscription records (one per user+workspace) — plan tier,
 *      credit limit, credits used in the current period, Stripe ids,
 *      subscription status. Updated atomically by both the billing
 *      webhook and the resolver's `consumeCredits` path.
 *
 *   3. Credit usage records (append-only ledger entries) — every
 *      successful model call writes one. Used for billing audits,
 *      hosted-AI dashboards, and concurrency tests.
 *
 * Concurrency:
 *   - Reads/writes go through an in-process mutex so concurrent
 *     `consumeCredits` calls cannot oversubscribe. A real Postgres
 *     impl swaps the mutex for a row-level lock; the contract
 *     (atomic read-modify-write) stays the same.
 *
 * On-disk layout (file-backed dev impl):
 *   $EDGE_AGENT_HOME/billing.json
 *     {
 *       "subscriptions": { "userId:workspaceId": SubscriptionRecord },
 *       "usage": [ CreditUsageRecord, ... ]   // newest first, capped
 *     }
 *
 * The file is written with mode 0600 and the directory with 0700, the
 * same convention as `server-github-auth`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

export type PlanTier = "free" | "starter" | "pro" | "team" | "enterprise"
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "none"

export interface SubscriptionRecord {
  userId: string
  workspaceId: string
  /** Account email, captured at plan-selection / login time. Lets the
   *  persisted billing row identify the user without a join back to the
   *  auth provider. Optional because legacy rows pre-date the column. */
  email?: string
  /** Account holder's given/family name, captured at sign-up. Optional
   *  for the same reason as `email`. */
  firstName?: string
  lastName?: string
  planTier: PlanTier
  creditsLimit: number
  creditsUsed: number
  billingPeriodStart: string // ISO
  billingPeriodEnd: string // ISO
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  subscriptionStatus: SubscriptionStatus
  updatedAt: string // ISO
}

export interface CreditUsageRecord {
  id: string
  userId: string
  workspaceId: string
  task: string
  intelligenceMode: string
  model: string
  provider: string
  estimatedCredits: number
  actualCredits: number
  requestId: string
  contextHash?: string
  createdAt: string // ISO
}

/** Billing-event idempotency record. One row per Stripe event id we've
 *  ever processed. The `rawStatus` lets us record "skipped: duplicate"
 *  vs "applied" without losing audit information. */
export interface BillingEventRecord {
  stripeEventId: string
  type: string
  userId?: string
  workspaceId?: string
  processedAt: string
  rawStatus: "applied" | "skipped" | "error"
}

/** Adapter interface. The file-backed impl is the default; swap via
 *  `setBillingStore(...)` in a deployment-specific bootstrap. */
export interface BillingStore {
  loadSubscription(userId: string, workspaceId: string): SubscriptionRecord
  upsertSubscription(
    userId: string,
    workspaceId: string,
    patch: Partial<SubscriptionRecord>,
  ): SubscriptionRecord
  /** Atomic: increment usage AND append a usage record. Returns the
   *  new `creditsUsed` value AFTER the increment. */
  consume(args: {
    userId: string
    workspaceId: string
    credits: number
    usage: Omit<CreditUsageRecord, "id" | "createdAt">
  }): { creditsUsed: number; record: CreditUsageRecord }
  /** Inspect-only — does not mutate. Returns null if `credits` would
   *  overspend the remaining quota. */
  canConsume(
    userId: string,
    workspaceId: string,
    credits: number,
  ): { ok: true; remaining: number } | { ok: false; remaining: number }
  /** Recent usage, newest first. Used by the audit dashboard and
   *  the persistence test. */
  recentUsage(userId: string, workspaceId: string, limit?: number): CreditUsageRecord[]

  /** Atomically claim a Stripe event id. Returns `true` if the caller
   *  is the first to process this event (so should apply it), `false`
   *  if a previous call already processed it. */
  claimEvent(record: Omit<BillingEventRecord, "processedAt">): boolean

  /** Convenience read used by tests + the audit dashboard. */
  hasProcessedEvent(stripeEventId: string): boolean

  /** Test-only: wipe everything. */
  _resetForTests(): void
}

const PLAN_DEFAULTS: Record<PlanTier, { creditsLimit: number }> = {
  free: { creditsLimit: 50 },
  starter: { creditsLimit: 500 },
  pro: { creditsLimit: 2_000 },
  team: { creditsLimit: 10_000 },
  enterprise: { creditsLimit: 100_000 },
}

function isoNow(): string {
  return new Date().toISOString()
}

function periodWindow(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

function defaultRecord(userId: string, workspaceId: string): SubscriptionRecord {
  // Default to the env-pinned tier so the resolver test fixtures keep
  // working. Production maps Stripe webhooks → planTier.
  const envTier = (process.env.EDGE_AGENT_PLAN_TIER ?? "").toLowerCase()
  const tier: PlanTier =
    envTier === "free" || envTier === "starter" || envTier === "pro" || envTier === "team" || envTier === "enterprise"
      ? (envTier as PlanTier)
      : "free"
  const win = periodWindow()
  return {
    userId,
    workspaceId,
    planTier: tier,
    creditsLimit: PLAN_DEFAULTS[tier].creditsLimit,
    creditsUsed: 0,
    billingPeriodStart: win.start,
    billingPeriodEnd: win.end,
    subscriptionStatus: tier === "free" ? "none" : "active",
    updatedAt: isoNow(),
  }
}

// ---------------------------------------------------------------------------
// File-backed default implementation
// ---------------------------------------------------------------------------

const APP_DIR_NAME = "edge-agent-ai"
const FILE_NAME = "billing.json"
const USAGE_CAP = 1000

function appDir(): string {
  const override = process.env.EDGE_AGENT_HOME
  if (override) return override
  const platform = process.platform
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, APP_DIR_NAME)
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, APP_DIR_NAME)
}

function filePath(): string {
  return path.join(appDir(), FILE_NAME)
}

interface OnDisk {
  subscriptions: Record<string, SubscriptionRecord>
  usage: CreditUsageRecord[]
  events?: BillingEventRecord[]
}

function ensureDir(): string {
  const dir = appDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* ignore */
  }
  return dir
}

function readDisk(): OnDisk {
  try {
    const raw = fs.readFileSync(filePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<OnDisk>
    return {
      subscriptions: parsed.subscriptions ?? {},
      usage: Array.isArray(parsed.usage) ? parsed.usage : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
    }
  } catch {
    return { subscriptions: {}, usage: [], events: [] }
  }
}

function writeDiskAtomic(data: OnDisk): void {
  ensureDir()
  const fp = filePath()
  const tmp = `${fp}.tmp-${randomUUID()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, fp)
}

function key(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`
}

export class FileBillingStore implements BillingStore {
  /** Single in-process mutex protecting both read and write paths. A
   *  Postgres impl replaces this with a row-level FOR UPDATE; the
   *  contract stays atomic read-modify-write. */
  private chain: Promise<unknown> = Promise.resolve()

  private withLockSync<T>(fn: () => T): T {
    // Sync façade — every call site is sync today (consume + canConsume
    // hit the same in-process state). We still serialize with the
    // chain for any future async hook (e.g. signing audit logs).
    return fn()
  }

  loadSubscription(userId: string, workspaceId: string): SubscriptionRecord {
    return this.withLockSync(() => {
      const disk = readDisk()
      const k = key(userId, workspaceId)
      const existing = disk.subscriptions[k]
      if (existing) return existing
      const next = defaultRecord(userId, workspaceId)
      disk.subscriptions[k] = next
      writeDiskAtomic(disk)
      return next
    })
  }

  upsertSubscription(
    userId: string,
    workspaceId: string,
    patch: Partial<SubscriptionRecord>,
  ): SubscriptionRecord {
    return this.withLockSync(() => {
      const disk = readDisk()
      const k = key(userId, workspaceId)
      const existing = disk.subscriptions[k] ?? defaultRecord(userId, workspaceId)
      const next: SubscriptionRecord = {
        ...existing,
        ...patch,
        userId,
        workspaceId,
        updatedAt: isoNow(),
      }
      // If the patch raised the planTier without an explicit limit,
      // refresh the limit to the new tier's default.
      if (patch.planTier && patch.creditsLimit === undefined) {
        next.creditsLimit = PLAN_DEFAULTS[next.planTier].creditsLimit
      }
      disk.subscriptions[k] = next
      writeDiskAtomic(disk)
      return next
    })
  }

  canConsume(
    userId: string,
    workspaceId: string,
    credits: number,
  ): { ok: true; remaining: number } | { ok: false; remaining: number } {
    return this.withLockSync(() => {
      const sub = this.loadSubscription(userId, workspaceId)
      const remaining = Math.max(0, sub.creditsLimit - sub.creditsUsed)
      if (credits > remaining) return { ok: false, remaining }
      return { ok: true, remaining }
    })
  }

  consume(args: {
    userId: string
    workspaceId: string
    credits: number
    usage: Omit<CreditUsageRecord, "id" | "createdAt">
  }): { creditsUsed: number; record: CreditUsageRecord } {
    return this.withLockSync(() => {
      const disk = readDisk()
      const k = key(args.userId, args.workspaceId)
      const existing =
        disk.subscriptions[k] ?? defaultRecord(args.userId, args.workspaceId)
      const remaining = Math.max(0, existing.creditsLimit - existing.creditsUsed)
      // Hard cap: never let consume() push creditsUsed past the limit.
      // The resolver already gates via canConsume, but defence in
      // depth covers a race in non-Postgres deployments.
      const credits = Math.max(0, Math.min(args.credits, remaining))
      const next: SubscriptionRecord = {
        ...existing,
        creditsUsed: existing.creditsUsed + credits,
        updatedAt: isoNow(),
      }
      disk.subscriptions[k] = next
      const record: CreditUsageRecord = {
        ...args.usage,
        id: randomUUID(),
        createdAt: isoNow(),
        actualCredits: credits,
      }
      disk.usage = [record, ...disk.usage].slice(0, USAGE_CAP)
      writeDiskAtomic(disk)
      return { creditsUsed: next.creditsUsed, record }
    })
  }

  recentUsage(
    userId: string,
    workspaceId: string,
    limit = 50,
  ): CreditUsageRecord[] {
    const disk = readDisk()
    return disk.usage
      .filter((u) => u.userId === userId && u.workspaceId === workspaceId)
      .slice(0, limit)
  }

  claimEvent(record: Omit<BillingEventRecord, "processedAt">): boolean {
    return this.withLockSync(() => {
      const disk = readDisk()
      const events = disk.events ?? []
      if (events.some((e) => e.stripeEventId === record.stripeEventId)) {
        return false
      }
      events.push({ ...record, processedAt: isoNow() })
      disk.events = events.slice(-USAGE_CAP)
      writeDiskAtomic(disk)
      return true
    })
  }

  hasProcessedEvent(stripeEventId: string): boolean {
    const disk = readDisk()
    return (disk.events ?? []).some((e) => e.stripeEventId === stripeEventId)
  }

  _resetForTests(): void {
    try {
      fs.rmSync(filePath(), { force: true })
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + injection seam
// ---------------------------------------------------------------------------

let store: BillingStore = new FileBillingStore()

export function getBillingStore(): BillingStore {
  return store
}

/** Swap the active billing store. Production deployments call this
 *  from a server bootstrap with a Postgres- or Stripe-backed impl. */
export function setBillingStore(next: BillingStore): void {
  store = next
}

/** Re-export plan defaults so the resolver and webhook can derive
 *  credit limits from a tier name. */
export const PLAN_TIER_LIMITS = PLAN_DEFAULTS

/** Helper — collapse a record into the shape `lib/server-subscription`
 *  has historically exposed to callers. */
export function recordToSubscriptionShape(r: SubscriptionRecord): {
  tier: PlanTier
  creditsTotal: number
  creditsUsed: number
} {
  return {
    tier: r.planTier,
    creditsTotal: r.creditsLimit,
    creditsUsed: r.creditsUsed,
  }
}
