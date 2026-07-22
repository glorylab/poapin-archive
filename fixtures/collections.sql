-- Small synthetic Collections snapshot for local development only. Repeated
-- slugs and shared drops are intentional. Never apply this file remotely.

PRAGMA foreign_keys = ON;

INSERT INTO collections_meta (key, value) VALUES
  ('snapshot_id', 'collections-2026-07-22-v1'),
  ('snapshot_at', '2026-07-22T12:00:00.000Z'),
  ('schema_version', '1'),
  ('ready', '1'),
  ('importer_version', 'development-fixture'),
  ('source_schema_sha256', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('collections_count', '4'),
  ('items_count', '4'),
  ('sections_count', '2'),
  ('item_sections_count', '3'),
  ('drop_cards_count', '4'),
  ('media_count', '4');

INSERT INTO collections (
  collection_id,
  slug,
  title,
  description,
  type,
  type_rank,
  year,
  created_by,
  owner_address,
  owner_address_norm,
  external_url,
  logo_image_url,
  banner_image_url,
  created_on,
  updated_on,
  item_count,
  section_count
) VALUES
  (
    101,
    'shared-history',
    'The Synthetic Artist',
    'A synthetic artist collection used to exercise local relationships.',
    'artist',
    1,
    2024,
    'fixture-importer',
    NULL,
    NULL,
    'https://artist.example.invalid/',
    'https://collections-assets.poap.invalid/101-logo.png',
    'https://collections-assets.poap.invalid/101-banner.jpg',
    '2024-01-10T10:00:00.000Z',
    '2026-07-20T08:00:00.000Z',
    2,
    1
  ),
  (
    102,
    'shared-history',
    'The Synthetic Organization',
    'This row deliberately reuses another collection slug.',
    'organization',
    2,
    2025,
    'fixture-importer',
    NULL,
    NULL,
    'https://organization.example.invalid/',
    'https://collections-assets.poap.invalid/102-logo.gif',
    NULL,
    '2025-03-02T09:30:00.000Z',
    '2026-07-20T08:00:00.000Z',
    1,
    1
  ),
  (
    103,
    'wallet-memories',
    'A Synthetic User Collection',
    NULL,
    'user',
    3,
    NULL,
    'fixture-importer',
    '0x2222222222222222222222222222222222222222',
    '0x2222222222222222222222222222222222222222',
    NULL,
    NULL,
    'https://untrusted-source.example.invalid/banner.png',
    '2026-01-15T06:00:00.000Z',
    '2026-07-19T11:45:00.000Z',
    1,
    0
  ),
  (
    104,
    'empty-fixture',
    'An Empty Synthetic Collection',
    'A hidden-from-browse fixture used to verify conditional export segments.',
    'user',
    4,
    2026,
    'fixture-importer',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    '2026-01-16T06:00:00.000Z',
    '2026-07-18T11:45:00.000Z',
    0,
    0
  );

INSERT INTO collection_drop_cards (
  drop_id,
  fancy_id,
  title,
  description,
  start_date,
  end_date,
  expiry_date,
  year,
  city,
  country,
  event_url,
  image_url,
  animation_url,
  image_object_key,
  is_virtual,
  private_value,
  is_hidden,
  channel,
  platform,
  location_type,
  timezone,
  integrator_id,
  created_date,
  token_count
) VALUES
  (
    1001,
    'synthetic-opening',
    'Synthetic Opening Night',
    'A fictional event used only by the local fixture.',
    '2024-01-10T18:00:00.000',
    '2024-01-10T22:00:00.000',
    '2024-02-10T22:00:00.000',
    2024,
    'Kyoto',
    'Japan',
    'https://events.example.invalid/opening',
    'https://assets.poap.invalid/1001.png',
    'http://127.0.0.1/private-animation.json',
    'snapshots/collections-2026-07-22-v1/drops/1001.png',
    0,
    'false',
    0,
    NULL,
    NULL,
    'in-person',
    'Asia/Tokyo',
    'fixture',
    '2024-01-01T00:00:00.000Z',
    42
  ),
  (
    1002,
    'synthetic-stream',
    'Synthetic Livestream',
    NULL,
    '2025-03-02T09:30:00.000',
    '2025-03-02T10:30:00.000',
    '2025-04-02T10:30:00.000',
    2025,
    NULL,
    NULL,
    'https://events.example.invalid/stream',
    'http://169.254.169.254/latest/meta-data',
    'https://assets.poap.invalid/1002-animation.json',
    NULL,
    1,
    'true',
    0,
    'fixture-channel',
    'fixture-platform',
    'virtual',
    'UTC',
    'fixture',
    '2025-02-01T00:00:00.000Z',
    12
  ),
  (
    1003,
    'synthetic-suggestion',
    'Synthetic Suggested Drop',
    'Suggested for the artist collection but not yet an item.',
    '2026-06-01T00:00:00.000',
    '2026-06-01T01:00:00.000',
    NULL,
    2026,
    NULL,
    NULL,
    NULL,
    'http://127.0.0.1/private-image.png',
    'http://10.0.0.1/private-animation.json',
    NULL,
    1,
    'false',
    0,
    NULL,
    NULL,
    'virtual',
    'UTC',
    NULL,
    '2026-05-01T00:00:00.000Z',
    0
  ),
  (
    1004,
    'synthetic-memory',
    'Synthetic Wallet Memory',
    NULL,
    '2026-01-15T06:00:00.000',
    '2026-01-15T07:00:00.000',
    NULL,
    2026,
    'Singapore',
    'Singapore',
    NULL,
    NULL,
    NULL,
    NULL,
    0,
    'false',
    1,
    NULL,
    NULL,
    'in-person',
    'Asia/Singapore',
    NULL,
    '2026-01-01T00:00:00.000Z',
    NULL
  );

-- Synthetic anonymous drop-supplement aggregates. Private and hidden rows
-- deliberately contain non-zero values so Worker tests can prove that public
-- projections redact the statistics rather than merely returning empty data.
UPDATE collection_drop_cards
SET
  transfer_count = 9,
  email_claims_minted = 4,
  email_claims_reserved = 2,
  email_claims_total = 6,
  featured_on = '2026-07-10T00:00:00.000Z',
  moments_uploaded = 3
WHERE drop_id = 1001;

UPDATE collection_drop_cards
SET
  transfer_count = 91,
  email_claims_minted = 8,
  email_claims_reserved = 4,
  email_claims_total = 12,
  featured_on = '2026-07-11T00:00:00.000Z',
  moments_uploaded = 7
WHERE drop_id = 1002;

UPDATE collection_drop_cards
SET transfer_count = 0, moments_uploaded = 0
WHERE drop_id = 1003;

UPDATE collection_drop_cards
SET
  transfer_count = 55,
  email_claims_minted = 5,
  email_claims_reserved = 1,
  email_claims_total = 6,
  featured_on = '2026-07-12T00:00:00.000Z',
  moments_uploaded = 11
WHERE drop_id = 1004;

INSERT INTO collection_drop_stats_by_chain (
  drop_id,
  chain_key,
  chain,
  created_on,
  poap_count,
  transfer_count
) VALUES
  (1001, 's:ethereum', 'ethereum', 1704067200, 30, 7),
  (1001, 's:gnosis', 'gnosis', 1704153600, 12, 2),
  (1002, 's:ethereum', 'ethereum', 1740873600, 12, 91),
  (1003, 's:polygon', 'polygon', 1780272000, 0, 0),
  (1004, 's:ethereum', 'ethereum', 1768435200, 1, 55);

INSERT INTO collection_items (item_id, collection_id, drop_id, created_on) VALUES
  (10001, 101, 1001, '2024-01-11T00:00:00.000Z'),
  (10002, 101, 1002, '2025-03-03T00:00:00.000Z'),
  (10003, 102, 1002, '2025-03-04T00:00:00.000Z'),
  (10004, 103, 1004, NULL);

INSERT INTO collection_sections (section_id, collection_id, name, position) VALUES
  ('11111111-1111-4111-8111-111111111111', 101, 'Highlights', 0),
  ('22222222-2222-4222-8222-222222222222', 102, 'Organization history', 0);

INSERT INTO collection_item_sections (item_id, section_id, position) VALUES
  (10001, '11111111-1111-4111-8111-111111111111', 0),
  (10002, '11111111-1111-4111-8111-111111111111', 1),
  (10003, '22222222-2222-4222-8222-222222222222', 0);

INSERT INTO collection_urls (url_id, collection_id, url) VALUES
  (5001, 101, 'https://artist.example.invalid/profile'),
  (5002, 101, 'https://social.example.invalid/synthetic-artist'),
  (5003, 102, 'javascript:alert(1)');

INSERT INTO collection_ui_settings (
  collection_id,
  primary_color,
  highlight_color,
  dark_color,
  grey_color,
  white_color,
  is_visible_in_recent_list,
  toggle_poap_elements
) VALUES
  (101, '#5c5aa0', '#e0c72f', '#1d3943', '#477787', '#ffffff', 1, 1),
  (102, '#4fafc1', NULL, '#274552', NULL, '#ffffff', 0, 0),
  (104, NULL, NULL, NULL, NULL, NULL, 0, 0);

INSERT INTO collection_media (
  collection_id,
  role,
  source_url,
  resolved_source_url,
  object_key,
  content_type,
  byte_length,
  sha256,
  width,
  height,
  status,
  eligible_for_publish,
  retrieved_on,
  failure_reason
) VALUES
  (
    101,
    'logo',
    'https://collections-assets.poap.invalid/101-logo.png',
    'https://collections-media-production.s3.us-east-2.amazonaws.com/101-logo.png',
    'snapshots/collections-2026-07-22-v1/collections/media/sha256/11/1111111111111111111111111111111111111111111111111111111111111111.png',
    'image/png',
    2048,
    '1111111111111111111111111111111111111111111111111111111111111111',
    256,
    256,
    'stored',
    1,
    '2026-07-22T12:05:00.000Z',
    NULL
  ),
  (
    101,
    'banner',
    'https://collections-assets.poap.invalid/101-banner.jpg',
    'https://collections-media-production.s3.us-east-2.amazonaws.com/101-banner.jpg',
    'snapshots/collections-2026-07-22-v1/collections/media/sha256/22/2222222222222222222222222222222222222222222222222222222222222222.jpg',
    'image/jpeg',
    8192,
    '2222222222222222222222222222222222222222222222222222222222222222',
    1200,
    400,
    'stored',
    1,
    '2026-07-22T12:05:02.000Z',
    NULL
  ),
  (
    102,
    'logo',
    'https://collections-assets.poap.invalid/102-logo.gif',
    NULL,
    NULL,
    'image/gif',
    NULL,
    NULL,
    NULL,
    NULL,
    'pending',
    0,
    NULL,
    NULL
  ),
  (
    103,
    'banner',
    'https://untrusted-source.example.invalid/banner.png',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'quarantined',
    0,
    '2026-07-22T12:05:05.000Z',
    'source_host_not_allowed'
  );

INSERT INTO collection_artists (
  artist_id,
  collection_id,
  ens,
  name,
  slug,
  created_at
) VALUES (
  '33333333-3333-4333-8333-333333333333',
  101,
  'synthetic-artist.eth',
  'Synthetic Artist',
  'synthetic-artist',
  '2024-01-10T10:00:00.000Z'
);

INSERT INTO collection_artist_drops (artist_id, drop_id) VALUES
  ('33333333-3333-4333-8333-333333333333', 1001),
  ('33333333-3333-4333-8333-333333333333', 1002);

INSERT INTO collection_organizations (
  organization_id,
  collection_id,
  name,
  slug,
  created_on
) VALUES (
  201,
  102,
  'Synthetic Organization',
  'synthetic-organization',
  '2025-03-02T09:30:00.000Z'
);

INSERT INTO verified_collections (collection_id, verified_by, verified_on) VALUES
  (102, 201, '2026-07-01T00:00:00.000Z');

INSERT INTO featured_collections (collection_id, featured_on) VALUES
  (101, '2026-07-15T00:00:00.000Z');

INSERT INTO suggested_drops (
  suggestion_id,
  collection_id,
  drop_id,
  suggested_by,
  curation_status,
  created_on,
  reviewed_on
) VALUES
  (
    7001,
    101,
    1004,
    '0x4444444444444444444444444444444444444444',
    'pending',
    '2026-07-18T00:00:00.000Z',
    NULL
  ),
  (
    7002,
    101,
    1003,
    '0x5555555555555555555555555555555555555555',
    'approved',
    '2026-07-19T00:00:00.000Z',
    '2026-07-20T00:00:00.000Z'
  ),
  (
    7003,
    102,
    1002,
    '0x6666666666666666666666666666666666666666',
    'pending',
    '2026-07-20T00:00:00.000Z',
    NULL
  );
