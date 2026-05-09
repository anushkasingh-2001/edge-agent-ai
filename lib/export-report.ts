import type { Project } from "./projects"
import type { ScanReport } from "./scan-report"

export type ExportFormat = "json" | "markdown"

type ExportContext = {
  project: Project | null
  branch: string | null
  report: ScanReport
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
