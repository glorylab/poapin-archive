export interface Bindings {
  CATALOG_DB: D1Database;
  HOLDINGS_DB: D1Database;
  ARCHIVE_BUCKET: R2Bucket;
  BROWSE_RATE_LIMITER: RateLimit;
  OWNER_RATE_LIMITER: RateLimit;
  EXPORT_RATE_LIMITER: RateLimit;
  SNAPSHOT_ID: string;
  API_CACHE_VERSION: string;
  MEDIA_BASE_URL: string;
}

export interface AppEnv {
  Bindings: Bindings;
}

export type D1ReadClient = Pick<D1DatabaseSession, "prepare" | "batch">;

export type DropSort = "recent" | "oldest" | "popular";
export type EventType = "all" | "virtual" | "in-person";

export interface DropsQuery {
  q: string | null;
  ftsQuery: string | null;
  year: number | null;
  type: EventType;
  sort: DropSort;
  limit: number;
  cursor: DropCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface OwnerQuery {
  address: string;
  limit: number;
  cursor: OwnerCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface DropCursor {
  v: 1;
  s: string;
  f: string;
  p: number;
  k: string | number;
  i: number;
}

export interface OwnerCursor {
  v: 1;
  s: string;
  f: string;
  p: number;
  u: string;
}

export interface CatalogSummaryRow {
  drop_id: number;
  fancy_id: string;
  title: string;
  start_date: string;
  city: string | null;
  country: string | null;
  year: number;
  is_virtual: number | null;
  token_count: number | null;
  has_artwork: number | null;
}

export interface CatalogDetailRow extends CatalogSummaryRow {
  description: string | null;
  end_date: string;
  event_url: string | null;
  channel: string | null;
  platform: string | null;
  location_type: string | null;
  timezone: string | null;
  created_at: string;
  email_reservations_total: number | null;
  email_reservations_minted: number | null;
  email_reservations_unminted: number | null;
}

export interface HoldingRow {
  source_uid: string;
  poap_id: number;
  drop_id: number;
  minted_on: number;
  network: string;
  transfer_count: number;
}

export interface ExportCatalogRow {
  drop_id: number;
  title: string;
  start_date: string;
  end_date: string;
  city: string | null;
  country: string | null;
  event_url: string | null;
  has_artwork: number;
}

export interface ArchiveMeta {
  snapshotId: string;
  snapshotAt: string;
  counts: {
    drops: number;
    tokens: number;
    owners: number;
    artworks: number;
  };
  years: number[];
}

export interface DropSummary {
  dropId: number;
  fancyId: string;
  title: string;
  startDate: string;
  city: string | null;
  country: string | null;
  year: number;
  isVirtual: boolean | null;
  imageUrl: string;
  hasArtwork: boolean;
  tokenCount: number;
}

export interface DropDetail extends DropSummary {
  description: string | null;
  endDate: string;
  eventUrl: string | null;
  channel: string | null;
  platform: string | null;
  locationType: string | null;
  timezone: string | null;
  createdAt: string;
  reservationsTotal: number;
  reservationsMinted: number;
  reservationsUnminted: number;
}

export interface OwnerToken extends DropSummary {
  sourceUid: string;
  poapId: number;
  mintedOn: number | null;
  ownerAddress: string;
  network: string;
  transferCount: number;
}

export interface ExportRecord {
  snapshot_id: string;
  snapshot_at: string;
  queried_address: string;
  source_uid: string;
  poap_id: number;
  drop_id: number;
  title: string;
  start_date: string;
  end_date: string;
  city: string | null;
  country: string | null;
  event_url: string | null;
  network: string;
  minted_on: number | null;
  transfer_count: number;
  artwork_url: string | null;
}
