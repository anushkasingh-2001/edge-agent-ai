# Deploying the Edge Agent cloud backend to Vercel

The desktop app (Electron) runs a **local** Next.js server for everything that
touches the user's machine (scanner, git, file read/write, patch *apply*). All
**AI generation, billing, auth, and plan** calls are sent to a **hosted cloud
backend** that you deploy here. The desktop reaches it via
`NEXT_PUBLIC_CLOUD_API_BASE` (see `lib/api-fetch.ts`).

Provider keys (OpenAI/Anthropic), Stripe secrets, the JWT secret and the
`DATABASE_URL` live **only** on this Vercel deployment. They are never bundled
into the desktop app — `lib/desktop-secret-denylist.ts` + `electron/main.ts`
strip them from the local server's environment.

This same repo is deployed to Vercel as the cloud backend. The desktop-only
routes (scanner/git/workspace) are also present but simply unused on Vercel.

---

## A. Deploy steps

### 1. Create the project on Vercel

```bash
# one-time
npm i -g vercel
cd /path/to/edge-agent-recovered
vercel login
vercel link            # create/select the Vercel project
```

`vercel.json` is already committed and pins the framework + commands:

```json
{
  "framework": "nextjs",
  "installCommand": "ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile",
  "buildCommand": "pnpm build"
}
```

`ELECTRON_SKIP_BINARY_DOWNLOAD=1` keeps Vercel from downloading the ~150 MB
Electron binary during install (the cloud backend doesn't need it).
`.vercelignore` keeps the scanner/Electron artifacts out of the upload.

### 2. Add environment variables (section B) + run readiness check

```bash
# Load your production env locally (or export vars inline), then:
PROD_CHECK=1 DATABASE_URL='postgres://…' pnpm prod:check
```

Fix any `"status": "fail"` items before deploying. Warnings (e.g. missing Upstash
in local dev) are OK during local checks; resolve them before production.

### 3. Run database migrations (section below) against Neon/Postgres

### 4. Deploy

```bash
vercel --prod
```

Vercel prints the production URL, e.g. `https://edge-agent-cloud.vercel.app`.
That is your `NEXT_PUBLIC_CLOUD_API_BASE` value (section C/D).

### 5. Verify the routes

After deploy, these should respond (most require a valid session/JWT, so a
401/403 is a *healthy* response — it proves the route is live and auth is on):

| Route | Purpose |
| --- | --- |
| `GET  /api/system/health` | readiness sweep (shows missing env) |
| `POST /api/hosted/chat` | hosted chat completion |
| `POST /api/cloud/finding/patch-generate` | single-finding patch generation |
| `POST /api/cloud/findings/fix-generate` | deterministic-fix LLM upgrade |
| `POST /api/cloud/findings/fix-filtered-generate` | bulk/clustered generation |
| `POST /api/finding/explain` | finding explanation |
| `POST /api/billing/checkout` | Stripe Checkout session |
| `POST /api/billing/portal` | Stripe billing portal |
| `POST /api/billing/webhook` | Stripe → subscription sync |
| `GET  /api/plan` | current plan/entitlements |

Quick smoke test:

```bash
curl -s https://<your-app>.vercel.app/api/system/health | jq
```

---

## B. Final Vercel environment variables

Set these in **Vercel → Project → Settings → Environment Variables** for
**Production** (and Preview if desired). Never prefix server secrets with
`NEXT_PUBLIC_` — only the URL vars below are public.

### Dummy billing mode (testing / staging — no Stripe)

Use this while you are **not** taking real payments. Both flags must be set:

| Variable | Where | Purpose |
| --- | --- | --- |
| `BILLING_MOCK=1` | Vercel cloud | Enables `/api/billing/dev-checkout` — instant plan upgrade, no Stripe |
| `NEXT_PUBLIC_BILLING_MOCK=1` | Vercel + desktop build | UI shows demo label; Subscribe/Upgrade uses mock checkout |

When `BILLING_MOCK=1`:

- **Stripe env vars are optional** (`pnpm prod:check` skips them).
- Users click **Upgrade to Pro/Team** in Settings → plan + credits update immediately in Postgres.
- UI shows: **“Demo billing mode — no real payment charged.”**
- Real Stripe routes (`/api/billing/checkout`, webhook) remain in the codebase for later.

When ready for real payments: unset both flags, add Stripe env vars, redeploy.

See [Testing with dummy payments](#h-testing-with-dummy-payments) below.

### Required (cloud backend — always)

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Neon/Postgres connection string (pooled URL, `?sslmode=require`). Billing + account stores require this in production. |
| `OPENAI_API_KEY` | Server-side hosted key (`sk-…`). Never in the desktop app. |
| `ANTHROPIC_API_KEY` | Server-side hosted key. Never in the desktop app. |
| `STRIPE_SECRET_KEY` | `sk_live_…` or `sk_test_…`. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the Stripe webhook endpoint (section E). |
| `STRIPE_PRICE_STARTER` | Stripe Price ID `price_…` for Starter. |
| `STRIPE_PRICE_PRO` | Stripe Price ID for Pro. |
| `STRIPE_PRICE_TEAM` | Stripe Price ID for Team. |
| `JWT_SECRET` | Session JWT signing secret, **min 16 chars**. (`EDGE_AGENT_JWT_SECRET` alias accepted.) |
| `RESEND_API_KEY` | `re_…` from [resend.com](https://resend.com) — default email provider (section F). |
| `EMAIL_FROM` | Sender, e.g. `Edge Agent AI <noreply@yourdomain.com>`. Domain must be verified in Resend. |
| `AUTH_CLEANUP_SECRET` | Long random string guarding `POST /api/auth/cleanup`. Vercel `CRON_SECRET` also works. |
| `NEXT_PUBLIC_APP_URL` | Public base URL, e.g. `https://<your-app>.vercel.app`. Used for email links + redirects. |
| `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS` | Comma-separated CORS origins for cloud API calls. See note below. |

### Required for real Stripe payments only (`BILLING_MOCK` off)

| Variable | Notes |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_live_…` or `sk_test_…`. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the Stripe webhook endpoint (section E). |
| `STRIPE_PRICE_STARTER` | Stripe Price ID `price_…` for Starter. |
| `STRIPE_PRICE_PRO` | Stripe Price ID for Pro. |
| `STRIPE_PRICE_TEAM` | Stripe Price ID for Team. |
| `NEXT_PUBLIC_BILLING_SUCCESS_URL` | Post-checkout success URL. |
| `NEXT_PUBLIC_BILLING_CANCEL_URL` | Checkout cancel URL. |

> The three Stripe price vars double as the **price → tier** map used by the
> webhook (`mapStripePriceToTier`), so they must be set on the deployment that
> receives webhooks.

### Recommended for production

| Variable | Notes |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL — **shared** auth rate limits across serverless instances. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token (paired with URL above). Without both, limits are per-instance only. |

### Desktop build only (not on Vercel)

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_CLOUD_API_BASE` | `https://<your-vercel-cloud-url>` — inlined at desktop **build** time. |
| `NEXT_PUBLIC_BILLING_MOCK=1` | Match cloud `BILLING_MOCK=1` so Upgrade buttons use dummy checkout. |

The desktop app must **never** include: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DATABASE_URL`, `STRIPE_SECRET_KEY`, or `STRIPE_WEBHOOK_SECRET`. These are
stripped by `lib/desktop-secret-denylist.ts` + `electron/main.ts`.

### Optional

| Variable | Notes |
| --- | --- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP email instead of Resend (requires `pnpm add nodemailer`). Resend is preferred. |
| `REFRESH_RETENTION_DAYS` | Days to keep revoked refresh tokens before cleanup (default `30`). |
| `CRON_SECRET` | Vercel built-in cron secret (alternative to `AUTH_CLEANUP_SECRET`). |

### Optional — scan-time intelligence models

The post-scan LLM verifier + gap-audit layer (`lib/scan-intelligence`, used by
`/api/scan` for Balanced/Deep/Exhaustive modes) resolves concrete models from
these env vars. All have sensible defaults — set them only to pin a specific
model. If neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` is present the layer
**skips AI gracefully** and returns the deterministic findings with
`intelligence_summary.ai_skipped_reason`. Scan-time AI is **not credit-metered**
(it uses the server provider key directly); the deterministic scan is identical
in every mode.

| Variable | Default | Used by |
| --- | --- | --- |
| `EDGE_AGENT_OPENAI_CHEAP_MODEL` | `gpt-5.4-mini` | Balanced verifier (first pass), Balanced gap audit |
| `EDGE_AGENT_OPENAI_ULTRA_CHEAP_MODEL` | `gpt-5.4-nano` | Reserved for ultra-cheap low-risk triage |
| `EDGE_AGENT_OPENAI_MID_MODEL` | `gpt-5.4` | Balanced escalation (high/critical uncertain) |
| `EDGE_AGENT_OPENAI_STRONG_MODEL` | `gpt-5.5` | Deep/Exhaustive verifier + gap audit + judge |
| `EDGE_AGENT_ANTHROPIC_CHEAP_MODEL` | `claude-haiku-4-5` | Balanced verifier / gap audit (Anthropic) |
| `EDGE_AGENT_ANTHROPIC_MID_MODEL` | `claude-sonnet-4-6` | Balanced escalation (Anthropic) |
| `EDGE_AGENT_ANTHROPIC_STRONG_MODEL` | `claude-sonnet-4-6` | Deep/Exhaustive verifier + gap audit (Anthropic) |
| `EDGE_AGENT_ANTHROPIC_EXHAUSTIVE_JUDGE_MODEL` | `claude-opus-4-8` | Deep/Exhaustive second-pass judge (critical/uncertain only) |
| `EDGE_AGENT_SCAN_EXHAUSTIVE_MAX_CALLS` | `80` | Per-scan AI-call budget for Exhaustive mode |
| `EDGE_AGENT_HOSTED_ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | Override Anthropic base URL |

Per-scan AI-call budgets are fixed by mode: Lite `0`, Balanced `8`, Deep `30`,
Exhaustive `80` (configurable via `EDGE_AGENT_SCAN_EXHAUSTIVE_MAX_CALLS`).

### Do **not** set in production cloud

| Variable | Why |
| --- | --- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Not used; OpenAI + Anthropic is the hosted stack. |
| `EDGE_AGENT_CUSTOM_API_KEY` | BYOK — not supported. |
| `EDGE_AGENT_RETURN_AUTH_TOKENS=1` | Dev only; exposes raw auth tokens in API responses. Ignored in production but must stay unset. |
| Any `NEXT_PUBLIC_*` server secret | e.g. `NEXT_PUBLIC_OPENAI_API_KEY` — never expose keys in the client bundle. |

### About `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS`

`lib/server-cloud-cors.ts` always allows **loopback** origins (local dev /
desktop renderer) automatically. Set this var for any additional origins:

- During dev against the deployed backend from a browser: add your local web
  origin, e.g. `http://localhost:3000`.
- For a packaged desktop app whose renderer uses a custom scheme, add that
  origin (or use `*` for early testing only — tighten before GA).

Example: `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS=http://localhost:3000,https://<your-app>.vercel.app`

---

## Running the DB migration against Neon/Postgres

The schema is idempotent (`migrations/00*.sql`, applied in order by
`scripts/db-migrate.ts`):

| Migration | Tables created |
| --- | --- |
| `001_billing.sql` | `subscriptions`, `credit_usage`, `billing_events`, `audit_logs` |
| `002_subscription_email.sql` | (column alters on `subscriptions`) |
| `003_subscription_name.sql` | (column alters on `subscriptions`) |
| `004_users.sql` | `users`, `workspaces`, `linked_accounts` |
| `005_auth_tokens.sql` | `email_verification_tokens`, `password_reset_tokens`, `refresh_tokens` |

```bash
DATABASE_URL='postgres://USER:PASS@HOST/db?sslmode=require' pnpm db:migrate
```

Expected output:

```json
{
  "ok": true,
  "applied": ["001_billing.sql", "002_…", "003_…", "004_users.sql", "005_auth_tokens.sql"],
  "databaseUrl": "postgres://USER:***@HOST/db"
}
```

Re-running is safe. Do not print or commit the URL.

### Postgres smoke test

Confirms connectivity, all 10 tables exist, and auth store queries work:

```bash
DATABASE_URL='postgres://USER:PASS@HOST/db?sslmode=require' pnpm db:user-smoke
```

Expected output:

```json
{
  "ok": true,
  "backend": "postgres",
  "tablesReachable": true,
  "tables": "All 10 expected tables exist."
}
```

---

## C. Cloud API URL

After `vercel --prod`, copy the printed Production URL:

```
https://<your-app>.vercel.app
```

(Or attach a custom domain in Vercel → Settings → Domains and use that.)

---

## D. Desktop ↔ cloud split

| Layer | Runs where | Handles |
| --- | --- | --- |
| **Cloud backend (Vercel)** | Your deployment | AI generation, billing, auth, plans, email, Stripe webhooks |
| **Desktop local server** | User's machine (127.0.0.1) | Scanner, git, file read/write, patch *apply* |

When building/packaging the desktop app, set the cloud base **at build time**
(it is inlined into the client bundle):

```bash
NEXT_PUBLIC_CLOUD_API_BASE=https://<your-app>.vercel.app
```

Use this in the environment for `pnpm build:standalone` /
`pnpm package:mac|win|linux`.

**Desktop must never include** (stripped automatically, but do not set in build env):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Validate a desktop build env locally:

```bash
PROD_CHECK_DESKTOP=1 NEXT_PUBLIC_CLOUD_API_BASE=https://<your-app>.vercel.app pnpm prod:check --skip-db
```

---

## E. Stripe setup

### 1. Create products and prices

In [Stripe Dashboard → Products](https://dashboard.stripe.com/products):

1. Create **Starter**, **Pro**, and **Team** products (or reuse existing ones).
2. Add a recurring **Price** to each product.
3. Copy each Price ID (`price_…`) into Vercel:
   - `STRIPE_PRICE_STARTER`
   - `STRIPE_PRICE_PRO`
   - `STRIPE_PRICE_TEAM`

Also set `STRIPE_SECRET_KEY` (`sk_live_…` or `sk_test_…`).

### 2. Webhook endpoint

Stripe Dashboard → **Developers → Webhooks → Add endpoint**:

- **Endpoint URL:** `https://<your-app>.vercel.app/api/billing/webhook`
- **Events to send:**
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`

Copy the endpoint **Signing secret** (`whsec_…`) into Vercel as
`STRIPE_WEBHOOK_SECRET`, then redeploy.

---

## F. Auth email, token cleanup & rate limiting

### Resend email (default provider)

Verification and password-reset emails are sent by `lib/server-email.ts`.

1. Create an account at [resend.com](https://resend.com).
2. **Verify your sending domain** (Resend → Domains → add DNS records).
3. Set on Vercel:
   - `RESEND_API_KEY=re_…`
   - `EMAIL_FROM="Edge Agent AI <noreply@yourdomain.com>"`
   - `NEXT_PUBLIC_APP_URL=https://<your-app>.vercel.app`
4. Deploy. When `RESEND_API_KEY` is set, emails go through Resend's HTTPS API
   (no extra dependency). SMTP is optional fallback only.

Email links (landing pages included):

- Verify: `${NEXT_PUBLIC_APP_URL}/auth/verify-email?token=…`
- Reset: `${NEXT_PUBLIC_APP_URL}/auth/reset-password?token=…`

**Test after deploy:**

1. Register a test account → check inbox for verification email.
2. Use **Forgot password** → check inbox for reset email.
3. Confirm links open the `/auth/verify-email` and `/auth/reset-password` pages.
4. Raw tokens must **not** appear in API JSON responses in production.

**Security:** the adapter never logs the body, link, or token.

### Vercel Cron — auth token cleanup

`vercel.json` registers a daily cron that calls the cleanup endpoint:

```json
{ "crons": [ { "path": "/api/auth/cleanup", "schedule": "0 4 * * *" } ] }
```

1. Set `AUTH_CLEANUP_SECRET` (any long random string) on Vercel. If you instead
   set Vercel's built-in `CRON_SECRET`, that is also accepted — Vercel Cron
   automatically sends `Authorization: Bearer $CRON_SECRET`.
2. Without a secret configured, `/api/auth/cleanup` is **disabled (404)** so it
   can't be triggered anonymously.

The job deletes **used/expired** verification + reset tokens and **expired**
refresh tokens (plus refresh tokens revoked longer than `REFRESH_RETENTION_DAYS`
ago). Active, valid tokens are preserved. It returns only delete counts.

Manual run (e.g. from your machine, against the same DB):

```bash
DATABASE_URL='postgres://…' pnpm auth:cleanup
# or hit the deployed route:
curl -s -X POST "https://<your-app>.vercel.app/api/auth/cleanup?key=$AUTH_CLEANUP_SECRET" | jq
```

### Upstash Redis — shared rate limiting (recommended in production)

The auth rate limiter (`lib/server-rate-limit.ts`) is backed by:

- **Upstash Redis** when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
  are set → limits are shared across **all** serverless instances.
- **In-memory** otherwise → per-instance only (fine for local/dev).

Setup: create a database at [upstash.com](https://upstash.com), copy the REST
URL + token, and add both to Vercel. No code change needed — the limiter selects
Redis automatically.

**Fallback behavior:**
- Local/dev without Upstash → in-memory limiter (works out of the box).
- Production without Upstash → the app **warns once** in the logs and falls back
  to per-instance in-memory limits (fail-safe; the endpoint still enforces a
  limit, just not globally).
- If a Redis call fails at runtime → the limiter logs once and falls back to
  in-memory for that call (never blocks the request on a Redis outage).

Limits enforced (unchanged):

| Route | Limit |
| --- | --- |
| `/api/auth/login` | 5 **failed** attempts / (email+IP) / 15 min |
| `/api/auth/register` | 5 / IP / hour |
| `/api/auth/send-verification` | 3 / user / hour |
| `/api/auth/forgot-password` | 3 / email / hour (+ 20 / IP / hour) |
| `/api/auth/reset-password` | 10 / IP / hour |
| `/api/auth/refresh` | 30 / IP / 15 min |

All return a generic **429** with `Retry-After`; none reveal whether an email
exists.

### Production checklist

- [ ] All **required** env vars in section B set on Vercel Production.
- [ ] `pnpm db:migrate` run against production `DATABASE_URL`.
- [ ] `pnpm db:user-smoke` passes against production `DATABASE_URL`.
- [ ] `PROD_CHECK=1 pnpm prod:check` passes (Stripe vars **skipped** if `BILLING_MOCK=1`, **required** if off).
- [ ] If `BILLING_MOCK=1`: dummy upgrade tested (Settings → Upgrade → credits change).
- [ ] If `BILLING_MOCK=0`: Stripe products/prices + webhook live with all 6 events.
- [ ] Resend domain verified; test verification + reset emails received.
- [ ] `AUTH_CLEANUP_SECRET` (or `CRON_SECRET`) set; cron visible in Vercel → Crons.
- [ ] `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set for shared rate limits.
- [ ] `EDGE_AGENT_RETURN_AUTH_TOKENS` **unset** in production.
- [ ] `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS` tightened to real origins.
- [ ] Desktop build uses `NEXT_PUBLIC_CLOUD_API_BASE=https://<your-app>.vercel.app`.
- [ ] Desktop build env has **no** cloud secrets (`OPENAI_API_KEY`, etc.).

---

## G. Pre-deploy smoke-test commands

Run from the repo root before `vercel --prod`:

```bash
# 1. Apply migrations (once per DB, or after schema changes)
DATABASE_URL='postgres://USER:PASS@HOST/db?sslmode=require' pnpm db:migrate

# 2. Verify Postgres tables + auth store
DATABASE_URL='postgres://USER:PASS@HOST/db?sslmode=require' pnpm db:user-smoke

# 3. Production readiness (env + schema). Export all Vercel Production vars first,
#    or pass DATABASE_URL inline:
BILLING_MOCK=1 PROD_CHECK=1 DATABASE_URL='postgres://…' pnpm prod:check

# 4. Typecheck + tests + build
npx tsc --noEmit
EDGE_AGENT_HOME=$(mktemp -d) npx tsx --test tests/*.test.ts
pnpm build

# 5. Deploy
vercel --prod

# 6. Post-deploy smoke
curl -s https://<your-app>.vercel.app/api/system/health | jq
# Register + test dummy upgrade (Settings → Upgrade) or Stripe checkout
```

Optional: validate desktop packaging env before `pnpm package:mac`:

```bash
PROD_CHECK_DESKTOP=1 \
  NEXT_PUBLIC_CLOUD_API_BASE=https://<your-app>.vercel.app \
  NEXT_PUBLIC_BILLING_MOCK=1 \
  pnpm prod:check --skip-db
```

---

## H. Testing with dummy payments

**Vercel (cloud backend):**

```bash
BILLING_MOCK=1
NEXT_PUBLIC_BILLING_MOCK=1
# … plus DATABASE_URL, JWT_SECRET, OPENAI/ANTHROPIC keys, Resend, etc.
# Stripe vars NOT required
```

**Flow:**

1. User registers/logs in with Edge Agent AI account (`/api/auth/register` or `/api/auth/login`).
2. Settings → **Upgrade to Pro** (or Team/Starter).
3. Server calls `/api/billing/dev-checkout` → subscription row updated in Postgres.
4. Credits and allowed AI modes refresh immediately (Team includes Max mode).

**Verify:**

```bash
BILLING_MOCK=1 PROD_CHECK=1 DATABASE_URL='postgres://…' pnpm prod:check
# Stripe keys should show "skip" not "fail"
```

**Optional demo email login** (Plan & Billing page only): `/api/auth/dev-login` also works when `BILLING_MOCK=1` — passwordless email for quick demos. Production identity should still use real account auth.

---

## I. Real Stripe payments later

When you are ready to charge cards:

1. Unset `BILLING_MOCK` and `NEXT_PUBLIC_BILLING_MOCK` on Vercel and desktop builds.
2. Add all Stripe env vars (section B — “Required for real Stripe payments only”).
3. Create products/prices + webhook (section E).
4. Run `PROD_CHECK=1 pnpm prod:check` — Stripe vars must pass (no `"skip"`).
5. Redeploy. Upgrade buttons will open Stripe Checkout instead of mock upgrade.

Stripe code paths are unchanged: `/api/billing/checkout`, `/api/billing/webhook`, `/api/billing/portal`.

---

## Notes / limits

- **Function duration:** all AI/cloud routes declare `maxDuration = 60`, so the
  deploy builds on **any** Vercel plan (Hobby caps functions at 60s). The cloud
  generation path is a single model call, well under 60s.
- **Runtime:** all routes use the default **Node.js** runtime (required for the
  Stripe HMAC signature check and JWT signing). None use the Edge runtime.
- **Auth in production:** `/api/auth/dev-login` and `/api/billing/dev-checkout` work when
  `BILLING_MOCK=1` (including on Vercel). They are disabled when mock billing is off.
  Real account auth uses `/api/auth/register` + `/api/auth/login`. See
  [docs/CLOUD-AUTH.md](./CLOUD-AUTH.md).
