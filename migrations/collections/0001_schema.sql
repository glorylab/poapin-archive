-- Curated POAP Collections are captured independently from the fixed archive
-- snapshot. Keeping them in a third database lets their snapshot and release
-- lifecycle change without rewriting the catalog or holdings databases.

CREATE TABLE collections_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE collections (
  collection_id INTEGER PRIMARY KEY CHECK (collection_id > 0),
  slug TEXT NOT NULL CHECK (length(slug) > 0),
  title TEXT NOT NULL CHECK (length(title) > 0),
  description TEXT,
  type TEXT,
  type_rank INTEGER,
  year INTEGER,
  created_by TEXT,
  owner_address TEXT,
  owner_address_norm TEXT CHECK (
    owner_address_norm IS NULL OR (
      length(owner_address_norm) = 42
      AND substr(owner_address_norm, 1, 2) = '0x'
      AND substr(owner_address_norm, 3) NOT GLOB '*[^0-9a-f]*'
      AND owner_address_norm = lower(owner_address_norm)
    )
  ),
  external_url TEXT,
  logo_image_url TEXT,
  banner_image_url TEXT,
  created_on TEXT NOT NULL,
  updated_on TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  section_count INTEGER NOT NULL DEFAULT 0 CHECK (section_count >= 0)
);

-- Slugs are intentionally non-unique in the source. Public identities and
-- routes must always include collection_id.
CREATE INDEX idx_collections_slug
  ON collections(slug, collection_id);
CREATE INDEX idx_collections_recent
  ON collections(updated_on DESC, collection_id DESC);
CREATE INDEX idx_collections_type_recent
  ON collections(type, updated_on DESC, collection_id DESC);
CREATE INDEX idx_collections_year_recent
  ON collections(year, updated_on DESC, collection_id DESC);

CREATE VIRTUAL TABLE collections_fts USING fts5(
  slug,
  title,
  description,
  content = 'collections',
  content_rowid = 'collection_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER collections_fts_after_insert AFTER INSERT ON collections BEGIN
  INSERT INTO collections_fts(rowid, slug, title, description)
  VALUES (new.collection_id, new.slug, new.title, new.description);
END;

CREATE TRIGGER collections_fts_after_delete AFTER DELETE ON collections BEGIN
  INSERT INTO collections_fts(
    collections_fts,
    rowid,
    slug,
    title,
    description
  ) VALUES (
    'delete',
    old.collection_id,
    old.slug,
    old.title,
    old.description
  );
END;

CREATE TRIGGER collections_fts_after_update AFTER UPDATE ON collections BEGIN
  INSERT INTO collections_fts(
    collections_fts,
    rowid,
    slug,
    title,
    description
  ) VALUES (
    'delete',
    old.collection_id,
    old.slug,
    old.title,
    old.description
  );
  INSERT INTO collections_fts(rowid, slug, title, description)
  VALUES (new.collection_id, new.slug, new.title, new.description);
END;

-- D1 cannot join another bound database. This bounded card projection keeps
-- collection item pages useful even when a referenced drop is absent from the
-- older CATALOG_DB snapshot. It is not the canonical drop archive.
CREATE TABLE collection_drop_cards (
  drop_id INTEGER PRIMARY KEY CHECK (drop_id > 0),
  fancy_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  expiry_date TEXT,
  year INTEGER NOT NULL,
  city TEXT,
  country TEXT,
  event_url TEXT,
  image_url TEXT,
  animation_url TEXT,
  image_object_key TEXT,
  is_virtual INTEGER CHECK (is_virtual IS NULL OR is_virtual IN (0, 1)),
  private_value TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  channel TEXT,
  platform TEXT,
  location_type TEXT,
  timezone TEXT,
  integrator_id TEXT,
  created_date TEXT NOT NULL,
  token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0)
);

CREATE TABLE collection_items (
  item_id INTEGER PRIMARY KEY CHECK (item_id > 0),
  collection_id INTEGER NOT NULL CHECK (collection_id > 0),
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  created_on TEXT,
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

-- The first index serves collection-detail keyset pagination. The reverse
-- index supports bounded drop-to-collection and address progress lookups.
CREATE INDEX idx_collection_items_collection
  ON collection_items(collection_id, item_id);
CREATE INDEX idx_collection_items_drop
  ON collection_items(drop_id, collection_id, item_id);

CREATE TABLE collection_sections (
  section_id TEXT PRIMARY KEY CHECK (length(section_id) > 0),
  collection_id INTEGER NOT NULL CHECK (collection_id > 0),
  name TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_sections_collection
  ON collection_sections(collection_id, position, section_id);

CREATE TABLE collection_item_sections (
  item_id INTEGER NOT NULL CHECK (item_id > 0),
  section_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (section_id, position, item_id),
  UNIQUE (item_id, section_id),
  FOREIGN KEY (item_id) REFERENCES collection_items(item_id) ON DELETE CASCADE,
  FOREIGN KEY (section_id) REFERENCES collection_sections(section_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_item_sections_item
  ON collection_item_sections(item_id, section_id);

CREATE TABLE collection_urls (
  url_id INTEGER PRIMARY KEY CHECK (url_id > 0),
  collection_id INTEGER NOT NULL CHECK (collection_id > 0),
  url TEXT NOT NULL CHECK (length(url) > 0),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

CREATE INDEX idx_collection_urls_collection
  ON collection_urls(collection_id, url_id);

CREATE TABLE collection_ui_settings (
  collection_id INTEGER PRIMARY KEY CHECK (collection_id > 0),
  primary_color TEXT,
  highlight_color TEXT,
  dark_color TEXT,
  grey_color TEXT,
  white_color TEXT,
  is_visible_in_recent_list INTEGER NOT NULL CHECK (is_visible_in_recent_list IN (0, 1)),
  toggle_poap_elements INTEGER NOT NULL CHECK (toggle_poap_elements IN (0, 1)),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

-- Collection logos and banners are copied only after the downloader validates
-- their host, redirects, bytes, and media signature. Source URLs remain here
-- for provenance; public responses should prefer immutable object_key values.
CREATE TABLE collection_media (
  collection_id INTEGER NOT NULL CHECK (collection_id > 0),
  role TEXT NOT NULL CHECK (role IN ('logo', 'banner', 'mobile_banner', 'social')),
  source_url TEXT NOT NULL CHECK (length(source_url) > 0),
  resolved_source_url TEXT,
  object_key TEXT,
  content_type TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  sha256 TEXT CHECK (
    sha256 IS NULL OR (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'missing', 'quarantined', 'failed')),
  eligible_for_publish INTEGER NOT NULL CHECK (eligible_for_publish IN (0, 1)),
  retrieved_on TEXT,
  failure_reason TEXT,
  PRIMARY KEY (collection_id, role),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_media_status
  ON collection_media(status, collection_id, role);

CREATE TABLE collection_artists (
  artist_id TEXT PRIMARY KEY CHECK (length(artist_id) > 0),
  collection_id INTEGER,
  ens TEXT,
  name TEXT,
  slug TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE SET NULL
) WITHOUT ROWID;

CREATE INDEX idx_collection_artists_collection
  ON collection_artists(collection_id, artist_id);

CREATE TABLE collection_artist_drops (
  artist_id TEXT NOT NULL,
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  PRIMARY KEY (artist_id, drop_id),
  FOREIGN KEY (artist_id) REFERENCES collection_artists(artist_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_collection_artist_drops_drop
  ON collection_artist_drops(drop_id, artist_id);

CREATE TABLE collection_organizations (
  organization_id INTEGER PRIMARY KEY CHECK (organization_id > 0),
  collection_id INTEGER,
  name TEXT NOT NULL CHECK (length(name) > 0),
  slug TEXT NOT NULL CHECK (length(slug) > 0),
  created_on TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE SET NULL
);

CREATE INDEX idx_collection_organizations_collection
  ON collection_organizations(collection_id, organization_id);

CREATE TABLE verified_collections (
  collection_id INTEGER PRIMARY KEY CHECK (collection_id > 0),
  verified_by INTEGER NOT NULL CHECK (verified_by > 0),
  verified_on TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES collection_organizations(organization_id)
);

CREATE TABLE featured_collections (
  collection_id INTEGER PRIMARY KEY CHECK (collection_id > 0),
  featured_on TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

CREATE INDEX idx_featured_collections_recent
  ON featured_collections(featured_on DESC, collection_id DESC);

CREATE TABLE suggested_drops (
  suggestion_id INTEGER PRIMARY KEY CHECK (suggestion_id > 0),
  collection_id INTEGER NOT NULL CHECK (collection_id > 0),
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  suggested_by TEXT,
  curation_status TEXT NOT NULL,
  created_on TEXT NOT NULL,
  reviewed_on TEXT,
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

CREATE INDEX idx_suggested_drops_collection
  ON suggested_drops(collection_id, suggestion_id);
CREATE INDEX idx_suggested_drops_status
  ON suggested_drops(curation_status, created_on DESC, suggestion_id DESC);
