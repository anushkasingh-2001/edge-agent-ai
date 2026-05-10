import { z } from "zod"

/** rule_id values produced by edge_agent_scanner (aligns with Scan Center checks that have a backend). */
export const SCANNER_RULE_IDS = [
  "dangerous-tools",
  "human-approval",
  "prompt-injection",
  "vague-prompts",
  "secrets",
  "mcp-security",
  "openapi-schema",
  "dependency-risks",
  "user-input-dangerous-code",
] as const

export type ScannerRuleId = (typeof SCANNER_RULE_IDS)[number]

const ScannerFindingSchema = z.object({
  id: z.string(),
  rule_id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string(),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  agent: z.string(),
  reason: z.string(),
  suggestedFix: z.string(),
  evidence: z.string(),
  code: z.string(),
  confidence: z.number(),
})

const ToolHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.enum(["decorator", "class", "filename", "directory"]),
  framework: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
})

const AgentHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.enum([
    "agent_class",
    "compiled_graph",
    "agent_executor",
    "agent_factory",
    "agent_file",
  ]),
  framework: z.string().nullable().optional(),
})

/**
 * Snapshot of `git status --porcelain` at scan time. Stamped on every
 * report by /api/scan when the scan target is a git repo. Lets the UI
 * disambiguate "this is what main looks like" from "this is what main
 * looks like *plus* the uncommitted changes you forgot to clean up
 * after switching branches" — the failure mode that drove this field
 * being added in the first place.
 *
 * `clean === true` means working tree matches HEAD: zero modified,
 * zero untracked, zero staged-but-uncommitted. Anything else and the
 * scan results don't represent a pure committed state, and the
 * Policy card / Recent Scans rows surface a warning so the user
 * knows.
 *
 * `branch` is recorded too because users frequently misremember which
 * branch they were on; pairing the badge with the actual branch makes
 * "Scan 17 on main · 26 issues · +3 untracked" unambiguous.
 */
const WorkingTreeStatusSchema = z.object({
  clean: z.boolean(),
  branch: z.string().nullable().optional(),
  /** Files in the working tree that aren't tracked at all (`??`). */
  untracked: z.number(),
  /** Tracked files with any kind of pending change — modified, added,
   *  deleted, renamed, etc. (anything that isn't `??`). */
  modified: z.number(),
  /** untracked + modified, pre-computed for convenience. */
  total: z.number(),
  /** True when the scanner walked the tree with ALL untracked files
   *  removed from its file list (the `includeUntracked: false` opt-out
   *  used by the pre-commit gate). The default in-place scan now
   *  always includes every untracked file, so this is false/undefined
   *  in normal usage. */
  untracked_excluded_from_scan: z.boolean().optional(),
  /** Total number of untracked files explicitly excluded by the
   *  blanket opt-out. Always 0 in normal scans. */
  untracked_excluded_count: z.number().optional(),
  /** Informational: how many of the SCANNED untracked files were
   *  attributed to a non-current branch. The scanner still processed
   *  them; this just lets the UI show "of N untracked, M originally
   *  came from branch X". */
  untracked_attributed_other_branch_count: z.number().optional(),
  /** Up to ~10 (path, branch) pairs for the cross-branch attributed
   *  files so the UI can name names ("from low, low, slot42")
   *  without bloating the report payload. */
  untracked_attributed_other_branches: z
    .array(z.object({ path: z.string(), branch: z.string() }))
    .optional(),
  /** True when the scan was run against a temporary `git worktree`
   *  checkout rather than the user's actual working tree — set when
   *  the caller asked to scan a different branch than the one
   *  currently checked out. In this case the working-tree counts are
   *  always zero and the dirty-tree warning shouldn't fire because
   *  the checkout is pristine by construction. */
  virtual_checkout: z.boolean().optional(),
  /** Short SHA of the commit that was checked out when
   *  `virtual_checkout === true`. Lets the UI show "branch HEAD only"
   *  alongside the actual ref. */
  virtual_checkout_sha: z.string().optional(),
  /** True when this scan was a stash-only scan: the route applied a
   *  `git stash` entry on top of HEAD in a temp worktree, isolated
   *  the files the stash actually touched, and scanned just those
   *  files. Findings come exclusively from the stashed WIP — the
   *  committed code is NOT part of this scan. */
  stash_scan: z.boolean().optional(),
  /** True when this was a normal in-place scan that ALSO automatically
   *  pulled in EVERY `git stash` entry attributed to the current
   *  branch as a second scanner pass and merged the findings. The
   *  stash extracts are unioned (latest wins on per-file conflicts)
   *  so the scanner sees one canonical version of each touched file.
   *  Differs from `stash_scan` in that the working tree was scanned
   *  too — `stash_included` is additive, `stash_scan` is exclusive.
   *  The single-stash fields below describe the LATEST stash for
   *  backward compat; `stashes_included` carries the full list. */
  stash_included: z.boolean().optional(),
  /** Latest stash ref folded into this scan (`stash@{0}` for the
   *  current branch). Older stashes for the same branch live in
   *  `stashes_included`. */
  stash_ref: z.string().optional(),
  /** Concrete commit SHA of the latest stash entry, for unambiguous
   *  logging. */
  stash_sha: z.string().optional(),
  /** Latest stash's subject ("WIP on main: a1d57d6 fix bug").
   *  Surfaced in the Recent Scans row so the user can tell stashes
   *  apart at a glance. */
  stash_message: z.string().optional(),
  /** First ~50 UNIQUE paths the merged stash union touched (across
   *  all included stashes; latest version of each file wins). Lets
   *  the UI list them in a tooltip without inflating the payload. */
  stash_files: z.array(z.string()).optional(),
  /** Total number of UNIQUE files across all included stashes
   *  (`stash_files` may be truncated; this is the unbounded count). */
  stash_file_count: z.number().optional(),
  /** Per-stash breakdown for every stash on the current branch that
   *  got folded into this scan. Newest-first to match `git stash list`.
   *  `file_count` is the count of files THIS stash touched (not the
   *  union — that's `stash_file_count`). */
  stashes_included: z
    .array(
      z.object({
        ref: z.string(),
        sha: z.string(),
        message: z.string(),
        file_count: z.number(),
      })
    )
    .optional(),
  /** Total number of stashes folded in. Equals
   *  `stashes_included.length` and lets the UI badge "+ 3 stashes ·
   *  12 files" without computing the array. */
  stashes_included_count: z.number().optional(),
})

export type WorkingTreeStatus = z.infer<typeof WorkingTreeStatusSchema>

export const ScanReportSchema = z.object({
  schema_version: z.string(),
  scan_root: z.string(),
  generated_at: z.string(),
  frameworks_detected: z.array(
    z.object({
      name: z.string(),
      evidence: z.array(z.string()),
    })
  ),
  // Older reports (pre-agents/tools_detected) won't have these fields;
  // default to [] so re-loading historical scans doesn't blow up the parse.
  agents_detected: z.array(AgentHitSchema).default([]),
  tools_detected: z.array(ToolHitSchema).default([]),
  summary: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    total: z.number(),
  }),
  risk_score: z.number(),
  findings: z.array(ScannerFindingSchema),
  /** Total text files the walker actually fed into the rules. The
   * scanner is regex/keyword based, so a file is INSPECTED whenever
   * its extension is in the allow list — but a file full of arbitrary
   * text contributes 0 findings. Surfacing this number stops users
   * (rightly) thinking "0 issues for my new file = scanner skipped
   * it"; the answer is "scanner saw it; no patterns matched". */
  files_scanned: z.number().int().min(0).optional(),
  /** Per-extension breakdown of `files_scanned`, e.g.
   * `{".py": 41, ".md": 8, ".txt": 3}`. Lets the UI explain things
   * like "you added a .pdf but the walker only looks at .py/.txt/etc.
   * — your file was skipped, that's why it shows no findings." */
  files_scanned_by_ext: z.record(z.string(), z.number().int().min(0)).optional(),
  // Optional — only present when the scan target is a git repo and
  // /api/scan succeeded in stamping it. Pre-existing reports stored
  // in localStorage from before this field landed will simply not
  // have it (the UI treats absent === unknown, not === clean).
  working_tree: WorkingTreeStatusSchema.optional(),
})

export type ScanReport = z.infer<typeof ScanReportSchema>
export type ScannerFinding = z.infer<typeof ScannerFindingSchema>
export type ToolHit = z.infer<typeof ToolHitSchema>
export type AgentHit = z.infer<typeof AgentHitSchema>

export function parseScanReport(data: unknown): ScanReport {
  return ScanReportSchema.parse(data)
}

/** UI Finding shape used by Findings view / drawer (numeric id for table keys). */
export type UiFinding = {
  id: number
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
  agent: string
  reason: string
  suggestedFix: string
  evidence: string
  code: string
  ruleId?: string
  scannerFindingId?: string
}

export function mapReportToUiFindings(report: ScanReport): UiFinding[] {
  return report.findings.map((f, i) => ({
    id: i + 1,
    severity: f.severity,
    category: f.category,
    title: f.title,
    file: f.file,
    line: f.line,
    agent: f.agent,
    reason: f.reason,
    suggestedFix: f.suggestedFix,
    evidence: f.evidence,
    code: f.code,
    ruleId: f.rule_id,
    scannerFindingId: f.id,
  }))
}

export function filterChecksForScanner(selectedCheckIds: string[]): string[] {
  const set = new Set<string>(SCANNER_RULE_IDS)
  return selectedCheckIds.filter((id) => set.has(id as ScannerRuleId))
}

/** When every scanner-backed check is selected, run a full scan (omit --check). Otherwise pass the subset. */
export function resolveChecksForApi(selectedCheckIds: string[]): string[] | undefined {
  if (selectedCheckIds.length === 0) return undefined
  const everyScanner = SCANNER_RULE_IDS.every((id) => selectedCheckIds.includes(id))
  if (everyScanner) return undefined
  const scannerHits = filterChecksForScanner(selectedCheckIds)
  if (scannerHits.length === 0) return undefined
  return scannerHits
}

export type TopBarAgentOption = {
  id: string
  name: string
  framework: string | null
  tools: number
  prompts: number
  risk: number
}

export const ALL_AGENTS_OPTION: TopBarAgentOption = {
  id: "all",
  name: "All Agents",
  framework: null,
  tools: 0,
  prompts: 0,
  risk: 0,
}

export function buildTopBarAgentsFromReport(
  report: ScanReport | null,
  riskScore: number
): TopBarAgentOption[] {
  if (!report?.agents_detected?.length) {
    return [ALL_AGENTS_OPTION]
  }
  // Pre-compute per-agent tool counts from tools_detected so the picker can
  // show "<agent> N tools" without recomputing in render.
  const toolsByAgent = new Map<string, number>()
  for (const t of report.tools_detected ?? []) {
    if (!t.agent) continue
    toolsByAgent.set(t.agent, (toolsByAgent.get(t.agent) ?? 0) + 1)
  }
  const fromAgents = report.agents_detected.map((a, i) => ({
    id: `agent-${i}-${a.name.replace(/\s+/g, "-").toLowerCase()}`,
    name: a.name,
    framework: a.framework ?? null,
    tools: toolsByAgent.get(a.name) ?? 0,
    prompts: 0,
    risk: Math.min(100, Math.max(0, riskScore + i * 2)),
  }))
  return [ALL_AGENTS_OPTION, ...fromAgents]
}

export type OverviewAgentCard = {
  name: string
  framework: string
  tools: number
  prompts: number
  risk: number
  status: string
}

export function topFindingsFromReport(
  report: ScanReport | null
): { title: string; severity: "critical" | "high" | "medium" | "low"; file: string; line: number }[] {
  if (!report?.findings.length) return []
  const w: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return [...report.findings]
    .sort((a, b) => w[a.severity] - w[b.severity] || a.title.localeCompare(b.title))
    .slice(0, 6)
    .map((f) => ({
      title: f.title,
      severity: f.severity,
      file: f.file,
      line: f.line,
    }))
}

export function buildOverviewAgentsFromReport(
  report: ScanReport | null,
  riskScore: number
): OverviewAgentCard[] {
  if (!report?.agents_detected?.length) return []

  // Dedupe by name. The scanner can emit the same logical agent more
  // than once when, for example, a `build_agent()` factory and a class
  // of the same name both appear in the source — they're two AgentHits
  // with identical `name` but different file:line coordinates. We
  // collapse those into one card per unique name, prefer the entry
  // with a known framework (more useful to the user), and keep the
  // first source location seen so View Details still has somewhere to
  // point at. Without this dedupe the React `key={agent.name}` in
  // DetectedAgents collides and React warns about duplicate keys.
  const seenIndex = new Map<string, number>()
  const unique: typeof report.agents_detected = []
  for (const a of report.agents_detected) {
    const idx = seenIndex.get(a.name)
    if (idx === undefined) {
      seenIndex.set(a.name, unique.length)
      unique.push(a)
      continue
    }
    const existing = unique[idx]
    if (!existing.framework && a.framework) {
      unique[idx] = { ...existing, framework: a.framework }
    }
  }

  const toolsByAgent = new Map<string, number>()
  for (const t of report.tools_detected ?? []) {
    if (!t.agent) continue
    toolsByAgent.set(t.agent, (toolsByAgent.get(t.agent) ?? 0) + 1)
  }
  return unique.map((a, i) => ({
    name: a.name,
    framework: a.framework ?? "",
    tools: toolsByAgent.get(a.name) ?? 0,
    prompts: 0,
    risk: Math.min(100, Math.max(0, riskScore + i * 2)),
    status: "scanned",
  }))
}

/**
 * Per-agent tool inventory used by the top-bar Tools picker. Sourced from
 * `tools_detected`. Each tool already carries an `agent` field assigned
 * server-side (single-agent: all unattributed tools go to the only agent;
 * multi-agent: directory-proximity match). Tools that ended up without an
 * agent fall into an "Unattributed" bucket so they're still discoverable.
 *
 * Within each agent group we dedupe by tool name so a single logical tool
 * doesn't show up multiple times (e.g. two files defining the same class).
 */
export type AgentToolEntry = {
  name: string
  file: string
  line: number
  kind: ToolHit["kind"]
}

export type AgentToolGroup = {
  agent: string
  tools: AgentToolEntry[]
}

const UNATTRIBUTED_BUCKET = "Unattributed"

export function buildToolsInventoryFromReport(
  report: ScanReport | null
): AgentToolGroup[] {
  if (!report?.tools_detected?.length) return []
  const buckets = new Map<string, Map<string, AgentToolEntry>>()
  for (const t of report.tools_detected) {
    const key = (t.agent && t.agent.trim()) || UNATTRIBUTED_BUCKET
    let inner = buckets.get(key)
    if (!inner) {
      inner = new Map<string, AgentToolEntry>()
      buckets.set(key, inner)
    }
    // Dedup by tool name within an agent — keeps the first occurrence so
    // the same tool defined in two places only appears once.
    if (!inner.has(t.name)) {
      inner.set(t.name, {
        name: t.name,
        file: t.file,
        line: t.line,
        kind: t.kind,
      })
    }
  }
  // Sort: agents alphabetical, "Unattributed" last so it doesn't crowd top.
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === UNATTRIBUTED_BUCKET) return 1
      if (b === UNATTRIBUTED_BUCKET) return -1
      return a.localeCompare(b)
    })
    .map(([agent, inner]) => ({
      agent,
      tools: [...inner.values()].sort((x, y) => x.name.localeCompare(y.name)),
    }))
}

export function totalToolCountFromReport(report: ScanReport | null): number {
  // After dedup, the user-visible count is the number of unique tool names
  // (across all agents). Compute it here so the top-bar badge matches what's
  // actually rendered in the dropdown.
  if (!report?.tools_detected?.length) return 0
  const seen = new Set<string>()
  for (const t of report.tools_detected) {
    const key = `${t.agent ?? ""}::${t.name}`
    seen.add(key)
  }
  return seen.size
}
