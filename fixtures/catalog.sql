-- Minimal synthetic sample for local development only. Never apply this file
-- as a production migration.

INSERT INTO archive_meta (key, value) VALUES
  ('snapshot_id', '2026-07-02-v1'),
  ('snapshot_at', '2026-07-02T14:28:17.259Z'),
  ('schema_version', '1'),
  ('importer_version', 'development-fixture'),
  ('drops_count', '3'),
  ('tokens_count', '3'),
  ('owners_count', '2'),
  ('artworks_count', '2'),
  ('years', '[2015,2018]');

INSERT INTO drops (
  drop_id,
  fancy_id,
  title,
  description,
  start_date,
  end_date,
  city,
  country,
  event_url,
  year,
  is_virtual,
  is_private,
  channel,
  platform,
  location_type,
  timezone,
  created_at,
  token_count,
  has_artwork
) VALUES
  (
    1,
    'dappcon-18',
    'DappCon',
    'A global conference for Ethereum application developers.',
    '2018-07-19T00:00:00.000Z',
    '2018-07-20T00:00:00.000Z',
    'Berlin',
    'Germany',
    'https://www.dappcon.io',
    2018,
    0,
    0,
    NULL,
    NULL,
    'in-person',
    'Europe/Berlin',
    '2019-05-28T06:40:54.242Z',
    1,
    1
  ),
  (
    2,
    'defi-summit-18',
    '#DeFi Summit',
    'A conference about decentralized finance.',
    '2018-10-29T00:00:00.000Z',
    '2018-10-29T00:00:00.000Z',
    'Prague',
    'Czech Republic',
    'https://offdevcon.com/event/defi-summit-prague/',
    2018,
    0,
    0,
    NULL,
    NULL,
    'in-person',
    'Europe/Prague',
    '2019-05-28T06:40:54.242Z',
    1,
    1
  ),
  (
    3,
    'devcon1',
    'DevCon1',
    'The first Ethereum developer conference.',
    '2015-11-09T00:00:00.000Z',
    '2015-11-13T00:00:00.000Z',
    'London',
    'United Kingdom',
    'https://devcon.ethereum.org/',
    2015,
    0,
    0,
    NULL,
    NULL,
    'in-person',
    'Europe/London',
    '2019-05-28T06:40:54.242Z',
    1,
    0
  );

INSERT INTO drop_stats (
  drop_id,
  email_reservations_total,
  email_reservations_minted,
  email_reservations_unminted
) VALUES
  (1, 0, 0, 0),
  (2, 2, 1, 1),
  (3, 0, 0, 0);
