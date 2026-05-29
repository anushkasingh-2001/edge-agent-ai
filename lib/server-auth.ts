/**
 * Server-side authentication seam for hosted AI.
 *
 * Hosted-only contract: every AI route MUST resolve an authenticated
 * caller before touching the resolver / model / billing. The session
 * object is the ONLY way userId + workspaceId enter the resolver.
 *
 * Resolution order (highest precedence first):
 *
 *   1. **JWT bearer** — `Authorization: Bearer <jwt>`. Verified with
 *      HS256 against `JWT_SECRET` (or the legacy alias `EDGE_AGENT_
 *      JWT_SECRET`). Issuer / audience checked against `JWT_ISSUER`
 *      and `JWT_AUDIENCE` when set.
 *
 *   2. **Signed session cookie** — `__edge_session=<jwt>`. Same JWT
 *      format as the bearer path; this is what NextAuth / a real
 *      OAuth callback writes after a successful login.
 *
 *   3. **Legacy desktop GitHub login** — OFF by default. Only honoured
 *      when `EDGE_AGENT_GITHUB_SESSION=1`. GitHub is otherwise an
 *      optional integration (repo/PR access), NOT the subscription
 *      identity; the Edge Agent AI account (1/2) is the identity of
 *      record for billing and credits.
 *
 *   4. **Bearer dev token** — `EDGE_AGENT_AUTH_BEARER`. A single
 *      pre-shared token. Allowed in non-production environments. Useful
 *      for staging dashboards / curl-driven integration tests.
 *
 *   5. **Dev stub** — `EDGE_AGENT_DEV_AUTH=1`. Returns a synthetic
 *      `local-user` / `local-workspace` session. NEVER honoured when
 *      `NODE_ENV === "production"`.
 *
 * Production rule:
 *   - With `NODE_ENV=production`, only JWT (1, 2) are accepted (plus the
 *     opt-in legacy GitHub login (3) when `EDGE_AGENT_GITHUB_SESSION=1`).
 *     The bearer-dev-token (4) and dev stub (5) are inert. `assertSession`
 *     throws `AuthRequiredError`.
 *
 * Errors:
 *   - `assertSession` throws `AuthRequiredError` on no session. Routes
 *     catch it and return 401.
 *   - `getOptionalSession` returns `null` instead of throwing — used
 *     by public endpoints (e.g. /api/plan) that adapt to anonymous.
 *
 * The session object NEVER includes provider credentials.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { getStoredAuth } from "./server-github-auth"

export interface Session {
  userId: string
  workspaceId: string
  email?: string
  /** Whether the account's email has been verified. Undefined for legacy /
   *  non-account sessions (treated as verified for backward compatibility). */
  emailVerified?: boolean
  /** Full display name + given/family parts, captured at sign-up. */
  name?: string
  firstName?: string
  lastName?: string
  role?: "owner" | "member" | "viewer"
  /** Plan hint forwarded from the auth provider. Authoritative plan
   *  state lives in the billing store. */
  planHint?: "free" | "starter" | "pro" | "team" | "enterprise"
  /** Where the session came from. Surfaced in audit logs. Production
   *  values: "jwt", "cookie", "github_local". */
  authSource:
    | "jwt"
    | "cookie"
    | "github_local"
    | "bearer_dev"
    | "dev_stub"
  /** Backward-compat alias for older code paths that read `source`. */
  source?: Session["authSource"]
}

export class AuthRequiredError extends Error {
  readonly code = "not_authenticated"
  readonly status = 401
  constructor(message: string) {
    super(message)
    this.name = "AuthRequiredError"
  }
}

export class AuthInvalidError extends Error {
  readonly code = "invalid_session"
  readonly status = 401
  constructor(message: string) {
    super(message)
    this.name = "AuthInvalidError"
  }
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production"
}

function jwtSecret(): string | null {
  const s =
    (process.env.JWT_SECRET ?? "").trim() ||
    (process.env.EDGE_AGENT_JWT_SECRET ?? "").trim()
  return s.length >= 16 ? s : null
}

function devStubEnabled(): boolean {
  return !isProductionEnv() && process.env.EDGE_AGENT_DEV_AUTH === "1"
}

function bearerDevAllowed(): boolean {
  return !isProductionEnv()
}

function withAuthSource<S extends Omit<Session, "source">>(s: S): Session {
  return { ...s, source: s.authSource }
}

// ---------------------------------------------------------------------------
// JWT (HS256)
//
// We implement HS256 in-process so the package doesn't depend on a
// JWT library. Routes are free to swap in `jsonwebtoken` / `jose`
// later — the verification result (the decoded payload) is what the
// session adapter consumes. Other algorithms (RS256, ES256, JWKS)
// can be added behind a `JWT_ALG` env switch without touching callers.
// ---------------------------------------------------------------------------

interface JwtHeader {
  alg: string
  typ?: string
  kid?: string
}

interface JwtPayload {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
  iss?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
  workspaceId?: string
  role?: Session["role"]
  plan?: Session["planHint"]
  [key: string]: unknown
}

function b64UrlDecode(part: string): Buffer {
  const pad = "=".repeat((4 - (part.length % 4)) % 4)
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

function verifyHs256(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  let header: JwtHeader
  let payload: JwtPayload
  try {
    header = JSON.parse(b64UrlDecode(h).toString("utf8")) as JwtHeader
    payload = JSON.parse(b64UrlDecode(p).toString("utf8")) as JwtPayload
  } catch {
    return null
  }
  if (header.alg !== "HS256") return null
  const expected = createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest()
  let provided: Buffer
  try {
    provided = b64UrlDecode(s)
  } catch {
    return null
  }
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === "number" && payload.exp < now) return null
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null
  const expectedIss = (process.env.JWT_ISSUER ?? "").trim()
  if (expectedIss && payload.iss !== expectedIss) return null
  const expectedAud = (process.env.JWT_AUDIENCE ?? "").trim()
  if (expectedAud) {
    const aud = payload.aud
    if (typeof aud === "string" && aud !== expectedAud) return null
    if (Array.isArray(aud) && !aud.includes(expectedAud)) return null
  }
  return payload
}

function payloadToSession(p: JwtPayload, source: Session["authSource"]): Session | null {
  const userId = (p.sub ?? "").toString().trim()
  if (!userId) return null
  const workspaceId =
    (typeof p.workspaceId === "string" && p.workspaceId.trim()) || userId
  const firstName = typeof p.given_name === "string" ? p.given_name : undefined
  const lastName = typeof p.family_name === "string" ? p.family_name : undefined
  const name =
    typeof p.name === "string"
      ? p.name
      : [firstName, lastName].filter(Boolean).join(" ") || undefined
  return withAuthSource({
    userId,
    workspaceId,
    email: typeof p.email === "string" ? p.email : undefined,
    emailVerified: typeof p.email_verified === "boolean" ? p.email_verified : undefined,
    name,
    firstName,
    lastName,
    role: p.role,
    planHint: p.plan,
    authSource: source,
  })
}

// ---------------------------------------------------------------------------
// Resolvers (highest precedence first)
// ---------------------------------------------------------------------------

function resolveSessionFromAuthorizationJwt(req: Request | null): Session | null {
  if (!req) return null
  const header = req.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return null
  const secret = jwtSecret()
  if (!secret) return null
  const payload = verifyHs256(m[1].trim(), secret)
  if (!payload) return null
  return payloadToSession(payload, "jwt")
}

const SESSION_COOKIE_NAME = "__edge_session"

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? ""
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    if (k !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

function resolveSessionFromCookie(req: Request | null): Session | null {
  if (!req) return null
  const token = readCookie(req, SESSION_COOKIE_NAME)
  if (!token) return null
  const secret = jwtSecret()
  if (!secret) return null
  const payload = verifyHs256(token, secret)
  if (!payload) return null
  return payloadToSession(payload, "cookie")
}

/**
 * GitHub is NO LONGER a hosted-AI / subscription identity. The product's
 * identity of record is the Edge Agent AI account (email/password → JWT).
 * GitHub is an OPTIONAL integration for repo/PR access only (its token is
 * read directly by the git/PR routes via `getStoredAuth`, not via a session).
 *
 * This resolver therefore returns null by default. Self-hosted / legacy
 * single-user desktop builds can opt back in with
 * `EDGE_AGENT_GITHUB_SESSION=1`, but credits/billing then key off the
 * GitHub login — which is exactly what the account model replaces.
 */
function githubSessionEnabled(): boolean {
  return (process.env.EDGE_AGENT_GITHUB_SESSION ?? "").trim() === "1"
}

function resolveSessionFromGithub(): Session | null {
  if (!githubSessionEnabled()) return null
  const stored = getStoredAuth()
  if (!stored?.login) return null
  return withAuthSource({
    userId: `github:${stored.login}`,
    workspaceId: `github:${stored.login}`,
    role: "owner",
    authSource: "github_local",
  })
}

function resolveSessionFromBearerDev(req: Request | null): Session | null {
  if (!req || !bearerDevAllowed()) return null
  const header = req.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return null
  const expected = (process.env.EDGE_AGENT_AUTH_BEARER ?? "").trim()
  if (!expected || expected !== m[1].trim()) return null
  const tail = m[1].slice(-12)
  return withAuthSource({
    userId: `bearer:${tail}`,
    workspaceId: `bearer:${tail}`,
    role: "owner",
    authSource: "bearer_dev",
  })
}

function devSession(): Session {
  return withAuthSource({
    userId: process.env.EDGE_AGENT_LOCAL_USER_ID ?? "local-user",
    workspaceId: process.env.EDGE_AGENT_LOCAL_WORKSPACE_ID ?? "local-workspace",
    email: process.env.EDGE_AGENT_LOCAL_EMAIL ?? "dev@local.test",
    role: "owner",
    planHint:
      (process.env.EDGE_AGENT_PLAN_TIER as Session["planHint"] | undefined) ??
      "pro",
    authSource: "dev_stub",
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getOptionalSession(req: Request | null = null): Session | null {
  // 1. JWT in Authorization header (production canon).
  const jwt = resolveSessionFromAuthorizationJwt(req)
  if (jwt) return jwt

  // 2. Signed session cookie (NextAuth / OAuth callback canon).
  const cookie = resolveSessionFromCookie(req)
  if (cookie) return cookie

  // 3. Legacy/opt-in desktop GitHub login (EDGE_AGENT_GITHUB_SESSION=1).
  //    Off by default — GitHub is an optional integration, not the
  //    subscription identity.
  const github = resolveSessionFromGithub()
  if (github) return github

  // 4. Non-prod bearer-dev token.
  const bearer = resolveSessionFromBearerDev(req)
  if (bearer) return bearer

  // 5. Non-prod dev stub.
  if (devStubEnabled()) return devSession()

  return null
}

export function assertSession(req: Request | null = null): Session {
  const s = getOptionalSession(req)
  if (!s) {
    throw new AuthRequiredError(
      "Sign in to use AI features. Edge Agent AI requires an authenticated session for hosted model access.",
    )
  }
  if (isProductionEnv() && (s.authSource === "dev_stub" || s.authSource === "bearer_dev")) {
    // Belt-and-suspenders — neither resolver returns these in
    // production, but if a future change ever did we fail closed.
    throw new AuthInvalidError("Production sessions must come from JWT, cookie, or desktop login.")
  }
  return s
}

export function authRequiredBody(err: AuthRequiredError): {
  status: number
  body: { error: string; code: "not_authenticated"; reason: string }
} {
  return {
    status: err.status,
    body: { error: err.message, code: err.code, reason: err.message },
  }
}

export function _devSessionForTests(): Session {
  return devSession()
}

// ---------------------------------------------------------------------------
// Token issuance (production-safe)
//
// The desktop/cloud split means the cloud backend is the ONLY party that
// holds `JWT_SECRET`, so it is the ONLY party that can mint a session token.
// `issueSessionToken` is the canonical signer used by the production auth
// endpoint (`/api/auth/session`) after a real identity has been verified
// (e.g. a GitHub access token validated against GitHub's /user API).
//
// The token carries ONLY identity claims — never a provider API key, never
// Stripe/DB secrets. Verification happens via the same `verifyHs256` path
// the resolvers already use, so an expired or tampered token is rejected and
// the route returns 401.
// ---------------------------------------------------------------------------

/** Default session lifetime: 7 days. Overridable per-call. */
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

export interface IssueSessionInput {
  /** Stable user id (the JWT `sub`). Required. */
  userId: string
  /** Defaults to `userId` when omitted. */
  workspaceId?: string
  email?: string
  emailVerified?: boolean
  name?: string
  firstName?: string
  lastName?: string
  role?: Session["role"]
  planHint?: Session["planHint"]
}

export interface IssuedSession {
  token: string
  /** Absolute expiry, unix seconds. */
  expiresAt: number
  /** Lifetime in seconds. */
  expiresIn: number
}

/**
 * Mint a signed HS256 session token. Returns `null` when no usable
 * `JWT_SECRET` is configured (caller should surface a 503 — the server is
 * misconfigured, not the client). `iss`/`aud` are stamped when the matching
 * env vars are set, so the same `verifyHs256` issuer/audience checks pass.
 */
export function issueSessionToken(
  input: IssueSessionInput,
  opts: { ttlSeconds?: number } = {},
): IssuedSession | null {
  const secret = jwtSecret()
  if (!secret) return null
  const userId = (input.userId ?? "").toString().trim()
  if (!userId) return null

  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.max(60, Math.floor(opts.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS))
  const exp = now + ttl

  const payload: JwtPayload = {
    sub: userId,
    workspaceId: (input.workspaceId ?? userId).toString().trim() || userId,
    email: input.email,
    email_verified: input.emailVerified,
    name: input.name,
    given_name: input.firstName,
    family_name: input.lastName,
    role: input.role,
    plan: input.planHint,
    iat: now,
    nbf: now,
    exp,
  }
  const iss = (process.env.JWT_ISSUER ?? "").trim()
  if (iss) payload.iss = iss
  const aud = (process.env.JWT_AUDIENCE ?? "").trim()
  if (aud) payload.aud = aud

  // Drop undefined claims so the token stays compact and a decoded payload
  // never carries empty/placeholder fields.
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k]
  }

  return { token: _signHs256(payload, secret), expiresAt: exp, expiresIn: ttl }
}

/** Build a self-signed HS256 token (test/dev only). NOT for production
 *  use — production tokens come from your IdP. Exported so tests can
 *  craft realistic Authorization headers / cookies without depending
 *  on `jsonwebtoken`. */
export function _signHs256(payload: JwtPayload, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" }
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  const h = enc(header)
  const p = enc(payload)
  const sig = createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${h}.${p}.${sig}`
}

export { SESSION_COOKIE_NAME }
