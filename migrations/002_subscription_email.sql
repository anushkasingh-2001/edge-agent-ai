-- Edge Agent AI — add account email to subscription rows.
--
-- Idempotent. Safe to run against a database created by 001 before the
-- `email` column existed. Fresh installs already get the column from
-- the updated 001 migration; this ALTER is a no-op there.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS email TEXT;
