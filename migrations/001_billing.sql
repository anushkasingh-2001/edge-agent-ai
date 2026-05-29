-- Edge Agent AI — production billing schema (Postgres).
--
-- Run before pointing `BILLING_STORE=postgres` at this database. Safe
-- to re-run (idempotent CREATE IF NOT EXISTS).
--
-- Identifiers chosen so the SQL adapter is portable to MySQL / SQLite
-- with minimal type tweaks (TIMESTAMPTZ → DATETIME, JSONB → JSON).

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                TEXT NOT NULL,
  workspace_id           TEXT NOT NULL,
  email                  TEXT,
  first_name             TEXT,
  last_name              TEXT,
  plan_tier              TEXT NOT NULL,
  subscription_status    TEXT NOT NULL,
  credits_limit          INTEGER NOT NULL,
  credits_used           INTEGER NOT NULL DEFAULT 0,
  billing_period_start   TIMESTAMPTZ NOT NULL,
  billing_period_end     TIMESTAMPTZ NOT NULL,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_idx
  ON subscriptions (stripe_customer_id);

CREATE TABLE IF NOT EXISTS credit_usage (
  id                 UUID PRIMARY KEY,
  user_id            TEXT NOT NULL,
  workspace_id       TEXT NOT NULL,
  task               TEXT NOT NULL,
  intelligence_mode  TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  estimated_credits  INTEGER NOT NULL,
  actual_credits     INTEGER NOT NULL,
  request_id         TEXT NOT NULL,
  context_hash       TEXT,
  status             TEXT NOT NULL DEFAULT 'success',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credit_usage_user_idx
  ON credit_usage (user_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_events (
  id                BIGSERIAL PRIMARY KEY,
  stripe_event_id   TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,
  user_id           TEXT,
  workspace_id      TEXT,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_status        TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX IF NOT EXISTS billing_events_user_idx
  ON billing_events (user_id, workspace_id, processed_at DESC);

-- Optional online audit-log table. Routes that opt in (via
-- `AUDIT_LOG_STORE=postgres`) write each hosted-AI attempt here so the
-- production audit trail lives in the same database as billing. The
-- schema deliberately stores metadata only — no prompts, no source
-- code, no provider keys.
CREATE TABLE IF NOT EXISTS audit_logs (
  id                UUID PRIMARY KEY,
  user_id           TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  task              TEXT NOT NULL,
  intelligence_mode TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL,
  estimated_credits INTEGER NOT NULL DEFAULT 0,
  actual_credits    INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  error_class       TEXT,
  block_reason      TEXT,
  context_hash      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_user_idx
  ON audit_logs (user_id, workspace_id, created_at DESC);
