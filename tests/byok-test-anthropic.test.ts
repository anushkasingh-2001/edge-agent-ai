/**
 * /api/byok/test Anthropic-specific behaviour.
 *
 * Pins:
 *   - The Anthropic test path hits the real Messages API
 *     (POST https://api.anthropic.com/v1/messages) with the spec'd
 *     headers (x-api-key, anthropic-version, content-type) and body
 *     (max_tokens=32, "Say OK only").
 *   - It does NOT use the OpenAI /v1/chat/completions format.
 *   - The 200 case returns ok=true with the resolved model id.
 *   - The "credit balance is too low" / "spend limit" case returns
 *     ok=false with code="billing_required" and the canonical
 *     "Anthropic API key works, but billing/credits or spend limit
 *     may not be enabled." prefix.
 *   - Authentication failures surface the real Anthropic message
 *     (no generic INVALID-key string).
 *   - Model-not-found is reported as model_unavailable with the
 *     upstream body.
 *
 * Run with:
 *   node --import tsx --test tests/byok-test-anthropic.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { POST as byokTest } from "../app/api/byok/test/route"

interface FetchCall {
  url: string
  init: RequestInit
}

function captureFetch(impl: (call: FetchCall) => Response): {
  restore: () => void
  calls: FetchCall[]
} {
  const orig = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} }
    calls.push(call)
    return impl(call)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = orig }, calls }
}

async function runTest(body: Record<string, unknown>) {
  const req = new Request("http://localhost/api/byok/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const res = await byokTest(req)
  return (await res.json()) as Record<string, unknown>
}

// ===================================================================
// 1. Anthropic test uses the Messages API with the spec'd payload
// ===================================================================

test("Anthropic test posts to /v1/messages with the spec'd headers + body", async () => {
  const { restore, calls } = captureFetch(() =>
    new Response(
      JSON.stringify({
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
  try {
    const j = await runTest({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
    })
    assert.equal(j.ok, true)
    assert.equal(j.provider, "anthropic")
    assert.equal(j.model, "claude-sonnet-4-6")
    assert.equal(calls.length, 1)
    const c = calls[0]
    assert.equal(c.url, "https://api.anthropic.com/v1/messages")
    assert.equal(c.init.method, "POST")
    const headers = c.init.headers as Record<string, string>
    assert.equal(headers["x-api-key"], "sk-ant-test")
    assert.equal(headers["anthropic-version"], "2023-06-01")
    assert.equal(headers["content-type"], "application/json")
    const sent = JSON.parse(String(c.init.body))
    assert.equal(sent.model, "claude-sonnet-4-6")
    assert.equal(sent.max_tokens, 32, "spec says max_tokens=32")
    assert.deepEqual(sent.messages, [{ role: "user", content: "Say OK only" }])
  } finally {
    restore()
  }
})

test("Anthropic test does NOT use the OpenAI /v1/chat/completions format", async () => {
  const { restore, calls } = captureFetch(() =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: "OK" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
  try {
    await runTest({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-haiku-4-5",
    })
    const c = calls[0]
    assert.ok(!c.url.includes("/v1/chat/completions"), "must not use OpenAI chat-completions URL")
    const sent = JSON.parse(String(c.init.body))
    assert.equal(sent.temperature, undefined, "OpenAI-style temperature must not be set")
    assert.equal(sent.response_format, undefined, "OpenAI-style response_format must not be set")
  } finally {
    restore()
  }
})

// ===================================================================
// 2. Credit / billing failure → billing_required + canonical prefix
// ===================================================================

test("Anthropic credit-balance error → billing_required with canonical prefix", async () => {
  const upstream = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  }
  const { restore } = captureFetch(() =>
    new Response(JSON.stringify(upstream), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )
  try {
    const j = await runTest({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
    })
    assert.equal(j.ok, false)
    assert.equal(j.code, "billing_required")
    assert.ok(
      String(j.message).startsWith(
        "Anthropic API key works, but billing/credits or spend limit may not be enabled.",
      ),
      `message must start with the canonical prefix, got: ${String(j.message)}`,
    )
    // The real upstream body must be surfaced — not collapsed to a
    // generic line.
    assert.ok(
      String(j.message).includes("credit balance is too low"),
      "upstream Anthropic message must be included verbatim",
    )
    assert.ok(String(j.upstream).includes("credit balance"))
  } finally {
    restore()
  }
})

// ===================================================================
// 3. Auth / model-not-found errors surface the real upstream body
// ===================================================================

test("Anthropic 401 returns code=invalid_api_key with the real Anthropic message", async () => {
  const { restore } = captureFetch(() =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    ),
  )
  try {
    const j = await runTest({
      provider: "anthropic",
      apiKey: "sk-ant-wrong",
      model: "claude-sonnet-4-6",
    })
    assert.equal(j.ok, false)
    assert.equal(j.code, "invalid_api_key")
    // The real upstream message ("invalid x-api-key") must appear in
    // the UI message — NOT the generic "API key is invalid…" line.
    assert.ok(String(j.message).includes("invalid x-api-key"))
    assert.equal(j.upstream, "invalid x-api-key")
  } finally {
    restore()
  }
})

test("Anthropic 404 model-not-found returns code=model_unavailable + upstream body", async () => {
  const { restore } = captureFetch(() =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "not_found_error", message: "model: claude-xxx not found" },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    ),
  )
  try {
    const j = await runTest({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-xxx",
    })
    assert.equal(j.ok, false)
    assert.equal(j.code, "model_unavailable")
    assert.ok(String(j.message).includes("claude-xxx not found"))
  } finally {
    restore()
  }
})
