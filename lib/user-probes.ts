/**
 * Client-side storage + types for user-authored behavioral probes.
 *
 * Why this lives separately from `lib/test-cases.ts`:
 *
 * `test-cases.ts` owns the *Scan Center* suite format — JSON of TestCases
 * with `expected` objects, used for narrowing static-scan rules. The
 * Behavioral Tests panel in Findings is a different runtime: it runs
 * adversarial probes against real source files and decides pass/fail by
 * checking whether the file contains an expected defense pattern.
 *
 * That contract — input pool + defense patterns + a target file — is
 * what this module persists, alongside a "disabled probe IDs" list so
 * users can hide built-in probes one by one without us forgetting their
 * choice between runs.
 *
 * Everything here is best-effort (`localStorage` can be unavailable or
 * full); callers always get a usable in-memory value back.
 */

import type { BehavioralSeverity } from "./behavioral-tests-client"
import { SECURITY_CHECKS } from "./security-checks"
import type { TestCase, TestSuite } from "./test-cases"

/** Per-test scenario. Drives how the conversation is rendered in the
 *  Per-test details panel and (in the future) how runtime probes
 *  sequence messages between multiple agents. */
export type UserProbeScenario =
  | "prompt_to_output"
  | "agent_to_agent"
  | "multi_agent_to_one"

/** One user-authored probe. Mirrors the server-side `ProbeTemplate`
 *  shape but stays serializable — we store regex patterns as plain
 *  strings (compiled server-side) and never accept arbitrary flags
 *  from the UI. */
export interface UserBehavioralProbe {
  /** Stable id. Always begins with `user.` so the runner and the UI
   *  can tell user probes apart from built-ins at a glance. */
  id: string
  /** Scanner rule id this probe targets (drives which findings the
   *  probe gets pointed at). `null` means "no static finding — try
   *  the agent file directly, otherwise skip." */
  rule_id: string | null
  /** User-facing label (matches Scan Center category vocabulary). */
  category: string
  severity: BehavioralSeverity
  name: string
  scenario: UserProbeScenario
  /** Pool of adversarial inputs (at least one). The runner draws a
   *  fresh one per run so successive runs probe with fresh samples,
   *  matching the rest of the behavioral tab's UX. */
  inputs: string[]
  /** Plain-language description of what the code is supposed to do
   *  when the probe input arrives. */
  expected_defense: string
  /** Regex pattern strings — at least one match in the target file
   *  body marks the probe as PASS. Empty array = always fails when a
   *  target is found (useful for "this codepath shouldn't exist at
   *  all" probes). */
  defense_patterns: string[]
  /** Optional explicit target. When set the runner reads this file
   *  instead of looking for findings under `rule_id`. Relative to
   *  the project root. */
  target_file: string | null
  /** Optional agent names that participate (for multi-agent
   *  scenarios). Stored alongside so the UI can render them, but
   *  the server runner doesn't use this today — kept for forward
   *  compatibility. */
  agents: string[]
  /** Optional accuracy target the user expects from a real-world run
   *  (e.g. 0.95). Surfaced in the Per-test details panel; not used
   *  by the static defense detector. */
  accuracy_target: number | null
  /** Plain-language description shown under "Observed in code" when
   *  the probe FAILS. */
  failure_observed: string
  /** ISO timestamps for "saved at" / "last edited at" surfacing. */
  createdAt: string
  updatedAt: string
}

/** Disabled-probe state plus user probes, scoped to one project.
 *  Wrapping it in an object means we only do one localStorage write
 *  per change instead of two. */
export interface ProjectProbeStore {
  /** `probe_id`s of *built-in* probes the user has hidden. */
  disabledProbeIds: string[]
  /** User-authored probes. */
  userProbes: UserBehavioralProbe[]
  /** When true, the Behavioral runner skips the entire built-in probe
   *  pool and only runs probes in `userProbes`. Persisted per project
   *  so the choice survives reload. Default `false` keeps the
   *  built-in baseline. */
  userOnly: boolean
}

const EMPTY: ProjectProbeStore = {
  disabledProbeIds: [],
  userProbes: [],
  userOnly: false,
}

function storageKey(projectPath: string): string {
  // We key on `projectPath` directly — the value is opaque to other
  // projects and already isolated by the absolute path. Using the
  // path verbatim is fine because localStorage keys are arbitrary
  // strings.
  return `edge-agent-ai.userProbes::${projectPath}`
}

function isProbe(v: unknown): v is UserBehavioralProbe {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === "string" &&
    typeof o.category === "string" &&
    typeof o.name === "string" &&
    typeof o.severity === "string" &&
    Array.isArray(o.inputs) &&
    Array.isArray(o.defense_patterns)
  )
}

function parseStore(raw: string | null): ProjectProbeStore {
  if (!raw) return { ...EMPTY }
  try {
    const j = JSON.parse(raw) as unknown
    if (!j || typeof j !== "object") return { ...EMPTY }
    const obj = j as Record<string, unknown>
    const disabled = Array.isArray(obj.disabledProbeIds)
      ? obj.disabledProbeIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0
        )
      : []
    const probes = Array.isArray(obj.userProbes)
      ? obj.userProbes.filter(isProbe)
      : []
    const userOnly = typeof obj.userOnly === "boolean" ? obj.userOnly : false
    return { disabledProbeIds: disabled, userProbes: probes, userOnly }
  } catch {
    return { ...EMPTY }
  }
}

/** Pull the current store for a project. Returns `EMPTY` when SSR or
 *  the slot is missing/corrupt — never throws. */
export function loadProbeStore(
  projectPath: string | null | undefined
): ProjectProbeStore {
  if (!projectPath) return { ...EMPTY }
  if (typeof window === "undefined") return { ...EMPTY }
  try {
    return parseStore(window.localStorage.getItem(storageKey(projectPath)))
  } catch {
    return { ...EMPTY }
  }
}

function writeStore(projectPath: string, store: ProjectProbeStore): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKey(projectPath), JSON.stringify(store))
  } catch {
    // Quota / private-mode: best effort, callers still get the new
    // value back in-memory.
  }
}

export function newUserProbeId(category: string): string {
  // Categories can contain spaces and slashes (e.g. "OpenAPI / auth /
  // schema quality"); slug them so the resulting id matches the
  // `[^\w-]+` cleanup the server runner applies.
  const slug = category
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  const rand = Math.random().toString(36).slice(2, 8)
  const ts = Date.now().toString(36)
  return `user.${slug || "custom"}.${ts}.${rand}`
}

/** Add or update one probe. Match is by `id`; if not present it's
 *  appended. Returns the updated store so callers can mirror it into
 *  React state in a single setState. */
export function upsertUserProbe(
  projectPath: string,
  probe: UserBehavioralProbe
): ProjectProbeStore {
  const cur = loadProbeStore(projectPath)
  const idx = cur.userProbes.findIndex((p) => p.id === probe.id)
  const now = new Date().toISOString()
  const next: UserBehavioralProbe = {
    ...probe,
    createdAt: idx === -1 ? probe.createdAt || now : probe.createdAt,
    updatedAt: now,
  }
  const list =
    idx === -1
      ? [...cur.userProbes, next]
      : cur.userProbes.map((p, i) => (i === idx ? next : p))
  const out: ProjectProbeStore = { ...cur, userProbes: list }
  writeStore(projectPath, out)
  return out
}

/** Remove a user probe by id. No-op when the id isn't found, so it's
 *  safe to call from anywhere without a guard. */
export function removeUserProbe(
  projectPath: string,
  id: string
): ProjectProbeStore {
  const cur = loadProbeStore(projectPath)
  const list = cur.userProbes.filter((p) => p.id !== id)
  const out: ProjectProbeStore = { ...cur, userProbes: list }
  writeStore(projectPath, out)
  return out
}

/** Mark a built-in probe template as hidden for this project. The
 *  next behavioral run won't include any tests for that probe. */
export function disableBuiltinProbe(
  projectPath: string,
  probeId: string
): ProjectProbeStore {
  const cur = loadProbeStore(projectPath)
  if (cur.disabledProbeIds.includes(probeId)) return cur
  const out: ProjectProbeStore = {
    ...cur,
    disabledProbeIds: [...cur.disabledProbeIds, probeId],
  }
  writeStore(projectPath, out)
  return out
}

/** Un-hide a previously disabled built-in probe. */
export function enableBuiltinProbe(
  projectPath: string,
  probeId: string
): ProjectProbeStore {
  const cur = loadProbeStore(projectPath)
  const list = cur.disabledProbeIds.filter((p) => p !== probeId)
  if (list.length === cur.disabledProbeIds.length) return cur
  const out: ProjectProbeStore = { ...cur, disabledProbeIds: list }
  writeStore(projectPath, out)
  return out
}

/** Toggle the "Only run my custom + suite tests" flag for a project.
 *  No-ops when the value is already what was requested so callers can
 *  invoke this from a controlled toggle without churning storage. */
export function setUserOnly(
  projectPath: string,
  value: boolean
): ProjectProbeStore {
  const cur = loadProbeStore(projectPath)
  if (cur.userOnly === value) return cur
  const out: ProjectProbeStore = { ...cur, userOnly: value }
  writeStore(projectPath, out)
  return out
}

/**
 * Replace the set of *suite-bridged* probes for a project in one
 * atomic write. The Define User-defined Inputs dialog uses this so
 * the Behavioral panel mirrors whatever the user has in the active
 * suite — without piling up stale probes every time they re-save.
 *
 * A probe is considered "suite-bridged" when its id starts with
 * `user.suite.`. Hand-authored probes from the Behavioral panel's
 * Define Custom Test dialog use a different prefix (`user.<slug>.`)
 * and are NEVER touched by this function — so suite re-saves don't
 * obliterate independent custom probes.
 */
export function replaceSuiteProbes(
  projectPath: string,
  probes: UserBehavioralProbe[]
): ProjectProbeStore {
  const cur = loadProbeStore(projectPath)
  const next: ProjectProbeStore = {
    ...cur,
    userProbes: [
      ...cur.userProbes.filter((p) => !p.id.startsWith("user.suite.")),
      ...probes,
    ],
  }
  writeStore(projectPath, next)
  return next
}

// ── Suite → Behavioral probe bridge ─────────────────────────────────

const VALID_SCENARIOS: ReadonlySet<UserProbeScenario> = new Set([
  "prompt_to_output",
  "agent_to_agent",
  "multi_agent_to_one",
])

const VALID_SEVERITIES: ReadonlySet<BehavioralSeverity> = new Set([
  "critical",
  "high",
  "medium",
  "low",
])

function categoryLabelFromRuleId(ruleId: string | null): {
  ruleId: string | null
  category: string
} {
  if (!ruleId) {
    return { ruleId: null, category: "Other" }
  }
  const hit = SECURITY_CHECKS.find((c) => c.id === ruleId)
  return { ruleId: ruleId, category: hit?.label ?? "Other" }
}

/**
 * Reverse a stored `TestSuite` into the set of behavioral probes the
 * Findings → Behavioral Tests panel should expose as `Custom` rows.
 *
 * This is the fallback path for suites authored *before* the
 * Define-User-Defined-Inputs dialog started bridging at save time —
 * the parent calls this whenever `activeSuite` changes so the
 * Behavioral panel always reflects whatever suite is active, even
 * after a page reload or a load from the Saved Tests picker.
 *
 * Mapping is **one probe per test**:
 *   • `inputs`: `[test.input]` (a 1-element pool).
 *   • `target_file`: `test.expected.file_under_test` (canonical) or
 *      the first hint in `agents_file_hints`, else `null`.
 *   • `rule_id` / `category`: derived from `expected.rule_id_hint`.
 *   • IDs use `user.suite.<suiteId>.t<index>` so `replaceSuiteProbes`
 *     can atomically replace the set without piling up stale rows.
 *
 * Returns `[]` for empty/missing suites — safe to pass straight to
 * `replaceSuiteProbes()` to clear a project's bridged set when the
 * user clears their active suite.
 */
export function buildBridgedProbesFromSuite(
  suite: TestSuite | null
): UserBehavioralProbe[] {
  if (!suite || !Array.isArray(suite.tests) || suite.tests.length === 0) {
    return []
  }
  const now = new Date().toISOString()
  const out: UserBehavioralProbe[] = []
  for (let i = 0; i < suite.tests.length; i++) {
    const test: TestCase = suite.tests[i]
    if (!test || typeof test.input !== "string" || test.input.trim() === "") {
      continue
    }
    const expected = (test.expected ?? {}) as Record<string, unknown>
    const ruleIdHint =
      typeof expected.rule_id_hint === "string"
        ? (expected.rule_id_hint as string)
        : null
    const { ruleId, category } = categoryLabelFromRuleId(ruleIdHint)

    const futRaw = expected.file_under_test
    const hintsRaw = expected.agents_file_hints
    const target =
      typeof futRaw === "string" && futRaw.length > 0
        ? futRaw
        : Array.isArray(hintsRaw)
          ? (hintsRaw.find(
              (h): h is string => typeof h === "string" && h.length > 0
            ) ?? null)
          : null

    const expectedOutputsRaw = expected.expected_outputs
    const defensePatterns = Array.isArray(expectedOutputsRaw)
      ? expectedOutputsRaw.filter(
          (o): o is string => typeof o === "string" && o.length > 0
        )
      : []

    const agentsRaw = expected.agents_involved
    const agents = Array.isArray(agentsRaw)
      ? agentsRaw.filter(
          (a): a is string => typeof a === "string" && a.length > 0
        )
      : test.agent
        ? [test.agent]
        : []

    const scenarioRaw = expected.scenario
    const scenario: UserProbeScenario =
      typeof scenarioRaw === "string" &&
      VALID_SCENARIOS.has(scenarioRaw as UserProbeScenario)
        ? (scenarioRaw as UserProbeScenario)
        : "prompt_to_output"

    const severity: BehavioralSeverity =
      test.severity_if_fail &&
      VALID_SEVERITIES.has(test.severity_if_fail as BehavioralSeverity)
        ? (test.severity_if_fail as BehavioralSeverity)
        : "high"

    const agentLabel = test.agent ?? agents[0] ?? "—"
    const probeName =
      category && category !== "Other"
        ? `${category} on ${agentLabel} — suite test ${i + 1}`
        : `Suite test ${i + 1}`

    out.push({
      id: `user.suite.${suite.id}.t${i}`,
      rule_id: ruleId,
      category,
      severity,
      name: probeName,
      scenario,
      inputs: [test.input],
      expected_defense:
        defensePatterns.length > 0
          ? `Source file should contain at least one of: ${defensePatterns.join(", ")}`
          : "User-defined check — no defense pattern declared; probe will fail until you add one.",
      defense_patterns: defensePatterns,
      target_file: target,
      agents,
      accuracy_target: null,
      failure_observed:
        typeof test.notes === "string" && test.notes.trim()
          ? test.notes.trim()
          : `Suite test ${i + 1} did not find the expected output in ${target ?? "the rule's target files"}.`,
      createdAt: now,
      updatedAt: now,
    })
  }
  return out
}

/** Wipe everything for a project — useful for "Reset to defaults"
 *  affordances. Not currently wired into the UI but cheap to keep. */
export function clearProbeStore(projectPath: string): ProjectProbeStore {
  if (typeof window === "undefined") return { ...EMPTY }
  try {
    window.localStorage.removeItem(storageKey(projectPath))
  } catch {
    /* ignore */
  }
  return { ...EMPTY }
}
