-- Durable resume journal for the staged Moments import. Wrangler imports one
-- SQL file atomically, so each load shard records its own marker in the same
-- implicit transaction as its rows.

CREATE TABLE import_shards (
  snapshot_id TEXT NOT NULL,
  source_database_sha256 TEXT NOT NULL CHECK (
    length(source_database_sha256) = 64
    AND source_database_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  shard_path TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  table_name TEXT NOT NULL CHECK (length(table_name) > 0),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  statement_count INTEGER NOT NULL CHECK (statement_count > 0),
  PRIMARY KEY (snapshot_id, shard_path)
) WITHOUT ROWID;
