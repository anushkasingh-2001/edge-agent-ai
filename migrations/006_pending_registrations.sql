-- Edge Agent AI — pending (unverified) registrations (Postgres).
--
-- When email verification is enforced, a signup does NOT create a `users` row.
-- Instead the credentials + a hashed OTP code are parked here, keyed by email.
-- The real account is created only when the user enters the correct code
-- (see /api/auth/verify-email). This guarantees "no account until verified",
-- lets a user re-request a code by simply registering again (upsert by email),
-- and keeps unverified attempts out of the real users table.
--
-- SECURITY: stores a scrypt password hash and a SHA-256 code hash only — never
-- plaintext password, never the raw OTP. Rows are short-lived (expires_at) and
-- swept by the auth cleanup job.
--
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS pending_registrations (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  name          TEXT,
  code_hash     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pending_registrations_expires_idx
  ON pending_registrations (expires_at);
