#!/usr/bin/env node
/**
 * Edge Agent AI — Policy Gate (GitHub Actions / standalone CLI)
 * ──────────────────────────────────────────────────────────────
 *
 * Runs the Python static scanner against the target commit (the
 * current checkout) and, when available, against the base commit
 * (e.g. the PR's target branch) — then evaluates the same
 * `evaluatePolicy()` logic the desktop app uses on top of the two
 * reports and `.edgeagent/policy.yaml`.
 *
 * Goals:
 *   • Reuse `lib/policy.ts` so the in-IDE gate and the CI gate can
 *     never drift. No re-implementation of policy rules here.
 *   • Honour `mode: block | warn | auto_merge` from the policy file
 *     (`auto_merge` behaves like `warn` for the gate's exit code —
 *     the actual auto-merge happens elsewhere).
 *   • Emit a Markdown summary into `$GITHUB_STEP_SUMMARY` and a
 *     standalone artefact at `policy-report.md`. Set
 *     `$GITHUB_OUTPUT` so downstream steps can branch on the
 *     decision.
 *   • Exit non-zero only when the policy says BLOCK in `block`
 *     mode — `warn` always exits 0, and `pass` always exits 0.
 *
 * Local usage (no GitHub env required):
 *   pnpm tsx scripts/policy-gate.ts --target HEAD
 *   pnpm tsx scripts/policy-gate.ts --target HEAD --base origin/main
 *
 * GitHub Actions usage:
 *   - uses: actions/checkout@v4 with fetch-depth: 0
 *   - run: pnpm install --frozen-lockfile
 *   - run: pnpm tsx scripts/policy-gate.ts
 *
 * The CLI auto-detects `GITHUB_BASE_REF`, `GITHUB_SHA`,
 * `GITHUB_HEAD_REF`, `GITHUB_REPOSITORY`, and writes to
 * `GITHUB_STEP_SUMMARY` / `GITHUB_OUTPUT` when they're set.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  DEFAULT_POLICY,
  evaluatePolicy,
  parsePolicyYaml,
  type Policy,
  type PolicyEvaluation,
} from "../lib/policy"
import {
  ScanReportSchema,
  type ScanReport,
} from "../lib/scan-report"

// ── Args / env ──────────────────────────────────────────────────────

interface CliArgs {
  repoRoot: string
  targetRef: string
  baseRef: string | null
  policyFile: string
  outDir: string
  postComment: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  // GitHub Actions hints — only used when the user didn't pass an
  // explicit flag, so local invocations keep their full control.
  const repoRoot = path.resolve(
    typeof args.repo === "string" ? args.repo : process.env.GITHUB_WORKSPACE || process.cwd()
  )
  const baseEnv =
    typeof args.base === "string"
      ? args.base
      : process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : null
  return {
    repoRoot,
    targetRef:
      typeof args.target === "string"
        ? args.target
        : process.env.GITHUB_SHA || "HEAD",
    baseRef: baseEnv,
    policyFile:
      typeof args["policy-file"] === "string"
        ? (args["policy-file"] as string)
        : ".edgeagent/policy.yaml",
    outDir: typeof args.out === "string" ? args.out : "edge-agent-output",
    postComment:
      typeof args["post-comment"] === "string"
        ? args["post-comment"] === "true"
        : Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_EVENT_NAME === "pull_request"),
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function runSh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; allowFail?: boolean; quiet?: boolean } = {}
): SpawnSyncReturns<string> {
  if (!opts.quiet) {
    process.stderr.write(`\u203a ${cmd} ${args.join(" ")}\n`)
  }
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (!opts.allowFail && r.status !== 0) {
    process.stderr.write(r.stdout || "")
    process.stderr.write(r.stderr || "")
    throw new Error(`Command failed (exit ${r.status}): ${cmd} ${args.join(" ")}`)
  }
  return r
}

function shortSha(repoRoot: string, ref: string): string | null {
  const r = runSh("git", ["rev-parse", "--short", ref], {
    cwd: repoRoot,
    allowFail: true,
    quiet: true,
  })
  if (r.status !== 0) return null
  return r.stdout.trim() || null
}

function currentBranch(repoRoot: string): string | null {
  // GITHUB_HEAD_REF wins on PR events (the source branch); fall back
  // to the local `git symbolic-ref` for push events and local runs.
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME
  const r = runSh("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: repoRoot,
    allowFail: true,
    quiet: true,
  })
  if (r.status !== 0) return null
  return r.stdout.trim() || null
}

/**
 * Run the Python scanner against `cwd` and return the parsed report.
 * We expect the scanner module to be importable as
 * `python -m edge_agent_scanner.cli` — installed via
 * `pip install -e scanner/` in CI or already present in the
 * developer's venv locally.
 */
function runScanner(cwd: string, outFile: string): ScanReport {
  // Resolve the python binary the same way GitHub Actions' setup-python does
  // — `python` is the safe shim on Windows + most Linux runners; if a venv
  // is active, `which python` picks it up automatically.
  const py = process.env.EDGE_AGENT_PYTHON || "python3"
  runSh(py, [
    "-m",
    "edge_agent_scanner.cli",
    "scan",
    cwd,
    "--out",
    outFile,
  ])
  const raw = JSON.parse(fs.readFileSync(outFile, "utf8")) as unknown
  const parsed = ScanReportSchema.safeParse(raw)
  if (!parsed.success) {
    process.stderr.write(
      `Scanner output failed schema validation:\n${parsed.error.toString()}\n`
    )
    throw new Error("Invalid scan report JSON")
  }
  return parsed.data
}

/**
 * Materialise `ref` as a temporary worktree and run the scanner
 * against it. Cleans up the worktree on the way out — even when the
 * scanner throws — so we don't leak `.git/worktrees/*` entries on
 * the runner.
 */
function scanAtRef(repoRoot: string, ref: string, outFile: string): ScanReport {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-base-"))
  try {
    runSh("git", ["worktree", "add", "--detach", tmpDir, ref], {
      cwd: repoRoot,
    })
    return runScanner(tmpDir, outFile)
  } finally {
    runSh("git", ["worktree", "remove", "--force", tmpDir], {
      cwd: repoRoot,
      allowFail: true,
      quiet: true,
    })
    // The worktree-remove command also deletes the directory; this
    // is just belt-and-braces in case git skipped it.
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function loadPolicy(repoRoot: string, relPath: string): { policy: Policy; errors: string[]; path: string | null } {
  const abs = path.resolve(repoRoot, relPath)
  if (!fs.existsSync(abs)) {
    return { policy: DEFAULT_POLICY, errors: [], path: null }
  }
  const yamlText = fs.readFileSync(abs, "utf8")
  const parsed = parsePolicyYaml(yamlText)
  return { policy: parsed.policy, errors: parsed.errors, path: abs }
}

// ── Markdown rendering ──────────────────────────────────────────────

interface ReportContext {
  project: { name: string; repo: string | null }
  policyPath: string | null
  policyErrors: string[]
  targetSha: string | null
  baseSha: string | null
  targetBranch: string | null
  baseBranch: string | null
  generatedAt: string
}

function decisionEmoji(d: PolicyEvaluation["decision"]): string {
  if (d === "block") return "**🛑 BLOCK**"
  if (d === "warn") return "**⚠️ WARN**"
  if (d === "pass") return "**✅ PASS**"
  return `**${String(d).toUpperCase()}**`
}

function deltaCell(base: number | null | undefined, target: number | null | undefined): string {
  if (base == null || target == null) return "—"
  const d = target - base
  if (d === 0) return "0"
  return d > 0 ? `+${d}` : `${d}`
}

function renderMarkdown(
  evaluation: PolicyEvaluation,
  policy: Policy,
  target: ScanReport,
  base: ScanReport | null,
  ctx: ReportContext
): string {
  const lines: string[] = []
  lines.push(`# Edge Agent AI — Policy Gate`)
  lines.push("")
  lines.push(`## Summary`)
  lines.push("")
  lines.push(`- **Project:** ${ctx.project.name}`)
  if (ctx.project.repo) lines.push(`- **Repository:** ${ctx.project.repo}`)
  lines.push(`- **Decision:** ${decisionEmoji(evaluation.decision)}`)
  lines.push(`- **Policy mode:** \`${policy.mode}\``)
  lines.push(
    `- **Policy file:** ${ctx.policyPath ? `\`${path.relative(process.cwd(), ctx.policyPath)}\`` : "_(default — no `.edgeagent/policy.yaml`)_"}`
  )
  lines.push(`- **Timestamp:** ${ctx.generatedAt}`)
  lines.push("")

  if (ctx.policyErrors.length > 0) {
    lines.push(`### ⚠️ Policy file warnings`)
    for (const e of ctx.policyErrors) lines.push(`- ${e}`)
    lines.push("")
  }

  lines.push(`## Compared States`)
  lines.push("")
  lines.push(`### Base`)
  lines.push(`- **Branch:** ${ctx.baseBranch ? `\`${ctx.baseBranch}\`` : "—"}`)
  lines.push(`- **Commit:** ${ctx.baseSha ? `\`${ctx.baseSha}\`` : "—"}`)
  lines.push("")
  lines.push(`### Target`)
  lines.push(`- **Branch:** ${ctx.targetBranch ? `\`${ctx.targetBranch}\`` : "—"}`)
  lines.push(`- **Commit:** ${ctx.targetSha ? `\`${ctx.targetSha}\`` : "—"}`)
  lines.push("")

  lines.push(`## Risk and Severity Delta`)
  lines.push("")
  lines.push(`| Metric | Base | Target | Delta |`)
  lines.push(`| --- | ---: | ---: | ---: |`)
  lines.push(
    `| Risk Score | ${base?.risk_score ?? "—"} | ${target.risk_score} | ${deltaCell(base?.risk_score, target.risk_score)} |`
  )
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    lines.push(
      `| ${sev[0].toUpperCase() + sev.slice(1)} | ${base?.summary[sev] ?? "—"} | ${target.summary[sev]} | ${deltaCell(base?.summary[sev], target.summary[sev])} |`
    )
  }
  lines.push("")

  lines.push(`## Decision`)
  lines.push("")
  lines.push(decisionEmoji(evaluation.decision))
  lines.push("")

  lines.push(`## Failed Conditions`)
  lines.push("")
  if (evaluation.failedConditions.length === 0) {
    lines.push("_None._")
  } else {
    for (let i = 0; i < evaluation.failedConditions.length; i++) {
      const id = evaluation.failedConditions[i]
      const reason = evaluation.reasons[i] ?? ""
      lines.push(`- \`${id}\` — ${reason || "(see policy file)"}`)
    }
  }
  lines.push("")

  lines.push(`## Passed Conditions`)
  lines.push("")
  if (evaluation.passedConditions.length === 0) {
    lines.push("_None._")
  } else {
    for (const id of evaluation.passedConditions) lines.push(`- \`${id}\``)
  }
  lines.push("")

  if (evaluation.inapplicableConditions.length > 0) {
    lines.push(`## Skipped (no baseline / metrics)`)
    lines.push("")
    for (const id of evaluation.inapplicableConditions) {
      lines.push(`- \`${id}\``)
    }
    lines.push("")
  }

  // Top blocking findings — surface the 10 most severe so reviewers
  // can triage without opening the JSON artefact.
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  const top = [...target.findings]
    .sort(
      (a, b) =>
        (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    )
    .slice(0, 10)
  if (top.length > 0) {
    lines.push(`## Top Findings`)
    lines.push("")
    lines.push(`| Severity | Rule | File | Line | Title |`)
    lines.push(`| --- | --- | --- | ---: | --- |`)
    for (const f of top) {
      lines.push(
        `| ${f.severity} | \`${f.rule_id}\` | \`${f.file}\` | ${f.line} | ${f.title.replace(/\|/g, "\\|")} |`
      )
    }
    lines.push("")
  }

  lines.push(`## Recommended Next Actions`)
  lines.push("")
  if (evaluation.decision === "block") {
    lines.push(
      "- Fix the blocking findings above, or relax the relevant rule in `.edgeagent/policy.yaml` (with code-owner approval)."
    )
    lines.push(
      "- Re-push to re-run this gate. The policy is enforced on every push to the PR."
    )
  } else if (evaluation.decision === "warn") {
    lines.push(
      "- The gate did not block the PR, but at least one rule reported a regression. Review the **Failed Conditions** list above before merging."
    )
  } else {
    lines.push("- No action required — policy passed.")
  }

  return lines.join("\n") + "\n"
}

// ── PR comment helpers (best-effort, requires `gh` on PATH) ─────────

const COMMENT_MARKER = "<!-- edge-agent-policy-gate -->"

function postPrCommentIfPossible(repoRoot: string, body: string): void {
  // Only run for PR events with a token + gh present.
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return
  if (!process.env.GITHUB_TOKEN) return
  const which = runSh("which", ["gh"], { allowFail: true, quiet: true })
  if (which.status !== 0) {
    process.stderr.write("note: `gh` not on PATH — skipping PR comment.\n")
    return
  }
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return
  let prNumber: number | null = null
  try {
    const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"))
    prNumber = ev?.pull_request?.number ?? null
  } catch {
    return
  }
  if (!prNumber) return

  // Write the body to a tmpfile so newlines / quotes survive intact.
  const tmp = path.join(os.tmpdir(), `edge-policy-comment-${Date.now()}.md`)
  fs.writeFileSync(tmp, `${COMMENT_MARKER}\n${body}`, "utf8")
  // `gh pr comment --edit-last` will replace the previous comment on
  // re-runs IFF the previous one starts with the same marker — that's
  // the most common pattern for sticky PR comments and avoids piling
  // up duplicates on every push.
  runSh(
    "gh",
    ["pr", "comment", String(prNumber), "--body-file", tmp, "--edit-last"],
    { cwd: repoRoot, allowFail: true }
  )
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  process.stderr.write(
    `Edge Agent AI policy gate · target=${args.targetRef} base=${args.baseRef ?? "(none)"} repo=${args.repoRoot}\n`
  )

  const outDir = path.resolve(args.repoRoot, args.outDir)
  fs.mkdirSync(outDir, { recursive: true })
  const targetJson = path.join(outDir, "report-target.json")
  const baseJson = path.join(outDir, "report-base.json")
  const mdPath = path.join(outDir, "policy-report.md")
  const evalJson = path.join(outDir, "policy-result.json")

  // 1. Scan target (current checkout — fastest, no worktree needed).
  const target = runScanner(args.repoRoot, targetJson)

  // 2. Scan base (optional — drives delta rules).
  let base: ScanReport | null = null
  if (args.baseRef) {
    try {
      base = scanAtRef(args.repoRoot, args.baseRef, baseJson)
    } catch (e) {
      process.stderr.write(
        `Warning: base scan failed — delta rules will be skipped. (${
          e instanceof Error ? e.message : String(e)
        })\n`
      )
    }
  }

  // 3. Load policy.
  const policyResult = loadPolicy(args.repoRoot, args.policyFile)

  // 4. Evaluate.
  const evaluation = evaluatePolicy({
    targetReport: target,
    baseReport: base,
    policy: policyResult.policy,
    context: {
      branch: currentBranch(args.repoRoot) || undefined,
    },
  })

  // 5. Render Markdown.
  const repo = process.env.GITHUB_REPOSITORY || null
  const projectName =
    repo?.split("/").pop() ?? path.basename(args.repoRoot)
  const md = renderMarkdown(evaluation, policyResult.policy, target, base, {
    project: { name: projectName, repo },
    policyPath: policyResult.path,
    policyErrors: policyResult.errors,
    targetSha: shortSha(args.repoRoot, args.targetRef),
    baseSha: args.baseRef ? shortSha(args.repoRoot, args.baseRef) : null,
    targetBranch: currentBranch(args.repoRoot),
    baseBranch:
      process.env.GITHUB_BASE_REF ??
      (args.baseRef ? args.baseRef.replace(/^origin\//, "") : null),
    generatedAt: new Date().toISOString(),
  })

  // 6. Persist artefacts.
  fs.writeFileSync(mdPath, md, "utf8")
  fs.writeFileSync(
    evalJson,
    JSON.stringify(
      {
        decision: evaluation.decision,
        mode: evaluation.mode,
        failedConditions: evaluation.failedConditions,
        passedConditions: evaluation.passedConditions,
        inapplicableConditions: evaluation.inapplicableConditions,
        reasons: evaluation.reasons,
        deltas: evaluation.deltas,
        target: {
          risk_score: target.risk_score,
          summary: target.summary,
          generated_at: target.generated_at,
        },
        base: base
          ? {
              risk_score: base.risk_score,
              summary: base.summary,
              generated_at: base.generated_at,
            }
          : null,
        policyPath: policyResult.path,
        policyErrors: policyResult.errors,
      },
      null,
      2
    ),
    "utf8"
  )

  // 7. Emit GitHub Actions outputs / step summary.
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, "utf8")
  }
  if (process.env.GITHUB_OUTPUT) {
    const out =
      `decision=${evaluation.decision}\n` +
      `mode=${evaluation.mode}\n` +
      `risk_score=${target.risk_score}\n` +
      `failed_count=${evaluation.failedConditions.length}\n` +
      `report_path=${mdPath}\n`
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out, "utf8")
  }

  // 8. PR sticky comment (best-effort).
  if (args.postComment) postPrCommentIfPossible(args.repoRoot, md)

  // 9. Exit code policy:
  //   • mode=block + decision=block  → exit 1 (fails the check)
  //   • mode=warn  + decision=block  → exit 0 (annotate, don't fail)
  //   • decision=warn or pass        → exit 0
  process.stderr.write(`Decision: ${evaluation.decision} (mode=${evaluation.mode})\n`)
  if (evaluation.decision === "block" && policyResult.policy.mode === "block") {
    return 1
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      `policy-gate crashed: ${e instanceof Error ? e.stack || e.message : String(e)}\n`
    )
    process.exit(2)
  })
