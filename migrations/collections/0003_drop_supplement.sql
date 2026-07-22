-- Enrich the bounded drop projection with the anonymous Compass statistics
-- captured by drop-supplement. This migration is additive so an already
-- staged v1 Collections database can be discarded or inspected safely; a
-- final release is always loaded into a fresh database with all migrations.

ALTER TABLE collection_drop_cards
  ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1
  CHECK (is_private IN (0, 1));

ALTER TABLE collection_drop_cards
  ADD COLUMN transfer_count INTEGER NOT NULL DEFAULT 0
  CHECK (transfer_count >= 0);

ALTER TABLE collection_drop_cards
  ADD COLUMN email_claims_minted INTEGER
  CHECK (email_claims_minted IS NULL OR email_claims_minted >= 0);

ALTER TABLE collection_drop_cards
  ADD COLUMN email_claims_reserved INTEGER
  CHECK (email_claims_reserved IS NULL OR email_claims_reserved >= 0);

ALTER TABLE collection_drop_cards
  ADD COLUMN email_claims_total INTEGER
  CHECK (email_claims_total IS NULL OR email_claims_total >= 0);

ALTER TABLE collection_drop_cards
  ADD COLUMN featured_on TEXT;

ALTER TABLE collection_drop_cards
  ADD COLUMN moments_uploaded INTEGER
  CHECK (moments_uploaded IS NULL OR moments_uploaded >= 0);

-- Normalize legacy rows once, then keep the query column synchronized. Only
-- the exact public source value "false" opens a card; NULL and any future
-- value remain private. This also protects callers that omit is_private.
UPDATE collection_drop_cards
SET is_private = CASE WHEN private_value = 'false' THEN 0 ELSE 1 END;

CREATE TRIGGER collection_drop_cards_private_after_insert
AFTER INSERT ON collection_drop_cards BEGIN
  UPDATE collection_drop_cards
  SET is_private = CASE WHEN new.private_value = 'false' THEN 0 ELSE 1 END
  WHERE drop_id = new.drop_id;
END;

CREATE TRIGGER collection_drop_cards_private_after_source_update
AFTER UPDATE OF private_value ON collection_drop_cards BEGIN
  UPDATE collection_drop_cards
  SET is_private = CASE WHEN new.private_value = 'false' THEN 0 ELSE 1 END
  WHERE drop_id = new.drop_id;
END;

CREATE TRIGGER collection_drop_cards_private_guard
BEFORE UPDATE OF is_private ON collection_drop_cards
WHEN new.is_private <> CASE WHEN new.private_value = 'false' THEN 0 ELSE 1 END
BEGIN
  SELECT RAISE(ABORT, 'collection_drop_cards.is_private must match private_value');
END;

CREATE INDEX idx_collection_drop_cards_private
  ON collection_drop_cards(is_private, drop_id);

-- chain itself is nullable in the upstream schema. chain_key encodes the
-- identity without coalescing NULL onto any possible real chain name:
--   n:           -> NULL
--   s:<chain>    -> a concrete chain
CREATE TABLE collection_drop_stats_by_chain (
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  chain_key TEXT NOT NULL CHECK (
    chain_key = CASE WHEN chain IS NULL THEN 'n:' ELSE 's:' || chain END
  ),
  chain TEXT CHECK (chain IS NULL OR length(chain) > 0),
  created_on INTEGER CHECK (created_on IS NULL OR created_on >= 0),
  poap_count INTEGER NOT NULL CHECK (poap_count >= 0),
  transfer_count INTEGER NOT NULL CHECK (transfer_count >= 0),
  PRIMARY KEY (drop_id, chain_key),
  FOREIGN KEY (drop_id) REFERENCES collection_drop_cards(drop_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_drop_stats_chain
  ON collection_drop_stats_by_chain(chain_key, poap_count DESC, drop_id);

-- Approved suggestions are the only suggestion status suitable for a public
-- collection view. Keep that bounded lookup off the general status index.
CREATE INDEX idx_suggested_drops_approved
  ON suggested_drops(collection_id, created_on DESC, suggestion_id DESC)
  WHERE curation_status = 'approved';
