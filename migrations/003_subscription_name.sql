-- Edge Agent AI — add account holder name to subscription rows.
--
-- Idempotent. Captured from the onboarding/welcome screen (email +
-- first/last name). Fresh installs get the columns from the updated 001
-- migration; this ALTER is a no-op there.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS first_name TEXT;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_name TEXT;
