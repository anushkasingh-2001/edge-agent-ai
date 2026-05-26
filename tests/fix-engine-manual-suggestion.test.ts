/**
 * Manual-suggestion labelling contract for the deterministic fix engine.
 *
 * The fix engine has two kinds of templates:
 *
 *   1. Rule-specific rewrites (e.g. `secrets`, `dangerous-tools` —
 *      these change real code and clear the finding).
 *   2. The generic fallback (`fallbackTemplate()` in
 *      `lib/server-finding-fixes.ts`) — used for any rule we don't
 *      have a rule-specific template for. It only inserts a TODO
 *      comment.
 *
 * The TODO-only fallback is NOT a fix. The scanner does not honor
 * the auto-inserted marker as a suppression, and the finding will
 * keep firing on every re-scan until the underlying code is actually
 * changed. The contract this file pins down:
 *
 *   - The proposal's `marker_only` flag is true.
 *   - The proposal's `title` says "Manual suggestion", NOT "Applied"
 *     or "Fixed".
 *   - The proposal's `description` makes clear this is NOT a fix.
 *   - The inserted comment body itself contains "MANUAL SUGGESTION"
 *     so a `git blame` reader sees the same truth.
 *   - A real rule-specific template (e.g. `secrets`) produces
 *     marker_only=false and a normal "Applied" title, just to keep
 *     us honest that the flag distinguishes the two paths.
 *
 * If any of these regress (e.g. someone re-renames the title to
 * "Suppressed" or "Auto-fixed"), every test here fails loudly.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildAndMaybeApplyFixes,
  type RunFixesResult,
} from "../lib/server-finding-fixes.js"

function makeTempProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-fix-manual-"))
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  return root
}

function cleanup(root: string) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

function previewFor(
  root: string,
  rule_id: string,
  rel: string,
  line: number,
): RunFixesResult {
  return buildAndMaybeApplyFixes({
    projectPath: root,
    mode: "suggest",
    targets: [
      {
        ref_id: `t-${rule_id}-${rel}-${line}`,
        rule_id,
        file: rel,
        line,
        title: `Finding on ${rel}:${line}`,
      },
    ],
  })
}

test("preview: TODO-only patch is labeled 'manual suggestion', not 'fixed'", () => {
  // prompt-contract has no rule-specific template, so it always
  // falls through to fallbackTemplate.
  const root = makeTempProject({
    "agent.py":
      "AGENT_NAME = 'demo'\n" + "PROMPT = '''Greet the user politely.'''\n",
  })
  try {
    const r = previewFor(root, "prompt-contract", "agent.py", 2)
    assert.equal(r.proposals.length, 1)
    const p = r.proposals[0]

    // 1. Flag must be set.
    assert.equal(
      p.marker_only,
      true,
      "fallback-template proposal must have marker_only=true",
    )

    // 2. Title must not pretend to be a fix.
    const titleLower = p.title.toLowerCase()
    assert.match(
      p.title,
      /manual suggestion/i,
      `proposal.title should contain "Manual suggestion" — got: ${p.title}`,
    )
    assert.ok(
      !/^applied/i.test(p.title.trim()) &&
        !/^fixed/i.test(p.title.trim()) &&
        !/^suppressed/i.test(p.title.trim()),
      `proposal.title should not present as a fix — got: ${p.title}`,
    )
    // "fix" inside "Manual suggestion (... fix ...)" would still be
    // OK; what we forbid is the title CLAIMING the code was fixed.
    assert.ok(
      !/auto[- ]fix(ed)?/i.test(titleLower) &&
        !/automatic(ally)? fix/i.test(titleLower),
      `proposal.title should not claim auto-fix — got: ${p.title}`,
    )

    // 3. Description must be honest about not changing the code.
    assert.match(
      p.description,
      /not a fix|finding will keep firing|underlying code|todo/i,
      `proposal.description should be honest about NOT fixing the code — got: ${p.description}`,
    )

    // 4. The inserted body itself (the "after" diff window) must
    //    carry the same truth so a git-blame reader sees it.
    assert.match(
      p.after,
      /MANUAL SUGGESTION/,
      `the inserted comment body should say "MANUAL SUGGESTION" so blame readers know it's not a fix — got after: ${p.after}`,
    )

    // 5. Preview mode never writes.
    assert.equal(p.applied, false)
    assert.equal(p.backup_path, null)
  } finally {
    cleanup(root)
  }
})

test("preview: rule-specific template (secrets) is NOT marker_only", () => {
  // Sanity: the marker_only flag must distinguish the two paths.
  // If a rule-specific template silently gained marker_only=true
  // we'd hide real fixes under the amber "Manual suggestion" banner.
  const root = makeTempProject({
    "config.py": "API_KEY = 'sk-deadbeefdeadbeefdeadbeefdeadbeef'\n",
  })
  try {
    const r = previewFor(root, "secrets", "config.py", 1)
    assert.equal(r.proposals.length, 1)
    const p = r.proposals[0]

    // secrets has a rule-specific rewriteLine template, so marker_only
    // MUST be false. (If this regresses, every rule-specific fix would
    // get amber-tagged.)
    assert.equal(
      p.marker_only,
      false,
      "rule-specific template must produce marker_only=false",
    )
    assert.doesNotMatch(
      p.title,
      /manual suggestion/i,
      `rule-specific template should not be titled "Manual suggestion" — got: ${p.title}`,
    )
  } finally {
    cleanup(root)
  }
})

test("apply: TODO-only patch does NOT pretend the finding is fixed", () => {
  // The user's exact complaint: clicking "Apply" on a prompt-contract
  // finding shows green "Applied" and a 0-finding table even though
  // the prompt was never rewritten. Verify the proposal stays honest
  // even after the file is written: marker_only=true survives, the
  // title still says "Manual suggestion".
  const root = makeTempProject({
    "agent.py":
      "AGENT_NAME = 'demo'\n" + "PROMPT = '''Greet the user politely.'''\n",
  })
  try {
    const r = buildAndMaybeApplyFixes({
      projectPath: root,
      mode: "apply",
      targets: [
        {
          ref_id: "t-prompt-1",
          rule_id: "prompt-contract",
          file: "agent.py",
          line: 2,
          title: "vague prompt",
        },
      ],
    })
    assert.equal(r.proposals.length, 1)
    const p = r.proposals[0]

    // It WAS applied (a comment got written to the file) BUT it's
    // not a fix. The UI uses marker_only to render "Manual
    // suggestion" instead of "Applied" and to leave the row in the
    // findings table.
    assert.equal(p.applied, true, "the TODO comment was written")
    assert.equal(
      p.marker_only,
      true,
      "applied + marker_only=true is the honest signal: 'we did write something but it's not a fix'",
    )
    assert.match(p.title, /manual suggestion/i)

    // And the file on disk must now contain the explicit
    // "MANUAL SUGGESTION" note so a future reader can't be confused
    // about whether this was a real auto-fix.
    const onDisk = fs.readFileSync(path.join(root, "agent.py"), "utf-8")
    assert.match(
      onDisk,
      /MANUAL SUGGESTION/,
      "the inserted comment on disk should explicitly mark itself as 'MANUAL SUGGESTION'",
    )
    // And the original prompt text (the actual vulnerability) must
    // still be present — we did NOT rewrite it.
    assert.match(
      onDisk,
      /Greet the user politely\./,
      "the original prompt text must still be there — we don't rewrite the vulnerable code in fallback mode",
    )
  } finally {
    cleanup(root)
  }
})
