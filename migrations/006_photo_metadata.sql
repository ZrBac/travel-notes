-- Additive and backward-compatible. No original media/content is changed.
ALTER TABLE media ADD COLUMN IF NOT EXISTS photo_metadata JSONB NOT NULL DEFAULT '{}';
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
