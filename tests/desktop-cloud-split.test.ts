/**
 * Desktop/cloud split contract.
 *
 *   - AI / billing / auth / plan routes go to the cloud backend when a
 *     cloud base is configured; filesystem routes (scan, fix, git) stay
 *     local.
 *   - Cloud calls carry the session Bearer token + credentials.
 *   - apiFetch never injects a provider API key.
 *   - The desktop server env strips provider keys / billing secrets /
 *     DATABASE_URL (and electron/main.ts mirrors that denylist).
 *   - Cloud success responses never include apiKey / baseUrl.
 *
 * Run: node --import tsx --test tests/desktop-cloud-split.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  apiFetch,
  classifyApiRoute,
  CLOUD_ROUTE_PREFIXES,
  getCloudApiBase,
  isCloudSplitEnabled,
  setCloudAuthToken,
} from "../lib/api-fetch"
import {
  DESKTOP_FORBIDDEN_ENV_KEYS,
  stripDesktopSecrets,
} from "../lib/desktop-secret-denylist"
import { redactForClient } from "../lib/server-ai-provider-resolver"

const repoRoot = path.resolve(__dirname, "..")
const ORIGINAL_FETCH = global.fetch
const CLOUD_BASE = "https://api.myproduct.test"

interface Captured {
  url: string
  init: RequestInit
}
let lastCall: Captured | null = null

function stubFetch(): void {
  lastCall = null
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    lastCall = { url: String(url), init: init ?? {} }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

function header(name: string): string | null {
  if (!lastCall) return null
  return new Headers(lastCall.init.headers).get(name)
}

/* ------------------------------------------------------------------ */
/* Route classification                                                */
/* ------------------------------------------------------------------ */

describe("classifyApiRoute", () => {
  it("routes hosted AI / billing / auth / plan to the cloud", () => {
    const cloud = [
      "/api/hosted/chat",
      "/api/hosted/playground",
      "/api/hosted/workflow",
      "/api/finding/explain",
      "/api/workflow/chat",
      "/api/plan",
      "/api/billing/checkout",
      "/api/billing/dev-checkout",
      "/api/billing/portal",
      "/api/auth/dev-login",
      "/api/auth/dev-login?logout=1",
    ]
    for (const r of cloud) {
      assert.equal(classifyApiRoute(r), "cloud", `${r} should be cloud`)
    }
  })

  it("keeps filesystem-bound routes local (incl. fix/patch which write files)", () => {
    const local = [
      "/api/scan",
      "/api/scan/estimate",
      "/api/finding/patch",
      "/api/findings/fix",
      "/api/findings/fix-filtered",
      "/api/workflow/analyze",
      "/api/workflow/export",
      "/api/git/status",
      "/api/github/clone",
      "/api/policy/evaluate",
      "/api/system/health",
      "/api/workspace/list",
    ]
    for (const r of local) {
      assert.equal(classifyApiRoute(r), "local", `${r} should be local`)
    }
  })

  it("does not match a prefix as a substring of a longer segment", () => {
    // "/api/plan" must NOT swallow "/api/planner".
    assert.equal(classifyApiRoute("/api/planner/thing"), "local")
  })

  it("explain is cloud but sibling patch is local", () => {
    assert.equal(classifyApiRoute("/api/finding/explain"), "cloud")
    assert.equal(classifyApiRoute("/api/finding/patch"), "local")
    assert.ok(CLOUD_ROUTE_PREFIXES.includes("/api/finding/explain"))
  })
})

/* ------------------------------------------------------------------ */
/* apiFetch — cloud configured                                         */
/* ------------------------------------------------------------------ */

describe("apiFetch with a cloud base configured", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_CLOUD_API_BASE = CLOUD_BASE
    setCloudAuthToken("jwt-session-token")
    stubFetch()
  })
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
    delete process.env.NEXT_PUBLIC_CLOUD_API_BASE
    delete process.env.EDGE_AGENT_CLOUD_API_BASE
    setCloudAuthToken(null)
  })

  it("getCloudApiBase / isCloudSplitEnabled reflect the env", () => {
    assert.equal(getCloudApiBase(), CLOUD_BASE)
    assert.equal(isCloudSplitEnabled(), true)
  })

  it("sends AI calls to the cloud base with the session Bearer + credentials", async () => {
    await apiFetch("/api/hosted/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.ok(lastCall)
    assert.equal(lastCall!.url, `${CLOUD_BASE}/api/hosted/chat`)
    assert.equal(header("authorization"), "Bearer jwt-session-token")
    assert.equal(lastCall!.init.credentials, "include")
  })

  it("preserves the query string when routing to the cloud", async () => {
    await apiFetch("/api/auth/dev-login?logout=1", { method: "POST" })
    assert.equal(lastCall!.url, `${CLOUD_BASE}/api/auth/dev-login?logout=1`)
  })

  it("keeps the scan route LOCAL (relative) even when cloud is configured", async () => {
    await apiFetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    assert.equal(lastCall!.url, "/api/scan")
    assert.equal(header("authorization"), null)
  })

  it("keeps fix/patch LOCAL so file-apply still works on desktop, but forwards the session token", async () => {
    // fix/patch stay same-origin (they touch local files) but DO carry the
    // session Bearer so the local server can relay it to the cloud generation
    // endpoint. The scan route, which never reaches the cloud, stays clean.
    await apiFetch("/api/findings/fix", { method: "POST", body: "{}" })
    assert.equal(lastCall!.url, "/api/findings/fix")
    assert.equal(header("authorization"), "Bearer jwt-session-token")

    await apiFetch("/api/finding/patch", { method: "POST", body: "{}" })
    assert.equal(lastCall!.url, "/api/finding/patch")
    assert.equal(header("authorization"), "Bearer jwt-session-token")

    await apiFetch("/api/findings/fix-filtered", { method: "POST", body: "{}" })
    assert.equal(lastCall!.url, "/api/findings/fix-filtered")
    assert.equal(header("authorization"), "Bearer jwt-session-token")
  })

  it("does not attach a token to fix/patch when no session is set", async () => {
    setCloudAuthToken(null)
    await apiFetch("/api/findings/fix", { method: "POST", body: "{}" })
    assert.equal(lastCall!.url, "/api/findings/fix")
    assert.equal(header("authorization"), null)
  })

  it("never injects a provider API key on a cloud call", async () => {
    await apiFetch("/api/finding/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: "/x", finding: {} }),
    })
    const h = new Headers(lastCall!.init.headers)
    assert.equal(h.get("x-api-key"), null)
    assert.equal(h.get("openai-api-key"), null)
    // Only a *session* Bearer is allowed, and it must not look like a key.
    const auth = h.get("authorization") ?? ""
    assert.ok(!/sk-/.test(auth), "Authorization must not carry a provider key")
    const body = String(lastCall!.init.body ?? "")
    assert.ok(!/apiKey|baseUrl|sk-/.test(body), "body must not carry a key/baseUrl")
  })

  it("does not attach an Authorization header when no session token is set", async () => {
    setCloudAuthToken(null)
    await apiFetch("/api/plan")
    assert.equal(lastCall!.url, `${CLOUD_BASE}/api/plan`)
    assert.equal(header("authorization"), null)
  })
})

/* ------------------------------------------------------------------ */
/* apiFetch — no cloud base (web/dev): everything same-origin          */
/* ------------------------------------------------------------------ */

describe("apiFetch with NO cloud base (single-origin web/dev)", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_CLOUD_API_BASE
    delete process.env.EDGE_AGENT_CLOUD_API_BASE
    setCloudAuthToken("jwt-session-token")
    stubFetch()
  })
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
    setCloudAuthToken(null)
  })

  it("is a no-op: cloud-category routes stay relative", async () => {
    assert.equal(isCloudSplitEnabled(), false)
    await apiFetch("/api/hosted/chat", { method: "POST", body: "{}" })
    assert.equal(lastCall!.url, "/api/hosted/chat")
    // No cross-origin → no forced credentials, no bearer.
    assert.equal(header("authorization"), null)
    assert.equal(lastCall!.init.credentials, undefined)
  })
})

/* ------------------------------------------------------------------ */
/* Desktop env secret stripping                                        */
/* ------------------------------------------------------------------ */

describe("desktop server env secret stripping", () => {
  it("removes every forbidden secret and keeps everything else", () => {
    const input: Record<string, string | undefined> = {
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      GEMINI_API_KEY: "g",
      GOOGLE_API_KEY: "g2",
      EDGE_AGENT_CUSTOM_API_KEY: "c",
      DATABASE_URL: "postgresql://secret",
      STRIPE_SECRET_KEY: "sk_live_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      EDGE_AGENT_DESKTOP: "1",
      EDGE_AGENT_SCANNER_BIN: "/path/to/scanner",
      PATH: "/usr/bin",
    }
    const { env, removed } = stripDesktopSecrets(input)
    for (const k of DESKTOP_FORBIDDEN_ENV_KEYS) {
      assert.equal(env[k], undefined, `${k} must be stripped`)
      assert.ok(removed.includes(k), `${k} must be reported as removed`)
    }
    // Non-secret operational env survives.
    assert.equal(env.EDGE_AGENT_DESKTOP, "1")
    assert.equal(env.EDGE_AGENT_SCANNER_BIN, "/path/to/scanner")
    assert.equal(env.PATH, "/usr/bin")
  })

  it("electron/main.ts mirrors the denylist and strips it from childEnv", () => {
    const main = readFileSync(path.join(repoRoot, "electron", "main.ts"), "utf8")
    for (const k of DESKTOP_FORBIDDEN_ENV_KEYS) {
      assert.ok(
        main.includes(`"${k}"`),
        `electron/main.ts must list ${k} in its denylist`,
      )
    }
    assert.ok(
      /delete childEnv\[key\]/.test(main),
      "electron/main.ts must delete denylisted keys from childEnv",
    )
  })
})

/* ------------------------------------------------------------------ */
/* Cloud response redaction                                            */
/* ------------------------------------------------------------------ */

describe("cloud response never leaks credentials", () => {
  it("redactForClient nulls apiKey and baseUrl", () => {
    const resolved = {
      ok: true as const,
      provider: "openai_compatible" as const,
      model: "gpt-4.1-mini",
      apiKeySource: "hosted" as const,
      apiKey: "sk-super-secret",
      baseUrl: "https://api.openai.com/v1",
      bundleMode: "standard",
      twoStep: false,
      estimatedCredits: 1,
      quotaStatus: { remaining: 49, total: 50 },
      estimatedCostUsd: 0.0001,
      requestId: "req-1",
    }
    const safe = redactForClient(resolved)
    assert.equal(safe.apiKey, null)
    assert.equal(safe.baseUrl, null)
    assert.equal(safe.model, "gpt-4.1-mini")
    const serialized = JSON.stringify(safe)
    assert.ok(!serialized.includes("sk-super-secret"))
    assert.ok(!serialized.includes("api.openai.com"))
  })
})
