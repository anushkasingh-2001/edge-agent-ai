-- Edge Agent AI — account identity schema (Postgres).
--
-- The product's identity of record. Subscriptions/credits/Stripe customers
-- key off users.id / workspaces.id (see migrations/001_billing.sql), NOT off
-- a GitHub login. GitHub (and other providers) live in linked_accounts as an
-- OPTIONAL integration for repo/PR access.
--
-- Safe to re-run (idempotent CREATE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  name               TEXT,
  -- scrypt digest (server-password.ts). NEVER a plaintext password.
  password_hash      TEXT NOT NULL,
  email_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspaces_owner_idx
  ON workspaces (owner_user_id);

-- Optional external integrations (e.g. GitHub). `token_ref` is an opaque
-- reference to where the provider token is held server-side — never the
-- token itself, and never returned to the renderer. No provider API keys.
CREATE TABLE IF NOT EXISTS linked_accounts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  token_ref         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS linked_accounts_user_idx
  ON linked_accounts (user_id);
