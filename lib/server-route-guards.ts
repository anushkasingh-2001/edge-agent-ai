/**
 * Shared route guards for hosted AI endpoints.
 *
 *   - `assertHostedRequest(req, body)` — call once at the top of every
 *     hosted AI POST route. Throws `RouteGuardError` for:
 *        - anonymous callers (401)
 *        - request bodies that contain BYOK-era key fields (400)
 *     Returns the resolved session on success.
 *
 * Routes catch the error and return its structured body:
 *
 *   try {
 *     const session = assertHostedRequest(req, body)
 *     ...
 *   } catch (e) {
 *     if (e instanceof RouteGuardError) return NextResponse.json(e.body, { status: e.status })
 *     throw e
 *   }
 */

import {
  AuthInvalidError,
  AuthRequiredError,
  assertSession,
  type Session,
} from "./server-auth"

/** Fields a hosted request must NEVER contain. Old clients pre-hosted
 *  may still send some of these — we reject with 400 so a misbehaving
 *  client surfaces immediately instead of silently leaking secrets. */
const FORBIDDEN_BODY_FIELDS = [
  "apiKey",
  "baseUrl",
  "providerKey",
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
] as const

export class RouteGuardError extends Error {
  readonly status: number
  readonly body: { error: string; code: string; reason: string }
  constructor(status: number, code: string, reason: string) {
    super(reason)
    this.name = "RouteGuardError"
    this.status = status
    this.body = { error: reason, code, reason }
  }
}

export function assertHostedRequest(
  req: Request,
  body: Record<string, unknown> | null | undefined,
): Session {
  if (body && typeof body === "object") {
    for (const k of FORBIDDEN_BODY_FIELDS) {
      if (k in body) {
        throw new RouteGuardError(
          400,
          "byok_not_supported",
          `Edge Agent AI is hosted-only. The '${k}' request field is no longer accepted — update the client to omit it.`,
        )
      }
    }
  }
  try {
    return assertSession(req)
  } catch (e) {
    if (e instanceof AuthRequiredError || e instanceof AuthInvalidError) {
      throw new RouteGuardError(e.status, e.code, e.message)
    }
    throw e
  }
}

export { AuthRequiredError, AuthInvalidError } from "./server-auth"
