import type { LatestPolicyResult } from "./latest-policy-result"
import type { PolicyApiResponse } from "./policy-client"
import type { Project } from "./projects"
import type { ScanReport, ScannerFinding } from "./scan-report"

export type ExportFormat = "json" | "markdown"

type ExportContext = {
  project: Project | null
  branch: string | null
  report: ScanReport
}

type PolicyExportContext = {
  project: Project | null
  branch: string | null
  /** The current scan report at the time of policy evaluation. Used
   *  for the target-vs-base headline so the export is fully
   *  self-contained — readers don't need to chase another file. */
  scanReport: ScanReport | null
  /** Result of `/api/policy/evaluate` (POST). Always required —
   *  `exportPolicyReport` won't be called when no evaluation exists. */
  policy: PolicyApiResponse
  generatedAt: string
  /** When present, the export uses this richer per-operation context
   *  (operation name, base/target SHAs, action taken, etc) instead of
   *  the minimal shape above. Set whenever the export originates from
   *  the latest-policy-result cache populated by Branch Compare /
   *  Commit / Push / Create PR. */
  operation?: LatestPolicyResult | null
}

/**
 * Trigger a browser download of the scan report in the requested format.
 * Pure-frontend (no backend round-trip), so exports work offline once a
 * scan has been loaded into the UI.
 */
export function exportScanReport(
  format: ExportFormat,
  ctx: ExportContext
): void {
  const { content, mime, filename } = renderExport(format, ctx)
  triggerDownload(filename, content, mime)
}

/**
 * Trigger a browser download of the POLICY report in the requested
 * format. Different from `exportScanReport`: this exports the policy
 * evaluation (decision, reasons, failed/passed conditions, deltas vs
 * the base branch, etc.) — useful for sharing "why was my PR blocked"
 * context with reviewers, attaching to compliance tickets, or
 * archiving the gate decision alongside a release.
 */
export function exportPolicyReport(
  format: ExportFormat,
  ctx: PolicyExportContext
): void {
  const { content, mime, filename } = renderPolicyExport(format, ctx)
  triggerDownload(filename, content, mime)
}

function renderExport(
  format: ExportFormat,
  ctx: ExportContext
): { content: string; mime: string; filename: string } {
  const stem = filenameStem(ctx)
  if (format === "json") {
    return {
      content: JSON.stringify(ctx.report, null, 2),
      mime: "application/json",
      filename: `${stem}.json`,
    }
  }
  return {
    content: renderMarkdown(ctx),
    mime: "text/markdown;charset=utf-8",
    filename: `${stem}.md`,
  }
}

function filenameStem(ctx: ExportContext): string {
  const projectSlug = (ctx.project?.name ?? "project")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  const stamp = ctx.report.generated_at
    .replace(/[:T]/g, "-")
    .replace(/\.\d+Z?$/, "")
    .replace(/[^0-9-]/g, "")
  return `edge-agent-ai-report-${projectSlug || "project"}-${stamp || Date.now()}`
}

function triggerDownload(filename: string, content: string, mime: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  // Some browsers require the anchor to be in the DOM before clicking.
  document.body.appendChild(a)
  a.click()
  // Defer revocation so the navigation actually starts.
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}

// ---- Markdown rendering ------------------------------------------------

function renderMarkdown(ctx: ExportContext): string {
  const { project, branch, report } = ctx
  const lines: string[] = []

  // Header.
  lines.push(`# Edge Agent AI scan report`)
  lines.push("")
  lines.push(`- **Project:** ${project?.name ?? "(unnamed)"}`)
  if (project?.path) lines.push(`- **Path:** \`${project.path}\``)
  if (project?.source) lines.push(`- **Source:** ${project.source}`)
  if (project?.githubUrl) lines.push(`- **GitHub:** ${project.githubUrl}`)
  if (branch) lines.push(`- **Branch:** \`${branch}\``)
  lines.push(`- **Scanned at:** ${report.generated_at}`)
  lines.push(`- **Risk score:** ${report.risk_score}/100`)
  lines.push("")

  // Summary.
  lines.push(`## Summary`)
  lines.push("")
  lines.push(`| Severity | Count |`)
  lines.push(`| --- | ---: |`)
  lines.push(`| Critical | ${report.summary.critical} |`)
  lines.push(`| High | ${report.summary.high} |`)
  lines.push(`| Medium | ${report.summary.medium} |`)
  lines.push(`| Low | ${report.summary.low} |`)
  lines.push(`| **Total** | **${report.summary.total}** |`)
  lines.push("")

  // Frameworks.
  lines.push(`## Frameworks detected`)
  lines.push("")
  if (report.frameworks_detected.length === 0) {
    lines.push("_None detected._")
  } else {
    for (const f of report.frameworks_detected) {
      lines.push(`- **${f.name}** (${f.evidence.length} evidence file${f.evidence.length === 1 ? "" : "s"})`)
    }
  }
  lines.push("")

  // Agents.
  lines.push(`## Agents detected`)
  lines.push("")
  const agents = report.agents_detected ?? []
  if (agents.length === 0) {
    lines.push("_No explicit agents detected._")
  } else {
    for (const a of agents) {
      const fw = a.framework ? ` _(${a.framework})_` : ""
      lines.push(`- **${a.name}**${fw} — \`${a.file}:${a.line}\` (${a.kind})`)
    }
  }
  lines.push("")

  // Tools grouped by agent (deduped by name within each group).
  lines.push(`## Tools detected`)
  lines.push("")
  const tools = report.tools_detected ?? []
  if (tools.length === 0) {
    lines.push("_No tools detected._")
  } else {
    const groups = new Map<string, Map<string, { file: string; line: number; kind: string }>>()
    for (const t of tools) {
      const agentKey = t.agent && t.agent.trim() ? t.agent : "Unattributed"
      let inner = groups.get(agentKey)
      if (!inner) {
        inner = new Map()
        groups.set(agentKey, inner)
      }
      if (!inner.has(t.name)) {
        inner.set(t.name, { file: t.file, line: t.line, kind: t.kind })
      }
    }
    const sortedAgents = [...groups.keys()].sort((a, b) => {
      if (a === "Unattributed") return 1
      if (b === "Unattributed") return -1
      return a.localeCompare(b)
    })
    for (const agentName of sortedAgents) {
      const inner = groups.get(agentName)!
      lines.push(`### ${agentName} (${inner.size})`)
      lines.push("")
      for (const [name, meta] of [...inner.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        lines.push(`- \`${name}\` — \`${meta.file}:${meta.line}\` (${meta.kind})`)
      }
      lines.push("")
    }
  }

  // Findings.
  lines.push(`## Findings (${report.findings.length})`)
  lines.push("")
  if (report.findings.length === 0) {
    lines.push("_No findings._")
  } else {
    lines.push(
      `| Severity | Category | Title | File | Line | Agent | Rule |`
    )
    lines.push(`| --- | --- | --- | --- | ---: | --- | --- |`)
    for (const f of report.findings) {
      lines.push(
        `| ${f.severity} | ${cell(f.category)} | ${cell(f.title)} | \`${cell(f.file)}\` | ${f.line} | ${cell(f.agent)} | ${cell(f.rule_id)} |`
      )
    }
    lines.push("")
    lines.push(`### Finding details`)
    lines.push("")
    for (const f of report.findings) {
      lines.push(
        `#### [${f.severity.toUpperCase()}] ${f.title} — \`${f.file}:${f.line}\``
      )
      lines.push("")
      if (f.reason) {
        lines.push(`**Reason:** ${f.reason}`)
        lines.push("")
      }
      if (f.suggestedFix) {
        lines.push(`**Suggested fix:** ${f.suggestedFix}`)
        lines.push("")
      }
      if (f.code) {
        lines.push("```")
        lines.push(f.code.slice(0, 800))
        lines.push("```")
        lines.push("")
      }
    }
  }

  // Footer.
  lines.push(`---`)
  lines.push(
    `Generated locally by Edge Agent AI. Source code never leaves this machine; LLM features are opt-in.`
  )

  return lines.join("\n")
}

/**
 * Escape a value for inclusion as a markdown table cell. Pipes and newlines
 * would otherwise break the table layout.
 */
function cell(value: string | null | undefined): string {
  if (value == null) return ""
  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .slice(0, 240)
}

// ---- Policy export -----------------------------------------------------

function renderPolicyExport(
  format: ExportFormat,
  ctx: PolicyExportContext
): { content: string; mime: string; filename: string } {
  const stem = policyFilenameStem(ctx)
  if (format === "json") {
    // JSON is the source-of-truth shape: every server field, plus a
    // small `_meta` block so the file is self-describing.
    const body = {
      _meta: {
        kind: "edge-agent-ai.policy-report",
        version: 1,
        generated_at: ctx.generatedAt,
        project: ctx.project
          ? {
              id: ctx.project.id,
              name: ctx.project.name,
              path: ctx.project.path,
              source: ctx.project.source,
              githubUrl: ctx.project.githubUrl ?? null,
            }
          : null,
        branch: ctx.branch ?? null,
      },
      decision: ctx.policy.evaluation?.decision ?? null,
      policySource: ctx.policy.policySource,
      policyPath: ctx.policy.policyPath ?? null,
      policyErrors: ctx.policy.policyErrors ?? [],
      policy: ctx.policy.policy,
      evaluation: ctx.policy.evaluation,
      base: {
        source: ctx.policy.baseSource ?? null,
        branch: ctx.policy.baseBranch ?? null,
        sha: ctx.policy.baseSha ?? null,
        cachedAt: ctx.policy.baseCachedAt ?? null,
        riskScore: ctx.policy.baseRiskScore ?? null,
        summary: ctx.policy.baseSummary ?? null,
      },
      target: ctx.scanReport
        ? {
            riskScore: ctx.scanReport.risk_score,
            summary: ctx.scanReport.summary,
            generatedAt: ctx.scanReport.generated_at,
          }
        : null,
      targetWorkingTree: ctx.policy.targetWorkingTree ?? null,
    }
    return {
      content: JSON.stringify(body, null, 2),
      mime: "application/json",
      filename: `${stem}.json`,
    }
  }
  return {
    content: renderPolicyMarkdown(ctx),
    mime: "text/markdown;charset=utf-8",
    filename: `${stem}.md`,
  }
}

function policyFilenameStem(ctx: PolicyExportContext): string {
  const projectSlug = (ctx.project?.name ?? "project")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  const stamp = ctx.generatedAt
    .replace(/[:T]/g, "-")
    .replace(/\.\d+Z?$/, "")
    .replace(/[^0-9-]/g, "")
  const decision = ctx.policy.evaluation?.decision ?? "no-decision"
  return `edge-agent-ai-policy-${projectSlug || "project"}-${decision}-${
    stamp || Date.now()
  }`
}

function renderPolicyMarkdown(ctx: PolicyExportContext): string {
  const { project, branch, policy, scanReport, generatedAt, operation } = ctx
  const ev = policy.evaluation
  const lines: string[] = []

  // ── Header ────────────────────────────────────────────────────────
  lines.push(`# Edge Agent AI Policy Report`)
  lines.push("")
  lines.push(`## Summary`)
  lines.push("")
  const summaryProjectName =
    project?.name ?? operation?.projectName ?? "(unnamed)"
  const opLabel = operation ? operationLabel(operation.operation) : "Manual export"
  const decision = ev?.decision ?? "no-decision"
  const decisionBadge = decisionEmoji(decision)
  lines.push(`- **Project:** ${summaryProjectName}`)
  lines.push(`- **Operation:** ${opLabel}`)
  lines.push(`- **Timestamp:** ${generatedAt}`)
  lines.push(`- **Decision:** ${decisionBadge}`)
  lines.push(`- **Policy mode:** \`${policy.policy.mode}\``)
  lines.push(
    `- **Policy file:** ${
      policy.policyPath ? `\`${policy.policyPath}\`` : "(default — no .edgeagent/policy.yaml)"
    }`
  )
  if (project?.path) lines.push(`- **Path:** \`${project.path}\``)
  if (project?.githubUrl) lines.push(`- **GitHub:** ${project.githubUrl}`)
  if (policy.policyErrors && policy.policyErrors.length > 0) {
    lines.push("")
    lines.push(`**Policy file warnings:**`)
    for (const e of policy.policyErrors) {
      lines.push(`- ${e}`)
    }
  }
  lines.push("")

  // ── Compared States ──────────────────────────────────────────────
  lines.push(`## Compared States`)
  lines.push("")
  lines.push(`### Base`)
  const baseBranchName = operation?.baseBranch ?? policy.baseBranch ?? null
  const baseShaShort = operation?.baseSha ?? policy.baseSha ?? null
  lines.push(`- **Branch:** ${baseBranchName ? `\`${baseBranchName}\`` : "—"}`)
  lines.push(`- **Commit:** ${baseShaShort ? `\`${baseShaShort}\`` : "—"}`)
  lines.push(
    `- **Mode:** ${
      operation?.baseIncludesStashes ? "commits + stashes" : "commits only"
    }`
  )
  lines.push("")
  lines.push(`### Target`)
  const targetBranchName = operation?.targetBranch ?? branch ?? null
  const targetShaShort = operation?.targetSha ?? null
  lines.push(`- **Branch:** ${targetBranchName ? `\`${targetBranchName}\`` : "—"}`)
  lines.push(`- **Commit:** ${targetShaShort ? `\`${targetShaShort}\`` : "—"}`)
  lines.push(
    `- **Mode:** ${
      operation?.targetIncludesStashes ? "commits + stashes" : "commits only"
    }`
  )
  // Working-tree note (target side only — base is always pristine
  // because the base scan runs against a temporary worktree).
  const wt = policy.targetWorkingTree
  if (wt && !wt.clean) {
    lines.push(
      `- **Working tree:** ⚠️ uncommitted (${wt.modified} modified · ${wt.untracked} untracked)`
    )
  }
  lines.push("")

  // ── Risk and Severity Delta ──────────────────────────────────────
  lines.push(`## Risk and Severity Delta`)
  lines.push("")
  const baseSum = policy.baseSummary ?? null
  const t = scanReport?.summary ?? operation?.targetReport?.summary ?? null
  const baseRisk = policy.baseRiskScore ?? null
  const targetRisk =
    scanReport?.risk_score ?? operation?.targetReport?.risk_score ?? null
  lines.push(`| Metric | Base | Target | Delta |`)
  lines.push(`| --- | ---: | ---: | ---: |`)
  lines.push(
    `| Risk Score | ${baseRisk ?? "—"} | ${targetRisk ?? "—"} | ${deltaCell(
      baseRisk,
      targetRisk
    )} |`
  )
  lines.push(
    `| Critical | ${baseSum?.critical ?? "—"} | ${t?.critical ?? "—"} | ${deltaCell(
      baseSum?.critical,
      t?.critical
    )} |`
  )
  lines.push(
    `| High | ${baseSum?.high ?? "—"} | ${t?.high ?? "—"} | ${deltaCell(
      baseSum?.high,
      t?.high
    )} |`
  )
  lines.push(
    `| Medium | ${baseSum?.medium ?? "—"} | ${t?.medium ?? "—"} | ${deltaCell(
      baseSum?.medium,
      t?.medium
    )} |`
  )
  lines.push(
    `| Low | ${baseSum?.low ?? "—"} | ${t?.low ?? "—"} | ${deltaCell(
      baseSum?.low,
      t?.low
    )} |`
  )
  lines.push("")
  if (policy.baseSource && policy.baseSource !== "none") {
    lines.push(
      `_Base scan source: \`${policy.baseSource}\`${
        policy.baseCachedAt ? ` · captured ${policy.baseCachedAt}` : ""
      }_`
    )
    lines.push("")
  }

  // ── Decision (own section per spec) ───────────────────────────────
  lines.push(`## Decision`)
  lines.push("")
  lines.push(decisionBadge)
  lines.push("")

  // ── Failed / Passed Conditions ───────────────────────────────────
  if (ev) {
    lines.push(`## Failed Conditions`)
    lines.push("")
    if (ev.failedConditions.length === 0) {
      lines.push("_None._")
    } else {
      for (let i = 0; i < ev.failedConditions.length; i++) {
        const id = ev.failedConditions[i]
        const reason = ev.reasons.find((r) => r.toLowerCase().includes(idTokens(id))) ??
          ev.reasons[i] ??
          ""
        lines.push(`- \`${id}\` — ${stripBlockedWarning(reason) || "(see details)"}`)
      }
    }
    lines.push("")

    lines.push(`## Passed Conditions`)
    lines.push("")
    if (ev.passedConditions.length === 0) {
      lines.push("_None._")
    } else {
      for (const id of ev.passedConditions) {
        lines.push(`- \`${id}\``)
      }
    }
    lines.push("")

    if (ev.inapplicableConditions.length > 0) {
      lines.push(`## Skipped (no baseline / metrics)`)
      lines.push("")
      for (const id of ev.inapplicableConditions) {
        lines.push(`- \`${id}\``)
      }
      lines.push("")
    }
  }

  // ── Blocking Findings ────────────────────────────────────────────
  // We only list findings that are CRITICAL or HIGH severity — these
  // are the ones the policy gate is most likely to be reacting to.
  // A finding-level reason is appended where useful.
  const findings: ScannerFinding[] =
    (scanReport?.findings as ScannerFinding[] | undefined) ??
    (operation?.targetReport?.findings as ScannerFinding[] | undefined) ??
    []
  const blockingFindings = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high"
  )
  lines.push(`## Blocking Findings`)
  lines.push("")
  if (blockingFindings.length === 0) {
    lines.push("_No critical or high findings on the target._")
  } else {
    lines.push(`| Severity | Rule | File | Line | Reason |`)
    lines.push(`| --- | --- | --- | ---: | --- |`)
    for (const f of blockingFindings.slice(0, 50)) {
      lines.push(
        `| ${f.severity} | ${cell(f.rule_id)} | \`${cell(f.file)}\` | ${f.line} | ${cell(
          f.reason || f.title
        )} |`
      )
    }
    if (blockingFindings.length > 50) {
      lines.push("")
      lines.push(`_+${blockingFindings.length - 50} more blocking findings omitted._`)
    }
  }
  lines.push("")

  // ── Action Taken ─────────────────────────────────────────────────
  lines.push(`## Action Taken`)
  lines.push("")
  const action = operation?.actionTaken
  if (!action) {
    lines.push("_Observational gate — no Git action was attempted._")
  } else {
    lines.push(`- Commit created: ${yesNo(action.commitCreated)}`)
    lines.push(`- Push completed: ${yesNo(action.pushed)}`)
    if (action.prCreated || action.prUrl || action.prNumber) {
      const prLine = action.prUrl
        ? `Yes — [#${action.prNumber ?? "?"}](${action.prUrl})`
        : action.prCreated
          ? `Yes${action.prNumber ? ` (#${action.prNumber})` : ""}`
          : "No"
      lines.push(`- PR created: ${prLine}`)
    } else {
      lines.push(`- PR created: No`)
    }
  }
  lines.push("")

  // ── Recommended Next Actions ─────────────────────────────────────
  lines.push(`## Recommended Next Actions`)
  lines.push("")
  const recs = recommendNextActions(ev, findings, decision)
  if (recs.length === 0) {
    lines.push("- Re-run the policy gate after any code changes.")
  } else {
    for (const r of recs) lines.push(`- ${r}`)
  }
  lines.push("")

  // ── Per-agent metric deltas (only when present) ─────────────────
  const perAgentEntries = Object.entries(ev?.deltas?.perAgent ?? {})
  if (perAgentEntries.length > 0) {
    lines.push(`## Per-agent metric deltas`)
    lines.push("")
    lines.push(`| Agent | Accuracy Δ | Runtime ms Δ | Tool-selection pass-rate Δ |`)
    lines.push(`| --- | ---: | ---: | ---: |`)
    for (const [agentName, m] of perAgentEntries) {
      lines.push(
        `| \`${agentName}\` | ${
          m.accuracy === null ? "—" : signed(m.accuracy)
        } | ${
          m.runtime_ms === null ? "—" : signed(m.runtime_ms)
        } | ${
          m.tool_selection_pass_rate === null
            ? "—"
            : signed(m.tool_selection_pass_rate)
        } |`
      )
    }
    lines.push("")
  }

  // ── Policy YAML excerpt ──────────────────────────────────────────
  // Embedding the full evaluated policy lets readers reproduce the
  // decision without needing a copy of the source repo's policy.yaml.
  lines.push(`## Policy in effect`)
  lines.push("")
  lines.push("```json")
  lines.push(JSON.stringify(policy.policy, null, 2))
  lines.push("```")
  lines.push("")

  // ── Footer ────────────────────────────────────────────────────────
  lines.push(`---`)
  lines.push(
    `Generated locally by Edge Agent AI. Policy evaluation is deterministic from the policy file and the two scan reports above.`
  )

  return lines.join("\n")
}

function operationLabel(op: LatestPolicyResult["operation"]): string {
  switch (op) {
    case "branch-compare":
      return "Branch Compare"
    case "commit":
      return "Commit"
    case "push":
      return "Push"
    case "create-pr":
      return "Create PR"
    case "test":
      return "Test (Settings → Policy Rules)"
    default:
      return op
  }
}

function decisionEmoji(d: string): string {
  switch (d) {
    case "block":
      return "🛑 BLOCK"
    case "warn":
      return "⚠️ WARN"
    case "pass":
      return "✅ PASS"
    case "auto_merge_allowed":
      return "✅ PASS — auto-merge eligible"
    default:
      return d
  }
}

function deltaCell(a: number | null | undefined, b: number | null | undefined): string {
  if (typeof a !== "number" || typeof b !== "number") return "—"
  const d = b - a
  return signed(d)
}

function yesNo(v: boolean | null | undefined): string {
  if (v === true) return "Yes"
  if (v === false) return "No"
  return "—"
}

function stripBlockedWarning(s: string): string {
  // Reasons start with "Blocked: " or "Warning: " — strip so the
  // bullet list looks clean.
  return s.replace(/^(Blocked|Warning):\s*/i, "")
}

/** Best-effort fuzzy match between a condition id and a reason
 *  string. Used purely for rendering — never throws. */
function idTokens(id: string): string {
  return id.split(".").slice(-1)[0].toLowerCase().replace(/_/g, " ")
}

function recommendNextActions(
  ev: PolicyApiResponse["evaluation"],
  findings: ScannerFinding[],
  decision: string
): string[] {
  const out: string[] = []
  const failed = new Set(ev?.failedConditions ?? [])
  const hasRule = (rule: string) => findings.some((f) => f.rule_id === rule)
  if (failed.has("security.block_if_secrets_found") || hasRule("secrets")) {
    out.push(
      "Remove hardcoded secrets and rotate exposed credentials. Use a secret manager (env vars + a vaulted store) instead."
    )
  }
  if (
    failed.has("security.block_if_dangerous_tool_without_approval") ||
    hasRule("dangerous-tools")
  ) {
    out.push(
      "Add a human-approval gate before every dangerous tool call (shell exec, file delete, transfer, send_email, etc)."
    )
  }
  if (
    failed.has("security.block_if_user_input_to_dangerous_code") ||
    hasRule("prompt-injection") ||
    hasRule("user-input-dangerous-code")
  ) {
    out.push(
      "Stop passing untrusted user input directly into shell, eval, file paths, SQL, or tool arguments. Validate and allowlist."
    )
  }
  if (failed.has("security.block_if_unsafe_mcp") || hasRule("mcp-security")) {
    out.push(
      "Tighten MCP configuration: explicit allowlists, no wildcards, no debug/insecure servers in production."
    )
  }
  if (
    failed.has("security.block_if_schema_auth_gap") ||
    hasRule("openapi-schema")
  ) {
    out.push(
      "Improve OpenAPI / auth / schema quality: require auth on every endpoint, document responses, no missing schemas."
    )
  }
  if (
    failed.has("security.require_risk_score_not_increase") ||
    failed.has("security.max_risk_score_increase") ||
    failed.has("security.max_risk_score")
  ) {
    out.push(
      "Reduce headline risk: focus on the highest-severity findings first; rerun the gate after each fix."
    )
  }
  if (
    failed.has("security.block_if_high_increased") ||
    failed.has("security.max_high_findings")
  ) {
    out.push(
      "Triage and fix high-severity findings — they're the biggest contributor to the risk regression."
    )
  }
  if (hasRule("vague-prompts")) {
    out.push(
      "Improve prompt specificity: tell agents *exactly* what to do, what tools they may use, and what they must refuse."
    )
  }
  for (const c of failed) {
    if (c.startsWith("evals.") || c.startsWith("agents.")) {
      out.push(
        "Re-run the eval suite after fixes and confirm accuracy / runtime / tool-selection metrics are back within policy bounds."
      )
      break
    }
  }
  if (decision === "block" || decision === "warn") {
    out.push("Re-run the policy gate after applying fixes to confirm it passes.")
  }
  // Dedupe while preserving order.
  return [...new Set(out)]
}

function signed(n: number): string {
  if (n === 0) return "0"
  return n > 0 ? `+${n}` : `${n}`
}
