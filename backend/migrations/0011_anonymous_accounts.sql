-- This is owner-only account metadata. Public handles and key-derived UUIDs
-- keep their existing shape; anonymous signup changes optional telemetry policy.
ALTER TABLE profiles
    ADD COLUMN is_anonymous BOOLEAN NOT NULL DEFAULT FALSE;
