-- Ownership data is isolated from the public catalog so ordinary browsing never
-- scans or opens the multi-million-row token database.

CREATE TABLE archive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE tokens (
  source_uid TEXT NOT NULL,
  poap_id INTEGER NOT NULL CHECK (poap_id > 0),
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  minted_on INTEGER NOT NULL CHECK (minted_on >= 0),
  owner_address_norm TEXT NOT NULL CHECK (
    length(owner_address_norm) = 42
    AND substr(owner_address_norm, 1, 2) = '0x'
    AND substr(owner_address_norm, 3) NOT GLOB '*[^0-9a-f]*'
    AND owner_address_norm = lower(owner_address_norm)
  ),
  network TEXT NOT NULL CHECK (length(network) > 0),
  transfer_count INTEGER NOT NULL CHECK (transfer_count >= 0),
  PRIMARY KEY (
    owner_address_norm,
    poap_id DESC,
    source_uid DESC
  )
) WITHOUT ROWID;

CREATE TABLE owner_stats (
  owner_address_norm TEXT PRIMARY KEY CHECK (
    length(owner_address_norm) = 42
    AND substr(owner_address_norm, 1, 2) = '0x'
    AND substr(owner_address_norm, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  token_count INTEGER NOT NULL CHECK (token_count > 0),
  unique_drop_count INTEGER NOT NULL CHECK (unique_drop_count > 0),
  first_minted_on INTEGER NOT NULL CHECK (first_minted_on >= 0),
  last_minted_on INTEGER NOT NULL CHECK (last_minted_on >= first_minted_on)
) WITHOUT ROWID;

-- The clustered primary key directly serves the only public token query.
-- Import validation separately enforces source_uid global uniqueness.
