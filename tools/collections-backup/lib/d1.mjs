import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { SqlShardWriter, writeStaticArtifact } from "../../archive-import/lib/sql-shards.mjs";
import { ENTITY_CONFIGS } from "./config.mjs";
import { DROP_SUPPLEMENT_QUERY } from "./drop-supplement.mjs";
import {
  exists,
  fileMetadata,
  readGzipJson,
  readJson,
  sha256,
  sha256File,
  writeJsonAtomic,
} from "./files.mjs";

const MAX_SHARD_BYTES = 4 * 1024 * 1024;
const MAX_STATEMENT_BYTES = 90 * 1024;
const ROWS_PER_STATEMENT = 100;
const MEDIA_CONTENT_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
});
const SHA256 = /^[0-9a-f]{64}$/;
const DROP_SUPPLEMENT_ROOT = "drop-supplement";
const DROP_RELATION_ARTIFACTS = Object.freeze({
  statsByChain: "normalized/drop_stats_by_chain.ndjson",
  emailClaimsStats: "normalized/email_claims_stats.ndjson",
  featuredDrops: "normalized/featured_drops.ndjson",
  momentsStats: "normalized/moments_stats.ndjson",
});

const TABLES = [
  {
    source: "collections",
    table: "collections",
    columns: [
      "collection_id",
      "slug",
      "title",
      "description",
      "type",
      "type_rank",
      "year",
      "created_by",
      "owner_address",
      "owner_address_norm",
      "external_url",
      "logo_image_url",
      "banner_image_url",
      "created_on",
      "updated_on",
      "item_count",
      "section_count",
    ],
    map: (row, context) => [
      integer(row.id, "collections.id"),
      requiredText(row.slug, "collections.slug"),
      requiredText(row.title, "collections.title"),
      nullableText(row.description),
      nullableText(row.type),
      nullableInteger(row.type_rank, "collections.type_rank"),
      nullableInteger(row.year, "collections.year"),
      nullableText(row.created_by),
      nullableText(row.owner_address),
      normalizeAddress(row.owner_address),
      nullableText(row.external_url),
      nullableText(row.logo_image_url),
      nullableText(row.banner_image_url),
      requiredText(row.created_on, "collections.created_on"),
      requiredText(row.updated_on, "collections.updated_on"),
      context.itemCounts.get(String(row.id)) ?? 0,
      context.sectionCounts.get(String(row.id)) ?? 0,
    ],
  },
  {
    source: "referenced_drops",
    table: "collection_drop_cards",
    columns: [
      "drop_id",
      "fancy_id",
      "title",
      "description",
      "start_date",
      "end_date",
      "expiry_date",
      "year",
      "city",
      "country",
      "event_url",
      "image_url",
      "animation_url",
      "image_object_key",
      "is_virtual",
      "private_value",
      "is_private",
      "is_hidden",
      "channel",
      "platform",
      "location_type",
      "timezone",
      "integrator_id",
      "created_date",
      "token_count",
      "transfer_count",
      "email_claims_minted",
      "email_claims_reserved",
      "email_claims_total",
      "featured_on",
      "moments_uploaded",
    ],
    map: (row, context) => {
      const dropId = integer(row.id, "drops.id");
      const supplement = context.dropSupplement.dropCards.get(dropId);
      if (!supplement) throw new Error(`Drop supplement is missing drop ${dropId}.`);
      const privacy = normalizePrivateValue(row.private, dropId);
      return [
        dropId,
        nonNullText(row.fancy_id, "drops.fancy_id"),
        nonNullText(row.name, "drops.name"),
        nullableText(row.description),
        requiredText(row.start_date, "drops.start_date"),
        requiredText(row.end_date, "drops.end_date"),
        nullableText(row.expiry_date),
        integer(row.year, "drops.year"),
        nullableText(row.city),
        nullableText(row.country),
        nullableText(row.drop_url),
        nullableText(row.image_url),
        nullableText(row.animation_url),
        supplement.imageObjectKey,
        nullableBoolean(row.virtual, "drops.virtual"),
        privacy.privateValue,
        privacy.isPrivate,
        row.hidden_drop ? 1 : 0,
        nullableText(row.channel),
        nullableText(row.platform),
        nullableText(row.location_type),
        nullableText(row.timezone),
        nullableText(row.integrator_id),
        requiredText(row.created_date, "drops.created_date"),
        supplement.tokenCount,
        supplement.transferCount,
        supplement.emailClaimsMinted,
        supplement.emailClaimsReserved,
        supplement.emailClaimsTotal,
        supplement.featuredOn,
        supplement.momentsUploaded,
      ];
    },
  },
  {
    source: "drop_stats_by_chain",
    table: "collection_drop_stats_by_chain",
    columns: ["drop_id", "chain_key", "chain", "created_on", "poap_count", "transfer_count"],
    map: (row) => [
      integer(row.dropId, "drop_stats_by_chain.dropId"),
      requiredText(row.chainKey, "drop_stats_by_chain.chainKey"),
      nullableText(row.chain),
      nullableInteger(row.createdOn, "drop_stats_by_chain.createdOn"),
      nonNegativeInteger(row.poapCount, "drop_stats_by_chain.poapCount"),
      nonNegativeInteger(row.transferCount, "drop_stats_by_chain.transferCount"),
    ],
  },
  {
    source: "items",
    table: "collection_items",
    columns: ["item_id", "collection_id", "drop_id", "created_on"],
    map: (row) => [
      integer(row.id, "items.id"),
      integer(row.collection_id, "items.collection_id"),
      integer(row.drop_id, "items.drop_id"),
      nullableText(row.created_on),
    ],
  },
  {
    source: "sections",
    table: "collection_sections",
    columns: ["section_id", "collection_id", "name", "position"],
    map: (row) => [
      requiredText(row.id, "sections.id").toLowerCase(),
      integer(row.collection_id, "sections.collection_id"),
      nullableText(row.name),
      integer(row.position, "sections.position"),
    ],
  },
  {
    source: "item_sections",
    table: "collection_item_sections",
    columns: ["item_id", "section_id", "position"],
    map: (row) => [
      integer(row.item_id, "item_sections.item_id"),
      requiredText(row.section_id, "item_sections.section_id").toLowerCase(),
      integer(row.position, "item_sections.position"),
    ],
  },
  {
    source: "collection_urls",
    table: "collection_urls",
    columns: ["url_id", "collection_id", "url"],
    map: (row) => [
      integer(row.id, "collection_urls.id"),
      integer(row.collection_id, "collection_urls.collection_id"),
      requiredText(row.url, "collection_urls.url"),
    ],
  },
  {
    source: "collection_ui_settings",
    table: "collection_ui_settings",
    columns: [
      "collection_id",
      "primary_color",
      "highlight_color",
      "dark_color",
      "grey_color",
      "white_color",
      "is_visible_in_recent_list",
      "toggle_poap_elements",
    ],
    map: (row) => [
      integer(row.collection_id, "collection_ui_settings.collection_id"),
      nullableText(row.primary_color),
      nullableText(row.highlight_color),
      nullableText(row.dark_color),
      nullableText(row.grey_color),
      nullableText(row.white_color),
      boolean(row.is_visible_in_recent_list, "collection_ui_settings.is_visible_in_recent_list"),
      boolean(row.toggle_poap_elements, "collection_ui_settings.toggle_poap_elements"),
    ],
  },
  {
    source: "collection_media",
    table: "collection_media",
    columns: [
      "collection_id",
      "role",
      "source_url",
      "resolved_source_url",
      "object_key",
      "content_type",
      "byte_length",
      "sha256",
      "width",
      "height",
      "status",
      "eligible_for_publish",
      "retrieved_on",
      "failure_reason",
    ],
    map: (row, context) => [
      integer(row.collectionId, "collection_media.collectionId"),
      requiredText(row.role, "collection_media.role"),
      requiredText(row.sourceUrl, "collection_media.sourceUrl"),
      nullableText(row.resolvedSourceUrl),
      row.sha256
        ? `snapshots/${context.snapshotId}/collections/media/sha256/${row.sha256.slice(0, 2)}/${row.sha256}.${row.extension}`
        : null,
      nullableText(row.contentType),
      nullableInteger(row.byteLength, "collection_media.byteLength"),
      nullableText(row.sha256),
      null,
      null,
      mediaStatus(row.status),
      row.eligibleForPublish ? 1 : 0,
      nullableText(row.completedAt),
      nullableText(row.failureReason),
    ],
  },
  {
    source: "artists",
    table: "collection_artists",
    columns: ["artist_id", "collection_id", "ens", "name", "slug", "created_at"],
    map: (row) => [
      requiredText(row.id, "artists.id").toLowerCase(),
      nullableInteger(row.collection_id, "artists.collection_id"),
      nullableText(row.ens),
      nullableText(row.name),
      nullableText(row.slug),
      requiredText(row.created_at, "artists.created_at"),
    ],
  },
  {
    source: "artist_drops",
    table: "collection_artist_drops",
    columns: ["artist_id", "drop_id"],
    map: (row) => [
      requiredText(row.artist_id, "artist_drops.artist_id").toLowerCase(),
      integer(row.drop_id, "artist_drops.drop_id"),
    ],
  },
  {
    source: "organizations",
    table: "collection_organizations",
    columns: ["organization_id", "collection_id", "name", "slug", "created_on"],
    map: (row) => [
      integer(row.id, "organizations.id"),
      nullableInteger(row.collection_id, "organizations.collection_id"),
      requiredText(row.name, "organizations.name"),
      requiredText(row.slug, "organizations.slug"),
      requiredText(row.created_on, "organizations.created_on"),
    ],
  },
  {
    source: "verified_collections",
    table: "verified_collections",
    columns: ["collection_id", "verified_by", "verified_on"],
    map: (row) => [
      integer(row.collection_id, "verified_collections.collection_id"),
      integer(row.verified_by, "verified_collections.verified_by"),
      requiredText(row.verified_on, "verified_collections.verified_on"),
    ],
  },
  {
    source: "featured_collections",
    table: "featured_collections",
    columns: ["collection_id", "featured_on"],
    map: (row) => [
      integer(row.collection_id, "featured_collections.collection_id"),
      requiredText(row.featured_on, "featured_collections.featured_on"),
    ],
  },
  {
    source: "suggested_drops",
    table: "suggested_drops",
    columns: [
      "suggestion_id",
      "collection_id",
      "drop_id",
      "suggested_by",
      "curation_status",
      "created_on",
      "reviewed_on",
    ],
    map: (row) => [
      integer(row.id, "suggested_drops.id"),
      integer(row.collection_id, "suggested_drops.collection_id"),
      integer(row.drop_id, "suggested_drops.drop_id"),
      nullableText(row.suggested_by),
      requiredText(row.curation_status, "suggested_drops.curation_status"),
      requiredText(row.created_on, "suggested_drops.created_on"),
      nullableText(row.reviewed_on),
    ],
  },
];

export async function buildCollectionsD1({ input, snapshotId }) {
  const root = resolve(input);
  validateSnapshotId(snapshotId);
  const manifest = await readJson(resolve(root, "manifest.json"));
  const reportPath = resolve(root, "validation/report.json");
  if (!(await exists(reportPath))) throw new Error("Run verify before build-d1.");
  const validation = await readJson(reportPath);
  const manifestMetadata = await sha256File(resolve(root, "manifest.json"));
  if (validation.manifest?.sha256 !== manifestMetadata.sha256) {
    throw new Error("Validation report is stale; run verify again before build-d1.");
  }
  if (
    !validation.verified ||
    validation.normalized?.checked !== validation.normalized?.expected ||
    validation.relationships?.checked !== true ||
    validation.media?.checked !== true ||
    validation.media?.complete !== true
  ) {
    throw new Error(
      "Collections snapshot has not passed complete structural and media verification.",
    );
  }
  const d1Root = resolve(root, "d1");
  if (await exists(d1Root)) throw new Error(`D1 output already exists at ${d1Root}.`);
  const sourceInputs = await bindCollectionsSnapshotInputs({
    root,
    manifest,
    validation,
    snapshotId,
  });
  await mkdir(d1Root, { recursive: true });

  try {
    const sourceDigest = sourceDigestFor(manifest, sourceInputs);
    const rows = await loadSourceRows(root);
    const dropSupplement = await loadDropSupplement({
      root,
      snapshotId,
      expectedBinding: sourceInputs.dropSupplement,
    });
    rows.drop_stats_by_chain = dropSupplement.statsRows;
    const context = {
      snapshotId,
      itemCounts: countsBy(rows.items, "collection_id"),
      sectionCounts: countsBy(rows.sections, "collection_id"),
      dropSupplement,
    };
    rows.collection_media = await loadMediaRows(root, rows.collections);

    const migrationRoot = resolve(import.meta.dirname, "../../../migrations/collections");
    const schema = await readFile(resolve(migrationRoot, "0001_schema.sql"), "utf8");
    const journalSchema = await readFile(resolve(migrationRoot, "0002_import_shards.sql"), "utf8");
    const supplementSchema = await readFile(
      resolve(migrationRoot, "0003_drop_supplement.sql"),
      "utf8",
    );
    const artifacts = [
      await writeStaticArtifact(root, "d1/prepare/000001_schema.sql", schema, {
        kind: "d1-sql",
        phase: "prepare",
        database: "collections",
      }),
      await writeStaticArtifact(root, "d1/prepare/000002_import_shards.sql", journalSchema, {
        kind: "d1-sql",
        phase: "prepare",
        database: "collections",
      }),
      await writeStaticArtifact(root, "d1/prepare/000003_drop_supplement.sql", supplementSchema, {
        kind: "d1-sql",
        phase: "prepare",
        database: "collections",
      }),
    ];

    for (let index = 0; index < TABLES.length; index += 1) {
      const config = TABLES[index];
      const writer = new SqlShardWriter({
        outputRoot: root,
        relativeDirectory: "d1/load",
        sequenceStart: index * 1_000 + 1,
        label: config.table,
        table: config.table,
        columns: config.columns,
        maxShardBytes: MAX_SHARD_BYTES,
        maxStatementBytes: MAX_STATEMENT_BYTES,
        rowsPerStatement: ROWS_PER_STATEMENT,
        database: "collections",
        journal: { snapshotId, sourceDatabaseSha256: sourceDigest },
      });
      for (const row of rows[config.source]) await writer.add(config.map(row, context));
      artifacts.push(...(await writer.close()));
    }

    const dataArtifacts = artifacts.filter((artifact) => artifact.phase === "load");
    const mediaProof = await writeMediaProof({
      root,
      snapshotId,
      sourceInputs,
      dropSupplement,
    });
    const finalizer = makeFinalizer({
      snapshotId,
      manifest,
      validation,
      sourceDigest,
      rows,
      dataArtifacts,
      sourceInputs,
      mediaProof,
    });
    artifacts.push(
      await writeStaticArtifact(root, "d1/finalize/999999_finalize.sql", finalizer, {
        kind: "d1-sql",
        phase: "finalize",
        database: "collections",
      }),
    );

    const buildReport = {
      version: 1,
      snapshotId,
      generatedAt: new Date().toISOString(),
      sourceManifestSha256: (await sha256File(resolve(root, "manifest.json"))).sha256,
      sourceValidationSha256: sourceInputs.validation.sha256,
      sourceInputsSha256: sourceInputs.sha256,
      sourceInputs,
      mediaProof,
      sourceDatabaseSha256: sourceDigest,
      schemaSha256: manifest.schema.sha256,
      tables: Object.fromEntries(
        TABLES.map((config) => [config.table, rows[config.source].length]),
      ),
      artifacts,
      settings: {
        maxShardBytes: MAX_SHARD_BYTES,
        maxStatementBytes: MAX_STATEMENT_BYTES,
        rowsPerStatement: ROWS_PER_STATEMENT,
      },
    };
    await writeJsonAtomic(resolve(root, "d1/report.json"), buildReport);
    buildReport.portableDatabase = await buildPortableDatabase(root, artifacts);
    const reboundInputs = await bindCollectionsSnapshotInputs({ root, snapshotId });
    if (reboundInputs.sha256 !== sourceInputs.sha256) {
      throw new Error("Collections snapshot inputs changed while build-d1 was running.");
    }
    await writeJsonAtomic(resolve(root, "d1/report.json"), buildReport);
    return buildReport;
  } catch (error) {
    await rm(d1Root, { recursive: true, force: true });
    throw error;
  }
}

async function loadSourceRows(root) {
  const names = [
    ...new Set(
      TABLES.map((config) => config.source).filter(
        (name) => name !== "collection_media" && name !== "drop_stats_by_chain",
      ),
    ),
  ];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readNdjson(resolve(root, `normalized/${name}.ndjson`)),
      ]),
    ),
  );
}

async function loadMediaRows(root, collections) {
  const checkpointPath = resolve(root, "media/checkpoint.ndjson");
  if (await exists(checkpointPath)) {
    const records = await readNdjson(checkpointPath);
    const latest = new Map();
    for (const row of records) {
      if (row.kind === "reference" && typeof row.id === "string") latest.set(row.id, row);
    }
    return [...latest.values()].sort(
      (left, right) =>
        Number(left.collectionId) - Number(right.collectionId) ||
        String(left.role).localeCompare(String(right.role)),
    );
  }
  const rows = [];
  for (const collection of collections) {
    for (const [role, sourceUrl] of [
      ["logo", collection.logo_image_url],
      ["banner", collection.banner_image_url],
    ]) {
      if (!sourceUrl) continue;
      rows.push({
        collectionId: collection.id,
        role,
        sourceUrl,
        status: "pending",
        eligibleForPublish: false,
      });
    }
  }
  return rows;
}

export async function bindCollectionsSnapshotInputs({
  root: inputRoot,
  manifest,
  validation,
  snapshotId,
} = {}) {
  const root = resolve(inputRoot);
  validateSnapshotId(snapshotId);
  const rootRealPath = await realpath(root);
  manifest ??= await readJson(resolve(root, "manifest.json"));
  validation ??= await readJson(resolve(root, "validation/report.json"));

  if (manifest.consistency?.status !== "stable-two-pass") {
    throw new Error("Collections snapshot must have stable-two-pass consistency.");
  }
  if (
    manifest.media?.captured !== true ||
    manifest.media?.complete !== true ||
    manifest.media?.publishable !== true ||
    validation.media?.checked !== true ||
    validation.media?.complete !== true
  ) {
    throw new Error("Collections media must be complete, verified, and publishable.");
  }

  const expectedEntities = ENTITY_CONFIGS.map((config) => config.name).sort();
  const actualEntities =
    manifest.entities && typeof manifest.entities === "object" && !Array.isArray(manifest.entities)
      ? Object.keys(manifest.entities).sort()
      : [];
  if (
    actualEntities.length !== expectedEntities.length ||
    actualEntities.some((name, index) => name !== expectedEntities[index])
  ) {
    throw new Error("Collections manifest entity set is incomplete or unexpected.");
  }

  const manifestMetadata = await verifiedInputFile(root, rootRealPath, "manifest.json");
  const validationMetadata = await verifiedInputFile(root, rootRealPath, "validation/report.json");
  const validationSidecarMetadata = await verifiedInputFile(
    root,
    rootRealPath,
    "validation/report.sha256",
  );
  const validationSidecar = await readFile(resolve(root, "validation/report.sha256"), "utf8");
  if (validationSidecar !== `${validationMetadata.sha256}  validation/report.json\n`) {
    throw new Error("Collections validation report checksum sidecar is stale.");
  }
  const checksumsMetadata = await verifiedInputFile(root, rootRealPath, "checksums.sha256");
  if (
    validation.version !== 1 ||
    validation.verified !== true ||
    validation.manifest?.sha256 !== manifestMetadata.sha256 ||
    validation.manifest?.byteLength !== manifestMetadata.byteLength
  ) {
    throw new Error("Collections validation report is not bound to the current manifest.");
  }
  if (
    validation.checksums?.path !== "checksums.sha256" ||
    validation.checksums.sha256 !== checksumsMetadata.sha256 ||
    validation.checksums.byteLength !== checksumsMetadata.byteLength
  ) {
    throw new Error("Collections checksums file is not bound to validation/report.json.");
  }
  const checksumEntries = parseChecksumEntries(
    await readFile(resolve(root, "checksums.sha256"), "utf8"),
  );
  if (checksumEntries.size !== validation.checksums.entries) {
    throw new Error("Collections checksum entry count differs from validation/report.json.");
  }
  assertChecksumEntry(checksumEntries, manifestMetadata);

  const normalizedArtifacts = manifest.normalized?.artifacts;
  if (!Array.isArray(normalizedArtifacts) || normalizedArtifacts.length === 0) {
    throw new Error("Collections manifest has no normalized artifact plan.");
  }
  const normalized = [];
  const seenNormalized = new Set();
  for (const artifact of normalizedArtifacts) {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      !artifact.path.startsWith("normalized/") ||
      seenNormalized.has(artifact.path) ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0 ||
      !Number.isSafeInteger(artifact.rows) ||
      artifact.rows < 0
    ) {
      throw new Error(`Invalid normalized artifact binding: ${artifact?.path ?? "<missing>"}.`);
    }
    seenNormalized.add(artifact.path);
    const actual = await verifiedInputFile(root, rootRealPath, artifact.path);
    if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) {
      throw new Error(`Normalized artifact changed after verification: ${artifact.path}.`);
    }
    assertChecksumEntry(checksumEntries, actual);
    normalized.push({
      path: artifact.path,
      sha256: actual.sha256,
      byteLength: actual.byteLength,
      rows: artifact.rows,
    });
  }
  normalized.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const stabilityPath = manifest.consistency.report;
  if (stabilityPath !== "validation/stability.json") {
    throw new Error("Collections consistency report path is not canonical.");
  }
  const stabilityMetadata = await verifiedInputFile(root, rootRealPath, stabilityPath);
  assertChecksumEntry(checksumEntries, stabilityMetadata);
  const stability = await readJson(resolve(root, stabilityPath));
  if (
    stability.version !== 1 ||
    stability.stable !== true ||
    stability.consistency !== "stable-two-pass" ||
    !Array.isArray(stability.mismatches) ||
    stability.mismatches.length !== 0 ||
    stability.comparedAt !== manifest.consistency.comparedAt ||
    stability.primary?.startedAt !== manifest.startedAt ||
    stability.primary?.finishedAt !== manifest.finishedAt ||
    stability.primary?.schemaSha256 !== manifest.schema?.sha256 ||
    stability.artifactsCompared !== normalized.length
  ) {
    throw new Error("Collections stability report is incomplete or not bound to this snapshot.");
  }

  const mediaManifestPath = manifest.media.manifest;
  if (mediaManifestPath !== "media/manifest.json") {
    throw new Error("Collections media manifest path is not canonical.");
  }
  const mediaManifestMetadata = await verifiedInputFile(root, rootRealPath, mediaManifestPath);
  assertChecksumEntry(checksumEntries, mediaManifestMetadata);
  const mediaManifest = await readJson(resolve(root, mediaManifestPath));
  if (
    mediaManifest.version !== 1 ||
    mediaManifest.dataset !== "poap-compass-collection-media" ||
    mediaManifest.complete !== true ||
    mediaManifest.publishable !== true ||
    mediaManifest.attemptedAll !== true ||
    mediaManifest.quarantinedReferencesAreExcluded !== true ||
    mediaManifest.checkpoint !== "media/checkpoint.ndjson" ||
    mediaManifest.referencesSha256 !== manifest.media.referencesSha256 ||
    mediaManifest.references !== manifest.media.references ||
    mediaManifest.uniqueObjects !== manifest.media.uniqueObjects
  ) {
    throw new Error("Collections media manifest is incomplete or differs from manifest.json.");
  }

  const planMetadata = await verifiedInputFile(root, rootRealPath, "media/plan.ndjson");
  const checkpointMetadata = await verifiedInputFile(root, rootRealPath, "media/checkpoint.ndjson");
  assertChecksumEntry(checksumEntries, planMetadata);
  assertChecksumEntry(checksumEntries, checkpointMetadata);
  const planRows = await readNdjson(resolve(root, "media/plan.ndjson"));
  const checkpointRows = await readNdjson(resolve(root, "media/checkpoint.ndjson"));
  const checkpointHeader = checkpointRows.find((row) => row.kind === "header") ?? null;
  const latest = new Map();
  for (const row of checkpointRows) {
    if (row.kind === "reference" && typeof row.id === "string") latest.set(row.id, row);
  }
  if (
    checkpointHeader?.referencesSha256 !== mediaManifest.referencesSha256 ||
    planRows.length !== mediaManifest.references ||
    latest.size !== mediaManifest.references ||
    validation.media.references !== mediaManifest.references ||
    validation.media.checkpointRecords !== latest.size
  ) {
    throw new Error(
      "Collections media plan/checkpoint counts are not bound to the verified report.",
    );
  }

  const statuses = { stored: 0, missing: 0, quarantined: 0, failed: 0 };
  const objects = new Map();
  for (const record of latest.values()) {
    if (!(record.status in statuses)) throw new Error(`Invalid media status for ${record.id}.`);
    statuses[record.status] += 1;
    if (record.status !== "stored") {
      if (record.eligibleForPublish !== false) {
        throw new Error(`Excluded media reference ${record.id} is marked publishable.`);
      }
      continue;
    }
    if (
      record.eligibleForPublish !== true ||
      !/^[0-9a-f]{64}$/.test(record.sha256 ?? "") ||
      !Number.isSafeInteger(record.byteLength) ||
      record.byteLength <= 0 ||
      !(record.extension in MEDIA_CONTENT_TYPES) ||
      record.contentType !== MEDIA_CONTENT_TYPES[record.extension]
    ) {
      throw new Error(`Stored media reference ${record.id} has invalid publication metadata.`);
    }
    const objectPath = `media/objects/sha256/${record.sha256.slice(0, 2)}/${record.sha256}.${record.extension}`;
    if (record.objectPath !== objectPath) {
      throw new Error(`Stored media reference ${record.id} has a non-canonical object path.`);
    }
    const actual = await verifiedInputFile(root, rootRealPath, objectPath);
    if (actual.sha256 !== record.sha256 || actual.byteLength !== record.byteLength) {
      throw new Error(`Media object changed after verification: ${objectPath}.`);
    }
    assertChecksumEntry(checksumEntries, actual);
    const descriptor = {
      sourcePath: objectPath,
      byteLength: record.byteLength,
      sha256: record.sha256,
      extension: record.extension,
      contentType: record.contentType,
    };
    const prior = objects.get(objectPath);
    if (prior && JSON.stringify(prior) !== JSON.stringify(descriptor)) {
      throw new Error(`Media references disagree about object ${objectPath}.`);
    }
    objects.set(objectPath, descriptor);
  }
  for (const [status, count] of Object.entries(statuses)) {
    if (
      mediaManifest.counts?.[status] !== count ||
      manifest.media.counts?.[status] !== count ||
      validation.media.statuses?.[status] !== count
    ) {
      throw new Error(`Collections media ${status} count differs across verified inputs.`);
    }
  }
  if (
    statuses.failed !== 0 ||
    statuses.missing !== 0 ||
    objects.size !== mediaManifest.uniqueObjects ||
    validation.media.objectsChecked !== objects.size ||
    validation.media.uniqueObjects !== objects.size
  ) {
    throw new Error("Collections media object set is incomplete.");
  }

  const objectList = [...objects.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath, "en"),
  );
  const publicationObjects = objectList.map((object) => ({
    key: `snapshots/${snapshotId}/collections/media/sha256/${object.sha256.slice(0, 2)}/${object.sha256}.${object.extension}`,
    sourcePath: object.sourcePath,
    byteLength: object.byteLength,
    sha256: object.sha256,
    contentType: object.contentType,
  }));
  const eligibleObjectsSha256 = sha256(
    `${publicationObjects.map((object) => JSON.stringify(object)).join("\n")}\n`,
  );
  const normalizedBinding = {
    artifacts: normalized.length,
    rows: normalized.reduce((sum, artifact) => sum + artifact.rows, 0),
    tables: Object.fromEntries(
      normalized.map((artifact) => [
        artifact.path.replace(/^normalized\//, "").replace(/\.(?:ndjson|txt)$/, ""),
        artifact.rows,
      ]),
    ),
    sha256: sha256(`${normalized.map((artifact) => JSON.stringify(artifact)).join("\n")}\n`),
  };
  const mediaBinding = {
    manifest: mediaManifestMetadata,
    plan: planMetadata,
    checkpoint: checkpointMetadata,
    references: latest.size,
    uniqueObjects: objects.size,
    objects: publicationObjects,
    eligibleObjectsSha256,
    sha256: sha256(
      `${[
        mediaManifestMetadata,
        planMetadata,
        checkpointMetadata,
        ...objectList.map(({ sourcePath: path, sha256, byteLength }) => ({
          path,
          sha256,
          byteLength,
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    ),
  };
  const binding = {
    version: 1,
    manifest: manifestMetadata,
    validation: validationMetadata,
    validationSidecar: validationSidecarMetadata,
    checksums: checksumsMetadata,
    stability: stabilityMetadata,
    normalized: normalizedBinding,
    media: mediaBinding,
    dropSupplement: await bindDropSupplementInputs({
      root,
      rootRealPath,
      snapshotId,
      manifest,
      manifestMetadata,
      normalizedArtifacts,
    }),
  };
  return { ...binding, sha256: sha256(`${JSON.stringify(binding)}\n`) };
}

async function bindDropSupplementInputs({
  root,
  rootRealPath,
  snapshotId,
  manifest,
  manifestMetadata,
  normalizedArtifacts,
}) {
  const schemaMetadata = await verifiedInputFile(root, rootRealPath, "schema/introspection.json");
  const normalizedByPath = new Map(
    normalizedArtifacts.map((artifact) => [artifact.path, artifact]),
  );
  const referencedDropIds = normalizedByPath.get("normalized/referenced_drop_ids.txt");
  const referencedDrops = normalizedByPath.get("normalized/referenced_drops.ndjson");
  if (!referencedDropIds || !referencedDrops) {
    throw new Error("Collections snapshot is missing its referenced-drop identity artifacts.");
  }
  const inspected = await inspectDropSupplement({
    root,
    rootRealPath,
    snapshotId,
    expectedSource: {
      endpoint: manifest.endpoint,
      manifest: manifestMetadata,
      schema: schemaMetadata,
      referencedDropIds,
      referencedDrops,
      referencedDropCount: referencedDropIds.rows,
    },
  });
  return inspected.binding;
}

async function loadDropSupplement({ root, snapshotId, expectedBinding }) {
  const rootRealPath = await realpath(root);
  const inspected = await inspectDropSupplement({ root, rootRealPath, snapshotId });
  if (JSON.stringify(inspected.binding) !== JSON.stringify(expectedBinding)) {
    throw new Error("Drop supplement inputs changed after source binding.");
  }
  return inspected.runtime;
}

async function inspectDropSupplement({ root, rootRealPath, snapshotId, expectedSource = null }) {
  const prefix = (path) => `${DROP_SUPPLEMENT_ROOT}/${path}`;
  const manifestPath = prefix("manifest.json");
  const supplementMetadata = await verifiedInputFile(root, rootRealPath, manifestPath);
  const supplement = await readJson(resolve(root, manifestPath));
  if (
    supplement.version !== 1 ||
    supplement.dataset !== "poap-compass-referenced-drop-supplement" ||
    supplement.complete !== true ||
    supplement.publishable !== true ||
    supplement.graphql?.complete !== true ||
    supplement.artwork?.complete !== true ||
    supplement.artwork?.publishable !== true ||
    supplement.artwork?.attemptedAll !== true
  ) {
    throw new Error("Drop supplement is not complete and publishable.");
  }
  if (!supplement.source || typeof supplement.source !== "object") {
    throw new Error("Drop supplement has no source snapshot binding.");
  }
  await verifyDropSupplementSourceFiles({ root, rootRealPath, source: supplement.source });
  if (expectedSource) assertDropSupplementSource(supplement.source, expectedSource);
  const sourceSha256 = sha256(JSON.stringify(supplement.source));
  const referencedDropCount = integer(
    supplement.source.referencedDropCount,
    "drop supplement referencedDropCount",
  );
  if (
    supplement.graphql.referencedDrops !== referencedDropCount ||
    supplement.artwork.references !== referencedDropCount
  ) {
    throw new Error("Drop supplement does not account for every referenced drop.");
  }

  const queryPath = supplement.graphql.query;
  if (queryPath !== "queries/referenced-drop-supplement.graphql") {
    throw new Error("Drop supplement query path is not canonical.");
  }
  const queryMetadata = await verifiedInputFile(root, rootRealPath, prefix(queryPath));
  const reviewedQueryFile = `${DROP_SUPPLEMENT_QUERY.trim()}\n`;
  const reviewedRequestSha256 = sha256(DROP_SUPPLEMENT_QUERY);
  const reviewedQueryFileSha256 = sha256(reviewedQueryFile);
  if (supplement.graphql.querySha256 !== reviewedRequestSha256) {
    throw new Error("Drop supplement request query checksum differs from the reviewed exporter.");
  }
  if (
    supplement.graphql.queryFileSha256 !== reviewedQueryFileSha256 ||
    queryMetadata.sha256 !== supplement.graphql.queryFileSha256 ||
    queryMetadata.byteLength !== Buffer.byteLength(reviewedQueryFile)
  ) {
    throw new Error("Drop supplement stored query checksum/size differs from its manifest.");
  }
  if ((await readFile(resolve(root, prefix(queryPath)), "utf8")) !== reviewedQueryFile) {
    throw new Error("Drop supplement stored query bytes differ from the reviewed exporter.");
  }

  const rawArtifacts = supplement.graphql.rawArtifacts;
  if (
    !Array.isArray(rawArtifacts) ||
    rawArtifacts.length !== supplement.graphql.pages ||
    !Number.isSafeInteger(supplement.graphql.pageSize) ||
    supplement.graphql.pageSize < 1 ||
    supplement.graphql.pageSize > 100
  ) {
    throw new Error("Drop supplement raw GraphQL artifact plan is invalid.");
  }
  const verifiedRaw = [];
  let requested = 0;
  for (const [index, artifact] of rawArtifacts.entries()) {
    const expectedPath = `raw/${String(index + 1).padStart(6, "0")}.json.gz`;
    if (
      artifact?.path !== expectedPath ||
      !Number.isSafeInteger(artifact.requested) ||
      artifact.requested < 1 ||
      artifact.requested > supplement.graphql.pageSize
    ) {
      throw new Error(`Drop supplement raw page plan is invalid: ${artifact?.path}.`);
    }
    const actual = await verifiedInputFile(root, rootRealPath, prefix(artifact.path));
    assertSupplementArtifact(artifact, actual, "raw GraphQL page");
    requested += artifact.requested;
    verifiedRaw.push(actual);
  }
  if (requested !== referencedDropCount) {
    throw new Error("Drop supplement raw pages do not cover the referenced-drop set.");
  }

  const normalizedArtifacts = supplement.graphql.artifacts;
  if (!Array.isArray(normalizedArtifacts) || normalizedArtifacts.length !== 4) {
    throw new Error("Drop supplement normalized GraphQL artifact plan is invalid.");
  }
  const normalizedByPath = new Map();
  for (const artifact of normalizedArtifacts) {
    if (!artifact || normalizedByPath.has(artifact.path)) {
      throw new Error("Drop supplement repeats a normalized GraphQL artifact.");
    }
    const actual = await verifiedInputFile(root, rootRealPath, prefix(artifact.path));
    assertSupplementArtifact(artifact, actual, "normalized GraphQL artifact");
    if (!Number.isSafeInteger(artifact.rows) || artifact.rows < 0) {
      throw new Error(`Drop supplement artifact has an invalid row count: ${artifact.path}.`);
    }
    normalizedByPath.set(artifact.path, { ...actual, rows: artifact.rows });
  }
  const expectedRelationPaths = Object.values(DROP_RELATION_ARTIFACTS).sort();
  const actualRelationPaths = [...normalizedByPath.keys()].sort();
  if (
    actualRelationPaths.length !== expectedRelationPaths.length ||
    actualRelationPaths.some((path, index) => path !== expectedRelationPaths[index])
  ) {
    throw new Error("Drop supplement normalized GraphQL artifact set is unexpected.");
  }

  const ids = await readDropIds(resolve(root, supplement.source.referencedDropIds.path));
  if (ids.length !== referencedDropCount) {
    throw new Error("Drop supplement referenced-drop IDs changed or are incomplete.");
  }
  const idSet = new Set(ids);
  const relationRows = {};
  for (const [name, path] of Object.entries(DROP_RELATION_ARTIFACTS)) {
    const rows = await readNdjson(resolve(root, prefix(path)));
    if (rows.length !== normalizedByPath.get(path).rows) {
      throw new Error(`Drop supplement ${name} row count differs from its artifact plan.`);
    }
    relationRows[name] = rows;
  }
  await assertNormalizedRelationsMatchRaw({
    root,
    prefix,
    rawArtifacts,
    ids,
    querySha256: supplement.graphql.querySha256,
    relationRows,
  });
  const dropProjection = projectDropSupplementRelations({ ids, idSet, relationRows });
  for (const [name, rows] of Object.entries(relationRows)) {
    if (supplement.graphql.counts?.[name] !== rows.length) {
      throw new Error(`Drop supplement ${name} count differs from its GraphQL checkpoint.`);
    }
  }

  const artworkPlanPath = supplement.artwork.plan?.path;
  if (artworkPlanPath !== "artwork/plan.ndjson" || !SHA256.test(supplement.artwork.plan?.sha256)) {
    throw new Error("Drop supplement artwork plan binding is invalid.");
  }
  const artworkPlanMetadata = await verifiedInputFile(root, rootRealPath, prefix(artworkPlanPath));
  if (artworkPlanMetadata.sha256 !== supplement.artwork.plan.sha256) {
    throw new Error("Drop supplement artwork plan checksum differs from its manifest.");
  }
  const artworkPlan = await readNdjson(resolve(root, prefix(artworkPlanPath)));

  const checkpointPath = supplement.artwork.checkpoint;
  if (checkpointPath !== "artwork/checkpoint.ndjson") {
    throw new Error("Drop supplement artwork checkpoint path is not canonical.");
  }
  const checkpointMetadata = await verifiedInputFile(root, rootRealPath, prefix(checkpointPath));
  const checkpointRows = await readNdjson(resolve(root, prefix(checkpointPath)));
  const checkpointHeader = checkpointRows[0];
  if (
    checkpointHeader?.kind !== "header" ||
    checkpointHeader.version !== 1 ||
    checkpointHeader.dataset !== "poap-compass-referenced-drop-artwork" ||
    checkpointHeader.bindingSha256 !== sourceSha256 ||
    checkpointHeader.planSha256 !== artworkPlanMetadata.sha256
  ) {
    throw new Error("Drop supplement artwork checkpoint is not bound to its source and plan.");
  }
  const checkpointLatest = new Map();
  for (const row of checkpointRows.slice(1)) {
    if (row.kind !== "reference" || typeof row.id !== "string") {
      throw new Error("Drop supplement artwork checkpoint contains an invalid record.");
    }
    checkpointLatest.set(row.id, row);
  }

  const artworkArtifacts = supplement.artwork.artifacts;
  if (!Array.isArray(artworkArtifacts) || artworkArtifacts.length !== 2) {
    throw new Error("Drop supplement artwork artifact plan is invalid.");
  }
  const artworkArtifactsByPath = new Map();
  for (const artifact of artworkArtifacts) {
    if (!artifact || artworkArtifactsByPath.has(artifact.path)) {
      throw new Error("Drop supplement repeats an artwork artifact.");
    }
    const actual = await verifiedInputFile(root, rootRealPath, prefix(artifact.path));
    assertSupplementArtifact(artifact, actual, "artwork artifact");
    if (!Number.isSafeInteger(artifact.rows) || artifact.rows < 0) {
      throw new Error(
        `Drop supplement artwork artifact has an invalid row count: ${artifact.path}.`,
      );
    }
    artworkArtifactsByPath.set(artifact.path, { ...actual, rows: artifact.rows });
  }
  const referencesPath = "artwork/references.ndjson";
  const catalogPath = "normalized/archive_catalog.ndjson";
  if (!artworkArtifactsByPath.has(referencesPath) || !artworkArtifactsByPath.has(catalogPath)) {
    throw new Error("Drop supplement artwork artifact set is unexpected.");
  }
  const references = await readNdjson(resolve(root, prefix(referencesPath)));
  const catalogRows = await readNdjson(resolve(root, prefix(catalogPath)));
  if (
    references.length !== referencedDropCount ||
    references.length !== artworkArtifactsByPath.get(referencesPath).rows ||
    catalogRows.length !== artworkArtifactsByPath.get(catalogPath).rows
  ) {
    throw new Error("Drop supplement artwork references/catalog counts are invalid.");
  }
  validateArchiveCatalogRows({
    ids,
    catalogRows,
    plan: artworkPlan,
    references,
    archiveCatalog: supplement.archiveCatalog,
  });

  const archiveProof = await loadArchiveMediaProof({
    root,
    rootRealPath,
    archiveMedia: supplement.archiveMedia,
  });

  const artwork = await projectDropArtwork({
    root,
    rootRealPath,
    snapshotId,
    ids,
    plan: artworkPlan,
    references,
    checkpointLatest,
    supplement,
    archiveProof,
  });
  if (artworkPlan.length !== referencedDropCount) {
    throw new Error("Drop supplement artwork plan does not cover every referenced drop.");
  }
  const counts = supplement.artwork.counts ?? {};
  if (
    counts.reused !== artwork.counts.reused ||
    counts.downloaded !== artwork.counts.downloaded ||
    counts.quarantined !== artwork.counts.quarantined ||
    counts.failed !== 0 ||
    counts.missing !== artwork.counts.missing ||
    counts.pending !== 0 ||
    artwork.counts.reused +
      artwork.counts.downloaded +
      artwork.counts.quarantined +
      artwork.counts.missing !==
      referencedDropCount ||
    supplement.artwork.uniqueDownloadedObjects !== artwork.storedObjects.length ||
    supplement.artwork.uniqueQuarantinedObjects !== artwork.quarantinedObjects.length ||
    supplement.artwork.quarantinedReferencesAreExcluded !== true ||
    supplement.quarantinedReferencesAreExcluded !== true
  ) {
    throw new Error("Drop supplement artwork counts do not describe a complete terminal set.");
  }
  assertArtworkProvenance(supplement, artwork, checkpointHeader);

  for (const [dropId, projection] of dropProjection.dropCards) {
    projection.imageObjectKey = artwork.byDrop.get(dropId)?.imageObjectKey ?? null;
  }

  const rawBinding = summarizeMetadata(verifiedRaw);
  const normalizedBinding = summarizeMetadata([...normalizedByPath.values()]);
  normalizedBinding.counts = Object.fromEntries(
    Object.entries(DROP_RELATION_ARTIFACTS).map(([name, path]) => [
      name,
      normalizedByPath.get(path).rows,
    ]),
  );
  const storedObjectsBinding = summarizeMetadata(artwork.storedObjects);
  const quarantinedObjectsBinding = summarizeMetadata(artwork.quarantinedObjects);
  const reusedKeysSha256 = sha256(
    `${artwork.reusedObjects.map((object) => JSON.stringify(object)).join("\n")}\n`,
  );
  const bindingWithoutHash = {
    version: 1,
    manifest: supplementMetadata,
    sourceSha256,
    referencedDrops: referencedDropCount,
    query: { ...queryMetadata, requestSha256: supplement.graphql.querySha256 },
    raw: { ...rawBinding, pages: verifiedRaw.length },
    normalized: normalizedBinding,
    artwork: {
      plan: artworkPlanMetadata,
      checkpoint: checkpointMetadata,
      references: artworkArtifactsByPath.get(referencesPath),
      archiveCatalog: artworkArtifactsByPath.get(catalogPath),
      reusedReferences: artwork.counts.reused,
      downloadedReferences: artwork.counts.downloaded,
      missingReferences: artwork.counts.missing,
      quarantinedReferences: artwork.counts.quarantined,
      reusedObjects: artwork.reusedObjects.length,
      downloadedObjects: artwork.storedObjects.length,
      reusedKeysSha256,
      downloadedObjectsSha256: storedObjectsBinding.sha256,
      quarantinedObjects: artwork.quarantinedObjects.length,
      quarantinedObjectsSha256: quarantinedObjectsBinding.sha256,
    },
    provenance: {
      archiveCatalog: supplement.archiveCatalog,
      archiveMedia: supplement.archiveMedia,
    },
  };
  const binding = {
    ...bindingWithoutHash,
    sha256: sha256(`${JSON.stringify(bindingWithoutHash)}\n`),
  };
  return {
    binding,
    runtime: {
      ...dropProjection,
      artworkByDrop: artwork.byDrop,
      reusedObjects: artwork.reusedObjects,
      storedObjects: artwork.storedObjects,
      quarantinedObjects: artwork.quarantinedObjects,
      binding,
    },
  };
}

function assertDropSupplementSource(actual, expected) {
  if (
    actual.endpoint !== expected.endpoint ||
    actual.referencedDropCount !== expected.referencedDropCount
  ) {
    throw new Error("Drop supplement is bound to another Collections snapshot.");
  }
  for (const name of ["manifest", "schema", "referencedDropIds", "referencedDrops"]) {
    const left = actual[name];
    const right = expected[name];
    if (
      left?.path !== right?.path ||
      left?.sha256 !== right?.sha256 ||
      left?.byteLength !== right?.byteLength
    ) {
      throw new Error(`Drop supplement source ${name} binding differs from this snapshot.`);
    }
  }
}

async function verifyDropSupplementSourceFiles({ root, rootRealPath, source }) {
  const expectedPaths = {
    manifest: "manifest.json",
    schema: "schema/introspection.json",
    referencedDropIds: "normalized/referenced_drop_ids.txt",
    referencedDrops: "normalized/referenced_drops.ndjson",
  };
  if (
    typeof source.endpoint !== "string" ||
    !source.endpoint.startsWith("https://") ||
    !Number.isSafeInteger(source.referencedDropCount) ||
    source.referencedDropCount < 0
  ) {
    throw new Error("Drop supplement source endpoint/count binding is invalid.");
  }
  for (const [name, path] of Object.entries(expectedPaths)) {
    const expected = source[name];
    if (expected?.path !== path) {
      throw new Error(`Drop supplement source ${name} path is not canonical.`);
    }
    const actual = await verifiedInputFile(root, rootRealPath, path);
    assertSupplementArtifact(expected, actual, `source ${name}`);
  }
}

function assertSupplementArtifact(expected, actual, label) {
  if (
    !SHA256.test(expected?.sha256 ?? "") ||
    !Number.isSafeInteger(expected?.byteLength) ||
    expected.byteLength < 0 ||
    expected.sha256 !== actual.sha256 ||
    expected.byteLength !== actual.byteLength
  ) {
    throw new Error(`Drop supplement ${label} checksum/size differs: ${expected?.path}.`);
  }
}

async function assertNormalizedRelationsMatchRaw({
  root,
  prefix,
  rawArtifacts,
  ids,
  querySha256,
  relationRows,
}) {
  const rebuilt = {
    statsByChain: [],
    emailClaimsStats: [],
    featuredDrops: [],
    momentsStats: [],
  };
  let cursor = 0;
  for (const artifact of rawArtifacts) {
    const page = await readGzipJson(resolve(root, prefix(artifact.path)));
    const expectedIds = ids.slice(cursor, cursor + artifact.requested);
    const drops = page.response?.data?.drops;
    if (
      page.version !== 1 ||
      page.dataset !== "poap-compass-referenced-drop-relations" ||
      page.querySha256 !== querySha256 ||
      page.query !== "queries/referenced-drop-supplement.graphql" ||
      page.operationName !== "ReferencedDropSupplement" ||
      page.status !== 200 ||
      page.response?.errors !== undefined ||
      !Array.isArray(page.variables?.dropIds) ||
      page.variables.dropLimit !== artifact.requested ||
      JSON.stringify(page.variables.dropIds) !== JSON.stringify(expectedIds) ||
      !Array.isArray(drops) ||
      drops.length !== expectedIds.length ||
      drops.some((drop, index) => Number(drop?.id) !== expectedIds[index]) ||
      artifact.firstDropId !== expectedIds[0] ||
      artifact.lastDropId !== expectedIds.at(-1)
    ) {
      throw new Error(`Drop supplement raw page is not canonical/bound: ${artifact.path}.`);
    }
    for (const drop of drops) {
      if (!Array.isArray(drop.stats_by_chain)) {
        throw new Error(`Drop supplement raw stats relation is invalid for ${drop.id}.`);
      }
      rebuilt.statsByChain.push(...drop.stats_by_chain);
      if (drop.email_claims_stats) rebuilt.emailClaimsStats.push(drop.email_claims_stats);
      if (drop.featured_drop) rebuilt.featuredDrops.push(drop.featured_drop);
      if (drop.moments_stats) rebuilt.momentsStats.push(drop.moments_stats);
    }
    const pageCounts = {
      statsByChain: drops.reduce((sum, drop) => sum + drop.stats_by_chain.length, 0),
      emailClaimsStats: drops.filter((drop) => drop.email_claims_stats !== null).length,
      featuredDrops: drops.filter((drop) => drop.featured_drop !== null).length,
      momentsStats: drops.filter((drop) => drop.moments_stats !== null).length,
    };
    if (JSON.stringify(pageCounts) !== JSON.stringify(artifact.counts)) {
      throw new Error(`Drop supplement raw page counts differ: ${artifact.path}.`);
    }
    cursor += artifact.requested;
  }
  rebuilt.statsByChain.sort(
    (left, right) =>
      Number(left.drop_id) - Number(right.drop_id) ||
      String(left.chain).localeCompare(String(right.chain), "en"),
  );
  for (const name of ["emailClaimsStats", "featuredDrops", "momentsStats"]) {
    rebuilt[name].sort((left, right) => Number(left.drop_id) - Number(right.drop_id));
  }
  for (const name of Object.keys(rebuilt)) {
    if (JSON.stringify(rebuilt[name]) !== JSON.stringify(relationRows[name])) {
      throw new Error(`Drop supplement normalized ${name} differs from its raw GraphQL pages.`);
    }
  }
}

function projectDropSupplementRelations({ ids, idSet, relationRows }) {
  const dropCards = new Map(
    ids.map((dropId) => [
      dropId,
      {
        tokenCount: 0,
        transferCount: 0,
        emailClaimsMinted: null,
        emailClaimsReserved: null,
        emailClaimsTotal: null,
        featuredOn: null,
        momentsUploaded: null,
        imageObjectKey: null,
      },
    ]),
  );
  const statsRows = [];
  const statsKeys = new Set();
  let priorStats = null;
  for (const row of relationRows.statsByChain) {
    const dropId = positiveInteger(row.drop_id, "drop_stats_by_chain.drop_id");
    if (!idSet.has(dropId)) throw new Error(`Drop stats references unknown drop ${dropId}.`);
    const chain = row.chain === null ? null : requiredText(row.chain, "drop_stats_by_chain.chain");
    const chainKey = chain === null ? "n:" : `s:${chain}`;
    const identity = `${dropId}\u0000${chainKey}`;
    if (
      statsKeys.has(identity) ||
      (priorStats !== null &&
        (dropId < priorStats.dropId ||
          (dropId === priorStats.dropId &&
            String(chain).localeCompare(String(priorStats.chain), "en") <= 0)))
    ) {
      throw new Error("Drop stats are duplicated or not in canonical identity order.");
    }
    statsKeys.add(identity);
    priorStats = { dropId, chain };
    const poapCount = nonNegativeInteger(row.poap_count, "drop_stats_by_chain.poap_count");
    const transferCount = nonNegativeInteger(
      row.transfer_count,
      "drop_stats_by_chain.transfer_count",
    );
    const projection = dropCards.get(dropId);
    projection.tokenCount = safeSum(projection.tokenCount, poapCount, `drop ${dropId} token count`);
    projection.transferCount = safeSum(
      projection.transferCount,
      transferCount,
      `drop ${dropId} transfer count`,
    );
    statsRows.push({
      dropId,
      chainKey,
      chain,
      createdOn: nullableNonNegativeInteger(row.created_on, "drop_stats_by_chain.created_on"),
      poapCount,
      transferCount,
    });
  }
  applySingleDropRelation({
    rows: relationRows.emailClaimsStats,
    idSet,
    label: "email_claims_stats",
    apply: (dropId, row) => {
      const projection = dropCards.get(dropId);
      projection.emailClaimsMinted = nullableNonNegativeInteger(
        row.minted,
        "email_claims_stats.minted",
      );
      projection.emailClaimsReserved = nullableNonNegativeInteger(
        row.reserved,
        "email_claims_stats.reserved",
      );
      projection.emailClaimsTotal = nullableNonNegativeInteger(
        row.total,
        "email_claims_stats.total",
      );
    },
  });
  applySingleDropRelation({
    rows: relationRows.featuredDrops,
    idSet,
    label: "featured_drops",
    apply: (dropId, row) => {
      dropCards.get(dropId).featuredOn = requiredText(
        row.featured_on,
        "featured_drops.featured_on",
      );
    },
  });
  applySingleDropRelation({
    rows: relationRows.momentsStats,
    idSet,
    label: "moments_stats",
    apply: (dropId, row) => {
      dropCards.get(dropId).momentsUploaded = nullableNonNegativeInteger(
        row.moments_uploaded,
        "moments_stats.moments_uploaded",
      );
    },
  });
  return { dropCards, statsRows };
}

function applySingleDropRelation({ rows, idSet, label, apply }) {
  let prior = 0;
  for (const row of rows) {
    const dropId = positiveInteger(row.drop_id, `${label}.drop_id`);
    if (!idSet.has(dropId) || dropId <= prior) {
      throw new Error(`${label} references an unknown/duplicate drop or is not ordered.`);
    }
    prior = dropId;
    apply(dropId, row);
  }
}

function validateArchiveCatalogRows({ ids, catalogRows, plan, references, archiveCatalog }) {
  const rows = new Map();
  const idSet = new Set(ids);
  let prior = 0;
  for (const row of catalogRows) {
    const dropId = positiveInteger(row.dropId, "archive_catalog.dropId");
    if (
      dropId <= prior ||
      !idSet.has(dropId) ||
      rows.has(dropId) ||
      !Number.isSafeInteger(row.tokenCount) ||
      row.tokenCount < 0 ||
      typeof row.hasArtwork !== "boolean"
    ) {
      throw new Error("Drop supplement normalized archive catalog is invalid or unordered.");
    }
    prior = dropId;
    rows.set(dropId, row);
  }
  if (
    archiveCatalog?.used === true &&
    (archiveCatalog.matchedDrops !== rows.size ||
      archiveCatalog.catalogArtworkFlags !==
        [...rows.values()].filter((row) => row.hasArtwork).length)
  ) {
    throw new Error("Drop supplement archive catalog counts differ from normalized rows.");
  }
  for (let index = 0; index < ids.length; index += 1) {
    const expected = rows.get(ids[index])?.tokenCount ?? null;
    if (plan[index]?.archiveTokenCount !== expected) {
      throw new Error(`Drop supplement artwork plan catalog count differs for ${ids[index]}.`);
    }
    if (references[index]?.status === "reused" && references[index].tokenCount !== expected) {
      throw new Error(`Drop supplement reused artwork catalog count differs for ${ids[index]}.`);
    }
  }
}

async function loadArchiveMediaProof({ root, rootRealPath, archiveMedia }) {
  if (archiveMedia?.used !== true) return null;
  const expectedPaths = [
    "provenance/archive/artwork-manifest.ndjson",
    "provenance/archive/upload-report.json",
    "provenance/archive/upload-checkpoint.jsonl",
  ];
  if (!Array.isArray(archiveMedia.artifacts) || archiveMedia.artifacts.length !== 3) {
    throw new Error("Drop supplement archive media provenance artifact plan is invalid.");
  }
  const artifacts = new Map();
  for (const artifact of archiveMedia.artifacts) {
    if (!artifact || artifacts.has(artifact.path) || !expectedPaths.includes(artifact.path)) {
      throw new Error("Drop supplement archive media provenance artifacts are unexpected.");
    }
    const actual = await verifiedInputFile(
      root,
      rootRealPath,
      `${DROP_SUPPLEMENT_ROOT}/${artifact.path}`,
    );
    assertSupplementArtifact(artifact, actual, "archive media provenance artifact");
    if (!Number.isSafeInteger(artifact.rows) || artifact.rows < 1) {
      throw new Error(`Archive media provenance row count is invalid: ${artifact.path}.`);
    }
    artifacts.set(artifact.path, { ...actual, rows: artifact.rows });
  }
  if (artifacts.size !== expectedPaths.length) {
    throw new Error("Drop supplement archive media provenance artifact set is incomplete.");
  }
  for (const [name, path] of [
    ["manifest", expectedPaths[0]],
    ["uploadReport", expectedPaths[1]],
    ["uploadCheckpoint", expectedPaths[2]],
  ]) {
    const expected = archiveMedia[name];
    const actual = artifacts.get(path);
    if (
      expected?.path !== path ||
      expected.sha256 !== actual.sha256 ||
      expected.byteLength !== actual.byteLength ||
      expected.rows !== actual.rows
    ) {
      throw new Error(`Drop supplement archive media ${name} provenance binding differs.`);
    }
  }

  const rows = await readNdjson(
    resolve(root, DROP_SUPPLEMENT_ROOT, "provenance/archive/upload-checkpoint.jsonl"),
  );
  const header = rows[0];
  if (
    header?.kind !== "header" ||
    header.version !== 1 ||
    header.snapshotId !== archiveMedia.snapshotId ||
    header.archiveSha256 !== archiveMedia.sourceArchive?.sha256 ||
    header.manifestSha256 !== archiveMedia.manifest.sha256 ||
    header.bucket !== archiveMedia.targetBucket ||
    typeof header.cacheControl !== "string" ||
    header.cacheControl.length === 0 ||
    header.objectPrefix !== `snapshots/${archiveMedia.snapshotId}/artwork/` ||
    rows.length !== archiveMedia.uploadCheckpoint.rows
  ) {
    throw new Error("Drop supplement archive upload checkpoint header/binding is invalid.");
  }
  const objects = new Map();
  for (const row of rows.slice(1)) {
    if (
      row.kind !== "object" ||
      row.version !== 1 ||
      typeof row.key !== "string" ||
      !row.key.startsWith(header.objectPrefix) ||
      !Number.isSafeInteger(row.byteLength) ||
      row.byteLength <= 0 ||
      !SHA256.test(row.sha256 ?? "") ||
      !["uploaded", "reused"].includes(row.disposition) ||
      objects.has(row.key)
    ) {
      throw new Error(`Drop supplement archive upload proof is invalid: ${row?.key}.`);
    }
    objects.set(row.key, row);
  }
  if (
    objects.size !== archiveMedia.uploadCheckpoint.objects ||
    objects.size !== archiveMedia.verifiedPublishedObjects
  ) {
    throw new Error("Drop supplement archive upload proof object count is incomplete.");
  }
  return { header, objects };
}

async function projectDropArtwork({
  root,
  rootRealPath,
  snapshotId,
  ids,
  plan,
  references,
  checkpointLatest,
  supplement,
  archiveProof,
}) {
  const byDrop = new Map();
  const reusedObjects = [];
  const storedObjectMap = new Map();
  const quarantinedObjectMap = new Map();
  let reused = 0;
  let downloaded = 0;
  let missing = 0;
  let quarantined = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const dropId = ids[index];
    const planned = plan[index];
    const reference = references[index];
    if (
      Number(planned?.dropId) !== dropId ||
      planned?.id !== String(dropId) ||
      Number(reference?.dropId) !== dropId ||
      reference?.id !== String(dropId)
    ) {
      throw new Error("Drop artwork plan/references do not match the exact drop ID order.");
    }
    if (reference.status === "reused") {
      if (reference.eligibleForPublish !== true) {
        throw new Error(`Reused drop artwork ${dropId} is not eligible for publication.`);
      }
      reused += 1;
      const archiveSnapshotId = supplement.archiveMedia?.snapshotId;
      const expectedKey = `snapshots/${archiveSnapshotId}/artwork/${dropId}.webp`;
      const proof = archiveProof?.objects.get(expectedKey);
      if (
        !archiveSnapshotId ||
        !proof ||
        reference.archiveSnapshotId !== archiveSnapshotId ||
        reference.objectKey !== expectedKey ||
        planned.reuseObjectKey !== expectedKey ||
        reference.sha256 !== proof.sha256 ||
        reference.byteLength !== proof.byteLength ||
        reference.contentType !== "image/webp" ||
        reference.cacheControl !== archiveProof.header.cacheControl ||
        reference.disposition !== proof.disposition ||
        (reference.etag ?? null) !== (proof.etag ?? null)
      ) {
        throw new Error(`Drop artwork ${dropId} has an invalid archive reuse proof.`);
      }
      const descriptor = {
        key: expectedKey,
        byteLength: reference.byteLength,
        sha256: reference.sha256,
        contentType: "image/webp",
        cacheControl: reference.cacheControl,
        etag: reference.etag ?? null,
        archiveDisposition: reference.disposition,
        archiveSnapshotId,
        dropId,
      };
      reusedObjects.push(descriptor);
      byDrop.set(dropId, { imageObjectKey: expectedKey, publication: descriptor });
      continue;
    }
    if (["missing", "quarantined"].includes(reference.status)) {
      if (
        reference.eligibleForPublish !== false ||
        planned.reuseObjectKey !== null ||
        typeof reference.failureCode !== "string" ||
        reference.failureCode.length === 0 ||
        typeof reference.failureReason !== "string" ||
        reference.failureReason.length === 0
      ) {
        throw new Error(`Excluded drop artwork ${dropId} lacks a terminal exclusion reason.`);
      }
      const checkpoint = checkpointLatest.get(String(dropId));
      for (const field of [
        "dropId",
        "status",
        "eligibleForPublish",
        "failureCode",
        "failureReason",
      ]) {
        if (checkpoint?.[field] !== reference[field]) {
          throw new Error(
            `Excluded drop artwork ${dropId} differs from its checkpoint (${field}).`,
          );
        }
      }
      if (reference.status === "missing") missing += 1;
      else {
        quarantined += 1;
        if (reference.quarantinePath === null) {
          if (
            reference.failureCode !== "EMPTY_MEDIA" ||
            reference.byteLength !== 0 ||
            reference.sha256 !== sha256("")
          ) {
            throw new Error(`Empty quarantined artwork ${dropId} has invalid zero-byte evidence.`);
          }
        } else if (typeof reference.quarantinePath === "string") {
          if (
            !SHA256.test(reference.sha256 ?? "") ||
            !Number.isSafeInteger(reference.byteLength) ||
            reference.byteLength <= 0
          ) {
            throw new Error(`Quarantined artwork ${dropId} has invalid byte evidence.`);
          }
          const expectedPath = `artwork/quarantine/sha256/${reference.sha256.slice(0, 2)}/${reference.sha256}.bin`;
          if (reference.quarantinePath !== expectedPath) {
            throw new Error(`Quarantined artwork ${dropId} has a non-canonical evidence path.`);
          }
          const actual = await verifiedInputFile(
            root,
            rootRealPath,
            `${DROP_SUPPLEMENT_ROOT}/${expectedPath}`,
          );
          if (actual.sha256 !== reference.sha256 || actual.byteLength !== reference.byteLength) {
            throw new Error(`Quarantined artwork ${dropId} evidence changed after capture.`);
          }
          quarantinedObjectMap.set(expectedPath, actual);
        } else if (
          !["INVALID_SOURCE_URL", "PRIVATE_NETWORK_TARGET", "SOURCE_HOST_NOT_ALLOWED"].includes(
            reference.failureCode,
          )
        ) {
          throw new Error(`Quarantined artwork ${dropId} has no byte/network exclusion evidence.`);
        }
      }
      byDrop.set(dropId, {
        imageObjectKey: null,
        exclusion: {
          status: reference.status,
          failureCode: reference.failureCode,
          failureReason: reference.failureReason,
        },
      });
      continue;
    }
    if (reference.status !== "stored" || planned.reuseObjectKey !== null) {
      throw new Error(`Drop artwork ${dropId} is neither verified-reused nor stored.`);
    }
    if (reference.eligibleForPublish !== true) {
      throw new Error(`Stored drop artwork ${dropId} is not eligible for publication.`);
    }
    downloaded += 1;
    const checkpoint = checkpointLatest.get(String(dropId));
    for (const field of [
      "dropId",
      "status",
      "eligibleForPublish",
      "objectPath",
      "sha256",
      "byteLength",
      "extension",
      "contentType",
    ]) {
      if (checkpoint?.[field] !== reference[field]) {
        throw new Error(`Drop artwork ${dropId} differs from its checkpoint (${field}).`);
      }
    }
    if (
      !SHA256.test(reference.sha256 ?? "") ||
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength <= 0 ||
      !(reference.extension in MEDIA_CONTENT_TYPES) ||
      reference.contentType !== MEDIA_CONTENT_TYPES[reference.extension]
    ) {
      throw new Error(`Stored drop artwork ${dropId} has invalid object metadata.`);
    }
    const objectPath = `artwork/objects/sha256/${reference.sha256.slice(0, 2)}/${reference.sha256}.${reference.extension}`;
    if (reference.objectPath !== objectPath) {
      throw new Error(`Stored drop artwork ${dropId} has a non-canonical object path.`);
    }
    const actual = await verifiedInputFile(
      root,
      rootRealPath,
      `${DROP_SUPPLEMENT_ROOT}/${objectPath}`,
    );
    if (actual.sha256 !== reference.sha256 || actual.byteLength !== reference.byteLength) {
      throw new Error(`Stored drop artwork ${dropId} changed after capture.`);
    }
    const targetKey = `snapshots/${snapshotId}/collections/drop-artwork/sha256/${reference.sha256.slice(0, 2)}/${reference.sha256}.${reference.extension}`;
    const descriptor = {
      key: targetKey,
      sourcePath: `${DROP_SUPPLEMENT_ROOT}/${objectPath}`,
      byteLength: reference.byteLength,
      sha256: reference.sha256,
      contentType: reference.contentType,
    };
    const prior = storedObjectMap.get(targetKey);
    if (prior && JSON.stringify(prior) !== JSON.stringify(descriptor)) {
      throw new Error(`Stored drop artwork objects disagree for ${targetKey}.`);
    }
    storedObjectMap.set(targetKey, descriptor);
    byDrop.set(dropId, { imageObjectKey: targetKey, publication: descriptor });
  }
  return {
    byDrop,
    reusedObjects,
    storedObjects: [...storedObjectMap.values()].sort((left, right) =>
      left.key.localeCompare(right.key, "en"),
    ),
    quarantinedObjects: [...quarantinedObjectMap.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    ),
    counts: { reused, downloaded, missing, quarantined },
  };
}

function assertArtworkProvenance(supplement, artwork, checkpointHeader) {
  const archive = supplement.archiveMedia;
  if (artwork.counts.reused > 0) {
    if (
      archive?.used !== true ||
      archive.publishable !== true ||
      !archive.snapshotId ||
      archive.verifiedPublishedObjects < artwork.counts.reused ||
      !SHA256.test(archive.manifest?.sha256 ?? "") ||
      !Number.isSafeInteger(archive.manifest?.byteLength) ||
      archive.manifest.byteLength <= 0 ||
      !SHA256.test(archive.uploadReport?.sha256 ?? "") ||
      !Number.isSafeInteger(archive.uploadReport?.byteLength) ||
      archive.uploadReport.byteLength <= 0 ||
      !SHA256.test(archive.uploadCheckpoint?.sha256 ?? "") ||
      !Number.isSafeInteger(archive.uploadCheckpoint?.byteLength) ||
      archive.uploadCheckpoint.byteLength <= 0 ||
      archive.uploadCheckpoint.objects !== archive.verifiedPublishedObjects ||
      checkpointHeader.archiveMediaManifestSha256 !== archive.manifest.sha256 ||
      checkpointHeader.archiveUploadReportSha256 !== archive.uploadReport.sha256 ||
      checkpointHeader.archiveSnapshotId !== archive.snapshotId
    ) {
      throw new Error("Drop supplement archive artwork reuse lacks verified upload provenance.");
    }
  } else if (archive?.used === true && archive.publishable !== true) {
    throw new Error("Drop supplement records a non-publishable archive media source.");
  }
  const catalog = supplement.archiveCatalog;
  if (catalog?.used === true) {
    if (
      !SHA256.test(catalog.sha256 ?? "") ||
      !Number.isSafeInteger(catalog.byteLength) ||
      catalog.byteLength <= 0 ||
      checkpointHeader.archiveCatalogSha256 !== catalog.sha256
    ) {
      throw new Error("Drop supplement archive catalog provenance is invalid.");
    }
  }
}

async function readDropIds(path) {
  const values = [];
  for (const [index, line] of (await readFile(path, "utf8")).split("\n").entries()) {
    if (!line) continue;
    if (!/^[1-9]\d*$/.test(line)) {
      throw new Error(`Invalid referenced drop ID on line ${index + 1}.`);
    }
    const value = Number(line);
    if (!Number.isSafeInteger(value) || value <= (values.at(-1) ?? 0)) {
      throw new Error("Referenced drop IDs are not strictly increasing safe integers.");
    }
    values.push(value);
  }
  return values;
}

function summarizeMetadata(entries) {
  const normalized = entries
    .map(({ path, sourcePath, sha256: digest, byteLength }) => ({
      path: path ?? sourcePath,
      sha256: digest,
      byteLength,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    artifacts: normalized.length,
    bytes: normalized.reduce((sum, entry) => safeSum(sum, entry.byteLength, "artifact bytes"), 0),
    sha256: sha256(`${normalized.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
  };
}

async function writeMediaProof({ root, snapshotId, sourceInputs, dropSupplement }) {
  const objects = new Map();
  const add = (object) => {
    const prior = objects.get(object.key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(object)) {
      throw new Error(`Media proof contains conflicting object descriptors for ${object.key}.`);
    }
    objects.set(object.key, object);
  };
  for (const object of sourceInputs.media.objects) {
    add({ kind: "collection-media", disposition: "upload", ...object });
  }
  for (const object of dropSupplement.reusedObjects) {
    add({ kind: "archive-drop-artwork", disposition: "reuse", ...object });
  }
  for (const object of dropSupplement.storedObjects) {
    add({ kind: "collection-drop-artwork", disposition: "upload", ...object });
  }
  const plan = [...objects.values()].sort((left, right) => left.key.localeCompare(right.key, "en"));
  const contents = `${plan.map((object) => JSON.stringify(object)).join("\n")}\n`;
  const manifest = await writeStaticArtifact(root, "d1/media/publication-plan.ndjson", contents, {
    rows: plan.length,
  });
  const counts = {
    collectionMedia: sourceInputs.media.objects.length,
    archiveDropArtwork: dropSupplement.reusedObjects.length,
    collectionDropArtwork: dropSupplement.storedObjects.length,
    upload: plan.filter((object) => object.disposition === "upload").length,
    reuse: plan.filter((object) => object.disposition === "reuse").length,
  };
  return {
    version: 2,
    sha256: manifest.sha256,
    objects: plan.length,
    manifest,
    counts,
    provenance: {
      snapshotId,
      collectionsMediaSha256: sourceInputs.media.eligibleObjectsSha256,
      dropSupplementSha256: sourceInputs.dropSupplement.sha256,
      archiveMedia: sourceInputs.dropSupplement.provenance.archiveMedia,
    },
  };
}

function parseChecksumEntries(source) {
  const entries = new Map();
  for (const [index, line] of source.split("\n").entries()) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  ([^\r\n]+)$/);
    if (!match || entries.has(match[2])) {
      throw new Error(`Invalid or duplicate checksum entry on line ${index + 1}.`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function assertChecksumEntry(entries, metadata) {
  if (entries.get(metadata.path) !== metadata.sha256) {
    throw new Error(`checksums.sha256 is stale for ${metadata.path}.`);
  }
}

async function verifiedInputFile(root, rootRealPath, path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe Collections input path: ${path}.`);
  }
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Collections input escapes the snapshot directory: ${path}.`);
  }
  const fileStat = await lstat(absolute);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Collections input is not a regular file: ${path}.`);
  }
  const actualRealPath = await realpath(absolute);
  const realRelative = relative(rootRealPath, actualRealPath);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`Collections input resolves outside the snapshot directory: ${path}.`);
  }
  return { path, ...(await sha256File(absolute)) };
}

async function buildPortableDatabase(root, artifacts) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = resolve(root, "d1/collections.sqlite3");
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    for (const artifact of artifacts) {
      database.exec(await readFile(resolve(root, artifact.path), "utf8"));
    }
    const integrity = database.prepare("PRAGMA integrity_check;").get().integrity_check;
    const foreignKeys = database.prepare("PRAGMA foreign_key_check;").all();
    if (integrity !== "ok" || foreignKeys.length > 0) {
      throw new Error("Portable Collections database failed SQLite integrity checks.");
    }
    database.exec(
      "INSERT INTO collections_fts(collections_fts, rank) VALUES('integrity-check', 1);",
    );
    const ready = database
      .prepare("SELECT value FROM collections_meta WHERE key = 'ready';")
      .get()?.value;
    if (ready !== "1") {
      throw new Error("Portable Collections database finalizer did not activate atomically.");
    }
    database.exec("PRAGMA optimize;");
  } finally {
    database.close();
  }
  return fileMetadata(root, path);
}

export function makeFinalizer({
  snapshotId,
  manifest,
  sourceDigest,
  rows,
  dataArtifacts,
  sourceInputs,
  mediaProof,
}) {
  if (
    mediaProof?.version !== 2 ||
    !/^[0-9a-f]{64}$/.test(mediaProof.sha256 ?? "") ||
    !Number.isSafeInteger(mediaProof.objects) ||
    mediaProof.objects < 0
  ) {
    throw new Error("Finalizer media proof is invalid.");
  }
  const metadata = {
    snapshot_id: snapshotId,
    snapshot_at: manifest.finishedAt,
    schema_version: "3",
    importer_version: "collections-backup-v2",
    source_schema_sha256: manifest.schema.sha256,
    source_database_sha256: sourceDigest,
    source_inputs_sha256: sourceInputs.sha256,
    media_proof_sha256: mediaProof.sha256,
    media_objects_count: String(mediaProof.objects),
    consistency: "stable-two-pass",
    collections_count: String(rows.collections.length),
    items_count: String(rows.items.length),
    sections_count: String(rows.sections.length),
    item_sections_count: String(rows.item_sections.length),
    drop_cards_count: String(rows.referenced_drops.length),
    drop_stats_by_chain_count: String(rows.drop_stats_by_chain.length),
    media_count: String(rows.collection_media.length),
    ready: "1",
  };
  const values = Object.entries(metadata)
    .map(([key, value]) => `  (${sqlLiteral(key)}, ${sqlLiteral(value)})`)
    .join(",\n");
  const expectedShards = dataArtifacts
    .map(
      (artifact) =>
        `    (${[
          snapshotId,
          sourceDigest,
          artifact.path,
          artifact.payloadSha256,
          artifact.table,
          artifact.rowCount,
          artifact.statementCount,
        ]
          .map(sqlLiteral)
          .join(", ")})`,
    )
    .join(",\n");
  const tableChecks = TABLES.map(
    (config) => `(SELECT COUNT(*) FROM "${config.table}") = ${rows[config.source].length}`,
  ).join("\n      AND ");
  return `-- Generated by tools/collections-backup. Do not edit.
-- This single INSERT is the activation transaction: a failed guard inserts
-- zero metadata rows, so collections_meta.ready can never appear partially.

WITH expected_shards(
  snapshot_id,
  source_database_sha256,
  shard_path,
  payload_sha256,
  table_name,
  row_count,
  statement_count
) AS (
  VALUES
${expectedShards}
),
expected_snapshot(consistency) AS (
  VALUES ('stable-two-pass')
),
metadata(key, value) AS (
  VALUES
${values}
),
activation_guard(ok) AS (
  SELECT
    (SELECT consistency FROM expected_snapshot) = 'stable-two-pass'
    AND (SELECT COUNT(*) FROM collections_meta) = 0
    AND (SELECT COUNT(*) FROM import_shards) = ${dataArtifacts.length}
    AND NOT EXISTS (
      SELECT 1
      FROM expected_shards AS expected
      LEFT JOIN import_shards AS actual
        ON actual.snapshot_id = expected.snapshot_id
       AND actual.shard_path = expected.shard_path
      WHERE actual.shard_path IS NULL
         OR actual.source_database_sha256 <> expected.source_database_sha256
         OR actual.payload_sha256 <> expected.payload_sha256
         OR actual.table_name <> expected.table_name
         OR actual.row_count <> expected.row_count
         OR actual.statement_count <> expected.statement_count
    )
    AND NOT EXISTS (
      SELECT 1
      FROM import_shards AS actual
      LEFT JOIN expected_shards AS expected
        ON expected.snapshot_id = actual.snapshot_id
       AND expected.shard_path = actual.shard_path
      WHERE expected.shard_path IS NULL
         OR actual.source_database_sha256 <> expected.source_database_sha256
         OR actual.payload_sha256 <> expected.payload_sha256
         OR actual.table_name <> expected.table_name
         OR actual.row_count <> expected.row_count
         OR actual.statement_count <> expected.statement_count
    )
    AND ${tableChecks}
)
INSERT INTO collections_meta (key, value)
SELECT metadata.key, metadata.value
FROM metadata, activation_guard
WHERE activation_guard.ok = 1;
`;
}

function sourceDigestFor(manifest, sourceInputs) {
  const rows = manifest.normalized.artifacts.map(
    (artifact) => `${artifact.path}\u0000${artifact.sha256}\u0000${artifact.rows ?? ""}`,
  );
  rows.push(`drop-supplement\u0000${sourceInputs.dropSupplement.sha256}\u0000`);
  rows.sort();
  return sha256(`${rows.join("\n")}\n`);
}

function countsBy(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row[field]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function normalizeAddress(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function mediaStatus(value) {
  return ["pending", "stored", "missing", "quarantined", "failed"].includes(value)
    ? value
    : "failed";
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is not a safe integer.`);
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = integer(value, label);
  if (parsed <= 0) throw new Error(`${label} is not positive.`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = integer(value, label);
  if (parsed < 0) throw new Error(`${label} is negative.`);
  return parsed;
}

function nullableNonNegativeInteger(value, label) {
  return value === null || value === undefined ? null : nonNegativeInteger(value, label);
}

function safeSum(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} exceeds the safe integer range.`);
  }
  return value;
}

function normalizePrivateValue(value, dropId) {
  if (value === false || value === "false") return { privateValue: "false", isPrivate: 0 };
  if (value === true || value === "true") return { privateValue: "true", isPrivate: 1 };
  if (value === null || value === undefined) return { privateValue: null, isPrivate: 1 };
  throw new Error(`drops.private for ${dropId} is not a reviewed boolean value.`);
}

function nullableInteger(value, label) {
  return value === null || value === undefined ? null : integer(value, label);
}

function boolean(value, label) {
  if (value === true) return 1;
  if (value === false) return 0;
  throw new Error(`${label} is not a boolean.`);
}

function nullableBoolean(value, label) {
  return value === null || value === undefined ? null : boolean(value, label);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is empty.`);
  return value;
}

function nonNullText(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is not text.`);
  return value;
}

function nullableText(value) {
  return value === null || value === undefined ? null : String(value);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateSnapshotId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("--snapshot-id must match ^[a-z0-9][a-z0-9._-]{0,63}$.");
  }
}

async function readNdjson(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line) rows.push(JSON.parse(line));
  return rows;
}

export const d1Internals = {
  normalizePrivateValue,
  projectDropArtwork,
  projectDropSupplementRelations,
  summarizeMetadata,
  writeMediaProof,
};
