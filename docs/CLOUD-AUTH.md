# Desktop → cloud authentication (production session/JWT flow)

The hosted cloud backend (deployed to Vercel) only serves a request after it
verifies a **session JWT** signed with the server's `JWT_SECRET`. This doc
describes how a logged-in desktop user obtains and uses that token in
production — without re-enabling the dev-only `/api/auth/dev-login` flow.

```
┌──────────────┐   1. GitHub PAT      ┌────────────────────────┐
│   Renderer   │ ───────────────────► │  Local server (desktop)│
│ (Electron UI)│                      │  /api/github/auth/login│  stores token on disk (0600)
└──────┬───────┘                      └───────────┬────────────┘
       │ 2. establishCloudSession()               │ 3. reads stored GitHub token
       │    POST /api/desktop/cloud-session        ▼
       │                              ┌────────────────────────┐
       │                              │  Local bridge route    │
       │                              │  /api/desktop/cloud-…  │
       │                              └───────────┬────────────┘
       │                                          │ 4. POST {provider:"github", token}
       │                                          ▼
       │                              ┌────────────────────────┐
       │                              │   CLOUD backend        │
       │                              │   /api/auth/session    │ 5. verify token via GitHub /user
       │                              │   (holds JWT_SECRET)   │ 6. mint signed JWT
       │  ◄───────── 7. { token } ────┴────────────────────────┘
       │ 8. setCloudAuthToken(token)
       ▼
  Subsequent cloud calls via apiFetch carry: Authorization: Bearer <token>
  Cloud routes verify it with JWT_SECRET → 401 if invalid/expired.
```

> **Identity note:** the diagram above shows the *optional* GitHub-bridge path.
> The identity of record is the **Edge Agent AI email/password account**
> (`/api/auth/register` + `/api/auth/login`). GitHub is only an optional
> integration for repo/PR access; it never owns the subscription or credits.

## Account auth production endpoints

All routes are cloud routes (CORS-enabled, `JWT_SECRET` required to sign):

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/auth/register` | POST | none | Create account. Returns access JWT + refresh token; seeds free plan; issues an email-verification token. |
| `/api/auth/login` | POST | none | Verify password, return access JWT + refresh token. |
| `/api/auth/refresh` | POST | refresh token | Rotate refresh token + mint a fresh access JWT (reflects current `email_verified`). GitHub is never used here. |
| `/api/auth/logout` | POST | none | Clear the session cookie. |
| `/api/auth/me` | GET | access JWT | Identity + plan/credit summary. |
| `/api/auth/send-verification` | POST | access JWT | (Re)issue an email-verification token. |
| `/api/auth/verify-email` | GET/POST | none (token) | Consume a verification token → `emailVerified = true`. |
| `/api/auth/forgot-password` | POST | none | Create a hashed reset token (generic 200, no enumeration). |
| `/api/auth/reset-password` | POST | none (token) | Set a new scrypt hash, consume the token. |
| `/api/auth/link/github` | POST | access JWT | Verify a GitHub token server-side, store a `linked_accounts` row. PAT never returned. |

### Token model

- **Access JWT** — HS256, ~7-day TTL, carries `sub` (userId), `workspaceId`,
  `email`, `email_verified`, `role`, `exp`. Stored client-side via
  `setCloudAuthToken`.
- **Refresh token** — opaque 256-bit random, ~30-day TTL, **rotated on every
  use**. Only its SHA-256 hash is persisted (`refresh_tokens`). Stored
  client-side via `setCloudRefreshToken`.
- **Verification / reset tokens** — opaque 256-bit random; only the SHA-256
  hash is stored (`email_verification_tokens`, `password_reset_tokens`).
  Single-use; reset tokens expire after 1h, verification after 24h. The raw
  token is **emailed in production** and only returned in the HTTP response in
  dev (`NODE_ENV !== production`, or `EDGE_AGENT_RETURN_AUTH_TOKENS=1`).

### 401 handling in `apiFetch`

On a `401` from a cloud route, `apiFetch` refreshes **once** via
`/api/auth/refresh` (using the stored refresh token) and retries the original
request **once**. If there's no refresh token, or the refresh fails, it fires
the `onLoginRequired` callback (the UI opens the account sign-in dialog). The
GitHub bridge is **never** auto-invoked.

### Email-verification gating

`emailVerificationEnforced()` is on in production (off in dev; override with
`EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION=0|1`). When enforced, an unverified
account:

- cannot create a paid checkout (`/api/billing/checkout` → 403 `email_unverified`);
- is clamped to free-tier AI in the resolver — `save`/`auto` still work within
  the free credit allowance, but `pro`/`max`/`manual` return 403 `email_unverified`.

### Email delivery

Verification and reset emails are sent via `lib/server-email.ts`:

- Set **`RESEND_API_KEY`** (uses the Resend HTTPS API, no extra dependency), or
  **`SMTP_HOST`** (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`; requires
  `pnpm add nodemailer`).
- Set **`EMAIL_FROM`** (e.g. `Edge Agent AI <noreply@yourdomain>`) and
  **`NEXT_PUBLIC_APP_URL`** (used to build the links).
- Links: `${NEXT_PUBLIC_APP_URL}/auth/verify-email?token=…` and
  `${NEXT_PUBLIC_APP_URL}/auth/reset-password?token=…` (landing pages included).
- The adapter **never logs** the body, link, or token — only provider name,
  recipient domain, and error. Sending is best-effort and never blocks the
  request or reveals whether an email exists.
- Raw tokens are returned in the HTTP response **only** in dev with
  `EDGE_AGENT_RETURN_AUTH_TOKENS=1` — **never** in production.

### Rate limiting (`lib/server-rate-limit.ts`)

Fixed-window limiter with a pluggable backend: **Upstash Redis** (shared across
instances) when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set,
otherwise **in-memory** (per instance). In production without Redis it warns once
and falls back to in-memory; a Redis outage also falls back per-call. All limited
routes return a generic **429** with `Retry-After` and never reveal whether an
email exists:

| Route | Limit |
| --- | --- |
| `/api/auth/login` | 5 **failed** attempts / (email+IP) / 15 min |
| `/api/auth/register` | 5 / IP / hour |
| `/api/auth/send-verification` | 3 / user / hour |
| `/api/auth/forgot-password` | 3 / email / hour (+ 20 / IP / hour) |
| `/api/auth/reset-password` | 10 / IP / hour |
| `/api/auth/refresh` | 30 / IP / 15 min |

### Refresh-token revocation

- `POST /api/auth/reset-password` revokes **all** of the user's refresh tokens
  after changing the password — every device must log in again.
- `POST /api/auth/logout-all` (account JWT required) revokes all refresh tokens
  for the current user and clears the session cookie.

### Token cleanup

`lib/server-auth-token-cleanup.ts` deletes spent/expired tokens:

- used or expired verification + reset tokens;
- expired refresh tokens, and refresh tokens revoked longer than
  `REFRESH_RETENTION_DAYS` (default 30) ago.

Run daily in production:

```bash
DATABASE_URL="postgres://…" pnpm auth:cleanup
```

Or schedule the cron-safe route `POST /api/auth/cleanup` (guarded by
`AUTH_CLEANUP_SECRET`; disabled/404 when the secret is unset) via Vercel Cron.

### Postgres: migrate + smoke test

Migrations `004_users.sql` (+ `email_verified` columns) and
`005_auth_tokens.sql` (verification/reset/refresh token tables) are applied by
`scripts/db-migrate.ts`, which runs every `migrations/NNN_*.sql` in order.

```bash
# 1. Apply all migrations (idempotent — safe to re-run).
DATABASE_URL="postgres://USER:PASS@HOST/DB?sslmode=require" pnpm db:migrate

# 2. Verify the live DB is reachable + every auth table exists (read-only).
DATABASE_URL="postgres://USER:PASS@HOST/DB?sslmode=require" pnpm db:user-smoke
```

Required env: `DATABASE_URL` (Neon/Postgres connection string). TLS is on by
default; set `PGSSLMODE=disable` only for a local non-TLS dev DB.

**Success output** looks like:

```json
// db:migrate
{ "ok": true, "applied": ["001_billing.sql", "...", "004_users.sql", "005_auth_tokens.sql"], "databaseUrl": "postgres://USER:***@HOST/DB" }

// db:user-smoke
{ "ok": true, "backend": "postgres", "tablesReachable": true }
```

A non-zero exit (and `"ok": false`) means a migration is missing or the DB is
unreachable. In production the account store **requires** `DATABASE_URL`;
without it the store fails safely (503 `user_db_unconfigured`) instead of
silently using a file backend.

## 1. How the desktop user logs in

1. The user signs in with GitHub in the app (a Personal Access Token today).
   `POST /api/github/auth/login` validates it against GitHub's `GET /user`
   and stores it on disk with mode `0600` (`lib/server-github-auth.ts`). The
   token never reaches the renderer.
2. The app calls `establishCloudSession()` (`lib/plan-client.ts`). That POSTs
   to the **local** bridge `POST /api/desktop/cloud-session`.

## 2. How the token is created

- The local bridge reads the stored GitHub token server-side and forwards it
  to the cloud issuer: `POST ${NEXT_PUBLIC_CLOUD_API_BASE}/api/auth/session`
  with `{ provider: "github", token }`.
- The cloud issuer (`/api/auth/session` → `lib/server-cloud-session.ts`):
  - verifies the GitHub token via `GET https://api.github.com/user`,
  - mints an HS256 JWT with `issueSessionToken()` (`lib/server-auth.ts`),
    signed with `JWT_SECRET` (alias `EDGE_AGENT_JWT_SECRET`).
- JWT claims (identity only — **never** a provider key):

  | Claim | Source |
  | --- | --- |
  | `sub` (userId) | `github:<id>` (falls back to `github:<login>`) |
  | `workspaceId` | same as `sub` |
  | `email` | GitHub `/user.email` when public, else omitted |
  | `role` | `owner` |
  | `name` | GitHub display name / login |
  | `iat`, `nbf`, `exp` | issued-at / not-before / expiry (default 7-day TTL) |
  | `iss`, `aud` | only when `JWT_ISSUER` / `JWT_AUDIENCE` are set |

- The GitHub token is **not** persisted on the cloud and **not** returned.

## 3. How the desktop stores and sends the token

- `establishCloudSession()` calls `setCloudAuthToken(token)` (`lib/api-fetch.ts`),
  which keeps it in memory and (in a browser/renderer) `localStorage`.
- Every cloud-category request made through `apiFetch()` attaches
  `Authorization: Bearer <token>` automatically (and also forwards it to the
  local `fix`/`patch` routes so they can relay it to the cloud generation
  endpoints). Provider keys are **never** attached — only the session token.
- On sign-out call `clearCloudSession()` (and the GitHub logout route).

## 4. How the cloud verifies the token

- Every hosted AI / billing / plan route resolves the caller via
  `assertSession()` / `getOptionalSession()` (`lib/server-auth.ts`), which:
  - reads `Authorization: Bearer <jwt>` (or the `__edge_session` cookie),
  - verifies the HS256 signature against `JWT_SECRET` with a constant-time
    compare,
  - enforces `exp`/`nbf` and, when configured, `iss`/`aud`.
- A missing token → `AuthRequiredError` → the route returns **401**.
- An expired/tampered/invalid token → verification fails → **401**.
- In production, the dev-stub and pre-shared bearer paths are inert; only JWT
  (header or cookie) and the local desktop GitHub session are accepted.

## Security notes

- No provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) is ever placed in
  the token or any auth response. Keys live only in the cloud environment.
- `/api/auth/dev-login` and `/api/billing/dev-checkout` remain **disabled**
  when `NODE_ENV=production`. They are unchanged by this flow.
- The cloud issuer is CORS-guarded (`lib/server-cloud-cors.ts`): loopback
  origins are always allowed; add packaged-app origins via
  `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS`.
- BYOK is not reintroduced: hosted AI remains the only path.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `JWT_SECRET` (or `EDGE_AGENT_JWT_SECRET`) | Cloud | Signs/verifies session JWTs (min 16 chars). |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Cloud (optional) | Stamped + enforced when set. |
| `NEXT_PUBLIC_CLOUD_API_BASE` | Desktop build | Cloud base the local bridge + apiFetch target. |
| `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS` | Cloud | Extra CORS origins for the desktop app. |
| `RESEND_API_KEY` | Cloud | Resend API key for transactional email. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Cloud | SMTP email (requires `nodemailer`). |
| `EMAIL_FROM` | Cloud | Sender address for auth emails. |
| `NEXT_PUBLIC_APP_URL` | Cloud | Base URL used to build verify/reset email links. |
| `EDGE_AGENT_RETURN_AUTH_TOKENS` | Dev only | `1` returns raw tokens in responses (ignored in production). |
| `AUTH_CLEANUP_SECRET` | Cloud (optional) | Enables `POST /api/auth/cleanup` for cron (Vercel `CRON_SECRET` also accepted). |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Cloud (recommended) | Shared rate-limit backend; falls back to in-memory if unset. |
| `REFRESH_RETENTION_DAYS` | Cloud (optional) | Days to keep revoked refresh tokens (default 30). |
| `DATABASE_URL` | Cloud | Postgres for the account + billing stores (required in prod). |
