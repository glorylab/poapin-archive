-- Freeze source-derived Moments rows as they are loaded. The import plan is
-- written before any source data. Monotonic per-table counters keep every
-- source-table guard constant-time while enforcing an exact row ceiling.

CREATE TABLE moments_import_plan (
  table_name TEXT PRIMARY KEY CHECK (
    table_name IN (
      'moments',
      'moment_visibility',
      'moment_drops',
      'moment_hidden_drops',
      'moment_media',
      'moment_links',
      'moment_user_tags',
      'capsules',
      'capsule_visibility',
      'capsule_moments',
      'moment_collections'
    )
  ),
  expected_rows INTEGER NOT NULL CHECK (expected_rows >= 0),
  loaded_rows INTEGER NOT NULL DEFAULT 0 CHECK (
    loaded_rows >= 0 AND loaded_rows <= expected_rows
  )
) WITHOUT ROWID;

CREATE TRIGGER guard_moments_import_plan_update
BEFORE UPDATE ON moments_import_plan
WHEN NOT (
  NEW.table_name = OLD.table_name
  AND NEW.expected_rows = OLD.expected_rows
  AND NEW.loaded_rows = OLD.loaded_rows + 1
)
BEGIN
  SELECT RAISE(ABORT, 'Moments import plan counters are monotonic');
END;

CREATE TRIGGER guard_moments_import_plan_delete
BEFORE DELETE ON moments_import_plan
BEGIN
  SELECT RAISE(ABORT, 'Moments import plan is immutable');
END;

CREATE TRIGGER guard_import_shards_update
BEFORE UPDATE ON import_shards
BEGIN
  SELECT RAISE(ABORT, 'Moments import journal is immutable');
END;

CREATE TRIGGER guard_import_shards_delete
BEFORE DELETE ON import_shards
BEGIN
  SELECT RAISE(ABORT, 'Moments import journal is immutable');
END;

CREATE TRIGGER guard_moments_insert
BEFORE INSERT ON moments
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moments'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moments' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moments exceeded its import plan');
END;

CREATE TRIGGER count_moments_insert
AFTER INSERT ON moments
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moments';
END;

CREATE TRIGGER guard_moments_update
BEFORE UPDATE ON moments
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moments is immutable');
END;

CREATE TRIGGER guard_moments_delete
BEFORE DELETE ON moments
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moments is immutable');
END;

CREATE TRIGGER guard_moment__visibility_insert
BEFORE INSERT ON moment_visibility
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_visibility'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_visibility' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_visibility exceeded its import plan');
END;

CREATE TRIGGER count_moment__visibility_insert
AFTER INSERT ON moment_visibility
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_visibility';
END;

CREATE TRIGGER guard_moment__visibility_update
BEFORE UPDATE ON moment_visibility
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_visibility is immutable');
END;

CREATE TRIGGER guard_moment__visibility_delete
BEFORE DELETE ON moment_visibility
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_visibility is immutable');
END;

CREATE TRIGGER guard_moment__drops_insert
BEFORE INSERT ON moment_drops
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_drops'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_drops' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_drops exceeded its import plan');
END;

CREATE TRIGGER count_moment__drops_insert
AFTER INSERT ON moment_drops
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_drops';
END;

CREATE TRIGGER guard_moment__drops_update
BEFORE UPDATE ON moment_drops
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_drops is immutable');
END;

CREATE TRIGGER guard_moment__drops_delete
BEFORE DELETE ON moment_drops
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_drops is immutable');
END;

CREATE TRIGGER guard_moment__hidden__drops_insert
BEFORE INSERT ON moment_hidden_drops
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_hidden_drops'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_hidden_drops' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_hidden_drops exceeded its import plan');
END;

CREATE TRIGGER count_moment__hidden__drops_insert
AFTER INSERT ON moment_hidden_drops
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_hidden_drops';
END;

CREATE TRIGGER guard_moment__hidden__drops_update
BEFORE UPDATE ON moment_hidden_drops
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_hidden_drops is immutable');
END;

CREATE TRIGGER guard_moment__hidden__drops_delete
BEFORE DELETE ON moment_hidden_drops
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_hidden_drops is immutable');
END;

CREATE TRIGGER guard_moment__media_insert
BEFORE INSERT ON moment_media
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_media'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_media' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_media exceeded its import plan');
END;

CREATE TRIGGER count_moment__media_insert
AFTER INSERT ON moment_media
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_media';
END;

CREATE TRIGGER guard_moment__media_update
BEFORE UPDATE ON moment_media
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_media is immutable');
END;

CREATE TRIGGER guard_moment__media_delete
BEFORE DELETE ON moment_media
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_media is immutable');
END;

CREATE TRIGGER guard_moment__links_insert
BEFORE INSERT ON moment_links
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_links'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_links' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_links exceeded its import plan');
END;

CREATE TRIGGER count_moment__links_insert
AFTER INSERT ON moment_links
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_links';
END;

CREATE TRIGGER guard_moment__links_update
BEFORE UPDATE ON moment_links
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_links is immutable');
END;

CREATE TRIGGER guard_moment__links_delete
BEFORE DELETE ON moment_links
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_links is immutable');
END;

CREATE TRIGGER guard_moment__user__tags_insert
BEFORE INSERT ON moment_user_tags
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_user_tags'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_user_tags' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_user_tags exceeded its import plan');
END;

CREATE TRIGGER count_moment__user__tags_insert
AFTER INSERT ON moment_user_tags
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_user_tags';
END;

CREATE TRIGGER guard_moment__user__tags_update
BEFORE UPDATE ON moment_user_tags
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_user_tags is immutable');
END;

CREATE TRIGGER guard_moment__user__tags_delete
BEFORE DELETE ON moment_user_tags
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_user_tags is immutable');
END;

CREATE TRIGGER guard_capsules_insert
BEFORE INSERT ON capsules
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'capsules'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'capsules' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsules exceeded its import plan');
END;

CREATE TRIGGER count_capsules_insert
AFTER INSERT ON capsules
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'capsules';
END;

CREATE TRIGGER guard_capsules_update
BEFORE UPDATE ON capsules
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsules is immutable');
END;

CREATE TRIGGER guard_capsules_delete
BEFORE DELETE ON capsules
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsules is immutable');
END;

CREATE TRIGGER guard_capsule__visibility_insert
BEFORE INSERT ON capsule_visibility
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'capsule_visibility'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'capsule_visibility' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsule_visibility exceeded its import plan');
END;

CREATE TRIGGER count_capsule__visibility_insert
AFTER INSERT ON capsule_visibility
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'capsule_visibility';
END;

CREATE TRIGGER guard_capsule__visibility_update
BEFORE UPDATE ON capsule_visibility
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsule_visibility is immutable');
END;

CREATE TRIGGER guard_capsule__visibility_delete
BEFORE DELETE ON capsule_visibility
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsule_visibility is immutable');
END;

CREATE TRIGGER guard_capsule__moments_insert
BEFORE INSERT ON capsule_moments
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'capsule_moments'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'capsule_moments' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsule_moments exceeded its import plan');
END;

CREATE TRIGGER count_capsule__moments_insert
AFTER INSERT ON capsule_moments
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'capsule_moments';
END;

CREATE TRIGGER guard_capsule__moments_update
BEFORE UPDATE ON capsule_moments
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsule_moments is immutable');
END;

CREATE TRIGGER guard_capsule__moments_delete
BEFORE DELETE ON capsule_moments
BEGIN
  SELECT RAISE(ABORT, 'Moments source table capsule_moments is immutable');
END;

CREATE TRIGGER guard_moment__collections_insert
BEFORE INSERT ON moment_collections
WHEN
  NOT EXISTS (
    SELECT 1 FROM moments_import_plan WHERE table_name = 'moment_collections'
  )
  OR EXISTS (
    SELECT 1
    FROM moments_import_plan
    WHERE table_name = 'moment_collections' AND loaded_rows >= expected_rows
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_collections exceeded its import plan');
END;

CREATE TRIGGER count_moment__collections_insert
AFTER INSERT ON moment_collections
BEGIN
  UPDATE moments_import_plan
  SET loaded_rows = loaded_rows + 1
  WHERE table_name = 'moment_collections';
END;

CREATE TRIGGER guard_moment__collections_update
BEFORE UPDATE ON moment_collections
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_collections is immutable');
END;

CREATE TRIGGER guard_moment__collections_delete
BEFORE DELETE ON moment_collections
BEGIN
  SELECT RAISE(ABORT, 'Moments source table moment_collections is immutable');
END;

-- The staged metadata shard is mutable only until its journal marker lands.
-- Afterwards activation may add its four binding rows and move ready from 0
-- to 1; no other metadata change is permitted.
CREATE TRIGGER guard_moments_meta_insert
BEFORE INSERT ON moments_meta
WHEN
  EXISTS (SELECT 1 FROM import_shards WHERE table_name = 'moments_meta')
  AND NEW.key NOT IN (
    'activation_database_id',
    'activation_report_sha256',
    'build_manifest_sha256',
    'activated_at'
  )
BEGIN
  SELECT RAISE(ABORT, 'Moments staged metadata is immutable');
END;

CREATE TRIGGER guard_moments_meta_update
BEFORE UPDATE ON moments_meta
WHEN NOT (
  EXISTS (SELECT 1 FROM import_shards WHERE table_name = 'moments_meta')
  AND OLD.key = 'ready'
  AND NEW.key = 'ready'
  AND OLD.value = '0'
  AND NEW.value = '1'
)
BEGIN
  SELECT RAISE(ABORT, 'Moments staged metadata is immutable');
END;

CREATE TRIGGER guard_moments_meta_delete
BEFORE DELETE ON moments_meta
WHEN EXISTS (SELECT 1 FROM import_shards WHERE table_name = 'moments_meta')
BEGIN
  SELECT RAISE(ABORT, 'Moments staged metadata is immutable');
END;

-- Suppressions are an operational emergency-off switch. They are accepted
-- only after activation, only as active records, and can never be relaxed or
-- deleted in place.
CREATE TRIGGER guard_moment_suppressions_insert
BEFORE INSERT ON moment_suppressions
WHEN
  NEW.active <> 1
  OR COALESCE((SELECT value FROM moments_meta WHERE key = 'ready'), '0') <> '1'
BEGIN
  SELECT RAISE(ABORT, 'Moment suppressions require an activated snapshot');
END;

CREATE TRIGGER guard_moment_suppressions_update
BEFORE UPDATE ON moment_suppressions
BEGIN
  SELECT RAISE(ABORT, 'Moment suppressions are monotonic');
END;

CREATE TRIGGER guard_moment_suppressions_delete
BEFORE DELETE ON moment_suppressions
BEGIN
  SELECT RAISE(ABORT, 'Moment suppressions are monotonic');
END;

CREATE TRIGGER guard_capsule_suppressions_insert
BEFORE INSERT ON capsule_suppressions
WHEN
  NEW.active <> 1
  OR COALESCE((SELECT value FROM moments_meta WHERE key = 'ready'), '0') <> '1'
BEGIN
  SELECT RAISE(ABORT, 'Capsule suppressions require an activated snapshot');
END;

CREATE TRIGGER guard_capsule_suppressions_update
BEFORE UPDATE ON capsule_suppressions
BEGIN
  SELECT RAISE(ABORT, 'Capsule suppressions are monotonic');
END;

CREATE TRIGGER guard_capsule_suppressions_delete
BEFORE DELETE ON capsule_suppressions
BEGIN
  SELECT RAISE(ABORT, 'Capsule suppressions are monotonic');
END;
