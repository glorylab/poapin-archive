import { readdir, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { inventoryArtwork } from "./artwork.mjs";
import {
  CATALOG_PREPARE_SQL,
  DROP_COLUMNS,
  DROP_STATS_COLUMNS,
  HOLDINGS_PREPARE_SQL,
  OWNER_STATS_COLUMNS,
  SOURCE_COLUMNS,
  SOURCE_DROP_COLUMNS,
  TARGET_SCHEMA_VERSION,
  TOKEN_COLUMNS,
  catalogFinalizeSql,
  holdingsFinalizeSql,
} from "./schema.mjs";
import { NdjsonWriter, SqlShardWriter, writeStaticArtifact } from "./sql-shards.mjs";
import {
  assertSqliteAvailable,
  jsonObjectSelect,
  queryJsonRows,
  streamJsonRows,
} from "./sqlite.mjs";
import {
  describeFile,
  invariant,
  isSafeInteger,
  normalizeAddress,
  sortNumbers,
  sortedEntries,
} from "./util.mjs";

const FORMAT_VERSION = 2;
const DEFAULT_MEDIA_BASE_URL = "https://media.poap.in";

export async function importArchive(options) {
  const settings = normalizeOptions(options);
  await prepareOutputDirectory(settings.outputDirectory);
  const sqliteVersion = await assertSqliteAvailable();
  settings.onProgress("Validating source schema and checksums");

  const sourceSchema = await inspectSourceSchema(settings.databasePath);
  const sourceMetadata = await readSnapshotMetadata(settings.databasePath);
  const sourceSchemaVersion = Number(sourceMetadata.schema_version);
  invariant(
    sourceSchemaVersion === TARGET_SCHEMA_VERSION,
    `Source schema version ${sourceMetadata.schema_version ?? "<missing>"} is unsupported; expected ${TARGET_SCHEMA_VERSION}.`,
  );
  const quickCheck = await queryJsonRows(
    settings.databasePath,
    "SELECT json_object('result', quick_check) FROM pragma_quick_check",
    { maximumRows: 100 },
  );
  invariant(
    quickCheck.length === 1 && quickCheck[0].result === "ok",
    `Source SQLite quick_check failed: ${quickCheck.map((row) => row.result).join(", ")}`,
  );

  const databaseDescription = await describeFile(settings.databasePath);
  if (settings.expectedDatabaseSha256) {
    invariant(
      databaseDescription.sha256 === settings.expectedDatabaseSha256,
      `Database SHA-256 mismatch: expected ${settings.expectedDatabaseSha256}, got ${databaseDescription.sha256}.`,
    );
  }

  const snapshotId = settings.snapshotId ?? deriveSnapshotId(sourceMetadata);
  settings.onProgress("Inventorying artwork");
  const artwork = await inventoryArtwork({
    archivePath: settings.archivePath,
    artworkDirectory: settings.artworkDirectory,
    artworkInventoryPath: settings.artworkInventoryPath,
    artworkInventoryPolicy: settings.artworkInventoryPolicy,
    hashArtworkFiles: settings.hashArtworkFiles,
  });
  if (artwork.source.snapshotId) {
    invariant(
      artwork.source.snapshotId === snapshotId,
      `Artwork inventory belongs to ${artwork.source.snapshotId}, not ${snapshotId}.`,
    );
  }
  const archiveIntegrity = resolveArchiveIntegrity(artwork.source, settings.expectedArchiveSha256);

  const artifacts = [];
  artifacts.push(
    await writeStaticArtifact(
      settings.outputDirectory,
      "catalog/000000_prepare.sql",
      CATALOG_PREPARE_SQL,
      { kind: "d1-sql", phase: "prepare", database: "catalog" },
    ),
  );
  artifacts.push(
    await writeStaticArtifact(
      settings.outputDirectory,
      "holdings/000000_prepare.sql",
      HOLDINGS_PREPARE_SQL,
      { kind: "d1-sql", phase: "prepare", database: "holdings" },
    ),
  );

  const rejectedDrops = new NdjsonWriter(
    settings.outputDirectory,
    "quality/rejected-drops.ndjson",
    {
      kind: "quality-report",
      entity: "drops",
    },
  );
  const rejectedTokens = new NdjsonWriter(
    settings.outputDirectory,
    "quality/rejected-tokens.ndjson",
    {
      kind: "quality-report",
      entity: "tokens",
    },
  );
  const rejectedEmailStats = new NdjsonWriter(
    settings.outputDirectory,
    "quality/rejected-email-reservation-stats.ndjson",
    { kind: "quality-report", entity: "email_reservation_stats" },
  );
  const rejectedOwnerStats = new NdjsonWriter(
    settings.outputDirectory,
    "quality/rejected-owner-stats.ndjson",
    { kind: "quality-report", entity: "owner_stats" },
  );
  const artworkManifest = new NdjsonWriter(settings.outputDirectory, "r2/artwork-manifest.ndjson", {
    kind: "r2-manifest",
    entity: "artwork",
  });
  await Promise.all([
    rejectedDrops.open(),
    rejectedTokens.open(),
    rejectedEmailStats.open(),
    rejectedOwnerStats.open(),
    artworkManifest.open(),
  ]);

  const dropWriter = makeSqlWriter(settings, {
    relativeDirectory: "catalog",
    sequenceStart: 100_001,
    label: "drops",
    table: "drops",
    columns: DROP_COLUMNS,
    database: "catalog",
    journal: { snapshotId, sourceDatabaseSha256: databaseDescription.sha256 },
  });
  const tokenWriter = makeSqlWriter(settings, {
    relativeDirectory: "holdings",
    sequenceStart: 100_001,
    label: "tokens",
    table: "tokens",
    columns: TOKEN_COLUMNS,
    database: "holdings",
    journal: { snapshotId, sourceDatabaseSha256: databaseDescription.sha256 },
  });
  const dropStatsWriter = makeSqlWriter(settings, {
    relativeDirectory: "catalog",
    sequenceStart: 200_001,
    label: "drop_stats",
    table: "drop_stats",
    columns: DROP_STATS_COLUMNS,
    database: "catalog",
    journal: { snapshotId, sourceDatabaseSha256: databaseDescription.sha256 },
  });
  const ownerStatsWriter = makeSqlWriter(settings, {
    relativeDirectory: "holdings",
    sequenceStart: 800_001,
    label: "owner_stats",
    table: "owner_stats",
    columns: OWNER_STATS_COLUMNS,
    database: "holdings",
    journal: { snapshotId, sourceDatabaseSha256: databaseDescription.sha256 },
  });

  const counts = {
    source: { drops: 0, tokens: 0, emailReservationStats: 0 },
    accepted: { drops: 0, tokens: 0, owners: 0, emailReservationStats: 0, artworks: 0 },
    rejected: { drops: 0, tokens: 0, ownerStats: 0, emailReservationStats: 0 },
  };
  const quality = {
    artwork: artwork.quality,
    drops: {
      emptyFancyIds: 0,
      emptyTitles: 0,
      invalidDates: 0,
      reversedDateRanges: 0,
      startYearMismatches: 0,
      unsafeEventUrls: 0,
      privateDrops: 0,
      unknownVirtuality: 0,
    },
    tokens: {
      normalizedAddressesChanged: 0,
      nullMintedOn: 0,
      orphanDropReferences: 0,
      duplicateSourceUids: 0,
      duplicateSourceUidExtraRows: 0,
      duplicatePoapIds: 0,
      duplicatePoapExtraRows: 0,
      networks: {},
    },
    emailReservationStats: { orphanDropReferences: 0 },
    media: { missingForDrops: 0, orphanArtwork: 0 },
    metadataMismatches: [],
    blockingIssues: [],
    warnings: [],
  };

  settings.onProgress("Reading email reservation aggregates");
  const emailStatsByDrop = new Map();
  for await (const row of streamJsonRows(
    settings.databasePath,
    jsonObjectSelect("email_reservation_stats", SOURCE_COLUMNS.email_reservation_stats, {
      orderBy: "drop_id",
    }),
  )) {
    counts.source.emailReservationStats += 1;
    const reasons = validateEmailStats(row);
    if (reasons.length > 0) {
      counts.rejected.emailReservationStats += 1;
      await rejectedEmailStats.add({ primaryKey: row.drop_id ?? null, reasons, record: row });
      continue;
    }
    emailStatsByDrop.set(row.drop_id, row);
  }

  settings.onProgress("Validating catalog drops");
  const acceptedDropIds = new Set();
  const seenFancyIds = new Set();
  const years = new Set();
  for await (const row of streamJsonRows(
    settings.databasePath,
    jsonObjectSelect("drops", SOURCE_DROP_COLUMNS, { orderBy: "drop_id" }),
  )) {
    counts.source.drops += 1;
    const reasons = validateDrop(row);
    if (typeof row.fancy_id === "string" && seenFancyIds.has(row.fancy_id))
      reasons.push("duplicate_fancy_id");
    if (reasons.length > 0) {
      counts.rejected.drops += 1;
      await rejectedDrops.add({ primaryKey: row.drop_id ?? null, reasons, record: row });
      continue;
    }
    seenFancyIds.add(row.fancy_id);
    acceptedDropIds.add(row.drop_id);
    years.add(row.year);
    counts.accepted.drops += 1;
    observeDropQuality(row, quality.drops);
  }

  for (const [dropId, row] of emailStatsByDrop) {
    if (acceptedDropIds.has(dropId)) {
      counts.accepted.emailReservationStats += 1;
      continue;
    }
    quality.emailReservationStats.orphanDropReferences += 1;
    counts.rejected.emailReservationStats += 1;
    await rejectedEmailStats.add({
      primaryKey: dropId,
      reasons: ["orphan_drop_reference"],
      record: row,
    });
    emailStatsByDrop.delete(dropId);
  }

  const [sourceUidUniqueness = { duplicateSourceUids: 0, duplicateSourceUidExtraRows: 0 }] =
    await queryJsonRows(
      settings.databasePath,
      `SELECT json_object(
        'duplicateSourceUids', COUNT(*),
        'duplicateSourceUidExtraRows', COALESCE(SUM(row_count - 1), 0)
      )
      FROM (
        SELECT source_uid, COUNT(*) AS row_count
        FROM tokens
        GROUP BY source_uid
        HAVING COUNT(*) > 1
      )`,
      { maximumRows: 1 },
    );
  quality.tokens.duplicateSourceUids = sourceUidUniqueness.duplicateSourceUids;
  quality.tokens.duplicateSourceUidExtraRows = sourceUidUniqueness.duplicateSourceUidExtraRows;

  settings.onProgress("Writing holdings tokens and owner aggregates (clustered order)");
  const tokenCountsByDrop = new Map();
  const networkCounts = new Map();
  let ownerAccumulator = null;
  const flushOwnerAccumulator = async () => {
    if (!ownerAccumulator) return;
    const ownerRow = {
      owner_address_norm: ownerAccumulator.address,
      token_count: ownerAccumulator.tokenCount,
      unique_drop_count: ownerAccumulator.dropIds.size,
      first_minted_on: ownerAccumulator.firstMintedOn,
      last_minted_on: ownerAccumulator.lastMintedOn,
    };
    const reasons = validateOwnerStats(ownerRow);
    if (reasons.length > 0) {
      counts.rejected.ownerStats += 1;
      await rejectedOwnerStats.add({
        primaryKey: ownerRow.owner_address_norm,
        reasons,
        record: ownerRow,
      });
    } else {
      counts.accepted.owners += 1;
      await ownerStatsWriter.add(OWNER_STATS_COLUMNS.map((column) => ownerRow[column]));
    }
    ownerAccumulator = null;
  };
  for await (const row of streamJsonRows(
    settings.databasePath,
    jsonObjectSelect("tokens", SOURCE_COLUMNS.tokens, {
      orderBy: "lower(owner_address), poap_id DESC, source_uid DESC",
    }),
  )) {
    counts.source.tokens += 1;
    const normalizedAddress = normalizeAddress(row.owner_address);
    if (normalizedAddress && normalizedAddress !== row.owner_address) {
      quality.tokens.normalizedAddressesChanged += 1;
    }
    if (row.minted_on === null) quality.tokens.nullMintedOn += 1;
    const reasons = validateToken(row, normalizedAddress);
    if (reasons.length > 0) {
      counts.rejected.tokens += 1;
      await rejectedTokens.add({ primaryKey: row.source_uid ?? null, reasons, record: row });
      continue;
    }
    counts.accepted.tokens += 1;
    tokenCountsByDrop.set(row.drop_id, (tokenCountsByDrop.get(row.drop_id) ?? 0) + 1);
    if (!acceptedDropIds.has(row.drop_id)) quality.tokens.orphanDropReferences += 1;
    if (ownerAccumulator?.address !== normalizedAddress) {
      await flushOwnerAccumulator();
      ownerAccumulator = {
        address: normalizedAddress,
        tokenCount: 0,
        dropIds: new Set(),
        firstMintedOn: row.minted_on,
        lastMintedOn: row.minted_on,
      };
    }
    ownerAccumulator.tokenCount += 1;
    ownerAccumulator.dropIds.add(row.drop_id);
    ownerAccumulator.firstMintedOn = Math.min(ownerAccumulator.firstMintedOn, row.minted_on);
    ownerAccumulator.lastMintedOn = Math.max(ownerAccumulator.lastMintedOn, row.minted_on);
    networkCounts.set(row.network, (networkCounts.get(row.network) ?? 0) + 1);
    await tokenWriter.add([
      row.source_uid,
      row.poap_id,
      row.drop_id,
      row.minted_on,
      normalizedAddress,
      row.network,
      row.transfer_count,
    ]);
    if (counts.source.tokens % 500_000 === 0) {
      settings.onProgress(`Processed ${counts.source.tokens.toLocaleString("en-US")} tokens`);
    }
  }
  await flushOwnerAccumulator();
  artifacts.push(...(await tokenWriter.close()));
  artifacts.push(...(await ownerStatsWriter.close()));
  quality.tokens.networks = Object.fromEntries(sortedEntries(networkCounts));

  const [duplicatePoaps = { duplicatePoapIds: 0, duplicatePoapExtraRows: 0 }] = await queryJsonRows(
    settings.databasePath,
    `SELECT json_object(
      'duplicatePoapIds', COUNT(*),
      'duplicatePoapExtraRows', COALESCE(SUM(row_count - 1), 0)
    )
    FROM (
      SELECT poap_id, COUNT(*) AS row_count
      FROM tokens
      GROUP BY poap_id
      HAVING COUNT(*) > 1
    )`,
    { maximumRows: 1 },
  );
  quality.tokens.duplicatePoapIds = duplicatePoaps.duplicatePoapIds;
  quality.tokens.duplicatePoapExtraRows = duplicatePoaps.duplicatePoapExtraRows;

  settings.onProgress("Writing catalog rows, aggregates, and R2 manifest");
  const unusableArtworkIds = new Set([
    ...artwork.quality.duplicateDropIds,
    ...artwork.quality.invalidWebpSignatures,
  ]);
  for await (const row of streamJsonRows(
    settings.databasePath,
    jsonObjectSelect("drops", SOURCE_DROP_COLUMNS, { orderBy: "drop_id" }),
  )) {
    if (!acceptedDropIds.has(row.drop_id)) continue;
    const dropId = row.drop_id;
    const email = emailStatsByDrop.get(dropId);
    const hasArtwork = artwork.entries.has(dropId) && !unusableArtworkIds.has(dropId);
    if (hasArtwork) counts.accepted.artworks += 1;
    else quality.media.missingForDrops += 1;
    await dropWriter.add([
      ...SOURCE_DROP_COLUMNS.map((column) => row[column]),
      tokenCountsByDrop.get(dropId) ?? 0,
      hasArtwork ? 1 : 0,
    ]);
    await dropStatsWriter.add([
      dropId,
      email?.email_reservations_total ?? 0,
      email?.email_reservations_minted ?? 0,
      email?.email_reservations_unminted ?? 0,
    ]);
  }
  artifacts.push(...(await dropWriter.close()));
  artifacts.push(...(await dropStatsWriter.close()));

  for (const dropId of sortNumbers(artwork.entries.keys())) {
    const entry = artwork.entries.get(dropId);
    const catalogDropExists = acceptedDropIds.has(dropId);
    const eligibleForPublish = catalogDropExists && !unusableArtworkIds.has(dropId);
    if (!catalogDropExists) quality.media.orphanArtwork += 1;
    await artworkManifest.add({
      snapshotId,
      dropId,
      object: {
        key: `snapshots/${snapshotId}/artwork/${dropId}.webp`,
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
        publicUrl: `${settings.mediaBaseUrl}/snapshots/${snapshotId}/artwork/${dropId}.webp`,
      },
      source: entry.source,
      catalogDropExists,
      eligibleForPublish,
    });
  }

  artifacts.push(
    await rejectedDrops.close(),
    await rejectedTokens.close(),
    await rejectedEmailStats.close(),
    await rejectedOwnerStats.close(),
    await artworkManifest.close(),
  );

  compareMetadataCounts(sourceMetadata, counts.source, quality.metadataMismatches);
  buildQualityConclusions({ artwork, archiveIntegrity, counts, quality, settings });

  const archiveMetadata = archiveMetaValues(archiveIntegrity);
  const catalogMetadata = {
    artworks_count: counts.accepted.artworks,
    drops_count: counts.accepted.drops,
    generated_at: sourceMetadata.generated_at ?? sourceMetadata.snapshot_at,
    importer_version: FORMAT_VERSION,
    owners_count: counts.accepted.owners,
    schema_version: TARGET_SCHEMA_VERSION,
    snapshot_id: snapshotId,
    snapshot_at: sourceMetadata.snapshot_at,
    source_database_sha256: databaseDescription.sha256,
    tokens_count: counts.accepted.tokens,
    years: JSON.stringify(sortNumbers(years)),
    ...archiveMetadata,
  };
  artifacts.push(
    await writeStaticArtifact(
      settings.outputDirectory,
      "catalog/999999_finalize.sql",
      catalogFinalizeSql(catalogMetadata),
      { kind: "d1-sql", phase: "finalize", database: "catalog" },
    ),
  );
  const holdingsMetadata = {
    generated_at: sourceMetadata.generated_at ?? sourceMetadata.snapshot_at,
    importer_version: FORMAT_VERSION,
    owners_count: counts.accepted.owners,
    schema_version: TARGET_SCHEMA_VERSION,
    snapshot_at: sourceMetadata.snapshot_at,
    snapshot_id: snapshotId,
    source_database_sha256: databaseDescription.sha256,
    tokens_count: counts.accepted.tokens,
    ...archiveMetadata,
  };
  artifacts.push(
    await writeStaticArtifact(
      settings.outputDirectory,
      "holdings/999999_finalize.sql",
      holdingsFinalizeSql(holdingsMetadata),
      { kind: "d1-sql", phase: "finalize", database: "holdings" },
    ),
  );

  artifacts.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const report = {
    formatVersion: FORMAT_VERSION,
    snapshot: {
      id: snapshotId,
      snapshotAt: sourceMetadata.snapshot_at,
      generatedAt: sourceMetadata.generated_at ?? null,
      sourceSchemaVersion,
    },
    source: {
      database: {
        name: basename(settings.databasePath),
        ...databaseDescription,
      },
      artwork: artwork.source,
      archiveIntegrity,
      ...(settings.sourceUrl ? { url: settings.sourceUrl } : {}),
      ...(settings.retrievedAt ? { retrievedAt: settings.retrievedAt } : {}),
      metadata: sourceMetadata,
      schema: sourceSchema,
    },
    importer: {
      name: "poapin-archive-import",
      version: FORMAT_VERSION,
      node: process.versions.node,
      sqlite: sqliteVersion,
      settings: {
        maxShardBytes: settings.maxShardBytes,
        maxStatementBytes: settings.maxStatementBytes,
        rowsPerStatement: settings.rowsPerStatement,
      },
    },
    target: {
      schemaVersion: TARGET_SCHEMA_VERSION,
      catalogDatabase: "poapin-archive-catalog",
      holdingsDatabase: "poapin-archive-holdings",
      mediaBaseUrl: settings.mediaBaseUrl,
      r2KeyPattern: "snapshots/{snapshotId}/artwork/{dropId}.webp",
    },
    counts,
    quality,
    artifacts,
  };
  const reportPath = resolve(settings.outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  settings.onProgress(`Import plan written to ${settings.outputDirectory}`);
  return { report, reportPath };
}

function normalizeOptions(options) {
  invariant(options && typeof options === "object", "Import options are required.");
  invariant(typeof options.databasePath === "string", "databasePath is required.");
  invariant(typeof options.outputDirectory === "string", "outputDirectory is required.");
  const mediaBaseUrl = (options.mediaBaseUrl ?? DEFAULT_MEDIA_BASE_URL).replace(/\/+$/, "");
  const parsedMediaUrl = new URL(mediaBaseUrl);
  invariant(parsedMediaUrl.protocol === "https:", "mediaBaseUrl must use HTTPS.");
  if (options.snapshotId) {
    invariant(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.snapshotId), "snapshotId is invalid.");
  }
  if (options.retrievedAt) {
    invariant(
      !Number.isNaN(Date.parse(options.retrievedAt)),
      "retrievedAt must be an ISO-8601 timestamp.",
    );
  }
  if (options.expectedDatabaseSha256) {
    invariant(
      /^[0-9a-f]{64}$/.test(options.expectedDatabaseSha256),
      "expectedDatabaseSha256 is invalid.",
    );
  }
  if (options.expectedArchiveSha256) {
    invariant(
      /^[0-9a-f]{64}$/.test(options.expectedArchiveSha256),
      "expectedArchiveSha256 is invalid.",
    );
  }
  const maxShardBytes = options.maxShardBytes ?? 8 * 1024 * 1024;
  const maxStatementBytes = options.maxStatementBytes ?? 90 * 1024;
  const rowsPerStatement = options.rowsPerStatement ?? 100;
  invariant(Number.isSafeInteger(maxShardBytes) && maxShardBytes > 0, "maxShardBytes is invalid.");
  invariant(
    Number.isSafeInteger(maxStatementBytes) &&
      maxStatementBytes > 0 &&
      maxStatementBytes <= 96 * 1024,
    "maxStatementBytes must be between 1 and 98304 bytes.",
  );
  invariant(
    maxShardBytes >= maxStatementBytes,
    "maxShardBytes must not be smaller than maxStatementBytes.",
  );
  invariant(
    Number.isSafeInteger(rowsPerStatement) && rowsPerStatement > 0,
    "rowsPerStatement is invalid.",
  );
  return {
    databasePath: resolve(options.databasePath),
    outputDirectory: resolve(options.outputDirectory),
    archivePath: options.archivePath ? resolve(options.archivePath) : null,
    artworkDirectory: options.artworkDirectory ? resolve(options.artworkDirectory) : null,
    artworkInventoryPath: options.artworkInventoryPath
      ? resolve(options.artworkInventoryPath)
      : null,
    artworkInventoryPolicy: options.artworkInventoryPolicy ?? null,
    snapshotId: options.snapshotId ?? null,
    sourceUrl: options.sourceUrl ?? null,
    retrievedAt: options.retrievedAt ?? null,
    expectedDatabaseSha256: options.expectedDatabaseSha256 ?? null,
    expectedArchiveSha256: options.expectedArchiveSha256 ?? null,
    mediaBaseUrl,
    hashArtworkFiles: options.hashArtworkFiles !== false,
    allowMissingArtwork: options.allowMissingArtwork === true,
    maxShardBytes,
    maxStatementBytes,
    rowsPerStatement,
    onProgress: options.onProgress ?? (() => {}),
  };
}

async function prepareOutputDirectory(outputDirectory) {
  let outputStat = null;
  try {
    outputStat = await stat(outputDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (outputStat) {
    invariant(outputStat.isDirectory(), `Output path is not a directory: ${outputDirectory}`);
    const existing = await readdir(outputDirectory);
    invariant(existing.length === 0, `Output directory must be empty: ${outputDirectory}`);
  } else {
    await mkdir(outputDirectory, { recursive: true });
  }
}

async function inspectSourceSchema(databasePath) {
  const schema = {};
  for (const [table, expectedColumns] of Object.entries(SOURCE_COLUMNS)) {
    const rows = await queryJsonRows(
      databasePath,
      `SELECT json_object(
        'name', name,
        'type', type,
        'notNull', "notnull",
        'primaryKeyPosition', pk
      ) FROM pragma_table_info('${table}') ORDER BY cid`,
      { maximumRows: 100 },
    );
    invariant(rows.length > 0, `Source table is missing: ${table}`);
    const actualColumns = new Set(rows.map((row) => row.name));
    const missing = expectedColumns.filter((column) => !actualColumns.has(column));
    invariant(
      missing.length === 0,
      `Source table ${table} is missing columns: ${missing.join(", ")}`,
    );
    schema[table] = rows;
  }
  const sourceUid = schema.tokens.find((column) => column.name === "source_uid");
  invariant(
    sourceUid?.primaryKeyPosition === 1,
    "Source tokens.source_uid must be the declared primary key.",
  );
  return schema;
}

async function readSnapshotMetadata(databasePath) {
  const rows = await queryJsonRows(
    databasePath,
    jsonObjectSelect("snapshot_metadata", SOURCE_COLUMNS.snapshot_metadata, { orderBy: "key" }),
    { maximumRows: 1_000 },
  );
  const metadata = {};
  for (const row of rows) {
    invariant(!(row.key in metadata), `Duplicate snapshot metadata key: ${row.key}`);
    metadata[row.key] = row.value;
  }
  invariant(typeof metadata.snapshot_at === "string", "snapshot_metadata.snapshot_at is required.");
  invariant(
    !Number.isNaN(Date.parse(metadata.snapshot_at)),
    "snapshot_metadata.snapshot_at is invalid.",
  );
  return metadata;
}

function deriveSnapshotId(metadata) {
  const day = metadata.snapshot_at.slice(0, 10);
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(day), "Cannot derive snapshot id from snapshot_at.");
  return `${day}-v${metadata.schema_version}`;
}

function makeSqlWriter(settings, config) {
  return new SqlShardWriter({
    outputRoot: settings.outputDirectory,
    maxShardBytes: settings.maxShardBytes,
    maxStatementBytes: settings.maxStatementBytes,
    rowsPerStatement: settings.rowsPerStatement,
    ...config,
  });
}

function validateDrop(row) {
  const reasons = [];
  if (!isSafeInteger(row.drop_id, { minimum: 1 })) reasons.push("invalid_drop_id");
  if (typeof row.fancy_id !== "string") reasons.push("invalid_fancy_id");
  if (typeof row.title !== "string") reasons.push("invalid_title");
  for (const field of [
    "description",
    "city",
    "country",
    "event_url",
    "channel",
    "platform",
    "location_type",
    "timezone",
  ]) {
    if (row[field] !== null && typeof row[field] !== "string") reasons.push(`invalid_${field}`);
  }
  for (const field of ["start_date", "end_date", "created_at"]) {
    if (typeof row[field] !== "string" || row[field].length === 0) reasons.push(`invalid_${field}`);
  }
  if (!isSafeInteger(row.year)) reasons.push("invalid_year");
  if (row.is_virtual !== null && row.is_virtual !== 0 && row.is_virtual !== 1)
    reasons.push("invalid_is_virtual");
  if (row.is_private !== 0 && row.is_private !== 1) reasons.push("invalid_is_private");
  return reasons;
}

function observeDropQuality(row, quality) {
  if (row.fancy_id.length === 0) quality.emptyFancyIds += 1;
  if (row.title.length === 0) quality.emptyTitles += 1;
  const start = Date.parse(row.start_date);
  const end = Date.parse(row.end_date);
  const created = Date.parse(row.created_at);
  if ([start, end, created].some(Number.isNaN)) quality.invalidDates += 1;
  else {
    if (end < start) quality.reversedDateRanges += 1;
    if (new Date(start).getUTCFullYear() !== row.year) quality.startYearMismatches += 1;
  }
  if (row.event_url) {
    try {
      const url = new URL(row.event_url);
      if (url.protocol !== "http:" && url.protocol !== "https:") quality.unsafeEventUrls += 1;
    } catch {
      quality.unsafeEventUrls += 1;
    }
  }
  if (row.is_private === 1) quality.privateDrops += 1;
  if (row.is_virtual === null) quality.unknownVirtuality += 1;
}

function validateEmailStats(row) {
  const reasons = [];
  if (!isSafeInteger(row.drop_id, { minimum: 1 })) reasons.push("invalid_drop_id");
  for (const field of [
    "email_reservations_total",
    "email_reservations_minted",
    "email_reservations_unminted",
  ]) {
    if (!isSafeInteger(row[field], { minimum: 0 })) reasons.push(`invalid_${field}`);
  }
  if (
    reasons.length === 0 &&
    row.email_reservations_total !== row.email_reservations_minted + row.email_reservations_unminted
  )
    reasons.push("reservation_total_mismatch");
  return reasons;
}

function validateToken(row, normalizedAddress) {
  const reasons = [];
  if (typeof row.source_uid !== "string" || row.source_uid.length === 0)
    reasons.push("invalid_source_uid");
  if (!isSafeInteger(row.poap_id, { minimum: 1 })) reasons.push("invalid_poap_id");
  if (!isSafeInteger(row.drop_id, { minimum: 1 })) reasons.push("invalid_drop_id");
  if (!isSafeInteger(row.minted_on, { minimum: 0 })) reasons.push("invalid_minted_on");
  if (!normalizedAddress) reasons.push("invalid_owner_address");
  if (typeof row.network !== "string" || row.network.length === 0) reasons.push("invalid_network");
  if (!isSafeInteger(row.transfer_count, { minimum: 0 })) reasons.push("invalid_transfer_count");
  return reasons;
}

function validateOwnerStats(row) {
  const reasons = [];
  if (
    !normalizeAddress(row.owner_address_norm) ||
    row.owner_address_norm !== row.owner_address_norm?.toLowerCase()
  ) {
    reasons.push("invalid_owner_address_norm");
  }
  if (!isSafeInteger(row.token_count, { minimum: 1 })) reasons.push("invalid_token_count");
  if (!isSafeInteger(row.unique_drop_count, { minimum: 1 }))
    reasons.push("invalid_unique_drop_count");
  if (!isSafeInteger(row.first_minted_on, { minimum: 0 })) reasons.push("invalid_first_minted_on");
  if (!isSafeInteger(row.last_minted_on, { minimum: 0 })) reasons.push("invalid_last_minted_on");
  if (reasons.length === 0 && row.last_minted_on < row.first_minted_on)
    reasons.push("reversed_minted_range");
  return reasons;
}

function compareMetadataCounts(metadata, sourceCounts, mismatches) {
  for (const [metadataKey, countKey] of [
    ["drops_count", "drops"],
    ["tokens_count", "tokens"],
    ["email_reservation_stats_count", "emailReservationStats"],
  ]) {
    const expected = Number(metadata[metadataKey]);
    const actual = sourceCounts[countKey];
    if (!Number.isSafeInteger(expected) || expected !== actual) {
      mismatches.push({ key: metadataKey, expected: metadata[metadataKey] ?? null, actual });
    }
  }
}

function resolveArchiveIntegrity(source, explicitExpectedSha256) {
  const inventoryExpected = source.kind === "inventory" ? source.expectedSha256 : null;
  if (explicitExpectedSha256 && inventoryExpected) {
    invariant(
      explicitExpectedSha256 === inventoryExpected,
      `Expected archive SHA-256 differs from the inventory pin: ${inventoryExpected}.`,
    );
  }
  const expectedSha256 = explicitExpectedSha256 ?? inventoryExpected ?? null;
  const measuredSha256 = source.kind === "zip" ? source.sha256 : (source.measuredSha256 ?? null);
  if (explicitExpectedSha256 && source.kind !== "zip" && source.kind !== "inventory") {
    throw new Error("--expected-archive-sha256 requires --archive or --artwork-inventory.");
  }
  if (expectedSha256 && measuredSha256) {
    invariant(
      measuredSha256 === expectedSha256,
      `Archive SHA-256 mismatch: expected ${expectedSha256}, got ${measuredSha256}.`,
    );
  }
  if (source.kind === "inventory" && source.wholeArchiveSha256Status === "not-measured") {
    invariant(measuredSha256 === null, "Range inventory inconsistently claims a measured digest.");
  }
  const status = measuredSha256
    ? expectedSha256
      ? "verified"
      : "measured-unpinned"
    : expectedSha256
      ? "expected-only-not-measured"
      : "not-applicable";
  return {
    status,
    expectedSha256,
    measuredSha256,
    matchesExpected: expectedSha256 && measuredSha256 ? true : null,
  };
}

function archiveMetaValues(integrity) {
  if (integrity.status === "not-applicable") return {};
  return {
    source_archive_sha256_status: integrity.status,
    ...(integrity.expectedSha256
      ? { source_archive_expected_sha256: integrity.expectedSha256 }
      : {}),
    ...(integrity.measuredSha256 ? { source_archive_sha256: integrity.measuredSha256 } : {}),
  };
}

function buildQualityConclusions({ artwork, archiveIntegrity, counts, quality, settings }) {
  const blockers = quality.blockingIssues;
  if (counts.rejected.drops > 0)
    blockers.push(`${counts.rejected.drops} drop row(s) were quarantined.`);
  if (counts.rejected.tokens > 0)
    blockers.push(`${counts.rejected.tokens} token row(s) were quarantined.`);
  if (quality.tokens.duplicateSourceUids > 0) {
    blockers.push("tokens.source_uid is not globally unique.");
  }
  if (counts.rejected.ownerStats > 0)
    blockers.push(`${counts.rejected.ownerStats} owner aggregate row(s) were quarantined.`);
  if (counts.rejected.emailReservationStats > 0) {
    blockers.push(
      `${counts.rejected.emailReservationStats} email aggregate row(s) were quarantined.`,
    );
  }
  if (quality.metadataMismatches.length > 0)
    blockers.push("Snapshot metadata row counts do not match the source tables.");
  if (artwork.quality.duplicateDropIds.length > 0)
    blockers.push("Artwork contains duplicate drop identifiers.");
  if (artwork.quality.unsafePaths.length > 0)
    blockers.push("The source archive contains unsafe paths.");
  if (artwork.quality.encryptedEntries > 0)
    blockers.push("The source archive contains encrypted entries.");
  if (artwork.quality.symlinkEntries > 0) blockers.push("Artwork input contains symbolic links.");
  if (artwork.quality.invalidWebpSignatures.length > 0)
    blockers.push("Artwork files with invalid WebP signatures were found.");
  if (artwork.source.kind === "none" && !settings.allowMissingArtwork) {
    blockers.push(
      "No artwork source was supplied; pass --allow-missing-artwork only for deliberate metadata-only runs.",
    );
  }
  if (!settings.retrievedAt) quality.warnings.push("Source retrieval time was not supplied.");
  if (!settings.sourceUrl) quality.warnings.push("Source acquisition URL was not supplied.");
  if (archiveIntegrity.status === "expected-only-not-measured") {
    quality.warnings.push(
      "The expected whole-archive SHA-256 is pinned but was not measured by the HTTP Range inventory.",
    );
  }
  if (quality.drops.emptyFancyIds > 0) {
    quality.warnings.push(
      `${quality.drops.emptyFancyIds} accepted drop(s) preserve an empty source fancy_id; drop_id remains the stable identifier.`,
    );
  }
  if (quality.media.missingForDrops > 0) {
    quality.warnings.push(
      `${quality.media.missingForDrops} accepted drop(s) have no publishable artwork.`,
    );
  }
  if (quality.media.orphanArtwork > 0) {
    quality.warnings.push(
      `${quality.media.orphanArtwork} artwork object(s) do not match an accepted drop.`,
    );
  }
  if (quality.tokens.duplicatePoapIds > 0) {
    quality.warnings.push(
      `${quality.tokens.duplicatePoapIds} POAP id value(s) are duplicated; source_uid remains the stable tie-breaker.`,
    );
  }
}
