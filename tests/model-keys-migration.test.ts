/**
 * Anthropic legacy-model migration in `lib/model-keys`.
 *
 * Hosted-only contract: there is no persistent provider-config store
 * any more. `purgeLegacyProviderKeys()` is the migration entry-point:
 * it reads any leftover BYOK localStorage slot, surfaces a migration
 * notice for every stale Anthropic id, then wipes the slot.
 *
 *   - claude-3-7-sonnet-latest  → claude-sonnet-4-6
 *   - claude-3-5-sonnet-latest  → claude-sonnet-4-6
 *   - claude-3-opus-*           → claude-opus-4-7
 *   - claude-3-haiku-*          → claude-haiku-4-5
 *   - any other legacy claude-* → claude-sonnet-4-6 (catch-all)
 *   - non-Anthropic providers   → unchanged (no notice)
 *
 * Run with:
 *   node --import tsx --test tests/model-keys-migration.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ANTHROPIC_DEFAULT_MODEL,
  consumeMigrationNotices,
  migrateAnthropicModel,
  purgeLegacyProviderKeys,
} from "../lib/model-keys"

// ---------------------------------------------------------------------------
// `window.localStorage` shim so the browser-only helpers run under Node test.
// ---------------------------------------------------------------------------

function installLocalStorage(): { reset: () => void; store: Record<string, string> } {
  const store: Record<string, string> = {}
  const fake = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    get length() {
      return Object.keys(store).length
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
  const w = globalThis as unknown as { window?: { localStorage: typeof fake } }
  const prev = w.window
  w.window = { localStorage: fake }
  return {
    reset: () => {
      w.window = prev
    },
    store,
  }
}

interface LegacyConfig {
  id: string
  type: "anthropic" | "openai_compatible" | "google"
  label: string
  model: string
  /** Legacy BYOK fields. The purge wipes the entire slot — these are
   *  only here so the test can confirm they're erased. */
  apiKey?: string
  baseUrl?: string
}

function seed(store: Record<string, string>, configs: LegacyConfig[]) {
  store["edge-agent-ai.modelKeys"] = JSON.stringify(configs)
}

function cfg(model: string, type: LegacyConfig["type"] = "anthropic"): LegacyConfig {
  return {
    id: `slot-${type}`,
    type,
    label: type,
    model,
    apiKey: "sk-legacy",
  }
}

// ===================================================================
// 1. Pure migrateAnthropicModel — the rule table
// ===================================================================

test("stale Sonnet ids migrate to claude-sonnet-4-6", () => {
  for (const stale of [
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-sonnet-20240229",
  ]) {
    const r = migrateAnthropicModel(stale)
    assert.equal(r.migrated, true, `${stale} should migrate`)
    assert.equal(r.newModel, "claude-sonnet-4-6", `${stale} should land on Sonnet 4.6`)
    assert.equal(r.oldModel, stale)
  }
})

test("stale Opus ids migrate to claude-opus-4-7", () => {
  for (const stale of [
    "claude-3-opus-20240229",
    "claude-3-opus-latest",
    "claude-opus-4-1-20250805",
  ]) {
    const r = migrateAnthropicModel(stale)
    assert.equal(r.migrated, true, `${stale} should migrate`)
    assert.equal(r.newModel, "claude-opus-4-7", `${stale} should land on Opus 4.7`)
  }
})

test("stale Haiku ids migrate to claude-haiku-4-5", () => {
  for (const stale of [
    "claude-3-haiku-20240307",
    "claude-3-5-haiku-latest",
    "claude-3-5-haiku-20241022",
  ]) {
    const r = migrateAnthropicModel(stale)
    assert.equal(r.migrated, true, `${stale} should migrate`)
    assert.equal(r.newModel, "claude-haiku-4-5", `${stale} should land on Haiku 4.5`)
  }
})

test("unknown legacy Claude ids fall back to the current Sonnet default", () => {
  for (const stale of [
    "claude-2.1",
    "claude-instant-1.2",
    "claude-something-old-2023",
  ]) {
    const r = migrateAnthropicModel(stale)
    assert.equal(r.migrated, true, `${stale} should hit the catch-all`)
    assert.equal(r.newModel, ANTHROPIC_DEFAULT_MODEL)
    assert.equal(r.newModel, "claude-sonnet-4-6")
  }
})

test("already-current Anthropic ids are NOT re-migrated", () => {
  for (const current of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]) {
    const r = migrateAnthropicModel(current)
    assert.equal(r.migrated, false, `${current} should be left alone`)
    assert.equal(r.newModel, current)
  }
})

test("non-claude ids passed to migrateAnthropicModel are left as-is", () => {
  for (const other of ["gpt-4o-mini", "gemini-2.5-pro", "llama3.1:8b", "qwen2.5-coder:7b"]) {
    const r = migrateAnthropicModel(other)
    assert.equal(r.migrated, false, `${other} must not be touched`)
    assert.equal(r.newModel, other)
  }
})

test("empty / whitespace input is a no-op (defensive)", () => {
  assert.deepEqual(migrateAnthropicModel(""), {
    migrated: false,
    oldModel: "",
    newModel: "",
  })
  const r = migrateAnthropicModel("   ")
  assert.equal(r.migrated, false)
})

// ===================================================================
// 2. purgeLegacyProviderKeys — hosted-only one-shot wipe
// ===================================================================

test("purgeLegacyProviderKeys removes stale BYOK entries", () => {
  const { reset, store } = installLocalStorage()
  try {
    seed(store, [
      cfg("claude-3-7-sonnet-latest", "anthropic"),
      cfg("gpt-4o", "openai_compatible"),
    ])
    const r = purgeLegacyProviderKeys()
    assert.equal(r.purged, true)
    // Slot is wiped — no apiKey lingers on disk.
    assert.equal(
      "edge-agent-ai.modelKeys" in store,
      false,
      "legacy provider-config slot must be removed from localStorage",
    )
  } finally {
    reset()
  }
})

test("purgeLegacyProviderKeys emits an Anthropic migration notice the UI consumes once", () => {
  const { reset, store } = installLocalStorage()
  try {
    seed(store, [cfg("claude-3-opus-20240229", "anthropic")])
    const r = purgeLegacyProviderKeys()
    assert.equal(r.purged, true)
    assert.equal(r.noticesAdded, 1)
    const notices = consumeMigrationNotices()
    assert.equal(notices.length, 1)
    assert.equal(notices[0].slot, "anthropic")
    assert.equal(notices[0].oldModel, "claude-3-opus-20240229")
    assert.equal(notices[0].newModel, "claude-opus-4-7")
    // Second consume returns empty — banner shows exactly once.
    assert.equal(consumeMigrationNotices().length, 0)
  } finally {
    reset()
  }
})

test("purgeLegacyProviderKeys produces no notice for current Anthropic ids", () => {
  const { reset, store } = installLocalStorage()
  try {
    seed(store, [cfg("claude-sonnet-4-6", "anthropic")])
    const r = purgeLegacyProviderKeys()
    assert.equal(r.purged, true)
    assert.equal(
      r.noticesAdded,
      0,
      "already-current Anthropic ids must not trigger a migration banner",
    )
  } finally {
    reset()
  }
})

test("purgeLegacyProviderKeys is a safe no-op on a clean localStorage", () => {
  const { reset } = installLocalStorage()
  try {
    const r = purgeLegacyProviderKeys()
    assert.equal(r.purged, false)
    assert.equal(r.noticesAdded, 0)
  } finally {
    reset()
  }
})

test("purgeLegacyProviderKeys drops corrupted JSON without crashing", () => {
  const { reset, store } = installLocalStorage()
  try {
    store["edge-agent-ai.modelKeys"] = "{not valid json"
    const r = purgeLegacyProviderKeys()
    assert.equal(r.purged, true)
    assert.equal("edge-agent-ai.modelKeys" in store, false)
  } finally {
    reset()
  }
})
