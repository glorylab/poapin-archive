import { safeExternalUrl } from "./repository";
import type { Bindings, D1ReadClient } from "./types";
import { ApiError } from "./validation";

export type MomentMediaKind = "image" | "video" | "audio" | "other";
export type MediaPreservationState = "none" | "pending" | "partial" | "complete";

export interface MomentsReleaseIdentity {
  snapshotId: string;
  sourceDatabaseSha256: string;
  buildManifestSha256: string;
}

export interface MomentCursor {
  v: 1;
  c: "moments";
  s: string;
  f: string;
  p: number;
  k: string;
  i: string;
}

export interface MomentsQuery {
  author: string | null;
  dropId: number | null;
  collectionId: number | null;
  mediaKind: MomentMediaKind | null;
  limit: number;
  cursor: MomentCursor | null;
  filterKey: string;
}

export interface MomentPageQuery {
  mediaKind?: MomentMediaKind | null;
  limit: number;
  cursor: MomentCursor | null;
  filterKey: string;
}

export interface MomentsMeta {
  snapshotId: string;
  snapshotAt: string;
  counts: {
    sourceMoments: number;
    publicMoments: number;
    media: number;
    capsules: number;
  };
}

export interface MomentMedia {
  mediaId: string;
  kind: MomentMediaKind;
  mimeType: string | null;
  url: string;
  thumbnailUrl: null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  position: number;
}

export interface MomentSummary {
  momentId: string;
  displayId: string | null;
  author: string | null;
  description: string | null;
  createdOn: string;
  updatedOn: string | null;
  isUpdated: boolean;
  sourceMediaCount: number;
  mediaCount: number;
  mediaPreservationState: MediaPreservationState;
  previewMedia: Omit<MomentMedia, "byteLength" | "durationMs" | "position"> | null;
  dropIds: number[];
  collectionIds: number[];
}

export interface MomentLink {
  linkId: string;
  title: string | null;
  description: string | null;
  url: string | null;
  imageUrl: string | null;
  createdOn: string | null;
}

export interface MomentUserTag {
  tagId: string;
  address: string | null;
  ens: string | null;
  x: number | null;
  y: number | null;
  createdOn: string | null;
}

export interface MomentCapsule {
  capsuleId: number;
  externalId: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  url: string | null;
  owner: string | null;
  createdOn: string;
}

export interface MomentDetail extends MomentSummary {
  cid: string | null;
  tokenId: string | null;
  media: MomentMedia[];
  links: MomentLink[];
  userTags: MomentUserTag[];
  capsules: MomentCapsule[];
}

interface MetaRow {
  key: string;
  value: string;
}

interface MomentSummaryRow {
  moment_id: string;
  display_id: string | null;
  author: string | null;
  description: string | null;
  created_on: string;
  updated_on: string | null;
  updated: number;
}

interface MomentMediaCountRow {
  moment_id: string;
  source_media_count: number;
  media_count: number;
}

interface MomentCoreRow {
  moment_id: string;
  cid: string | null;
  token_id: string | null;
}

interface MomentMediaRow {
  media_key: string;
  moment_id: string;
  media_kind: string;
  object_key: string;
  archive_sha256: string;
  archive_byte_length: number | null;
  archive_content_type: string | null;
  archive_status: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  position: number;
}

interface MomentDropRow {
  moment_id: string;
  drop_id: number;
}

interface MomentCollectionRow {
  moment_id: string;
  collection_id: number;
}

interface MomentLinkRow {
  link_id: string;
  moment_id: string;
  title: string | null;
  description: string | null;
  url: string | null;
  image_object_key: string | null;
  image_sha256: string | null;
  image_mime_type: string | null;
  image_archive_status: string;
  created_on: string | null;
}

interface MomentTagRow {
  tag_id: string;
  moment_id: string;
  address: string | null;
  ens: string | null;
  x: number | null;
  y: number | null;
  created_on: string | null;
}

interface MomentCapsuleRow {
  moment_id: string;
  capsule_id: number;
  external_id: string | null;
  title: string | null;
  description: string | null;
  image_object_key: string | null;
  image_sha256: string | null;
  image_mime_type: string | null;
  image_archive_status: string;
  url: string | null;
  owner: string | null;
  created_on: string;
}

interface CountRow {
  count: number;
}

const MAX_PAGE_SIZE = 48;
interface RelationBounds {
  perMoment: number;
  perPage: number;
}

// Release-shape audit (moments-2026-07-23-v1):
// - Drop/Collection summaries: at most 14 rows per Moment and 480 rows per page.
// - Public media: at most 565 rows per Moment and 811 rows per author-export page.
// Keep headroom for the immutable release while bounding every D1 result before
// it reaches Worker memory. A future release outside this envelope fails closed
// instead of returning a silently truncated archive.
const SUMMARY_RELATION_BOUNDS = {
  perMoment: 32,
  perPage: MAX_PAGE_SIZE * 32,
} as const satisfies RelationBounds;
const DETAIL_RELATION_BOUNDS = {
  media: { perMoment: 1_024, perPage: 2_048 },
  links: { perMoment: 64, perPage: 512 },
  userTags: { perMoment: 64, perPage: 512 },
  capsules: { perMoment: 64, perPage: 512 },
} as const satisfies Record<string, RelationBounds>;
const SHA256 = /^[0-9a-f]{64}$/;

const READINESS_SQL = `
  SELECT key, value
  FROM moments_meta
  WHERE key IN (
    'snapshot_id',
    'ready',
    'source_database_sha256',
    'build_manifest_sha256'
  )
  LIMIT 4`;

const META_SQL = `
  SELECT key, value
  FROM moments_meta
  WHERE key IN (
    'snapshot_id',
    'snapshot_at',
    'ready',
    'source_database_sha256',
    'build_manifest_sha256',
    'source_moments_count',
    'public_moments_count',
    'media_count',
    'capsules_count'
  )`;

const PUBLIC_MEDIA_PREDICATE = publicMediaPredicate("media");

const SUMMARY_COLUMNS = `
  moment.moment_id,
  moment.display_id,
  moment.author,
  moment.description,
  moment.created_on,
  moment.updated_on,
  moment.updated`;

export function momentsReleaseIdentity(
  bindings: Pick<
    Bindings,
    "MOMENTS_SNAPSHOT_ID" | "MOMENTS_SOURCE_DATABASE_SHA256" | "MOMENTS_BUILD_MANIFEST_SHA256"
  >,
): MomentsReleaseIdentity {
  const identity = {
    snapshotId: bindings.MOMENTS_SNAPSHOT_ID,
    sourceDatabaseSha256: bindings.MOMENTS_SOURCE_DATABASE_SHA256,
    buildManifestSha256: bindings.MOMENTS_BUILD_MANIFEST_SHA256,
  };
  if (
    !identity.snapshotId ||
    !SHA256.test(identity.sourceDatabaseSha256) ||
    !SHA256.test(identity.buildManifestSha256)
  ) {
    throw new ApiError(
      503,
      "The Moments release identity is not configured.",
      "moments_release_unavailable",
    );
  }
  return identity;
}

export async function fetchMomentsMeta(
  db: D1ReadClient,
  release: MomentsReleaseIdentity,
): Promise<MomentsMeta> {
  const result = await db.prepare(META_SQL).all<MetaRow>();
  const meta = new Map(result.results.map((row) => [row.key, row.value]));
  assertMomentsReadiness(result.results, release);
  const snapshotAt = meta.get("snapshot_at");
  if (!snapshotAt) {
    throw new ApiError(503, "Moments metadata is not available.", "moments_unavailable");
  }
  return {
    snapshotId: release.snapshotId,
    snapshotAt,
    counts: {
      sourceMoments: storedCount(meta.get("source_moments_count")),
      publicMoments: storedCount(meta.get("public_moments_count")),
      media: storedCount(meta.get("media_count")),
      capsules: storedCount(meta.get("capsules_count")),
    },
  };
}

export async function fetchMoments(
  db: D1ReadClient,
  query: MomentsQuery,
  release: MomentsReleaseIdentity,
  mediaBaseUrl: string,
): Promise<{ snapshotId: string; items: MomentSummary[]; nextCursor: string | null }> {
  const snapshotId = release.snapshotId;
  assertPageQuery(query, snapshotId);
  const browse = makeBrowseStatement(query);
  const [readinessResult, browseResult] = await db.batch<MetaRow | MomentSummaryRow>([
    db.prepare(READINESS_SQL),
    db.prepare(browse.sql).bind(...browse.values),
  ]);
  assertMomentsReadiness(readinessResult.results as MetaRow[], release);
  const allRows = browseResult.results as MomentSummaryRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const items = await hydrateSummaries(db, rows, snapshotId, mediaBaseUrl);
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeMomentCursor({
          v: 1,
          c: "moments",
          s: snapshotId,
          f: query.filterKey,
          p: (query.cursor?.p ?? 1) + 1,
          k: last.created_on,
          i: last.moment_id,
        })
      : null;
  return { snapshotId, items, nextCursor };
}

export async function fetchMoment(
  db: D1ReadClient,
  momentId: string,
  release: MomentsReleaseIdentity,
  mediaBaseUrl: string,
): Promise<MomentDetail | null> {
  const snapshotId = release.snapshotId;
  const [readinessResult, momentResult] = await db.batch<MetaRow | MomentSummaryRow>([
    db.prepare(READINESS_SQL),
    db
      .prepare(
        `
          SELECT ${SUMMARY_COLUMNS}
          FROM public_moments moment
          WHERE moment.moment_id = ?1
          LIMIT 1`,
      )
      .bind(momentId),
  ]);
  assertMomentsReadiness(readinessResult.results as MetaRow[], release);
  const row = momentResult.results[0] as MomentSummaryRow | undefined;
  if (!row) return null;
  const summaries = await hydrateSummaries(db, [row], snapshotId, mediaBaseUrl);
  const details = await hydrateDetails(db, summaries, snapshotId, mediaBaseUrl);
  return details[0] ?? null;
}

export async function fetchAuthorMomentExportPage(
  db: D1ReadClient,
  author: string,
  query: MomentPageQuery,
  release: MomentsReleaseIdentity,
  mediaBaseUrl: string,
): Promise<{
  schemaVersion: "poapin-moment-author-export-v1";
  snapshotId: string;
  author: string;
  items: MomentDetail[];
  nextCursor: string | null;
}> {
  const snapshotId = release.snapshotId;
  const page = await fetchMoments(
    db,
    {
      author,
      dropId: null,
      collectionId: null,
      mediaKind: query.mediaKind ?? null,
      limit: query.limit,
      cursor: query.cursor,
      filterKey: query.filterKey,
    },
    release,
    mediaBaseUrl,
  );
  return {
    schemaVersion: "poapin-moment-author-export-v1",
    snapshotId,
    author,
    items: await hydrateDetails(db, page.items, snapshotId, mediaBaseUrl),
    nextCursor: page.nextCursor,
  };
}

export function fetchDropMoments(
  db: D1ReadClient,
  dropId: number,
  query: MomentPageQuery,
  release: MomentsReleaseIdentity,
  mediaBaseUrl: string,
): Promise<{ snapshotId: string; items: MomentSummary[]; nextCursor: string | null }> {
  return fetchMoments(
    db,
    {
      author: null,
      dropId,
      collectionId: null,
      mediaKind: query.mediaKind ?? null,
      limit: query.limit,
      cursor: query.cursor,
      filterKey: query.filterKey,
    },
    release,
    mediaBaseUrl,
  );
}

export function fetchCollectionMoments(
  db: D1ReadClient,
  collectionId: number,
  query: MomentPageQuery,
  release: MomentsReleaseIdentity,
  mediaBaseUrl: string,
): Promise<{ snapshotId: string; items: MomentSummary[]; nextCursor: string | null }> {
  return fetchMoments(
    db,
    {
      author: null,
      dropId: null,
      collectionId,
      mediaKind: query.mediaKind ?? null,
      limit: query.limit,
      cursor: query.cursor,
      filterKey: query.filterKey,
    },
    release,
    mediaBaseUrl,
  );
}

export function fetchDropMomentCount(
  db: D1ReadClient,
  dropId: number,
  release: MomentsReleaseIdentity,
): Promise<number> {
  return fetchScopedCount(db, "drop", dropId, release);
}

export function fetchCollectionMomentCount(
  db: D1ReadClient,
  collectionId: number,
  release: MomentsReleaseIdentity,
): Promise<number> {
  return fetchScopedCount(db, "collection", collectionId, release);
}

async function fetchScopedCount(
  db: D1ReadClient,
  scope: "drop" | "collection",
  id: number,
  release: MomentsReleaseIdentity,
): Promise<number> {
  const relation = scope === "drop" ? "moment_drops" : "moment_collections";
  const idColumn = scope === "drop" ? "drop_id" : "collection_id";
  const [readinessResult, countResult] = await db.batch<MetaRow | CountRow>([
    db.prepare(READINESS_SQL),
    db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM ${relation} relation
          JOIN public_moments moment ON moment.moment_id = relation.moment_id
          WHERE relation.${idColumn} = ?1`,
      )
      .bind(id),
  ]);
  assertMomentsReadiness(readinessResult.results as MetaRow[], release);
  return numberValue((countResult.results[0] as CountRow | undefined)?.count);
}

export function makeBrowseStatement(query: MomentsQuery): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };
  let from: string;
  const where: string[] = [
    `EXISTS (
        SELECT 1
        FROM public_moments allowed_moment
        WHERE allowed_moment.moment_id = moment.moment_id
      )`,
  ];

  // Begin unscoped browsing from the matching recency index so SQLite can stop
  // after the bounded page instead of sorting the whole public projection. A
  // Drop/Collection filter starts from its selective relationship index. The
  // public_moments EXISTS remains the single fail-closed publication gate.
  if (query.dropId !== null) {
    from = `moment_drops browse_drop INDEXED BY idx_moment_drops_drop
    JOIN moments moment ON moment.moment_id = browse_drop.moment_id`;
    where.push(`browse_drop.drop_id = ${bind(query.dropId)}`);
  } else if (query.collectionId !== null) {
    from = `moment_collections browse_collection INDEXED BY idx_moment_collections_collection
    JOIN moments moment ON moment.moment_id = browse_collection.moment_id`;
    where.push(`browse_collection.collection_id = ${bind(query.collectionId)}`);
  } else if (query.author !== null) {
    from = "moments moment INDEXED BY idx_moments_author_recent";
  } else {
    from = "moments moment INDEXED BY idx_moments_recent";
  }

  let sql = `
    SELECT ${SUMMARY_COLUMNS}
    FROM ${from}
    WHERE ${where.join("\n      AND ")}`;
  if (query.author !== null) {
    sql += `\n      AND moment.author_address_norm = ${bind(query.author)}`;
  }
  if (query.dropId !== null && !from.startsWith("moment_drops ")) {
    sql += `
      AND EXISTS (
        SELECT 1
        FROM moment_drops filtered_drop
        WHERE filtered_drop.moment_id = moment.moment_id
          AND filtered_drop.drop_id = ${bind(query.dropId)}
      )`;
  }
  if (query.collectionId !== null && !from.startsWith("moment_collections ")) {
    sql += `
      AND EXISTS (
        SELECT 1
        FROM moment_collections filtered_collection
        WHERE filtered_collection.moment_id = moment.moment_id
          AND filtered_collection.collection_id = ${bind(query.collectionId)}
      )`;
  }
  if (query.mediaKind !== null) {
    sql += `
      AND EXISTS (
        SELECT 1
        FROM moment_media media
        WHERE media.moment_id = moment.moment_id
          AND media.media_kind = ${bind(query.mediaKind)}
          AND ${PUBLIC_MEDIA_PREDICATE}
      )`;
  }
  if (query.cursor) {
    sql += `
      AND (moment.created_on, moment.moment_id) < (
        ${bind(query.cursor.k)},
        ${bind(query.cursor.i)}
      )`;
  }
  sql += `
    ORDER BY moment.created_on DESC, moment.moment_id DESC
    LIMIT ${bind(query.limit + 1)}`;
  return { sql, values };
}

async function hydrateSummaries(
  db: D1ReadClient,
  rows: MomentSummaryRow[],
  snapshotId: string,
  mediaBaseUrl: string,
): Promise<MomentSummary[]> {
  if (rows.length === 0) return [];
  const momentIds = rows.map((row) => row.moment_id);
  const placeholders = momentIds.map((_, index) => `?${index + 1}`).join(", ");
  const limitBind = momentIds.length + 1;
  const summaryRelationLimit = relationRowLimit(momentIds.length, SUMMARY_RELATION_BOUNDS);
  const previewPredicate = publicMediaPredicate("preview");
  const earlierPredicate = publicMediaPredicate("earlier");
  const countPredicate = publicMediaPredicate("media");
  const [mediaCountsResult, previewResult, dropsResult, collectionsResult] = await db.batch<
    MomentMediaCountRow | MomentMediaRow | MomentDropRow | MomentCollectionRow
  >([
    db
      .prepare(
        `
          SELECT
            media.moment_id,
            COUNT(*) AS source_media_count,
            SUM(CASE WHEN ${countPredicate} THEN 1 ELSE 0 END) AS media_count
          FROM moment_media media INDEXED BY idx_moment_media_moment
          WHERE media.moment_id IN (${placeholders})
          GROUP BY media.moment_id
          ORDER BY media.moment_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...momentIds, momentIds.length + 1),
    db
      .prepare(
        `
          SELECT
            preview.media_key,
            preview.moment_id,
            preview.media_kind,
            preview.object_key,
            preview.archive_sha256,
            preview.archive_byte_length,
            preview.archive_content_type,
            preview.archive_status,
            preview.width,
            preview.height,
            preview.duration_ms,
            preview.position
          FROM moment_media preview
          WHERE preview.moment_id IN (${placeholders})
            AND ${previewPredicate}
            AND NOT EXISTS (
              SELECT 1
              FROM moment_media earlier
              WHERE earlier.moment_id = preview.moment_id
                AND ${earlierPredicate}
                AND (earlier.position, earlier.created_at, earlier.media_key)
                  < (preview.position, preview.created_at, preview.media_key)
            )
          ORDER BY preview.moment_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...momentIds, momentIds.length + 1),
    db
      .prepare(
        `
          SELECT moment_id, drop_id
          FROM moment_drops
          WHERE moment_id IN (${placeholders})
          ORDER BY moment_id ASC, position ASC, drop_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...momentIds, summaryRelationLimit + 1),
    db
      .prepare(
        `
          SELECT moment_id, collection_id
          FROM moment_collections
          WHERE moment_id IN (${placeholders})
          ORDER BY moment_id ASC, collection_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...momentIds, summaryRelationLimit + 1),
  ]);
  assertBound(mediaCountsResult.results.length, momentIds.length, "media counts");
  assertBound(previewResult.results.length, momentIds.length, "media previews");
  assertBound(dropsResult.results.length, summaryRelationLimit, "Drop relationships");
  assertBound(collectionsResult.results.length, summaryRelationLimit, "Collection relationships");

  const previewByMoment = new Map<string, MomentMedia>();
  for (const row of previewResult.results as MomentMediaRow[]) {
    const media = toMomentMedia(row, snapshotId, mediaBaseUrl);
    if (media) previewByMoment.set(row.moment_id, media);
  }
  const mediaCountsByMoment = new Map(
    (mediaCountsResult.results as MomentMediaCountRow[]).map((row) => [row.moment_id, row]),
  );
  const dropsByMoment = groupNumbers(
    dropsResult.results as MomentDropRow[],
    (row) => row.moment_id,
    (row) => numberValue(row.drop_id),
  );
  const collectionsByMoment = groupNumbers(
    collectionsResult.results as MomentCollectionRow[],
    (row) => row.moment_id,
    (row) => numberValue(row.collection_id),
  );
  assertPerMomentBound(dropsByMoment, "Drop relationships", SUMMARY_RELATION_BOUNDS.perMoment);
  assertPerMomentBound(
    collectionsByMoment,
    "Collection relationships",
    SUMMARY_RELATION_BOUNDS.perMoment,
  );

  return rows.map((row) => {
    const preview = previewByMoment.get(row.moment_id) ?? null;
    const counts = mediaCountsByMoment.get(row.moment_id);
    const sourceMediaCount = counts ? numberValue(counts.source_media_count) : 0;
    const mediaCount = counts ? numberValue(counts.media_count) : 0;
    return {
      momentId: row.moment_id,
      displayId: row.display_id,
      author: row.author,
      description: row.description,
      createdOn: row.created_on,
      updatedOn: row.updated_on,
      isUpdated: numberValue(row.updated) === 1,
      sourceMediaCount,
      mediaCount,
      mediaPreservationState: mediaPreservationState(sourceMediaCount, mediaCount),
      previewMedia: preview
        ? {
            mediaId: preview.mediaId,
            kind: preview.kind,
            mimeType: preview.mimeType,
            url: preview.url,
            thumbnailUrl: null,
            width: preview.width,
            height: preview.height,
          }
        : null,
      dropIds: dropsByMoment.get(row.moment_id) ?? [],
      collectionIds: collectionsByMoment.get(row.moment_id) ?? [],
    };
  });
}

async function hydrateDetails(
  db: D1ReadClient,
  summaries: MomentSummary[],
  snapshotId: string,
  mediaBaseUrl: string,
): Promise<MomentDetail[]> {
  if (summaries.length === 0) return [];
  const ids = summaries.map((summary) => summary.momentId);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
  const limitBind = ids.length + 1;
  const mediaLimit = relationRowLimit(ids.length, DETAIL_RELATION_BOUNDS.media);
  const linksLimit = relationRowLimit(ids.length, DETAIL_RELATION_BOUNDS.links);
  const userTagsLimit = relationRowLimit(ids.length, DETAIL_RELATION_BOUNDS.userTags);
  const capsulesLimit = relationRowLimit(ids.length, DETAIL_RELATION_BOUNDS.capsules);
  const [coreResult, mediaResult, linksResult, tagsResult, capsulesResult] = await db.batch<
    MomentCoreRow | MomentMediaRow | MomentLinkRow | MomentTagRow | MomentCapsuleRow
  >([
    db
      .prepare(
        `
          SELECT moment_id, cid, token_id
          FROM public_moments
          WHERE moment_id IN (${placeholders})`,
      )
      .bind(...ids),
    db
      .prepare(
        `
          SELECT
            media.media_key,
            media.moment_id,
            media.media_kind,
            media.object_key,
            media.archive_sha256,
            media.archive_byte_length,
            media.archive_content_type,
            media.archive_status,
            media.width,
            media.height,
            media.duration_ms,
            media.position
          FROM moment_media media
          WHERE media.moment_id IN (${placeholders})
            AND ${PUBLIC_MEDIA_PREDICATE}
          ORDER BY media.moment_id ASC, media.position ASC, media.created_at ASC, media.media_key ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...ids, mediaLimit + 1),
    db
      .prepare(
        `
          SELECT
            link_id,
            moment_id,
            title,
            description,
            url,
            image_object_key,
            image_sha256,
            image_mime_type,
            image_archive_status,
            created_on
          FROM moment_links
          WHERE moment_id IN (${placeholders})
          ORDER BY moment_id ASC, position ASC, link_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...ids, linksLimit + 1),
    db
      .prepare(
        `
          SELECT tag_id, moment_id, address, ens, x, y, created_on
          FROM moment_user_tags
          WHERE moment_id IN (${placeholders})
          ORDER BY moment_id ASC, position ASC, tag_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...ids, userTagsLimit + 1),
    db
      .prepare(
        `
          SELECT
            relation.moment_id,
            capsule.capsule_id,
            capsule.external_id,
            capsule.title,
            capsule.description,
            capsule.image_object_key,
            capsule.image_sha256,
            capsule.image_mime_type,
            capsule.image_archive_status,
            capsule.url,
            capsule.owner,
            capsule.created_on
          FROM capsule_moments relation
          JOIN public_capsules capsule ON capsule.capsule_id = relation.capsule_id
          WHERE relation.moment_id IN (${placeholders})
          ORDER BY relation.moment_id ASC, relation.position ASC, capsule.capsule_id ASC
          LIMIT ?${limitBind}`,
      )
      .bind(...ids, capsulesLimit + 1),
  ]);
  for (const [name, length, maximum] of [
    ["media", mediaResult.results.length, mediaLimit],
    ["links", linksResult.results.length, linksLimit],
    ["user tags", tagsResult.results.length, userTagsLimit],
    ["capsules", capsulesResult.results.length, capsulesLimit],
  ] as const) {
    assertBound(length, maximum, name);
  }

  const coreByMoment = new Map(
    (coreResult.results as MomentCoreRow[]).map((row) => [row.moment_id, row]),
  );
  const mediaByMoment = groupMapped(
    mediaResult.results as MomentMediaRow[],
    (row) => row.moment_id,
    (row) => toMomentMedia(row, snapshotId, mediaBaseUrl),
  );
  const linksByMoment = groupMapped(
    linksResult.results as MomentLinkRow[],
    (row) => row.moment_id,
    (row) => toMomentLink(row, snapshotId, mediaBaseUrl),
  );
  const tagsByMoment = groupMapped(
    tagsResult.results as MomentTagRow[],
    (row) => row.moment_id,
    toMomentTag,
  );
  const capsulesByMoment = groupMapped(
    capsulesResult.results as MomentCapsuleRow[],
    (row) => row.moment_id,
    (row) => toMomentCapsule(row, snapshotId, mediaBaseUrl),
  );
  assertPerMomentBound(mediaByMoment, "media", DETAIL_RELATION_BOUNDS.media.perMoment);
  assertPerMomentBound(linksByMoment, "links", DETAIL_RELATION_BOUNDS.links.perMoment);
  assertPerMomentBound(tagsByMoment, "user tags", DETAIL_RELATION_BOUNDS.userTags.perMoment);
  assertPerMomentBound(capsulesByMoment, "capsules", DETAIL_RELATION_BOUNDS.capsules.perMoment);

  return summaries.map((summary) => {
    const core = coreByMoment.get(summary.momentId);
    if (!core) {
      throw new ApiError(503, "A public Moment changed during this request.", "snapshot_mismatch");
    }
    return {
      ...summary,
      cid: core.cid,
      tokenId: core.token_id,
      media: mediaByMoment.get(summary.momentId) ?? [],
      links: linksByMoment.get(summary.momentId) ?? [],
      userTags: tagsByMoment.get(summary.momentId) ?? [],
      capsules: capsulesByMoment.get(summary.momentId) ?? [],
    };
  });
}

function toMomentMedia(
  row: MomentMediaRow,
  snapshotId: string,
  mediaBaseUrl: string,
): MomentMedia | null {
  const url = publicObjectUrl(
    row.object_key,
    row.archive_sha256,
    row.archive_content_type,
    row.archive_status,
    snapshotId,
    mediaBaseUrl,
  );
  if (!url) return null;
  return {
    mediaId: row.media_key,
    kind: toMediaKind(row.media_kind),
    mimeType: row.archive_content_type,
    url,
    thumbnailUrl: null,
    byteLength: nullableNumber(row.archive_byte_length),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    durationMs: nullableNumber(row.duration_ms),
    position: numberValue(row.position),
  };
}

function toMomentLink(row: MomentLinkRow, snapshotId: string, mediaBaseUrl: string): MomentLink {
  return {
    linkId: row.link_id,
    title: row.title,
    description: row.description,
    url: safeMomentExternalUrl(row.url),
    imageUrl: publicObjectUrl(
      row.image_object_key,
      row.image_sha256,
      row.image_mime_type,
      row.image_archive_status,
      snapshotId,
      mediaBaseUrl,
    ),
    createdOn: row.created_on,
  };
}

function toMomentTag(row: MomentTagRow): MomentUserTag {
  return {
    tagId: row.tag_id,
    address: row.address,
    ens: row.ens,
    x: nullableNumber(row.x),
    y: nullableNumber(row.y),
    createdOn: row.created_on,
  };
}

function toMomentCapsule(
  row: MomentCapsuleRow,
  snapshotId: string,
  mediaBaseUrl: string,
): MomentCapsule {
  return {
    capsuleId: numberValue(row.capsule_id),
    externalId: row.external_id,
    title: row.title,
    description: row.description,
    imageUrl: publicObjectUrl(
      row.image_object_key,
      row.image_sha256,
      row.image_mime_type,
      row.image_archive_status,
      snapshotId,
      mediaBaseUrl,
    ),
    url: safeMomentExternalUrl(row.url),
    owner: row.owner,
    createdOn: row.created_on,
  };
}

export function safeMomentExternalUrl(value: string | null): string | null {
  const safe = safeExternalUrl(value);
  if (!safe) return null;
  return new URL(safe).protocol === "https:" ? safe : null;
}

function mediaPreservationState(
  sourceMediaCount: number,
  mediaCount: number,
): MediaPreservationState {
  if (sourceMediaCount === 0) return "none";
  if (mediaCount === 0) return "pending";
  return mediaCount < sourceMediaCount ? "partial" : "complete";
}

function publicObjectUrl(
  objectKey: string | null,
  sha256: string | null,
  contentType: string | null,
  archiveStatus: string,
  snapshotId: string,
  mediaBaseUrl: string,
): string | null {
  if (archiveStatus !== "public_stored" || !objectKey || !sha256) return null;
  const extension = mediaExtension(contentType);
  if (!extension || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const expected = publicObjectKey(snapshotId, sha256, extension);
  if (objectKey !== expected) return null;
  try {
    const base = new URL(mediaBaseUrl);
    if (base.protocol !== "https:" || base.username || base.password) return null;
    base.search = "";
    base.hash = "";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/${objectKey}`;
    return base.toString();
  } catch {
    return null;
  }
}

function publicObjectKey(snapshotId: string, sha256: string, extension: string): string {
  return `snapshots/${snapshotId}/moments/original/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

function publicMediaPredicate(alias: string): string {
  const extension = mediaExtensionSql(`${alias}.archive_content_type`);
  const snapshotId = `(SELECT value FROM moments_meta WHERE key = 'snapshot_id')`;
  return `${alias}.archive_status = 'public_stored'
      AND ${alias}.object_key IS NOT NULL
      AND ${alias}.archive_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
      AND length(${alias}.archive_sha256) = 64
      AND ${alias}.archive_sha256 NOT GLOB '*[^0-9a-f]*'
      AND (${extension}) IS NOT NULL
      AND ${alias}.object_key =
        'snapshots/' || ${snapshotId} || '/moments/original/sha256/' ||
        substr(${alias}.archive_sha256, 1, 2) || '/' || ${alias}.archive_sha256 || '.' ||
        (${extension})`;
}

function mediaExtension(contentType: string | null): string | null {
  switch (contentType?.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/heic":
      return "heic";
    case "image/x-adobe-dng":
      return "dng";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/aac":
      return "aac";
    case "application/octet-stream":
      return "bin";
    default:
      return null;
  }
}

function mediaExtensionSql(column: string): string {
  return `CASE lower(trim(${column}))
    WHEN 'image/jpeg' THEN 'jpg'
    WHEN 'image/png' THEN 'png'
    WHEN 'image/gif' THEN 'gif'
    WHEN 'image/webp' THEN 'webp'
    WHEN 'image/avif' THEN 'avif'
    WHEN 'image/heic' THEN 'heic'
    WHEN 'image/x-adobe-dng' THEN 'dng'
    WHEN 'video/mp4' THEN 'mp4'
    WHEN 'video/webm' THEN 'webm'
    WHEN 'video/quicktime' THEN 'mov'
    WHEN 'audio/mpeg' THEN 'mp3'
    WHEN 'audio/mp4' THEN 'm4a'
    WHEN 'audio/ogg' THEN 'ogg'
    WHEN 'audio/wav' THEN 'wav'
    WHEN 'audio/x-wav' THEN 'wav'
    WHEN 'audio/flac' THEN 'flac'
    WHEN 'audio/aac' THEN 'aac'
    WHEN 'application/octet-stream' THEN 'bin'
    ELSE NULL
  END`;
}

function assertMomentsReadiness(rows: MetaRow[], expected: MomentsReleaseIdentity): void {
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  if (meta.get("snapshot_id") !== expected.snapshotId) {
    throw new ApiError(
      503,
      "Moments snapshot metadata does not match this deployment.",
      "snapshot_mismatch",
    );
  }
  if (
    meta.get("source_database_sha256") !== expected.sourceDatabaseSha256 ||
    meta.get("build_manifest_sha256") !== expected.buildManifestSha256
  ) {
    throw new ApiError(
      503,
      "Moments release metadata does not match this deployment.",
      "moments_release_mismatch",
    );
  }
  if (meta.get("ready") !== "1") {
    throw new ApiError(
      503,
      "The Moments snapshot has not been published yet.",
      "moments_unavailable",
    );
  }
}

function assertPageQuery(
  query: Pick<MomentsQuery, "limit" | "cursor" | "filterKey">,
  snapshotId: string,
): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE_SIZE) {
    throw new ApiError(400, `Moment page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (query.cursor) {
    if (
      query.cursor.v !== 1 ||
      query.cursor.c !== "moments" ||
      query.cursor.s !== snapshotId ||
      query.cursor.f !== query.filterKey ||
      !Number.isInteger(query.cursor.p) ||
      query.cursor.p < 2 ||
      !query.cursor.k ||
      !query.cursor.i
    ) {
      throw new ApiError(400, "Moment cursor does not match this query.");
    }
  }
}

function assertBound(actual: number, maximum: number, relation: string): void {
  if (actual > maximum) {
    throw new ApiError(
      503,
      `This page exceeds the bounded ${relation} shape supported by this API version.`,
      "moments_shape_unsupported",
    );
  }
}

function relationRowLimit(momentCount: number, bounds: RelationBounds): number {
  return Math.min(bounds.perPage, momentCount * bounds.perMoment);
}

function assertPerMomentBound<T>(
  byMoment: Map<string, T[]>,
  relation: string,
  maximum: number,
): void {
  for (const values of byMoment.values()) {
    assertBound(values.length, maximum, relation);
  }
}

function groupNumbers<Row>(
  rows: Row[],
  key: (row: Row) => string,
  value: (row: Row) => number,
): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const values = grouped.get(groupKey) ?? [];
    values.push(value(row));
    grouped.set(groupKey, values);
  }
  return grouped;
}

function groupMapped<Row, Value>(
  rows: Row[],
  key: (row: Row) => string,
  value: (row: Row) => Value | null,
): Map<string, Value[]> {
  const grouped = new Map<string, Value[]>();
  for (const row of rows) {
    const mapped = value(row);
    if (mapped === null) continue;
    const groupKey = key(row);
    const values = grouped.get(groupKey) ?? [];
    values.push(mapped);
    grouped.set(groupKey, values);
  }
  return grouped;
}

function encodeMomentCursor(cursor: MomentCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toMediaKind(value: string): MomentMediaKind {
  return value === "image" || value === "video" || value === "audio" ? value : "other";
}

function storedCount(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new ApiError(503, "Moments metadata contains an invalid count.", "moments_unavailable");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new ApiError(503, "Moments metadata count is outside the supported range.");
  }
  return count;
}

function numberValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
