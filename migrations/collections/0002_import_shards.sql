-- Durable, server-side resume journal for offline Collections imports. Each
-- data shard inserts its marker in the same D1 import transaction as its rows.

CREATE TABLE import_shards (
  snapshot_id TEXT NOT NULL,
  source_database_sha256 TEXT NOT NULL CHECK (length(source_database_sha256) = 64),
  shard_path TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  statement_count INTEGER NOT NULL CHECK (statement_count > 0),
  PRIMARY KEY (snapshot_id, shard_path)
) WITHOUT ROWID;
