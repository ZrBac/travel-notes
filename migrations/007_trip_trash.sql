-- Keep travel material for restoration; no existing departures are deleted.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
