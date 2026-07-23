-- D1 schema emitted by tools/moments-backup. Keep column-compatible with
-- migrations/moments/0001_schema.sql; the public views are fail-closed.
PRAGMA foreign_keys = ON;

CREATE TABLE moments_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE moments (
  moment_id TEXT PRIMARY KEY CHECK (length(moment_id) > 0),
  display_id TEXT UNIQUE,
  author TEXT,
  author_address_norm TEXT CHECK (
    author_address_norm IS NULL OR (
      length(author_address_norm) = 42 AND substr(author_address_norm, 1, 2) = '0x'
      AND substr(author_address_norm, 3) NOT GLOB '*[^0-9a-f]*'
      AND author_address_norm = lower(author_address_norm)
    )
  ),
  description TEXT,
  cid TEXT,
  token_id TEXT,
  legacy_drop_id INTEGER CHECK (legacy_drop_id IS NULL OR legacy_drop_id > 0),
  created_on TEXT NOT NULL CHECK (length(created_on) > 0),
  updated_on TEXT,
  updated INTEGER NOT NULL DEFAULT 0 CHECK (updated IN (0, 1))
) WITHOUT ROWID;
CREATE INDEX idx_moments_recent ON moments(created_on DESC, moment_id DESC);
CREATE INDEX idx_moments_author_recent
  ON moments(author_address_norm, created_on DESC, moment_id DESC)
  WHERE author_address_norm IS NOT NULL;
CREATE INDEX idx_moments_display_id ON moments(display_id) WHERE display_id IS NOT NULL;

CREATE TABLE moment_visibility (
  moment_id TEXT PRIMARY KEY,
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  source_scope TEXT NOT NULL CHECK (length(source_scope) > 0),
  evaluated_on TEXT NOT NULL,
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_visibility_public
  ON moment_visibility(moment_id) WHERE is_public = 1;

CREATE TABLE moment_drops (
  moment_id TEXT NOT NULL,
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (moment_id, drop_id),
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_drops_drop ON moment_drops(drop_id, moment_id);

CREATE TABLE moment_hidden_drops (
  drop_id INTEGER PRIMARY KEY CHECK (drop_id > 0),
  hidden_on TEXT,
  source TEXT NOT NULL DEFAULT 'upstream'
);

CREATE TABLE moment_suppressions (
  moment_id TEXT PRIMARY KEY,
  reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
  public_message TEXT,
  suppressed_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_suppressions_active
  ON moment_suppressions(moment_id) WHERE active = 1;

CREATE TABLE moment_media (
  media_key TEXT PRIMARY KEY CHECK (length(media_key) > 0),
  moment_id TEXT,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'audio', 'other')),
  mime_type TEXT,
  source_hash TEXT,
  source_status TEXT NOT NULL,
  source_status_reason TEXT,
  object_key TEXT,
  archive_sha256 TEXT CHECK (
    archive_sha256 IS NULL OR (
      length(archive_sha256) = 64
      AND archive_sha256 NOT GLOB '*[^0-9a-f]*'
      AND archive_sha256 = lower(archive_sha256)
    )
  ),
  archive_byte_length INTEGER CHECK (archive_byte_length IS NULL OR archive_byte_length >= 0),
  archive_content_type TEXT,
  archive_status TEXT NOT NULL CHECK (
    archive_status IN ('pending', 'public_stored', 'private_stored', 'missing', 'quarantined', 'failed')
  ),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_media_moment
  ON moment_media(moment_id, position, created_at, media_key);
CREATE INDEX idx_moment_media_public_kind
  ON moment_media(moment_id, media_kind, position, created_at, media_key)
  WHERE archive_status = 'public_stored' AND object_key IS NOT NULL AND archive_sha256 IS NOT NULL;
CREATE INDEX idx_moment_media_sha256
  ON moment_media(archive_sha256) WHERE archive_sha256 IS NOT NULL;

CREATE TABLE moment_links (
  link_id TEXT PRIMARY KEY CHECK (length(link_id) > 0),
  moment_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  url TEXT,
  image_object_key TEXT,
  image_sha256 TEXT CHECK (
    image_sha256 IS NULL OR (
      length(image_sha256) = 64 AND image_sha256 NOT GLOB '*[^0-9a-f]*'
      AND image_sha256 = lower(image_sha256)
    )
  ),
  image_mime_type TEXT,
  image_archive_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    image_archive_status IN ('pending', 'public_stored', 'private_stored', 'missing', 'quarantined', 'failed')
  ),
  created_on TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_links_moment ON moment_links(moment_id, position, link_id);

CREATE TABLE moment_user_tags (
  tag_id TEXT PRIMARY KEY CHECK (length(tag_id) > 0),
  moment_id TEXT NOT NULL,
  address TEXT,
  address_norm TEXT CHECK (
    address_norm IS NULL OR (
      length(address_norm) = 42 AND substr(address_norm, 1, 2) = '0x'
      AND substr(address_norm, 3) NOT GLOB '*[^0-9a-f]*'
      AND address_norm = lower(address_norm)
    )
  ),
  ens TEXT,
  created_by TEXT,
  x INTEGER,
  y INTEGER,
  created_on TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_user_tags_moment
  ON moment_user_tags(moment_id, position, tag_id);
CREATE INDEX idx_moment_user_tags_address
  ON moment_user_tags(address_norm, moment_id) WHERE address_norm IS NOT NULL;

CREATE TABLE capsules (
  capsule_id INTEGER PRIMARY KEY CHECK (capsule_id > 0),
  external_id TEXT,
  owner TEXT,
  owner_address_norm TEXT CHECK (
    owner_address_norm IS NULL OR (
      length(owner_address_norm) = 42 AND substr(owner_address_norm, 1, 2) = '0x'
      AND substr(owner_address_norm, 3) NOT GLOB '*[^0-9a-f]*'
      AND owner_address_norm = lower(owner_address_norm)
    )
  ),
  title TEXT,
  description TEXT,
  url TEXT,
  image_object_key TEXT,
  image_sha256 TEXT CHECK (
    image_sha256 IS NULL OR (
      length(image_sha256) = 64 AND image_sha256 NOT GLOB '*[^0-9a-f]*'
      AND image_sha256 = lower(image_sha256)
    )
  ),
  image_mime_type TEXT,
  image_archive_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    image_archive_status IN ('pending', 'public_stored', 'private_stored', 'missing', 'quarantined', 'failed')
  ),
  created_on TEXT NOT NULL
);
CREATE INDEX idx_capsules_recent ON capsules(created_on DESC, capsule_id DESC);
CREATE INDEX idx_capsules_owner
  ON capsules(owner_address_norm, created_on DESC, capsule_id DESC)
  WHERE owner_address_norm IS NOT NULL;

CREATE TABLE capsule_visibility (
  capsule_id INTEGER PRIMARY KEY,
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  source_scope TEXT NOT NULL CHECK (length(source_scope) > 0),
  evaluated_on TEXT NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES capsules(capsule_id) ON DELETE CASCADE
);

CREATE TABLE capsule_suppressions (
  capsule_id INTEGER PRIMARY KEY,
  reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
  suppressed_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  FOREIGN KEY (capsule_id) REFERENCES capsules(capsule_id) ON DELETE CASCADE
);

CREATE TABLE capsule_moments (
  capsule_id INTEGER NOT NULL CHECK (capsule_id > 0),
  moment_id TEXT NOT NULL,
  created_on TEXT,
  created_by TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (capsule_id, moment_id),
  FOREIGN KEY (capsule_id) REFERENCES capsules(capsule_id) ON DELETE CASCADE,
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_capsule_moments_moment ON capsule_moments(moment_id, capsule_id);

CREATE TABLE moment_collections (
  moment_id TEXT NOT NULL,
  collection_id INTEGER NOT NULL CHECK (collection_id > 0),
  PRIMARY KEY (moment_id, collection_id),
  FOREIGN KEY (moment_id) REFERENCES moments(moment_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_moment_collections_collection
  ON moment_collections(collection_id, moment_id);

CREATE VIEW public_moments AS
SELECT m.moment_id, m.display_id, m.author, m.author_address_norm, m.description,
  m.cid, m.token_id, m.created_on, m.updated_on, m.updated
FROM moments m
JOIN moment_visibility visibility
  ON visibility.moment_id = m.moment_id AND visibility.is_public = 1
WHERE EXISTS (SELECT 1 FROM moment_drops d WHERE d.moment_id = m.moment_id)
  AND NOT EXISTS (
    SELECT 1 FROM moment_drops d JOIN moment_hidden_drops h ON h.drop_id = d.drop_id
    WHERE d.moment_id = m.moment_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM moment_suppressions s
    WHERE s.moment_id = m.moment_id AND s.active = 1
  );

CREATE VIEW public_capsules AS
SELECT c.capsule_id, c.external_id, c.owner, c.owner_address_norm, c.title,
  c.description, c.url, c.image_object_key, c.image_sha256, c.image_mime_type,
  c.image_archive_status, c.created_on
FROM capsules c
JOIN capsule_visibility visibility
  ON visibility.capsule_id = c.capsule_id AND visibility.is_public = 1
WHERE NOT EXISTS (
  SELECT 1 FROM capsule_suppressions s
  WHERE s.capsule_id = c.capsule_id AND s.active = 1
);
