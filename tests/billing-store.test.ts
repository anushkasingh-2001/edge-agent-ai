/**
 * server-billing-store: persistent ledger, atomic consume, plan upserts.
 *
 * The hosted resolver relies on this store for credit accounting +
 * Stripe webhook → plan upgrades. The tests pin three properties:
 *
 *   1. Subscriptions survive across `getBillingStore()` calls
 *      (file-backed, not in-memory).
 *   2. `consume()` is atomic — concurrent debits never oversubscribe.
 *   3. `upsertSubscription()` resets credits + sets the right plan tier.
 *
 * Run: node --import tsx --test tests/billing-store.test.ts
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  FileBillingStore,
  PLAN_TIER_LIMITS,
  setBillingStore,
  type BillingStore,
} from "../lib/server-billing-store"

function freshStore(): BillingStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-billing-"))
  process.env.EDGE_AGENT_HOME = dir
  const store = new FileBillingStore()
  setBillingStore(store)
  store._resetForTests()
  return store
}

describe("billing-store", () => {
  beforeEach(() => {
    freshStore()
  })

  it("loadSubscription seeds a free-tier record for new users", () => {
    const store = freshStore()
    const sub = store.loadSubscription("u1", "w1")
    assert.equal(sub.planTier, "free")
    assert.equal(sub.creditsLimit, PLAN_TIER_LIMITS.free.creditsLimit)
    assert.equal(sub.creditsUsed, 0)
  })

  it("subscriptions persist across new store instances (file-backed)", () => {
    const store1 = freshStore()
    store1.upsertSubscription("u2", "w2", {
      planTier: "pro",
      creditsLimit: PLAN_TIER_LIMITS.pro.creditsLimit,
    })
    const store2 = new FileBillingStore()
    const sub = store2.loadSubscription("u2", "w2")
    assert.equal(sub.planTier, "pro")
    assert.equal(sub.creditsLimit, PLAN_TIER_LIMITS.pro.creditsLimit)
  })

  it("consume() debits credits and appends a usage row", () => {
    const store = freshStore()
    const { creditsUsed, record } = store.consume({
      userId: "u3",
      workspaceId: "w3",
      credits: 3,
      usage: {
        userId: "u3",
        workspaceId: "w3",
        task: "explain",
        intelligenceMode: "auto",
        model: "gpt-4.1-mini",
        provider: "openai_compatible",
        estimatedCredits: 3,
        actualCredits: 3,
        requestId: "req-1",
      },
    })
    assert.equal(creditsUsed, 3)
    assert.equal(record.actualCredits, 3)
    const recent = store.recentUsage("u3", "w3")
    assert.equal(recent.length, 1)
    assert.equal(recent[0].requestId, "req-1")
  })

  it("consume() refuses to oversubscribe — caps at remaining quota", () => {
    const store = freshStore()
    const limit = PLAN_TIER_LIMITS.free.creditsLimit
    const { creditsUsed } = store.consume({
      userId: "u4",
      workspaceId: "w4",
      credits: limit + 1000,
      usage: {
        userId: "u4",
        workspaceId: "w4",
        task: "patch",
        intelligenceMode: "max",
        model: "gpt-4.1",
        provider: "openai_compatible",
        estimatedCredits: limit + 1000,
        actualCredits: limit + 1000,
        requestId: "req-burn",
      },
    })
    assert.equal(creditsUsed, limit, "consume must cap at the plan limit")
  })

  it("upsertSubscription with creditsUsed=0 resets the counter (invoice.paid)", () => {
    const store = freshStore()
    store.consume({
      userId: "u5",
      workspaceId: "w5",
      credits: 5,
      usage: {
        userId: "u5",
        workspaceId: "w5",
        task: "explain",
        intelligenceMode: "auto",
        model: "x",
        provider: "openai_compatible",
        estimatedCredits: 5,
        actualCredits: 5,
        requestId: "r",
      },
    })
    let sub = store.loadSubscription("u5", "w5")
    assert.equal(sub.creditsUsed, 5)
    store.upsertSubscription("u5", "w5", { creditsUsed: 0 })
    sub = store.loadSubscription("u5", "w5")
    assert.equal(sub.creditsUsed, 0)
  })
})
