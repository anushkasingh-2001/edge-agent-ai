/**
 * resolveAiProviderForRequest — the ONE place that decides which model
 * runs, with which key, for any AI task in any mode.
 *
 * **Hosted-only contract.**
 *
 * As of the hosted-only pivot this resolver:
 *   - Reads provider credentials ONLY from server env / secret manager
 *     (process.env.OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY).
 *     There is no caller-supplied API key path, no BYOK fallback, no
 *     "use your own key" toggle.
 *   - Requires an authenticated user identity (today: a stubbed
 *     `local-user`/`local-workspace`; the auth seam is `assertSession`
 *     so the real wire-in is a single function change). All AI routes
 *     must surface the resolver's `not_authenticated` failure if there
 *     is no session.
 *   - Enforces plan + per-mode + per-task entitlements (Pro/Max/Manual
 *     blocked before the upstream call when not allowed).
 *   - Enforces quota: BEFORE the model call the resolver returns
 *     `quota_exceeded` if the estimated credit cost exceeds the
 *     remaining balance; AFTER the call routes call `recordConsumption`
 *     to debit the ledger.
 *   - Composes intelligence-mode routing (routeForMode) so the model
 *     id, bundle mode, two-step flag, and escalation target are all
 *     derived from the request — never from the client.
 *
 * Wire contract:
 *   - Public API responses NEVER include `apiKey`. Routes either omit
 *     it entirely or pass the result through `redactForClient()`.
 *   - The `apiKeySource` discriminator on success is always `"hosted"`.
 *
 * If `aiProviderMode` arrives on the wire it is informational only —
 * the resolver is hosted-only and ignores it. Routes are encouraged to
 * stop sending it.
 */

import { routeForMode } from "./server-model-router-ext"
import type { ModelTier, ProviderKind } from "./server-model-router"
import type { IntelligenceMode } from "./context-bundle"
import type { LlmTask, ManualOverrides } from "./intelligence-mode"
import { MODE_POLICIES } from "./intelligence-mode"
import {
  loadSubscription,
  modeAllowed,
  checkQuota,
  consumeCreditsAtomic,
  type Subscription,
} from "./server-subscription"
import { priceFor } from "./server-cost-controller"
import { BUNDLE_INPUT_TOKEN_CAP } from "./context-bundle"
import {
  beginAudit,
  completeAudit,
  logBlocked,
  redactSecrets,
} from "./server-audit-log"
import { emailVerificationEnforced, EMAIL_UNVERIFIED_MESSAGE } from "./server-email-verification"

/** Intelligence modes an UNVERIFIED (free-clamped) account may still use. */
const FREE_INTELLIGENCE_MODES: IntelligenceMode[] = ["save", "auto"]
/** Free-tier credit allowance (mirrors PLAN defaults). Used to clamp an
 *  unverified account's quota even if a stale paid row exists. */
const FREE_CREDIT_ALLOWANCE = 50

export type ManualModelSelection = Record<string, string>

/** Identity of the authenticated caller. Today this is a stub; the
 *  shape is the contract the future real auth layer must produce. */
export interface CallerIdentity {
  userId: string
  workspaceId: string
}

export interface ResolveArgs {
  /** Authenticated caller. Routes MUST resolve this via `assertSession`
   *  (or the equivalent server-side identity layer) before calling the
   *  resolver — no anonymous AI calls. */
  userId: string
  workspaceId: string
  intelligenceMode: IntelligenceMode
  task: LlmTask
  /** Manual mode per-task model ids, e.g. { patch: "anthropic:claude-opus-4-7" }. */
  manualModelSelection?: ManualModelSelection | null
  /** Optional complexity score for Auto routing (defaults to 0). */
  complexity?: number
  /** Rough token estimate so the resolver can produce a quota cost
   *  estimate before the model call. */
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  /** Whether the caller's account email is verified. `false` (with
   *  enforcement on) limits the caller to free-tier AI; `undefined` is
   *  treated as verified (legacy / non-account sessions). */
  emailVerified?: boolean
}

/** Server-only successful resolution. `apiKey` MUST never leave the
 *  process boundary — pass through `redactForClient()` before any
 *  HTTP response. */
export interface ResolveOk {
  ok: true
  provider: ProviderKind
  model: string
  /** Always `"hosted"` on the hosted-only contract. */
  apiKeySource: "hosted"
  /** Server-managed key for the upstream model call. Read straight out
   *  of `process.env.*_API_KEY`. Never echoed to the client. */
  apiKey: string
  /** Provider-default base URL (Anthropic / Google / OpenAI). Never
   *  echoed to the client. */
  baseUrl: string | null
  bundleMode: string
  twoStep: boolean
  /** Authoritative cost in credits the resolver reserved against the
   *  caller's quota. Routes pass the same number to `recordConsumption`
   *  on success. */
  estimatedCredits: number
  /** Credits left AFTER reserving this call (informational, may be
   *  echoed to the UI). */
  quotaStatus: { remaining: number; total: number }
  /** Cost echo in USD for the UI display only. */
  estimatedCostUsd: number
  /** Audit-log request id. Routes pass this back to
   *  `recordConsumption` so the audit row + credit debit reference
   *  the same upstream attempt. */
  requestId: string
}

export interface ResolveErr {
  ok: false
  reason: string
  code:
    | "not_authenticated"
    | "missing_hosted_key"
    | "mode_not_in_plan"
    | "manual_not_in_plan"
    | "task_not_allowed_in_mode"
    | "quota_exceeded"
    | "billing_db_unconfigured"
    | "email_unverified"
  /** UI surfaces an upgrade prompt for plan-related failures. */
  upgrade?: boolean
  /** Remaining credits when the failure is a quota issue (so the UI
   *  can show "you have N credits, this call needs M"). */
  remaining?: number
  /** Estimated credit cost of the rejected call. */
  needed?: number
}

export type ResolveResult = ResolveOk | ResolveErr

const TIER_VALUES = new Set<ModelTier>(["cheap", "mid", "coding_flagship", "local"])

const TASK_ALIASES: Record<LlmTask, string[]> = {
  explain: ["explain", "explanation"],
  root_cause: ["root_cause", "rootCause", "root-cause"],
  suggest: ["suggest", "suggestion"],
  patch: ["patch", "patch_generation", "patchGeneration"],
  bulk: ["bulk", "bulk_fix", "bulkFix"],
  verify: ["verify", "verifier"],
}

/** Per-routed-tier credit cost. Two-step plan→patch flows add one
 *  more credit for the plan phase. Bulk flows charge per call site
 *  (one cluster at a time) so this scales naturally. */
const CREDITS_PER_TIER: Record<ModelTier, number> = {
  cheap: 1,
  mid: 3,
  coding_flagship: 8,
  local: 0,
}

const HOSTED_MESSAGES = {
  notAuthenticated:
    "Sign in to use AI features. Edge Agent AI requires an authenticated session for hosted model access.",
  missingServerKey:
    "Hosted AI is temporarily unavailable. The server is missing a provider credential. Contact your workspace admin.",
  quotaExceeded:
    "You've used all the AI credits in your plan for this period. Upgrade your plan or wait until your credits reset.",
} as const

/** Provider → env var holding its server-side credential. The resolver
 *  reads keys ONLY from these and ONLY on the server. */
const PROVIDER_ENV: Record<ProviderKind, string> = {
  openai_compatible: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  // `custom` is the local/private path. No hosted key is needed; the
  // model runs against a self-hosted endpoint via baseUrl. Kept on the
  // record so providerKindFromSlot can still map a "custom:" prefix.
  custom: "EDGE_AGENT_CUSTOM_API_KEY",
}

/** Provider → default base URL. The hosted resolver does not let the
 *  caller override this; a real billing config can change these
 *  via env if needed (`EDGE_AGENT_HOSTED_OPENAI_BASE_URL` etc.). */
function hostedBaseUrlFor(provider: ProviderKind): string | null {
  switch (provider) {
    case "openai_compatible":
      return process.env.EDGE_AGENT_HOSTED_OPENAI_BASE_URL ?? null
    case "anthropic":
      return null // anthropic SDK / our client knows its own base
    case "google":
      return null
    case "custom":
      return process.env.EDGE_AGENT_HOSTED_CUSTOM_BASE_URL ?? null
  }
}

function providerKindFromSlot(slot: string | undefined): ProviderKind | null {
  switch (slot) {
    case "openai":
    case "openai_compatible":
      return "openai_compatible"
    case "anthropic":
      return "anthropic"
    case "google":
    case "gemini":
      return "google"
    case "custom":
      return "custom"
    default:
      return null
  }
}

function selectedManualValue(selection: ManualModelSelection | null | undefined, task: LlmTask): string | undefined {
  if (!selection) return undefined
  for (const key of TASK_ALIASES[task]) {
    const value = selection[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function parseManualSelection(value: string | undefined):
  | { kind: "none" }
  | { kind: "tier"; tier: ModelTier }
  | { kind: "model"; provider: ProviderKind | null; model: string } {
  if (!value) return { kind: "none" }
  if (TIER_VALUES.has(value as ModelTier)) return { kind: "tier", tier: value as ModelTier }

  const colon = value.indexOf(":")
  if (colon > 0) {
    const slot = value.slice(0, colon)
    const model = value.slice(colon + 1).trim()
    if (model) return { kind: "model", provider: providerKindFromSlot(slot), model }
  }
  return { kind: "model", provider: null, model: value }
}

function manualTierOverrides(selection: ManualModelSelection | null | undefined): ManualOverrides | undefined {
  if (!selection) return undefined
  const out: ManualOverrides = {}
  for (const task of Object.keys(TASK_ALIASES) as LlmTask[]) {
    const parsed = parseManualSelection(selectedManualValue(selection, task))
    if (parsed.kind === "tier") out[task] = parsed.tier
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Auth seam — see `lib/server-auth.ts` for the real implementation.
 *
 * This re-export is kept for backwards compatibility with the small
 * number of call sites that imported `assertSession` from the
 * resolver. New code should import directly from `./server-auth`.
 */
export { assertSession } from "./server-auth"

/**
 * Pure decision + plan-eligibility + quota enforcement. Does NOT call
 * a model. Returns the resolved (provider, model, server key, base URL)
 * the caller must then forward to the actual upstream client.
 *
 * SYNC variant — loads the subscription from the sync `getBillingStore()`
 * singleton (FileBillingStore in dev/desktop). Production routes use
 * `resolveAiProviderForRequestAsync` so they hit the online DB.
 */
export function resolveAiProviderForRequest(args: ResolveArgs): ResolveResult {
  // 1. Identity. Routes are supposed to call assertSession() and pass
  //    its userId/workspaceId in; we re-check here so the resolver
  //    cannot be misused by a caller that forgot to authenticate.
  if (!args.userId || !args.workspaceId) {
    logBlocked({
      userId: args.userId || "anonymous",
      workspaceId: args.workspaceId || "anonymous",
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      blockReason: "not_authenticated",
    })
    return {
      ok: false,
      code: "not_authenticated",
      reason: HOSTED_MESSAGES.notAuthenticated,
    }
  }

  const sub: Subscription = loadSubscription(args.userId, args.workspaceId)
  return resolveWithSub(args, sub)
}

/**
 * Async variant — `await`s the production billing store (Postgres)
 * and otherwise behaves identically. ALL hosted-AI route handlers use
 * this entry point so cloud deployments hit the online DB.
 */
export async function resolveAiProviderForRequestAsync(args: ResolveArgs): Promise<ResolveResult> {
  if (!args.userId || !args.workspaceId) {
    logBlocked({
      userId: args.userId || "anonymous",
      workspaceId: args.workspaceId || "anonymous",
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      blockReason: "not_authenticated",
    })
    return {
      ok: false,
      code: "not_authenticated",
      reason: HOSTED_MESSAGES.notAuthenticated,
    }
  }
  // Late-bound import so the bootstrap module isn't eagerly loaded by
  // test files that exercise the sync entry point.
  const { getAsyncBillingStore, ensureBootstrap, BillingMisconfiguredError } =
    await import("./server-billing-bootstrap")
  try {
    await ensureBootstrap()
    const subRecord = await getAsyncBillingStore().loadSubscription(
      args.userId,
      args.workspaceId,
    )
    const { PLAN_ENTITLEMENTS } = await import("./server-subscription")
    const ent = PLAN_ENTITLEMENTS[subRecord.planTier] ?? PLAN_ENTITLEMENTS.free
    const sub: Subscription = {
      userId: subRecord.userId,
      workspaceId: subRecord.workspaceId,
      tier: subRecord.planTier,
      allowedModes: [...ent.allowedModes],
      allowManualModelSelection: ent.allowManualModelSelection,
      creditsTotal: subRecord.creditsLimit,
      creditsUsed: subRecord.creditsUsed,
      subscriptionStatus: subRecord.subscriptionStatus,
      billingPeriodEnd: subRecord.billingPeriodEnd,
    }
    return resolveWithSub(args, sub)
  } catch (e) {
    if (e instanceof BillingMisconfiguredError) {
      logBlocked({
        userId: args.userId,
        workspaceId: args.workspaceId,
        task: args.task,
        intelligenceMode: args.intelligenceMode,
        blockReason: "billing_db_unconfigured",
      })
      return {
        ok: false,
        code: "billing_db_unconfigured",
        reason:
          "Hosted AI billing database is not configured on this server. Set DATABASE_URL or contact your administrator.",
      }
    }
    throw e
  }
}

function resolveWithSub(args: ResolveArgs, sub: Subscription): ResolveResult {
  // 1b. Email-verification gate. Unverified accounts (when enforcement is on)
  //     are limited to the free tier — paid modes are blocked, and credits are
  //     clamped to the free allowance. Verified / legacy sessions pass through.
  if (emailVerificationEnforced() && args.emailVerified === false) {
    if (!FREE_INTELLIGENCE_MODES.includes(args.intelligenceMode)) {
      logBlocked({
        userId: args.userId,
        workspaceId: args.workspaceId,
        task: args.task,
        intelligenceMode: args.intelligenceMode,
        blockReason: "email_unverified",
      })
      return {
        ok: false,
        code: "email_unverified",
        upgrade: false,
        reason: EMAIL_UNVERIFIED_MESSAGE,
      }
    }
    sub = {
      ...sub,
      tier: "free",
      allowedModes: [...FREE_INTELLIGENCE_MODES],
      allowManualModelSelection: false,
      creditsTotal: Math.min(sub.creditsTotal, FREE_CREDIT_ALLOWANCE),
    }
  }

  // 2. Plan gate.
  if (!modeAllowed(sub, args.intelligenceMode)) {
    logBlocked({
      userId: args.userId,
      workspaceId: args.workspaceId,
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      blockReason: `mode_not_in_plan:${sub.tier}`,
    })
    return {
      ok: false,
      code: "mode_not_in_plan",
      upgrade: true,
      reason: `Your ${sub.tier} plan does not include ${args.intelligenceMode.toUpperCase()} mode. Upgrade to use it.`,
    }
  }
  if (args.intelligenceMode === "manual" && !sub.allowManualModelSelection) {
    logBlocked({
      userId: args.userId,
      workspaceId: args.workspaceId,
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      blockReason: `manual_not_in_plan:${sub.tier}`,
    })
    return {
      ok: false,
      code: "manual_not_in_plan",
      upgrade: true,
      reason: `Manual model selection is not available on the ${sub.tier} plan. Upgrade to choose models per task.`,
    }
  }

  // 3. Task gate (Save refuses patches; secrets refused upstream).
  const policy = MODE_POLICIES[args.intelligenceMode]
  if ((args.task === "patch" || args.task === "bulk") && !policy.allowPatchGeneration) {
    logBlocked({
      userId: args.userId,
      workspaceId: args.workspaceId,
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      blockReason: "task_not_allowed_in_mode",
    })
    return {
      ok: false,
      code: "task_not_allowed_in_mode",
      reason: `${args.intelligenceMode.toUpperCase()} mode does not generate patches; it provides deterministic suggestions only.`,
    }
  }

  // 4. Route the model.
  const manual = args.intelligenceMode === "manual"
    ? parseManualSelection(selectedManualValue(args.manualModelSelection, args.task))
    : { kind: "none" as const }

  const provider: ProviderKind =
    manual.kind === "model" && manual.provider
      ? manual.provider
      : "openai_compatible"

  const decision = routeForMode({
    mode: args.intelligenceMode,
    task: args.task,
    complexity: typeof args.complexity === "number" ? args.complexity : 0,
    provider,
    manual: manualTierOverrides(args.manualModelSelection),
  })
  const selectedModel = manual.kind === "model" ? manual.model : decision.model

  // 5. Quota gate.
  const tierCost = CREDITS_PER_TIER[decision.tier] ?? 1
  const estimatedCredits = tierCost + (decision.twoStep ? 1 : 0)
  const quota = checkQuota(sub, estimatedCredits)
  if (!quota.ok) {
    logBlocked({
      userId: args.userId,
      workspaceId: args.workspaceId,
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      provider,
      model: selectedModel,
      blockReason: `quota_exceeded:needs=${estimatedCredits} remaining=${quota.remaining}`,
    })
    return {
      ok: false,
      code: "quota_exceeded",
      upgrade: true,
      reason: HOSTED_MESSAGES.quotaExceeded,
      remaining: quota.remaining,
      needed: estimatedCredits,
    }
  }

  // 6. Hosted key.
  const envName = PROVIDER_ENV[provider]
  const apiKey = (process.env[envName] ?? "").trim()
  if (!apiKey && provider !== "custom") {
    logBlocked({
      userId: args.userId,
      workspaceId: args.workspaceId,
      task: args.task,
      intelligenceMode: args.intelligenceMode,
      provider,
      model: selectedModel,
      blockReason: "missing_hosted_key",
    })
    return {
      ok: false,
      code: "missing_hosted_key",
      reason: HOSTED_MESSAGES.missingServerKey,
    }
  }

  // 7. Cost echo for the UI.
  const price = priceFor(selectedModel, provider)
  const inTok = args.estimatedInputTokens ?? BUNDLE_INPUT_TOKEN_CAP[decision.bundleMode]
  const outTok = args.estimatedOutputTokens ?? decision.maxTokens
  const estimatedCostUsd = (inTok / 1000) * price.inputPer1k + (outTok / 1000) * price.outputPer1k

  // 8. Open an audit record for the in-flight attempt. Routes call
  //    `recordConsumption({ requestId, status, ... })` after the
  //    upstream call to close it out.
  const requestId = beginAudit({
    userId: args.userId,
    workspaceId: args.workspaceId,
    task: args.task,
    intelligenceMode: args.intelligenceMode,
    provider,
    model: selectedModel,
    estimatedCredits,
  })

  return {
    ok: true,
    provider,
    model: selectedModel,
    apiKeySource: "hosted",
    apiKey,
    baseUrl: hostedBaseUrlFor(provider),
    bundleMode: decision.bundleMode,
    twoStep: decision.twoStep,
    estimatedCredits,
    quotaStatus: {
      remaining: Math.max(0, quota.remaining - estimatedCredits),
      total: sub.creditsTotal,
    },
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(5)),
    requestId,
  }
}

/**
 * Debit the credit ledger after a successful upstream model call AND
 * close out the audit-log row the resolver opened via `beginAudit`.
 *
 * Failed/blocked calls also call this with `status: "failed"` or
 * `status: "blocked"` and `credits: 0` so the audit row gets closed
 * and the ledger stays untouched.
 */
/** Args for both the sync and async credit-debit + audit-close paths. */
export interface RecordConsumptionArgs {
  userId: string
  workspaceId: string
  apiKeySource: "hosted"
  estimatedCredits: number
  requestId?: string
  status?: "success" | "failed" | "blocked"
  task?: string
  intelligenceMode?: string
  model?: string
  provider?: string
  contextHash?: string
  inputTokens?: number
  outputTokens?: number
  errorClass?: string
  blockReason?: string
}

function closeAudit(args: RecordConsumptionArgs, debited: number, status: RecordConsumptionArgs["status"] = "success"): void {
  if (!args.requestId) return
  completeAudit(args.requestId, status ?? "success", {
    actualCredits: debited,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    errorClass: args.errorClass,
    blockReason: args.blockReason ? redactSecrets(args.blockReason) : undefined,
  })
}

/**
 * Sync credit debit (file-backed dev path only).
 * Production deployments using Postgres MUST call
 * `recordConsumptionAsync` from within their async route handler.
 */
export function recordConsumption(args: RecordConsumptionArgs): number {
  if (!args.userId || !args.workspaceId) return 0
  const status = args.status ?? "success"
  const credits =
    status === "success" ? Math.max(0, Math.floor(args.estimatedCredits)) : 0

  let debited = 0
  if (credits > 0) {
    consumeCreditsAtomic({
      userId: args.userId,
      workspaceId: args.workspaceId,
      credits,
      usage: {
        task: args.task ?? "unknown",
        intelligenceMode: args.intelligenceMode ?? "unknown",
        model: args.model ?? "unknown",
        provider: args.provider ?? "unknown",
        estimatedCredits: args.estimatedCredits,
        requestId: args.requestId ?? "no-request-id",
        contextHash: args.contextHash,
      },
    })
    debited = credits
  }
  closeAudit(args, debited, status)
  return debited
}

/**
 * Async credit debit. Routes that need to work against the production
 * Postgres backend use this — it delegates to the AsyncBillingStore
 * and is safe to call from inside an async Next handler. Behavior is
 * identical to `recordConsumption`; only the persistence backend
 * differs.
 */
export async function recordConsumptionAsync(args: RecordConsumptionArgs): Promise<number> {
  if (!args.userId || !args.workspaceId) return 0
  const status = args.status ?? "success"
  const credits =
    status === "success" ? Math.max(0, Math.floor(args.estimatedCredits)) : 0

  let debited = 0
  if (credits > 0) {
    const { getAsyncBillingStore, ensureBootstrap } = await import(
      "./server-billing-bootstrap"
    )
    await ensureBootstrap()
    await getAsyncBillingStore().consume({
      userId: args.userId,
      workspaceId: args.workspaceId,
      credits,
      usage: {
        userId: args.userId,
        workspaceId: args.workspaceId,
        task: args.task ?? "unknown",
        intelligenceMode: args.intelligenceMode ?? "unknown",
        model: args.model ?? "unknown",
        provider: args.provider ?? "unknown",
        estimatedCredits: args.estimatedCredits,
        actualCredits: credits,
        requestId: args.requestId ?? "no-request-id",
        contextHash: args.contextHash,
      },
    })
    debited = credits
  }
  closeAudit(args, debited, status)
  return debited
}

/**
 * Classify an upstream provider error so routes can show a clean
 * message. We deliberately don't echo the upstream body verbatim —
 * some compat servers reflect the request (with the Authorization
 * header) back in their error.
 */
export function classifyUpstreamFailure(status: number, message?: string):
  | { code: "upstream_unavailable"; reason: string }
  | { code: "model_unavailable"; reason: string }
  | { code: "other"; reason: string } {
  const text = (message ?? "").toLowerCase()
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|unauthorized/.test(text)) {
    // A 401/403 on the hosted contract is an operator/billing issue,
    // not a user problem. The UI should surface "Hosted AI is
    // temporarily unavailable" rather than asking the user to "check
    // your key" — there is no user key to check.
    return { code: "upstream_unavailable", reason: HOSTED_MESSAGES.missingServerKey }
  }
  if (status === 404 || /model.*not.*found|no such model|model_not_found/.test(text)) {
    return { code: "model_unavailable", reason: "Hosted AI model is unavailable right now. Try a different mode or retry shortly." }
  }
  return { code: "other", reason: message ?? "Upstream model call failed." }
}

/** Strip the server-side `apiKey` (and the redundant `baseUrl`) from
 *  a successful resolve result before it goes into an API response.
 *  Hosted contract: API responses NEVER include these. */
export function redactForClient(
  r: ResolveOk,
): Omit<ResolveOk, "apiKey" | "baseUrl"> & { apiKey: null; baseUrl: null } {
  return { ...r, apiKey: null, baseUrl: null }
}

// Canonical user-facing strings. Routes use these so the UI shows a
// consistent voice across explain/patch/fix surfaces.
export const HOSTED_USER_MESSAGES = HOSTED_MESSAGES
