-- Synthetic Moments snapshot for local development and Worker tests only.
-- The invisible rows deliberately exercise every fail-closed boundary.

PRAGMA foreign_keys = ON;

INSERT INTO moments_meta (key, value) VALUES
  ('snapshot_id', 'moments-2026-07-23-v1'),
  ('snapshot_at', '2026-07-23T00:00:00.000Z'),
  ('schema_version', '1'),
  ('ready', '0'),
  ('source_database_sha256', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('build_manifest_sha256', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  ('source_moments_count', '8'),
  ('public_moments_count', '3'),
  ('media_count', '5'),
  ('capsules_count', '3'),
  ('public_capsules_count', '2');

-- Production builds write this immutable plan before source-derived rows. The
-- synthetic fixture follows the same contract so import guards remain active
-- in tests instead of being bypassed.
INSERT INTO moments_import_plan (table_name, expected_rows) VALUES
  ('moments', 8),
  ('moment_visibility', 8),
  ('moment_drops', 8),
  ('moment_hidden_drops', 1),
  ('moment_media', 5),
  ('moment_links', 2),
  ('moment_user_tags', 1),
  ('capsules', 3),
  ('capsule_visibility', 3),
  ('capsule_moments', 3),
  ('moment_collections', 6);

INSERT INTO moments (
  moment_id,
  display_id,
  author,
  author_address_norm,
  description,
  cid,
  token_id,
  legacy_drop_id,
  created_on,
  updated_on,
  updated
) VALUES
  (
    '00000000-0000-4000-8000-000000000003',
    'PUBLIC003',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Newest public image Moment.',
    'bafy-public-003',
    '3003',
    1001,
    '2026-07-20T12:00:00.000Z',
    '2026-07-21T12:00:00.000Z',
    1
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'PUBLIC002',
    '0x2222222222222222222222222222222222222222',
    '0x2222222222222222222222222222222222222222',
    'Public video Moment sharing a timestamp for cursor tests.',
    'bafy-public-002',
    '2002',
    1002,
    '2026-07-20T12:00:00.000Z',
    NULL,
    0
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'PUBLIC001',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Older public audio Moment.',
    'bafy-public-001',
    '1001',
    1001,
    '2026-07-19T12:00:00.000Z',
    NULL,
    0
  ),
  (
    '00000000-0000-4000-8000-000000000010',
    'HIDDEN001',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Must not escape because its Drop is hidden.',
    NULL,
    NULL,
    999,
    '2026-07-22T12:00:00.000Z',
    NULL,
    0
  ),
  (
    '00000000-0000-4000-8000-000000000011',
    'ORPHAN001',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Must not escape because it has no explicit Drop relationship.',
    NULL,
    NULL,
    NULL,
    '2026-07-23T12:00:00.000Z',
    NULL,
    0
  ),
  (
    '00000000-0000-4000-8000-000000000012',
    'PRIVATE001',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Must not escape without an affirmative publication decision.',
    NULL,
    NULL,
    1001,
    '2026-07-24T12:00:00.000Z',
    NULL,
    0
  ),
  (
    '00000000-0000-4000-8000-000000000013',
    'SUPPRESS001',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Must not escape while its suppression is active.',
    NULL,
    NULL,
    1001,
    '2026-07-25T12:00:00.000Z',
    NULL,
    0
  ),
  (
    '00000000-0000-4000-8000-000000000014',
    'MIXED001',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'Any hidden Drop relation excludes the whole Moment.',
    NULL,
    NULL,
    1001,
    '2026-07-26T12:00:00.000Z',
    NULL,
    0
  );

INSERT INTO moment_visibility (moment_id, is_public, source_scope, evaluated_on) VALUES
  ('00000000-0000-4000-8000-000000000003', 1, 'explore', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000002', 1, 'explore', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000001', 1, 'explore', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000010', 1, 'explore', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000011', 1, 'explore', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000012', 0, 'unclassified', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000013', 1, 'explore', '2026-07-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000014', 1, 'explore', '2026-07-23T00:00:00.000Z');

INSERT INTO moment_drops (moment_id, drop_id, position) VALUES
  ('00000000-0000-4000-8000-000000000003', 1001, 0),
  ('00000000-0000-4000-8000-000000000002', 1002, 0),
  ('00000000-0000-4000-8000-000000000001', 1001, 0),
  ('00000000-0000-4000-8000-000000000010', 999, 0),
  ('00000000-0000-4000-8000-000000000012', 1001, 0),
  ('00000000-0000-4000-8000-000000000013', 1001, 0),
  ('00000000-0000-4000-8000-000000000014', 1001, 0),
  ('00000000-0000-4000-8000-000000000014', 999, 1);

INSERT INTO moment_hidden_drops (drop_id, hidden_on, source) VALUES
  (999, '2026-07-22T00:00:00.000Z', 'fixture');

INSERT INTO moment_media (
  media_key,
  moment_id,
  media_kind,
  mime_type,
  source_hash,
  source_status,
  source_status_reason,
  object_key,
  archive_sha256,
  archive_byte_length,
  archive_content_type,
  archive_status,
  width,
  height,
  duration_ms,
  position,
  created_at,
  updated_at
) VALUES
  (
    'media-public-image',
    '00000000-0000-4000-8000-000000000003',
    'image',
    'image/jpeg',
    'upstream-image-hash',
    'ready',
    NULL,
    'snapshots/moments-2026-07-23-v1/moments/original/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    123456,
    'image/jpeg',
    'public_stored',
    1200,
    800,
    NULL,
    0,
    '2026-07-20T12:01:00.000Z',
    '2026-07-20T12:01:00.000Z'
  ),
  (
    'media-public-video',
    '00000000-0000-4000-8000-000000000002',
    'video',
    'video/mp4',
    NULL,
    'ready',
    NULL,
    'snapshots/moments-2026-07-23-v1/moments/original/sha256/cc/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.mp4',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    234567,
    'video/mp4',
    'public_stored',
    1920,
    1080,
    12000,
    0,
    '2026-07-20T12:01:00.000Z',
    '2026-07-20T12:01:00.000Z'
  ),
  (
    'media-public-audio',
    '00000000-0000-4000-8000-000000000001',
    'audio',
    'audio/mpeg',
    NULL,
    'ready',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'pending',
    NULL,
    NULL,
    30000,
    0,
    '2026-07-19T12:01:00.000Z',
    '2026-07-19T12:01:00.000Z'
  ),
  (
    'media-ineligible',
    '00000000-0000-4000-8000-000000000003',
    'image',
    'image/png',
    NULL,
    'ready',
    NULL,
    'moments/private/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    456789,
    'image/png',
    'public_stored',
    640,
    480,
    NULL,
    1,
    '2026-07-20T12:02:00.000Z',
    '2026-07-20T12:02:00.000Z'
  ),
  (
    'media-orphan',
    '00000000-0000-4000-8000-000000000011',
    'image',
    'image/jpeg',
    NULL,
    'ready',
    NULL,
    'snapshots/moments-2026-07-23-v1/moments/original/sha256/ff/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.jpg',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    567890,
    'image/jpeg',
    'public_stored',
    640,
    480,
    NULL,
    0,
    '2026-07-23T12:01:00.000Z',
    '2026-07-23T12:01:00.000Z'
  );

INSERT INTO moment_links (
  link_id,
  moment_id,
  title,
  description,
  url,
  image_object_key,
  image_sha256,
  image_mime_type,
  image_archive_status,
  created_on,
  position
) VALUES
  (
    'link-public-safe',
    '00000000-0000-4000-8000-000000000003',
    'A safe public link',
    'Synthetic fixture link.',
    'https://example.invalid/moment',
    'snapshots/moments-2026-07-23-v1/moments/original/sha256/12/1212121212121212121212121212121212121212121212121212121212121212.webp',
    '1212121212121212121212121212121212121212121212121212121212121212',
    'image/webp',
    'public_stored',
    '2026-07-20T12:03:00.000Z',
    0
  ),
  (
    'link-public-unsafe',
    '00000000-0000-4000-8000-000000000003',
    'An unsafe public link',
    'The Worker must null this URL.',
    'javascript:alert(1)',
    NULL,
    NULL,
    NULL,
    'pending',
    '2026-07-20T12:04:00.000Z',
    1
  );

INSERT INTO moment_user_tags (
  tag_id,
  moment_id,
  address,
  address_norm,
  ens,
  created_by,
  x,
  y,
  created_on,
  position
) VALUES
  (
    'tag-public-001',
    '00000000-0000-4000-8000-000000000003',
    '0x3333333333333333333333333333333333333333',
    '0x3333333333333333333333333333333333333333',
    'synthetic.eth',
    '0x1111111111111111111111111111111111111111',
    25,
    75,
    '2026-07-20T12:05:00.000Z',
    0
  );

INSERT INTO capsules (
  capsule_id,
  external_id,
  owner,
  owner_address_norm,
  title,
  description,
  url,
  image_object_key,
  image_sha256,
  image_mime_type,
  image_archive_status,
  created_on
) VALUES
  (
    1,
    'capsule-public',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'A public sibling capsule',
    'Capsules remain distinct from Moments.',
    'https://example.invalid/capsule',
    'snapshots/moments-2026-07-23-v1/moments/original/sha256/34/3434343434343434343434343434343434343434343434343434343434343434.jpg',
    '3434343434343434343434343434343434343434343434343434343434343434',
    'image/jpeg',
    'public_stored',
    '2026-07-18T00:00:00.000Z'
  ),
  (
    2,
    'capsule-suppressed',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'A suppressed capsule',
    NULL,
    'javascript:alert(1)',
    NULL,
    NULL,
    NULL,
    'pending',
    '2026-07-18T00:01:00.000Z'
  ),
  (
    3,
    'capsule-private',
    '0x1111111111111111111111111111111111111111',
    '0x1111111111111111111111111111111111111111',
    'A non-public capsule',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'pending',
    '2026-07-18T00:02:00.000Z'
  );

INSERT INTO capsule_visibility (capsule_id, is_public, source_scope, evaluated_on) VALUES
  (1, 1, 'capsule-directory', '2026-07-23T00:00:00.000Z'),
  (2, 1, 'capsule-directory', '2026-07-23T00:00:00.000Z'),
  (3, 0, 'unclassified', '2026-07-23T00:00:00.000Z');

INSERT INTO capsule_moments (capsule_id, moment_id, created_on, created_by, position) VALUES
  (1, '00000000-0000-4000-8000-000000000003', '2026-07-20T13:00:00.000Z', 'fixture', 0),
  (2, '00000000-0000-4000-8000-000000000003', '2026-07-20T13:01:00.000Z', 'fixture', 1),
  (3, '00000000-0000-4000-8000-000000000003', '2026-07-20T13:02:00.000Z', 'fixture', 2);

INSERT INTO moment_collections (moment_id, collection_id) VALUES
  ('00000000-0000-4000-8000-000000000003', 101),
  ('00000000-0000-4000-8000-000000000002', 102),
  ('00000000-0000-4000-8000-000000000001', 101),
  ('00000000-0000-4000-8000-000000000010', 103),
  ('00000000-0000-4000-8000-000000000011', 103),
  ('00000000-0000-4000-8000-000000000013', 101);

-- The fixture activates only after all immutable source rows have landed and
-- its metadata shard is journaled, matching the production transition.
INSERT INTO import_shards (
  snapshot_id,
  source_database_sha256,
  shard_path,
  payload_sha256,
  table_name,
  row_count,
  statement_count
) VALUES (
  'moments-2026-07-23-v1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'fixture/moments-meta.sql',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'moments_meta',
  11,
  1
);

UPDATE moments_meta SET value = '1' WHERE key = 'ready';

INSERT INTO moment_suppressions (
  moment_id,
  reason_code,
  public_message,
  suppressed_on,
  active
) VALUES
  (
    '00000000-0000-4000-8000-000000000013',
    'rights_request',
    'This Moment is unavailable.',
    '2026-07-23T00:00:00.000Z',
    1
  );

INSERT INTO capsule_suppressions (capsule_id, reason_code, suppressed_on, active) VALUES
  (2, 'rights_request', '2026-07-23T00:00:00.000Z', 1);
