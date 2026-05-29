/**
 * Completion transport — the seam that lets the patch pipeline obtain a
 * raw model completion from EITHER the in-process LLM client (single-origin
 * web/dev) OR a remote cloud generation endpoint (packaged desktop).
 *
 * Why this exists
 * ---------------
 * The desktop build must never hold provider keys, so it cannot call
 * OpenAI/Anthropic directly. But it still owns the user's local files, so
 * patch *application* must stay local. The split is therefore:
 *
 *   - LOCAL  builds the redacted ContextBundle / prompt, validates the
 *            returned patch, applies it, backs up, re-scans.
 *   - CLOUD  receives ONLY the prompt (already-redacted slices), runs the
 *            hosted resolver (auth → plan → quota → key), calls the model,
 *            debits credits, and returns the patch text.
 *
 * `CompletionFn` is the contract between the two. The pipeline calls it
 * instead of `callLlm` whenever a `generate` function is injected. The
 * function NEVER carries a provider key in either direction — the cloud
 * resolves its own key from server env and never echoes it back.
 */

import type { IntelligenceMode } from "./context-bundle"

/** What the pipeline asks for: a single chat completion. The `system` and
 *  `user` strings are already redacted, graph-bounded prompt text — never
 *  raw repo contents and never a secret. */
export interface CompletionRequest {
  system: string
  user: string
  /** Force JSON object output (patch replies are always JSON). */
  json: boolean
  maxTokens: number
  /** Locally-routed model id (a hint; the cloud is authoritative and may
   *  re-route by plan). Not a secret. */
  model: string
  intelligenceMode: IntelligenceMode
  /** Coarse task label so the cloud resolver applies the right gate. */
  task: "patch" | "plan" | "bulk"
  temperature?: number
  /** Optional complexity score so the cloud can route Auto correctly. */
  complexity?: number
  /** Manual mode per-task model ids (never a key). */
  manualModelSelection?: Record<string, string>
}

/** Result shape, compatible with `LlmResult` so the pipeline can consume it
 *  with the same `ok`/`text`/`error` checks it uses for `callLlm`. */
export type CompletionResult =
  | {
      ok: true
      text: string
      model?: string
      /** Credits the cloud actually debited for this call (cloud path only). */
      creditsUsed?: number
      /** Remaining credits after this call (cloud path only). */
      quotaRemaining?: number | null
    }
  | {
      ok: false
      error: string
      /** Resolver/cloud failure code (e.g. quota_exceeded, not_authenticated). */
      code?: string
      upgrade?: boolean
      remaining?: number
      needed?: number
      /** HTTP status returned by the cloud, when applicable. */
      status?: number
    }

export type CompletionFn = (req: CompletionRequest) => Promise<CompletionResult>

export interface CloudCompletionOptions {
  /** Cloud backend base URL (no trailing slash), e.g. https://api.you.com */
  baseUrl: string
  /** User session JWT to forward as `Authorization: Bearer`. */
  token: string | null
  /** Cloud generation endpoint path, e.g. /api/cloud/finding/patch-generate */
  endpoint: string
  /** Called when the cloud reports credits/quota for a successful call. */
  onMeta?: (m: { creditsUsed: number; quotaRemaining: number | null }) => void
  /** Called on an auth/plan/quota/upstream failure so the route can map it
   *  to the right HTTP status instead of a generic "model failed". */
  onError?: (e: {
    code: string
    reason: string
    upgrade?: boolean
    remaining?: number
    needed?: number
    status: number
  }) => void
  /** Test seam: override fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Build a `CompletionFn` that relays the prompt to a cloud generation
 * endpoint with the user's session Bearer token. The request body carries
 * ONLY prompt text + routing hints — never a provider key, baseUrl, or repo
 * contents. The response is expected to be `{ text, model, creditsUsed,
 * quotaRemaining }` and is asserted to never include a key.
 */
export function makeCloudCompletionFn(opts: CloudCompletionOptions): CompletionFn {
  const base = opts.baseUrl.replace(/\/+$/, "")
  const doFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input as RequestInfo | URL, init))

  return async (req: CompletionRequest): Promise<CompletionResult> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (opts.token && opts.token.trim()) {
      headers.Authorization = `Bearer ${opts.token.trim()}`
    }

    // Whitelist exactly the fields the cloud needs. We deliberately do NOT
    // spread `req` so a future field can't accidentally smuggle a secret.
    const payload = {
      system: req.system,
      user: req.user,
      json: req.json,
      maxTokens: req.maxTokens,
      model: req.model,
      intelligenceMode: req.intelligenceMode,
      task: req.task,
      temperature: req.temperature,
      complexity: req.complexity,
      manualModelSelection: req.manualModelSelection,
    }

    let resp: Response
    try {
      resp = await doFetch(`${base}${opts.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
    } catch (e) {
      return {
        ok: false,
        error: `cloud_unreachable: ${e instanceof Error ? e.message : String(e)}`,
        code: "cloud_unreachable",
        status: 0,
      }
    }

    let data: Record<string, unknown> = {}
    try {
      data = (await resp.json()) as Record<string, unknown>
    } catch {
      data = {}
    }

    if (!resp.ok) {
      const code = typeof data.code === "string" ? data.code : "cloud_error"
      const reason =
        (typeof data.error === "string" && data.error) ||
        (typeof data.reason === "string" && data.reason) ||
        `cloud_http_${resp.status}`
      const err = {
        code,
        reason,
        upgrade: typeof data.upgrade === "boolean" ? data.upgrade : undefined,
        remaining: typeof data.remaining === "number" ? data.remaining : undefined,
        needed: typeof data.needed === "number" ? data.needed : undefined,
        status: resp.status,
      }
      opts.onError?.(err)
      return { ok: false, error: reason, code, upgrade: err.upgrade, remaining: err.remaining, needed: err.needed, status: resp.status }
    }

    const text = typeof data.text === "string" ? data.text : null
    if (!text) {
      return { ok: false, error: "cloud_empty_reply", code: "cloud_empty_reply", status: resp.status }
    }
    const creditsUsed = typeof data.creditsUsed === "number" ? data.creditsUsed : 0
    const quotaRemaining = typeof data.quotaRemaining === "number" ? data.quotaRemaining : null
    opts.onMeta?.({ creditsUsed, quotaRemaining })
    return {
      ok: true,
      text,
      model: typeof data.model === "string" ? data.model : undefined,
      creditsUsed,
      quotaRemaining,
    }
  }
}
