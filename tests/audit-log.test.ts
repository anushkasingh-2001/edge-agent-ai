/**
 * server-audit-log: begin/complete + secret redaction.
 *
 * Run: node --import tsx --test tests/audit-log.test.ts
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  beginAudit,
  completeAudit,
  logBlocked,
  redactSecrets,
  getAuditWriter,
} from "../lib/server-audit-log"

function withTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-audit-"))
  process.env.EDGE_AGENT_HOME = dir
  getAuditWriter()._resetForTests()
}

describe("audit-log", () => {
  beforeEach(withTempHome)

  it("redactSecrets masks bearer tokens, sk-... keys, and api_key= forms", () => {
    const dirty = `auth=Bearer sk-proj-ABCDEFGHIJKL_1234567890XYZQWE api_key="abcd1234efgh5678"`
    const clean = redactSecrets(dirty)
    assert.ok(!clean.includes("sk-proj"))
    assert.ok(clean.includes("[REDACTED]"), "expected at least one redacted token")
    assert.ok(!/abcd1234efgh5678/.test(clean), "api_key value must be masked")
  })

  it("begin/complete writes a single closing record per request", () => {
    const reqId = beginAudit({
      userId: "u",
      workspaceId: "w",
      task: "explain",
      intelligenceMode: "auto",
      provider: "openai_compatible",
      model: "gpt-4.1-mini",
      estimatedCredits: 1,
    })
    completeAudit(reqId, "success", { actualCredits: 1, inputTokens: 100, outputTokens: 80 })

    const recent = getAuditWriter().recent(50)
    const ours = recent.filter((r) => r.requestId === reqId)
    assert.ok(ours.length >= 2, "expected start + complete rows for the request id")
    const final = ours[ours.length - 1]
    assert.equal(final.status, "success")
    assert.equal(final.actualCredits, 1)
  })

  it("logBlocked never logs apiKey-like material", () => {
    logBlocked({
      userId: "u",
      workspaceId: "w",
      task: "explain",
      intelligenceMode: "auto",
      blockReason: "missing_hosted_key sk-test-12345",
    })
    const rows = getAuditWriter().recent(10)
    for (const r of rows) {
      const blob = JSON.stringify(r)
      assert.ok(!/sk-test-/.test(blob), "audit row must not contain raw sk- keys")
    }
  })

  it("audit records never contain `apiKey` field", () => {
    beginAudit({
      userId: "u",
      workspaceId: "w",
      task: "patch",
      intelligenceMode: "pro",
      provider: "openai_compatible",
      model: "gpt-4.1",
      estimatedCredits: 3,
    })
    const rows = getAuditWriter().recent(10)
    for (const r of rows) {
      assert.ok(!("apiKey" in r), "audit record schema must not include apiKey")
    }
  })
})
