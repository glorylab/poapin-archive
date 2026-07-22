import { collectionDropArtworkUrl, collectionMediaObjectUrl } from "./media";
import { safeExternalUrl } from "./repository";
import type {
  CollectionArtist,
  CollectionArtistDropsPage,
  CollectionArtistRow,
  CollectionDetailRow,
  CollectionDropCard,
  CollectionDropStatsByChainRow,
  CollectionDropStatsPage,
  CollectionDropStatsRow,
  CollectionItem,
  CollectionItemSectionRow,
  CollectionItemsPage,
  CollectionItemsQuery,
  CollectionItemRow,
  CollectionExportSegmentQuery,
  CollectionMedia,
  CollectionMediaRow,
  CollectionOrganization,
  CollectionOrganizationRow,
  CollectionProfile,
  CollectionRecord,
  CollectionSection,
  CollectionSectionRow,
  CollectionsQuery,
  CollectionSummary,
  CollectionSummaryRow,
  CollectionSuggestionsPage,
  CollectionType,
  CollectionUiSettings,
  CollectionUrlRow,
  D1ReadClient,
} from "./types";
import { ApiError, encodeCursor } from "./validation";

const MAX_PROFILE_URLS = 100;
const MAX_PROFILE_MEDIA = 4;
const MAX_PROFILE_SECTIONS = 100;
const MAX_PROFILE_ENTITIES = 16;
const MAX_ITEM_SECTION_MEMBERSHIPS = 4_800;
const MAX_DROP_STATS_CHAINS_PER_DROP = 16;
const MAX_DROP_STATS_CHAIN_ROWS = 48 * MAX_DROP_STATS_CHAINS_PER_DROP;

const READINESS_SQL = `
  SELECT key, value
  FROM collections_meta
  WHERE key IN ('snapshot_id', 'ready')
  LIMIT 2`;

const COLLECTION_SUMMARY_COLUMNS = `
  c.collection_id,
  c.slug,
  c.title,
  c.description,
  c.type,
  c.year,
  c.updated_on,
  c.item_count,
  c.section_count,
  logo.object_key AS logo_object_key,
  banner.object_key AS banner_object_key,
  featured.featured_on,
  verification.verified_on`;

const COLLECTION_MEDIA_JOINS = `
  LEFT JOIN collection_media logo
    ON logo.collection_id = c.collection_id
    AND logo.role = 'logo'
    AND logo.status = 'stored'
    AND logo.eligible_for_publish = 1
  LEFT JOIN collection_media banner
    ON banner.collection_id = c.collection_id
    AND banner.role = 'banner'
    AND banner.status = 'stored'
    AND banner.eligible_for_publish = 1
  LEFT JOIN featured_collections featured
    ON featured.collection_id = c.collection_id
  LEFT JOIN verified_collections verification
    ON verification.collection_id = c.collection_id`;

const COLLECTION_DETAIL_SQL = `
  SELECT
    ${COLLECTION_SUMMARY_COLUMNS},
    c.type_rank,
    c.owner_address,
    c.external_url,
    c.created_on,
    ui.collection_id AS ui_collection_id,
    ui.primary_color,
    ui.highlight_color,
    ui.dark_color,
    ui.grey_color,
    ui.white_color,
    ui.is_visible_in_recent_list,
    ui.toggle_poap_elements,
    verification.verified_by,
    verifier.name AS verifier_name,
    verifier.slug AS verifier_slug
  FROM collections c
  ${COLLECTION_MEDIA_JOINS}
  LEFT JOIN collection_ui_settings ui
    ON ui.collection_id = c.collection_id
  LEFT JOIN collection_organizations verifier
    ON verifier.organization_id = verification.verified_by
  WHERE c.collection_id = ?1
  LIMIT 1`;

const COLLECTION_URLS_SQL = `
  SELECT url_id, url
  FROM collection_urls
  WHERE collection_id = ?1
  ORDER BY url_id ASC
  LIMIT ${MAX_PROFILE_URLS + 1}`;

const COLLECTION_MEDIA_SQL = `
  SELECT
    role,
    object_key,
    content_type,
    byte_length,
    sha256,
    width,
    height,
    status,
    eligible_for_publish
  FROM collection_media
  WHERE collection_id = ?1
  ORDER BY CASE role
    WHEN 'logo' THEN 1
    WHEN 'banner' THEN 2
    WHEN 'mobile_banner' THEN 3
    ELSE 4
  END
  LIMIT ${MAX_PROFILE_MEDIA + 1}`;

const COLLECTION_SECTIONS_SQL = `
  SELECT section_id, name, position
  FROM collection_sections
  WHERE collection_id = ?1
  ORDER BY position ASC, section_id ASC
  LIMIT ${MAX_PROFILE_SECTIONS + 1}`;

const COLLECTION_ARTISTS_SQL = `
  SELECT artist_id, ens, name, slug, created_at
  FROM collection_artists
  WHERE collection_id = ?1
  ORDER BY artist_id ASC
  LIMIT ${MAX_PROFILE_ENTITIES + 1}`;

const COLLECTION_ORGANIZATIONS_SQL = `
  SELECT organization_id, name, slug, created_on
  FROM collection_organizations
  WHERE collection_id = ?1
  ORDER BY organization_id ASC
  LIMIT ${MAX_PROFILE_ENTITIES + 1}`;

const COLLECTION_ITEM_COUNT_SQL = `
  SELECT item_count
  FROM collections
  WHERE collection_id = ?1
  LIMIT 1`;

const DROP_CARD_COLUMNS = `
  drop_card.fancy_id,
  drop_card.title AS drop_title,
  drop_card.description AS drop_description,
  drop_card.start_date,
  drop_card.end_date,
  drop_card.expiry_date,
  drop_card.year AS drop_year,
  drop_card.city,
  drop_card.country,
  drop_card.event_url,
  drop_card.image_object_key,
  drop_card.is_virtual,
  drop_card.private_value,
  drop_card.is_hidden,
  drop_card.channel,
  drop_card.platform,
  drop_card.location_type,
  drop_card.timezone,
  drop_card.integrator_id,
  drop_card.created_date,
  drop_card.token_count,
  drop_card.transfer_count,
  drop_card.email_claims_minted,
  drop_card.email_claims_reserved,
  drop_card.email_claims_total,
  drop_card.featured_on AS drop_featured_on,
  drop_card.moments_uploaded`;

const COLLECTION_ITEM_COLUMNS = `
  item.item_id,
  item.created_on,
  item.drop_id,
  ${DROP_CARD_COLUMNS}`;

interface MetaRow {
  key: string;
  value: string;
}

interface CollectionCountRow {
  item_count: number;
}

interface CollectionExportCountRow {
  item_count: number;
  section_count: number;
}

interface CollectionExportUrlRow {
  url_id: number;
}

interface CollectionExportMediaRow {
  role: string;
}

type DropCardSourceRow = Omit<CollectionItemRow, "item_id" | "created_on">;

type DropAggregateSourceRow = Pick<
  CollectionItemRow,
  | "token_count"
  | "transfer_count"
  | "email_claims_minted"
  | "email_claims_reserved"
  | "email_claims_total"
  | "drop_featured_on"
  | "moments_uploaded"
>;

type CollectionArtistDropRow = DropCardSourceRow & {
  artist_id: string;
};

type CollectionSuggestionRow = DropCardSourceRow & {
  suggestion_id: number;
  suggested_by: string | null;
  suggestion_created_on: string;
};

interface SegmentPresenceRow {
  present: number;
}

type CollectionExportSegmentName =
  "metadata" | "items" | "artist-drops" | "suggestions" | "drop-stats";

interface CollectionExportManifest {
  schemaVersion: "poapin-collection-export-v1";
  snapshotId: string;
  collectionId: number;
  counts: { items: number; sections: number; urls: number; media: number };
  segments: Array<{
    name: CollectionExportSegmentName;
    path: string;
    pagination: "none" | "cursor";
    pageSize?: number;
  }>;
}

export async function fetchCollectionsReadiness(
  db: D1ReadClient,
  snapshotId: string,
): Promise<{ snapshotId: string; ready: true }> {
  const result = await db.prepare(READINESS_SQL).all<MetaRow>();
  assertCollectionsReadiness(result.results, snapshotId);
  return { snapshotId, ready: true };
}

export async function fetchCollections(
  db: D1ReadClient,
  query: CollectionsQuery,
  snapshotId: string,
  mediaBaseUrl: string,
): Promise<{ items: CollectionSummary[]; nextCursor: string | null }> {
  const browse = makeCollectionBrowseStatement(query);
  const [readinessResult, browseResult] = await db.batch<MetaRow | CollectionSummaryRow>([
    db.prepare(READINESS_SQL),
    db.prepare(browse.sql).bind(...browse.values),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);

  const rows = browseResult.results as CollectionSummaryRow[];
  const hasNext = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const items = pageRows.map((row) => toCollectionSummary(row, mediaBaseUrl, snapshotId));
  const last = pageRows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "collections",
          s: snapshotId,
          f: query.filterKey,
          p: (query.cursor?.p ?? 1) + 1,
          k: last.updated_on,
          i: numberValue(last.collection_id),
        })
      : null;

  return { items, nextCursor };
}

export async function fetchCollectionProfile(
  db: D1ReadClient,
  collectionId: number,
  snapshotId: string,
  mediaBaseUrl: string,
): Promise<CollectionProfile | null> {
  const [
    readinessResult,
    detailResult,
    urlsResult,
    mediaResult,
    sectionsResult,
    artistsResult,
    organizationsResult,
  ] = await db.batch<
    | MetaRow
    | CollectionDetailRow
    | CollectionUrlRow
    | CollectionMediaRow
    | CollectionSectionRow
    | CollectionArtistRow
    | CollectionOrganizationRow
  >([
    db.prepare(READINESS_SQL),
    db.prepare(COLLECTION_DETAIL_SQL).bind(collectionId),
    db.prepare(COLLECTION_URLS_SQL).bind(collectionId),
    db.prepare(COLLECTION_MEDIA_SQL).bind(collectionId),
    db.prepare(COLLECTION_SECTIONS_SQL).bind(collectionId),
    db.prepare(COLLECTION_ARTISTS_SQL).bind(collectionId),
    db.prepare(COLLECTION_ORGANIZATIONS_SQL).bind(collectionId),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);

  const detail = detailResult.results[0] as CollectionDetailRow | undefined;
  if (!detail) return null;
  const urls = urlsResult.results as CollectionUrlRow[];
  const media = mediaResult.results as CollectionMediaRow[];
  const sections = sectionsResult.results as CollectionSectionRow[];
  const artists = artistsResult.results as CollectionArtistRow[];
  const organizations = organizationsResult.results as CollectionOrganizationRow[];
  assertProfileBounds(urls.length, media.length, sections.length);
  assertEntityBounds(artists.length, organizations.length);

  return {
    snapshotId,
    collection: toCollectionRecord(detail, mediaBaseUrl, snapshotId),
    urls: urls.map((row) => ({ urlId: numberValue(row.url_id), url: safeExternalUrl(row.url) })),
    uiSettings: toUiSettings(detail),
    media: media.map((row) => toCollectionMedia(row, mediaBaseUrl, snapshotId)),
    sections: sections.map(toCollectionSection),
    artists: artists.map(toCollectionArtist),
    organizations: organizations.map(toCollectionOrganization),
  };
}

export async function fetchCollectionItems(
  db: D1ReadClient,
  query: CollectionItemsQuery,
  snapshotId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
): Promise<CollectionItemsPage | null> {
  const itemStatement = makeCollectionItemsStatement(query);
  const [readinessResult, countResult, itemsResult] = await db.batch<
    MetaRow | CollectionCountRow | CollectionItemRow
  >([
    db.prepare(READINESS_SQL),
    db.prepare(COLLECTION_ITEM_COUNT_SQL).bind(query.collectionId),
    db.prepare(itemStatement.sql).bind(...itemStatement.values),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);

  const countRow = countResult.results[0] as CollectionCountRow | undefined;
  if (!countRow) return null;
  const allRows = itemsResult.results as CollectionItemRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const sectionMemberships = await fetchItemSectionMemberships(
    db,
    query.collectionId,
    rows.map((row) => numberValue(row.item_id)),
  );
  const items = rows.map((row) =>
    toCollectionItem(
      row,
      sectionMemberships.get(numberValue(row.item_id)) ?? [],
      mediaBaseUrl,
      archiveSnapshotId,
      snapshotId,
    ),
  );
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "collection-items",
          s: snapshotId,
          f: query.filterKey,
          p: (query.cursor?.p ?? 1) + 1,
          i: numberValue(last.item_id),
        })
      : null;

  return {
    collectionId: query.collectionId,
    total: numberValue(countRow.item_count),
    items,
    nextCursor,
  };
}

export async function fetchCollectionArtistDrops(
  db: D1ReadClient,
  query: CollectionExportSegmentQuery,
  snapshotId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
): Promise<CollectionArtistDropsPage | null> {
  if (query.segment !== "artist-drops") {
    throw new ApiError(400, "Export segment query is invalid.");
  }
  const statement = makeCollectionArtistDropsStatement(query);
  const [readinessResult, collectionResult, rowsResult] = await db.batch<
    MetaRow | CollectionCountRow | CollectionArtistDropRow
  >([
    db.prepare(READINESS_SQL),
    db.prepare(COLLECTION_ITEM_COUNT_SQL).bind(query.collectionId),
    db.prepare(statement.sql).bind(...statement.values),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);
  if (!collectionResult.results[0]) return null;

  const allRows = rowsResult.results as CollectionArtistDropRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "collection-export-segment",
          s: snapshotId,
          f: query.filterKey,
          p: (query.cursor?.p ?? 1) + 1,
          g: "artist-drops",
          a: last.artist_id,
          d: numberValue(last.drop_id),
        })
      : null;

  return {
    collectionId: query.collectionId,
    items: rows.map((row) => ({
      artistId: row.artist_id,
      dropId: numberValue(row.drop_id),
      drop:
        row.fancy_id === null
          ? null
          : toCollectionDropCard(row, mediaBaseUrl, archiveSnapshotId, snapshotId),
    })),
    nextCursor,
  };
}

export async function fetchCollectionSuggestions(
  db: D1ReadClient,
  query: CollectionExportSegmentQuery,
  snapshotId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
): Promise<CollectionSuggestionsPage | null> {
  if (query.segment !== "suggestions") {
    throw new ApiError(400, "Export segment query is invalid.");
  }
  const statement = makeCollectionSuggestionsStatement(query);
  const [readinessResult, collectionResult, rowsResult] = await db.batch<
    MetaRow | CollectionCountRow | CollectionSuggestionRow
  >([
    db.prepare(READINESS_SQL),
    db.prepare(COLLECTION_ITEM_COUNT_SQL).bind(query.collectionId),
    db.prepare(statement.sql).bind(...statement.values),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);
  if (!collectionResult.results[0]) return null;

  const allRows = rowsResult.results as CollectionSuggestionRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "collection-export-segment",
          s: snapshotId,
          f: query.filterKey,
          p: (query.cursor?.p ?? 1) + 1,
          g: "suggestions",
          i: numberValue(last.suggestion_id),
        })
      : null;

  return {
    collectionId: query.collectionId,
    items: rows.map((row) => ({
      suggestionId: numberValue(row.suggestion_id),
      dropId: numberValue(row.drop_id),
      suggestedBy: row.suggested_by,
      createdOn: row.suggestion_created_on,
      drop:
        row.fancy_id === null
          ? null
          : toCollectionDropCard(row, mediaBaseUrl, archiveSnapshotId, snapshotId),
    })),
    nextCursor,
  };
}

export async function fetchCollectionDropStats(
  db: D1ReadClient,
  query: CollectionExportSegmentQuery,
  snapshotId: string,
): Promise<CollectionDropStatsPage | null> {
  if (query.segment !== "drop-stats") {
    throw new ApiError(400, "Export segment query is invalid.");
  }
  const statement = makeCollectionDropStatsStatement(query);
  const [readinessResult, collectionResult, rowsResult] = await db.batch<
    MetaRow | CollectionCountRow | CollectionDropStatsRow
  >([
    db.prepare(READINESS_SQL),
    db.prepare(COLLECTION_ITEM_COUNT_SQL).bind(query.collectionId),
    db.prepare(statement.sql).bind(...statement.values),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);
  if (!collectionResult.results[0]) return null;

  const allRows = rowsResult.results as CollectionDropStatsRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);

  // Privacy is decided before the secondary lookup. Private, hidden, missing,
  // or otherwise malformed cards never have their chain statistics queried.
  const visibleDropIds = rows
    .filter((row) => dropStatsVisibility(row) === "visible")
    .map((row) => numberValue(row.drop_id));
  const byChain = await fetchDropStatsByChain(db, visibleDropIds);
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "collection-export-segment",
          s: snapshotId,
          f: query.filterKey,
          p: (query.cursor?.p ?? 1) + 1,
          g: "drop-stats",
          d: numberValue(last.drop_id),
        })
      : null;

  return {
    collectionId: query.collectionId,
    items: rows.map((row) =>
      toCollectionDropStats(row, byChain.get(numberValue(row.drop_id)) ?? []),
    ),
    nextCursor,
  };
}

export async function fetchCollectionExportManifest(
  db: D1ReadClient,
  collectionId: number,
  snapshotId: string,
): Promise<CollectionExportManifest | null> {
  const countsSql = `
    SELECT
      c.item_count,
      c.section_count
    FROM collections c
    WHERE c.collection_id = ?1
    LIMIT 1`;
  const [
    readinessResult,
    countsResult,
    urlsResult,
    mediaResult,
    artistDropsResult,
    suggestionsResult,
  ] = await db.batch<
    | MetaRow
    | CollectionExportCountRow
    | CollectionExportUrlRow
    | CollectionExportMediaRow
    | SegmentPresenceRow
  >([
    db.prepare(READINESS_SQL),
    db.prepare(countsSql).bind(collectionId),
    db
      .prepare(
        `SELECT url_id FROM collection_urls WHERE collection_id = ?1 ORDER BY url_id LIMIT ${MAX_PROFILE_URLS + 1}`,
      )
      .bind(collectionId),
    db
      .prepare(
        `SELECT role FROM collection_media WHERE collection_id = ?1 ORDER BY role LIMIT ${MAX_PROFILE_MEDIA + 1}`,
      )
      .bind(collectionId),
    db
      .prepare(
        `SELECT 1 AS present
         FROM collection_artist_drops artist_drop
         JOIN collection_artists artist ON artist.artist_id = artist_drop.artist_id
         WHERE artist.collection_id = ?1
         LIMIT 1`,
      )
      .bind(collectionId),
    db
      .prepare(
        `SELECT 1 AS present
         FROM suggested_drops
         WHERE collection_id = ?1
           AND curation_status = 'approved'
         LIMIT 1`,
      )
      .bind(collectionId),
  ]);
  assertCollectionsReadiness(readinessResult.results as MetaRow[], snapshotId);
  const row = countsResult.results[0] as CollectionExportCountRow | undefined;
  if (!row) return null;
  const urlsCount = urlsResult.results.length;
  const mediaCount = mediaResult.results.length;
  assertProfileBounds(urlsCount, mediaCount, numberValue(row.section_count));

  const basePath = `/api/collections/${collectionId}/export`;
  const segments: CollectionExportManifest["segments"] = [
    { name: "metadata", path: `${basePath}/metadata`, pagination: "none" },
    { name: "items", path: `${basePath}/items?limit=48`, pagination: "cursor", pageSize: 48 },
  ];
  if (artistDropsResult.results.length > 0) {
    segments.push({
      name: "artist-drops",
      path: `${basePath}/artist-drops?limit=48`,
      pagination: "cursor",
      pageSize: 48,
    });
  }
  if (suggestionsResult.results.length > 0) {
    segments.push({
      name: "suggestions",
      path: `${basePath}/suggestions?limit=48`,
      pagination: "cursor",
      pageSize: 48,
    });
  }
  if (
    numberValue(row.item_count) > 0 ||
    artistDropsResult.results.length > 0 ||
    suggestionsResult.results.length > 0
  ) {
    segments.push({
      name: "drop-stats",
      path: `${basePath}/drop-stats?limit=48`,
      pagination: "cursor",
      pageSize: 48,
    });
  }
  return {
    schemaVersion: "poapin-collection-export-v1",
    snapshotId,
    collectionId,
    counts: {
      items: numberValue(row.item_count),
      sections: numberValue(row.section_count),
      urls: urlsCount,
      media: mediaCount,
    },
    segments,
  };
}

function makeCollectionBrowseStatement(query: CollectionsQuery): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };
  let sql = `
    SELECT ${COLLECTION_SUMMARY_COLUMNS}
    FROM collections c`;
  if (query.ftsQuery)
    sql += "\n    JOIN collections_fts ON collections_fts.rowid = c.collection_id";
  sql += COLLECTION_MEDIA_JOINS;
  sql += "\n    WHERE 1 = 1";
  if (query.ftsQuery) sql += `\n      AND collections_fts MATCH ${bind(query.ftsQuery)}`;
  if (!query.ftsQuery) {
    sql += `
      AND NOT EXISTS (
        SELECT 1
        FROM collection_ui_settings recent_ui
        WHERE recent_ui.collection_id = c.collection_id
          AND recent_ui.is_visible_in_recent_list = 0
      )`;
  }
  if (query.year !== null) sql += `\n      AND c.year = ${bind(query.year)}`;
  if (query.type !== "all") sql += `\n      AND c.type = ${bind(query.type)}`;
  if (query.cursor) {
    sql += `\n      AND (c.updated_on, c.collection_id) < (${bind(query.cursor.k)}, ${bind(query.cursor.i)})`;
  }
  sql += `\n    ORDER BY c.updated_on DESC, c.collection_id DESC\n    LIMIT ${bind(query.limit + 1)}`;
  return { sql, values };
}

function makeCollectionItemsStatement(query: CollectionItemsQuery): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [query.collectionId];
  let cursorClause = "";
  if (query.cursor) {
    values.push(query.cursor.i);
    cursorClause = `\n      AND item.item_id > ?${values.length}`;
  }
  values.push(query.limit + 1);
  return {
    sql: `
      SELECT ${COLLECTION_ITEM_COLUMNS}
      FROM collection_items item
      LEFT JOIN collection_drop_cards drop_card ON drop_card.drop_id = item.drop_id
      WHERE item.collection_id = ?1${cursorClause}
      ORDER BY item.item_id ASC
      LIMIT ?${values.length}`,
    values,
  };
}

function makeCollectionArtistDropsStatement(query: CollectionExportSegmentQuery): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [query.collectionId];
  let cursorClause = "";
  if (query.cursor) {
    values.push(query.cursor.a!, query.cursor.d!);
    cursorClause = `
      AND (artist_drop.artist_id, artist_drop.drop_id) > (?2, ?3)`;
  }
  values.push(query.limit + 1);
  return {
    sql: `
      SELECT
        artist_drop.artist_id,
        artist_drop.drop_id,
        ${DROP_CARD_COLUMNS}
      FROM collection_artist_drops artist_drop
      JOIN collection_artists artist ON artist.artist_id = artist_drop.artist_id
      LEFT JOIN collection_drop_cards drop_card ON drop_card.drop_id = artist_drop.drop_id
      WHERE artist.collection_id = ?1${cursorClause}
      ORDER BY artist_drop.artist_id ASC, artist_drop.drop_id ASC
      LIMIT ?${values.length}`,
    values,
  };
}

function makeCollectionSuggestionsStatement(query: CollectionExportSegmentQuery): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [query.collectionId];
  let cursorClause = "";
  if (query.cursor) {
    values.push(query.cursor.i!);
    cursorClause = `
      AND suggestion.suggestion_id > ?2`;
  }
  values.push(query.limit + 1);
  return {
    sql: `
      SELECT
        suggestion.suggestion_id,
        suggestion.drop_id,
        suggestion.suggested_by,
        suggestion.created_on AS suggestion_created_on,
        ${DROP_CARD_COLUMNS}
      FROM suggested_drops suggestion
      LEFT JOIN collection_drop_cards drop_card ON drop_card.drop_id = suggestion.drop_id
      WHERE suggestion.collection_id = ?1
        AND suggestion.curation_status = 'approved'${cursorClause}
      ORDER BY suggestion.suggestion_id ASC
      LIMIT ?${values.length}`,
    values,
  };
}

function makeCollectionDropStatsStatement(query: CollectionExportSegmentQuery): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [query.collectionId];
  let itemCursorClause = "";
  let artistCursorClause = "";
  let suggestionCursorClause = "";
  if (query.cursor) {
    values.push(query.cursor.d!);
    itemCursorClause = ` AND item.drop_id > ?${values.length}`;
    artistCursorClause = ` AND artist_drop.drop_id > ?${values.length}`;
    suggestionCursorClause = ` AND suggestion.drop_id > ?${values.length}`;
  }
  values.push(query.limit + 1);
  return {
    sql: `
      WITH scoped_drop_ids(drop_id) AS (
        SELECT item.drop_id
        FROM collection_items item
        WHERE item.collection_id = ?1${itemCursorClause}
        UNION
        SELECT artist_drop.drop_id
        FROM collection_artist_drops artist_drop
        JOIN collection_artists artist ON artist.artist_id = artist_drop.artist_id
        WHERE artist.collection_id = ?1${artistCursorClause}
        UNION
        SELECT suggestion.drop_id
        FROM suggested_drops suggestion
        WHERE suggestion.collection_id = ?1
          AND suggestion.curation_status = 'approved'${suggestionCursorClause}
      )
      SELECT
        scoped.drop_id,
        drop_card.drop_id AS card_drop_id,
        drop_card.private_value,
        drop_card.is_hidden,
        drop_card.token_count,
        drop_card.transfer_count,
        drop_card.email_claims_minted,
        drop_card.email_claims_reserved,
        drop_card.email_claims_total,
        drop_card.featured_on AS drop_featured_on,
        drop_card.moments_uploaded
      FROM scoped_drop_ids scoped
      LEFT JOIN collection_drop_cards drop_card ON drop_card.drop_id = scoped.drop_id
      ORDER BY scoped.drop_id ASC
      LIMIT ?${values.length}`,
    values,
  };
}

async function fetchItemSectionMemberships(
  db: D1ReadClient,
  collectionId: number,
  itemIds: number[],
): Promise<Map<number, Array<{ sectionId: string; position: number }>>> {
  if (itemIds.length === 0) return new Map();
  const placeholders = itemIds.map((_, index) => `?${index + 2}`).join(", ");
  const result = await db
    .prepare(
      `
        SELECT membership.item_id, membership.section_id, membership.position
        FROM collection_item_sections membership
        JOIN collection_sections section ON section.section_id = membership.section_id
        WHERE section.collection_id = ?1
          AND membership.item_id IN (${placeholders})
        ORDER BY membership.item_id ASC, section.position ASC, membership.position ASC, membership.section_id ASC
        LIMIT ${MAX_ITEM_SECTION_MEMBERSHIPS + 1}`,
    )
    .bind(collectionId, ...itemIds)
    .all<CollectionItemSectionRow>();
  if (result.results.length > MAX_ITEM_SECTION_MEMBERSHIPS) {
    throw new ApiError(
      503,
      "This collection exceeds the bounded item-section shape supported by this API version.",
      "collections_shape_unsupported",
    );
  }
  const memberships = new Map<number, Array<{ sectionId: string; position: number }>>();
  for (const row of result.results) {
    const itemId = numberValue(row.item_id);
    const itemMemberships = memberships.get(itemId) ?? [];
    itemMemberships.push({ sectionId: row.section_id, position: numberValue(row.position) });
    memberships.set(itemId, itemMemberships);
  }
  return memberships;
}

async function fetchDropStatsByChain(
  db: D1ReadClient,
  dropIds: number[],
): Promise<
  Map<
    number,
    Array<{
      chain: string | null;
      createdOn: number | null;
      poapCount: number;
      transferCount: number;
    }>
  >
> {
  const uniqueDropIds = [...new Set(dropIds)];
  if (uniqueDropIds.length === 0) return new Map();
  if (uniqueDropIds.length > 48) {
    throw new ApiError(
      503,
      "Drop statistics page exceeds the supported shape.",
      "collections_shape_unsupported",
    );
  }

  const placeholders = uniqueDropIds.map((_, index) => `?${index + 1}`).join(", ");
  const limitBind = uniqueDropIds.length + 1;
  const result = await db
    .prepare(
      `
        SELECT drop_id, chain, created_on, poap_count, transfer_count
        FROM collection_drop_stats_by_chain
        WHERE drop_id IN (${placeholders})
        ORDER BY drop_id ASC, chain_key ASC
        LIMIT ?${limitBind}`,
    )
    .bind(...uniqueDropIds, MAX_DROP_STATS_CHAIN_ROWS + 1)
    .all<CollectionDropStatsByChainRow>();
  if (result.results.length > MAX_DROP_STATS_CHAIN_ROWS) {
    throw new ApiError(
      503,
      "This page exceeds the bounded per-chain statistics shape supported by this API version.",
      "collections_shape_unsupported",
    );
  }

  const allowedDropIds = new Set(uniqueDropIds);
  const byDrop = new Map<
    number,
    Array<{
      chain: string | null;
      createdOn: number | null;
      poapCount: number;
      transferCount: number;
    }>
  >();
  for (const row of result.results) {
    const dropId = numberValue(row.drop_id);
    if (!allowedDropIds.has(dropId)) {
      throw new ApiError(503, "Drop statistics query escaped its bounded ID set.");
    }
    const entries = byDrop.get(dropId) ?? [];
    if (entries.length >= MAX_DROP_STATS_CHAINS_PER_DROP) {
      throw new ApiError(
        503,
        "A drop exceeds the bounded per-chain statistics shape supported by this API version.",
        "collections_shape_unsupported",
      );
    }
    entries.push({
      chain: row.chain,
      createdOn: nullableNumber(row.created_on),
      poapCount: numberValue(row.poap_count),
      transferCount: numberValue(row.transfer_count),
    });
    byDrop.set(dropId, entries);
  }
  return byDrop;
}

function assertCollectionsReadiness(rows: MetaRow[], expectedSnapshotId: string): void {
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  if (meta.get("snapshot_id") !== expectedSnapshotId) {
    throw new ApiError(
      503,
      "Collections snapshot metadata does not match this deployment.",
      "snapshot_mismatch",
    );
  }
  if (meta.get("ready") !== "1") {
    throw new ApiError(
      503,
      "The Collections snapshot has not been published yet.",
      "collections_unavailable",
    );
  }
}

function assertProfileBounds(urls: number, media: number, sections: number): void {
  if (urls > MAX_PROFILE_URLS || media > MAX_PROFILE_MEDIA || sections > MAX_PROFILE_SECTIONS) {
    throw new ApiError(
      503,
      "This collection exceeds the bounded profile shape supported by this API version.",
      "collections_shape_unsupported",
    );
  }
}

function assertEntityBounds(artists: number, organizations: number): void {
  if (artists > MAX_PROFILE_ENTITIES || organizations > MAX_PROFILE_ENTITIES) {
    throw new ApiError(
      503,
      "This collection exceeds the bounded entity shape supported by this API version.",
      "collections_shape_unsupported",
    );
  }
}

function toCollectionSummary(
  row: CollectionSummaryRow,
  mediaBaseUrl: string,
  collectionsSnapshotId: string,
): CollectionSummary {
  return {
    collectionId: numberValue(row.collection_id),
    slug: row.slug,
    title: row.title,
    description: row.description,
    type: toCollectionType(row.type),
    year: nullableNumber(row.year),
    updatedOn: row.updated_on,
    itemCount: numberValue(row.item_count),
    sectionCount: numberValue(row.section_count),
    logoUrl: collectionMediaObjectUrl(mediaBaseUrl, row.logo_object_key, collectionsSnapshotId),
    bannerUrl: collectionMediaObjectUrl(mediaBaseUrl, row.banner_object_key, collectionsSnapshotId),
    isFeatured: row.featured_on !== null,
    isVerified: row.verified_on !== null,
  };
}

function toCollectionRecord(
  row: CollectionDetailRow,
  mediaBaseUrl: string,
  collectionsSnapshotId: string,
): CollectionRecord {
  const summary = toCollectionSummary(row, mediaBaseUrl, collectionsSnapshotId);
  const verification =
    row.verified_by !== null &&
    row.verifier_name !== null &&
    row.verifier_slug !== null &&
    row.verified_on !== null
      ? {
          organizationId: numberValue(row.verified_by),
          organizationName: row.verifier_name,
          organizationSlug: row.verifier_slug,
          verifiedOn: row.verified_on,
        }
      : null;
  return {
    ...summary,
    typeRank: nullableNumber(row.type_rank),
    ownerAddress: row.owner_address,
    externalUrl: safeExternalUrl(row.external_url),
    createdOn: row.created_on,
    featuredOn: row.featured_on,
    verification,
  };
}

function toUiSettings(row: CollectionDetailRow): CollectionUiSettings | null {
  if (row.ui_collection_id === null) return null;
  return {
    primaryColor: row.primary_color,
    highlightColor: row.highlight_color,
    darkColor: row.dark_color,
    greyColor: row.grey_color,
    whiteColor: row.white_color,
    isVisibleInRecentList: numberValue(row.is_visible_in_recent_list) === 1,
    togglePoapElements: numberValue(row.toggle_poap_elements) === 1,
  };
}

function toCollectionMedia(
  row: CollectionMediaRow,
  mediaBaseUrl: string,
  collectionsSnapshotId: string,
): CollectionMedia {
  const eligibleForPublish = row.status === "stored" && numberValue(row.eligible_for_publish) === 1;
  return {
    role: row.role as CollectionMedia["role"],
    objectUrl: eligibleForPublish
      ? collectionMediaObjectUrl(mediaBaseUrl, row.object_key, collectionsSnapshotId)
      : null,
    contentType: row.content_type,
    byteLength: nullableNumber(row.byte_length),
    sha256: row.sha256,
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    status: row.status as CollectionMedia["status"],
    eligibleForPublish,
  };
}

function toCollectionSection(row: CollectionSectionRow): CollectionSection {
  return {
    sectionId: row.section_id,
    name: row.name,
    position: numberValue(row.position),
  };
}

function toCollectionArtist(row: CollectionArtistRow): CollectionArtist {
  return {
    artistId: row.artist_id,
    ens: row.ens,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
  };
}

function toCollectionOrganization(row: CollectionOrganizationRow): CollectionOrganization {
  return {
    organizationId: numberValue(row.organization_id),
    name: row.name,
    slug: row.slug,
    createdOn: row.created_on,
  };
}

function toCollectionItem(
  row: CollectionItemRow,
  sections: Array<{ sectionId: string; position: number }>,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): CollectionItem {
  return {
    itemId: numberValue(row.item_id),
    createdOn: row.created_on,
    sections,
    drop:
      row.fancy_id === null
        ? null
        : toCollectionDropCard(row, mediaBaseUrl, archiveSnapshotId, collectionsSnapshotId),
  };
}

function toCollectionDropCard(
  row: DropCardSourceRow,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): CollectionDropCard {
  const dropId = numberValue(row.drop_id);
  if (row.is_hidden !== 0) return { dropId, isHidden: true };
  if (row.private_value !== "false") return { dropId, isPrivate: true };
  return {
    dropId,
    fancyId: row.fancy_id ?? "",
    title: row.drop_title ?? "",
    description: row.drop_description,
    startDate: row.start_date ?? "",
    endDate: row.end_date ?? "",
    expiryDate: row.expiry_date,
    year: numberValue(row.drop_year),
    city: row.city,
    country: row.country,
    eventUrl: safeExternalUrl(row.event_url),
    imageUrl: collectionDropArtworkUrl(
      mediaBaseUrl,
      row.image_object_key,
      archiveSnapshotId,
      collectionsSnapshotId,
      dropId,
    ),
    isVirtual: row.is_virtual === null ? null : numberValue(row.is_virtual) === 1,
    isPrivate: false,
    isHidden: false,
    channel: row.channel,
    platform: row.platform,
    locationType: row.location_type,
    timezone: row.timezone,
    integratorId: row.integrator_id,
    createdDate: row.created_date ?? "",
    tokenCount: nullableNumber(row.token_count),
    transferCount: numberValue(row.transfer_count),
    emailClaims: toEmailClaims(row),
    featuredOn: row.drop_featured_on,
    momentsUploaded: nullableNumber(row.moments_uploaded),
  };
}

function dropStatsVisibility(
  row: CollectionDropStatsRow,
): "missing" | "hidden" | "private" | "visible" {
  if (row.card_drop_id === null) return "missing";
  if (row.is_hidden !== 0) return "hidden";
  if (row.private_value !== "false") return "private";
  return "visible";
}

function toCollectionDropStats(
  row: CollectionDropStatsRow,
  byChain: Array<{
    chain: string | null;
    createdOn: number | null;
    poapCount: number;
    transferCount: number;
  }>,
): CollectionDropStatsPage["items"][number] {
  const dropId = numberValue(row.drop_id);
  const visibility = dropStatsVisibility(row);
  if (visibility === "missing") return { dropId };
  if (visibility === "hidden") return { dropId, isHidden: true };
  if (visibility === "private") return { dropId, isPrivate: true };
  return {
    dropId,
    isPrivate: false,
    isHidden: false,
    tokenCount: nullableNumber(row.token_count),
    transferCount: numberValue(row.transfer_count),
    emailClaims: toEmailClaims(row),
    featuredOn: row.drop_featured_on,
    momentsUploaded: nullableNumber(row.moments_uploaded),
    byChain,
  };
}

function toEmailClaims(row: DropAggregateSourceRow): {
  minted: number | null;
  reserved: number | null;
  total: number | null;
} | null {
  if (
    row.email_claims_minted === null &&
    row.email_claims_reserved === null &&
    row.email_claims_total === null
  ) {
    return null;
  }
  return {
    minted: nullableNumber(row.email_claims_minted),
    reserved: nullableNumber(row.email_claims_reserved),
    total: nullableNumber(row.email_claims_total),
  };
}

function toCollectionType(value: string | null): Exclude<CollectionType, "all"> | null {
  return value === "artist" || value === "organization" || value === "user" ? value : null;
}

function numberValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
