-- Address exports need an exact owner lookup without scanning the complete
-- Collections snapshot. The sort columns make the index serve keyset
-- pagination directly and keep requests bounded as the archive grows.

CREATE INDEX idx_collections_owner_recent
  ON collections(owner_address_norm, updated_on DESC, collection_id DESC)
  WHERE owner_address_norm IS NOT NULL;
