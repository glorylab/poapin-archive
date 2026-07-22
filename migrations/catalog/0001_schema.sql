-- Public drop catalog. This database stays small enough for low-cost browse and
-- search requests; the multi-million-row ownership dataset lives separately.

CREATE TABLE archive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE drops (
  drop_id INTEGER PRIMARY KEY,
  fancy_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  city TEXT,
  country TEXT,
  event_url TEXT,
  year INTEGER NOT NULL,
  is_virtual INTEGER CHECK (is_virtual IS NULL OR is_virtual IN (0, 1)),
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  channel TEXT,
  platform TEXT,
  location_type TEXT,
  timezone TEXT,
  created_at TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  has_artwork INTEGER NOT NULL DEFAULT 0 CHECK (has_artwork IN (0, 1))
);

CREATE TABLE drop_stats (
  drop_id INTEGER PRIMARY KEY,
  email_reservations_total INTEGER NOT NULL DEFAULT 0
    CHECK (email_reservations_total >= 0),
  email_reservations_minted INTEGER NOT NULL DEFAULT 0
    CHECK (email_reservations_minted >= 0),
  email_reservations_unminted INTEGER NOT NULL DEFAULT 0
    CHECK (email_reservations_unminted >= 0),
  FOREIGN KEY (drop_id) REFERENCES drops(drop_id) ON DELETE CASCADE,
  CHECK (
    email_reservations_total =
      email_reservations_minted + email_reservations_unminted
  )
);

CREATE UNIQUE INDEX idx_drops_fancy_id ON drops(fancy_id);

-- Keyset browse indexes. The same indexes can be scanned in reverse for the
-- oldest-first view. Private rows are intentionally excluded from public paths.
CREATE INDEX idx_drops_recent
  ON drops(start_date DESC, drop_id DESC)
  WHERE is_private = 0;
CREATE INDEX idx_drops_year_recent
  ON drops(year, start_date DESC, drop_id DESC)
  WHERE is_private = 0;
CREATE INDEX idx_drops_type_recent
  ON drops(is_virtual, start_date DESC, drop_id DESC)
  WHERE is_private = 0;
CREATE INDEX idx_drops_year_type_recent
  ON drops(year, is_virtual, start_date DESC, drop_id DESC)
  WHERE is_private = 0;
CREATE INDEX idx_drops_popular
  ON drops(token_count DESC, drop_id DESC)
  WHERE is_private = 0;

-- External-content FTS avoids storing a second copy of the catalog text. The
-- triggers keep local seed data and future snapshot replacements in sync.
CREATE VIRTUAL TABLE drops_fts USING fts5(
  title,
  description,
  city,
  country,
  content = 'drops',
  content_rowid = 'drop_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER drops_fts_after_insert AFTER INSERT ON drops BEGIN
  INSERT INTO drops_fts(rowid, title, description, city, country)
  VALUES (new.drop_id, new.title, new.description, new.city, new.country);
END;

CREATE TRIGGER drops_fts_after_delete AFTER DELETE ON drops BEGIN
  INSERT INTO drops_fts(
    drops_fts,
    rowid,
    title,
    description,
    city,
    country
  ) VALUES (
    'delete',
    old.drop_id,
    old.title,
    old.description,
    old.city,
    old.country
  );
END;

CREATE TRIGGER drops_fts_after_update AFTER UPDATE ON drops BEGIN
  INSERT INTO drops_fts(
    drops_fts,
    rowid,
    title,
    description,
    city,
    country
  ) VALUES (
    'delete',
    old.drop_id,
    old.title,
    old.description,
    old.city,
    old.country
  );
  INSERT INTO drops_fts(rowid, title, description, city, country)
  VALUES (new.drop_id, new.title, new.description, new.city, new.country);
END;
