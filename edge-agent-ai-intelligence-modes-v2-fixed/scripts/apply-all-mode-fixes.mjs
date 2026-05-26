#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = process.cwd()

function repoPath(rel) {
  return path.join(repoRoot, rel)
}
function bundlePath(rel) {
  return path.join(bundleDir, rel)
}
function read(rel) {
  return fs.readFileSync(repoPath(rel), "utf8")
}
function write(rel, text) {
  fs.mkdirSync(path.dirname(repoPath(rel)), { recursive: true })
  fs.writeFileSync(repoPath(rel), text, "utf8")
  console.log(`updated ${rel}`)
}
function copy(relFromBundle, relToRepo) {
  const src = bundlePath(relFromBundle)
  const dst = repoPath(relToRepo)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log(`copied ${relToRepo}`)
}
function ensureContains(rel, needle, description) {
  const text = read(rel)
  if (!text.includes(needle)) {
    throw new Error(`${rel}: expected to find ${description}`)
  }
}
function replaceOnce(text, from, to, rel, label) {
  if (text.includes(to)) return text
  if (!text.includes(from)) throw new Error(`${rel}: cannot find block for ${label}`)
  return text.replace(from, to)
}
function insertAfterOnce(text, anchor, addition, marker, rel) {
  if (text.includes(marker)) return text
  if (!text.includes(anchor)) throw new Error(`${rel}: cannot find anchor for ${marker}`)
  return text.replace(anchor, `${anchor}${addition}`)
}
function insertBeforeOnce(text, anchor, addition, marker, rel) {
  if (text.includes(marker)) return text
  if (!text.includes(anchor)) throw new Error(`${rel}: cannot find anchor for ${marker}`)
  return text.replace(anchor, `${addition}${anchor}`)
}

// 1) Replace/copy files where the safest correction is a full file.
copy("new-files/lib/server-ai-provider-resolver.ts", "lib/server-ai-provider-resolver.ts")
copy("new-files/components/model-selector.tsx", "components/model-selector.tsx")
copy("new-files/tests/all-modes-e2e-wiring.test.ts", "tests/all-modes-e2e-wiring.test.ts")

// 2) Make the fix client carry mode/provider/manual model selection.
{
  const rel = "lib/finding-fixes-client.ts"
  let t = read(rel)
  t = replaceOnce(
    t,
`export async function runFindingFixesApi(args: {
  projectPath: string
  mode: FixMode
  targets: FixTarget[]
  signal?: AbortSignal
}): Promise<RunFixesResult> {`,
`export async function runFindingFixesApi(args: {
  projectPath: string
  mode: FixMode
  targets: FixTarget[]
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  aiProviderMode?: "hosted" | "byok"
  manualModelSelection?: Record<string, string>
  signal?: AbortSignal
}): Promise<RunFixesResult> {`,
    rel,
    "runFindingFixesApi args",
  )
  t = replaceOnce(
    t,
`      targets: args.targets,
    }),`,
`      targets: args.targets,
      intelligenceMode: args.intelligenceMode,
      aiProviderMode: args.aiProviderMode,
      manualModelSelection: args.manualModelSelection,
      // Backward-compat for the Step 1 patch name. Server normalizes both.
      manualModels: args.manualModelSelection,
    }),`,
    rel,
    "runFindingFixesApi body",
  )
  write(rel, t)
}

// 3) Thread mode/provider/manual selection through the Fix button + dialog.
{
  const rel = "components/finding-fix-button.tsx"
  let t = read(rel)
  t = insertAfterOnce(
    t,
`  disabled?: boolean
  className?: string
`,
`  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  aiProviderMode?: "hosted" | "byok"
  manualModelSelection?: Record<string, string>
`,
    "manualModelSelection?: Record<string, string>",
    rel,
  )
  t = insertAfterOnce(
    t,
`  disabled = false,
  className,
`,
`  intelligenceMode,
  aiProviderMode,
  manualModelSelection,
`,
    "manualModelSelection,\n  onApplied",
    rel,
  )
  t = insertBeforeOnce(
    t,
`        onApplied={onApplied}
`,
`        intelligenceMode={intelligenceMode}
        aiProviderMode={aiProviderMode}
        manualModelSelection={manualModelSelection}
`,
    "aiProviderMode={aiProviderMode}",
    rel,
  )
  write(rel, t)
}

{
  const rel = "components/finding-fix-dialog.tsx"
  let t = read(rel)
  t = insertAfterOnce(
    t,
`  title: string
`,
`  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  aiProviderMode?: "hosted" | "byok"
  manualModelSelection?: Record<string, string>
`,
    "manualModelSelection?: Record<string, string>",
    rel,
  )
  t = insertAfterOnce(
    t,
`  title,
`,
`  intelligenceMode,
  aiProviderMode,
  manualModelSelection,
`,
    "manualModelSelection,\n  onApplied",
    rel,
  )
  t = insertAfterOnce(
    t,
`          targets,
`,
`          intelligenceMode,
          aiProviderMode,
          manualModelSelection,
`,
    "aiProviderMode,\n          manualModelSelection",
    rel,
  )
  t = replaceOnce(
    t,
`    [projectPath, targets, onApplied]
`,
`    [projectPath, targets, onApplied, intelligenceMode, aiProviderMode, manualModelSelection]
`,
    rel,
    "dialog deps",
  )
  write(rel, t)
}

// 4) Surface Provider mode + Manual model picker in Findings and pass the values to every fix path.
{
  const rel = "components/views/findings.tsx"
  let t = read(rel)
  t = insertAfterOnce(
    t,
`} from "@/components/intelligence-mode-toggle"
`,
`import { AiProviderToggle, type AiProviderMode } from "@/components/ai-provider-toggle"
import { ModelSelector, type ManualModelMap } from "@/components/model-selector"
import { usePlanSummary, modeAllowedByPlan } from "@/lib/plan-client"
import type { LlmSlot } from "@/lib/model-keys"
`,
    "@/components/ai-provider-toggle",
    rel,
  )
  t = insertAfterOnce(
    t,
`  const [intelligenceMode, setIntelligenceMode] =
    useState<IntelligenceMode>("auto")
`,
`
  // v2 all-mode wiring: Hosted/BYOK and Manual per-task model selection.
  const [aiProviderMode, setAiProviderMode] = useState<AiProviderMode>("hosted")
  const [manualModelSelection, setManualModelSelection] = useState<ManualModelMap>({})
  const { plan } = usePlanSummary()
  const availableManualSlots = useMemo<LlmSlot[]>(
    () =>
      aiProviderMode === "hosted"
        ? ["openai", "anthropic", "google"]
        : ["openai", "anthropic", "google", "custom"],
    [aiProviderMode],
  )

  useEffect(() => {
    if (!modeAllowedByPlan(plan, intelligenceMode)) {
      setIntelligenceMode("auto")
    }
  }, [plan, intelligenceMode])
`,
    "v2 all-mode wiring",
    rel,
  )
  t = replaceOnce(
    t,
`            <IntelligenceModeToggle
              value={intelligenceMode}
              onChange={setIntelligenceMode}
            />
          </div>
          <div className="flex items-center gap-4">`,
`            <IntelligenceModeToggle
              value={intelligenceMode}
              onChange={setIntelligenceMode}
            />
          </div>

          <AiProviderToggle
            value={aiProviderMode}
            onChange={setAiProviderMode}
            plan={plan ? {
              tier: plan.tier,
              creditsRemaining: plan.creditsRemaining,
              creditsTotal: plan.creditsTotal,
            } : null}
            className="max-w-3xl"
          />

          {intelligenceMode === "manual" ? (
            <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
              <ModelSelector
                availableSlots={availableManualSlots}
                value={manualModelSelection}
                onChange={setManualModelSelection}
              />
              {plan && !plan.allowManualModelSelection ? (
                <p className="mt-2 text-xs text-yellow-500">
                  Your current plan can enter Manual mode, but per-task model selection is blocked server-side unless the plan allows it.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center gap-4">`,
    rel,
    "Findings toolbar mode/provider/manual UI",
  )
  t = insertBeforeOnce(
    t,
`              onApplied={handleApplied}
`,
`              intelligenceMode={intelligenceMode}
              aiProviderMode={aiProviderMode}
              manualModelSelection={intelligenceMode === "manual" ? manualModelSelection : undefined}
`,
    "manualModelSelection={intelligenceMode === \"manual\" ? manualModelSelection : undefined}",
    rel,
  )
  t = insertBeforeOnce(
    t,
`        onFixApplied={handleApplied}
`,
`        intelligenceMode={intelligenceMode}
        aiProviderMode={aiProviderMode}
        manualModelSelection={intelligenceMode === "manual" ? manualModelSelection : undefined}
`,
    "onFixApplied={handleApplied}\n        intelligenceMode={intelligenceMode}",
    rel,
  )
  write(rel, t)
}

// 5) The patch pipeline must honour the resolver-selected model. Without this,
// Manual mode resolves a model but the pipeline silently re-routes by tier.
{
  const rel = "lib/server-patch-pipeline.ts"
  let t = read(rel)
  t = insertAfterOnce(
    t,
`  forceTask?: FixTask
`,
`  /** v2: final concrete model picked by Hosted/BYOK/manual resolver. */
  forceModel?: string
  forceMaxTokens?: number
  forceTwoStep?: boolean
`,
    "forceModel?: string",
    rel,
  )
  // Insert after either routeModel or routeForMode decision block.
  const marker = "// v2: honour resolver-selected model"
  if (!t.includes(marker)) {
    const re = /(  const decision = (?:routeModel|routeForMode)\(\{[\s\S]*?\n  \}\)\n)/
    const m = t.match(re)
    if (!m) throw new Error(`${rel}: cannot find model decision block`)
    t = t.replace(re, `$1\n  ${marker}\n  if (ctx.forceModel) decision.model = ctx.forceModel\n  if (typeof ctx.forceMaxTokens === "number") decision.maxTokens = ctx.forceMaxTokens\n  if (typeof ctx.forceTwoStep === "boolean") decision.twoStep = ctx.forceTwoStep\n`)
  }
  // Include forced model in cache context if hashContext has the mode additions.
  if (t.includes("forceTier: ctx.forceTier") && !t.includes("forceModel: ctx.forceModel")) {
    t = t.replace("forceTier: ctx.forceTier,", "forceTier: ctx.forceTier,\n        forceModel: ctx.forceModel,")
  }
  write(rel, t)
}

// 6) Single-finding patch route: pass mode/manual/provider resolution into the pipeline and record hosted credits.
{
  const rel = "app/api/finding/patch/route.ts"
  let t = read(rel)
  if (t.includes("resolveAiProviderForRequest") && !t.includes("recordConsumption")) {
    t = t.replace(
      `import { resolveAiProviderForRequest } from "@/lib/server-ai-provider-resolver"`,
      `import { resolveAiProviderForRequest, recordConsumption } from "@/lib/server-ai-provider-resolver"`,
    )
  }
  if (!t.includes("manualModelSelection?: Record<string, string>")) {
    t = t.replace(
      `  privateCodeMode?: boolean\n`,
      `  privateCodeMode?: boolean\n  aiProviderMode?: "hosted" | "byok"\n  manualModelSelection?: Record<string, string>\n`,
    )
  }
  if (t.includes("const resolution = resolveAiProviderForRequest") && !t.includes("forceModel: resolution.model")) {
    t = t.replace(
      `    privateCodeMode: !!body.privateCodeMode,\n  })`,
      `    privateCodeMode: !!body.privateCodeMode,\n    intelligenceMode,\n    complexity,\n    manualModels: body.manualModelSelection,\n    forceModel: resolution.model,\n    forceTwoStep: resolution.twoStep,\n  })`,
    )
  }
  if (t.includes("recordConsumption") && !t.includes("recordConsumption({ userId: \"local-user\"")) {
    t = t.replace(
`  if ("refused" in preview && preview.refused) {
    return NextResponse.json({ status: "refused", intelligenceMode, ...preview }, { status: 200 })
  }
`,
`  if ("refused" in preview && preview.refused) {
    return NextResponse.json({ status: "refused", intelligenceMode, ...preview }, { status: 200 })
  }
  recordConsumption({
    userId: "local-user",
    workspaceId: "local-workspace",
    apiKeySource: resolution.apiKeySource,
    actualCostUsd: resolution.estimatedCostUsd,
  })
`)
  }
  write(rel, t)
}

// 7) Bulk deterministic/AI-fallback route: accept the new client fields. If the Step 1
// LLM upgrade patch is present, also pass resolver-selected model into the pipeline.
{
  const rel = "app/api/findings/fix/route.ts"
  let t = read(rel)
  if (t.includes("generatePatchPreview") && !t.includes("resolveAiProviderForRequest")) {
    t = t.replace(
      `import type { FixProposal } from "@/lib/finding-fixes-client"`,
      `import type { FixProposal } from "@/lib/finding-fixes-client"\nimport { resolveAiProviderForRequest, recordConsumption } from "@/lib/server-ai-provider-resolver"`,
    )
  }
  if (!t.includes("aiProviderMode?: \"hosted\" | \"byok\"")) {
    t = t.replace(
      `    manualModels?: Record<string, string>\n`,
      `    manualModels?: Record<string, string>\n    aiProviderMode?: "hosted" | "byok"\n    manualModelSelection?: Record<string, string>\n`,
    )
  }
  if (t.includes("const provider = (body.provider ?? \"openai_compatible\") as ProviderKind") && t.includes("generatePatchPreview") && !t.includes("const aiProviderMode = body.aiProviderMode ?? \"hosted\"")) {
    t = t.replace(
`    const provider = (body.provider ?? "openai_compatible") as ProviderKind
    const apiKey = body.apiKey ?? process.env.OPENAI_API_KEY ?? null

    if (policy.allowPatchGeneration && body.mode === "suggest" && apiKey) {`,
`    const aiProviderMode = body.aiProviderMode ?? "hosted"

    if (policy.allowPatchGeneration && body.mode === "suggest") {`)
    t = t.replace(
`        const preview = await generatePatchPreview({`,
`        const resolution = resolveAiProviderForRequest({
          userId: "local-user",
          workspaceId: "local-workspace",
          aiProviderMode,
          intelligenceMode: mode,
          task: "patch",
          complexity,
          manualModelSelection: body.manualModelSelection ?? body.manualModels,
          byokApiKey: aiProviderMode === "byok" ? body.apiKey ?? null : null,
          byokBaseUrl: aiProviderMode === "byok" ? body.baseUrl ?? null : null,
          byokProvider: body.provider,
        })
        if (!resolution.ok) continue

        const preview = await generatePatchPreview({`)
    t = t.replace(
`          provider,
          apiKey,
          baseUrl: body.baseUrl ?? null,
          privateCodeMode: !!body.privateCodeMode,
          intelligenceMode: mode,
          complexity,
          manualModels: body.manualModels,
        })`,
`          provider: resolution.provider,
          apiKey: resolution.apiKey,
          baseUrl: resolution.baseUrl ?? null,
          privateCodeMode: !!body.privateCodeMode,
          intelligenceMode: mode,
          complexity,
          manualModels: body.manualModelSelection ?? body.manualModels,
          forceModel: resolution.model,
          forceTwoStep: resolution.twoStep,
        })`)
    t = t.replace(
`        if ("refused" in preview && preview.refused) continue
        const pv = preview as PatchPreview`,
`        if ("refused" in preview && preview.refused) continue
        recordConsumption({
          userId: "local-user",
          workspaceId: "local-workspace",
          apiKeySource: resolution.apiKeySource,
          actualCostUsd: resolution.estimatedCostUsd,
        })
        const pv = preview as PatchPreview`)
  }
  write(rel, t)
}

console.log("\nAll-mode v2 fixes applied. Run: npx tsc --noEmit && node --import tsx/esm --test tests/all-modes-e2e-wiring.test.ts")
