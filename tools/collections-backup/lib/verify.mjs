import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { ENTITY_CONFIGS } from "./config.mjs";
import { readJson, sha256, sha256File, writeJsonAtomic } from "./files.mjs";
import { GraphqlClient, INTROSPECTION_QUERY } from "./graphql.mjs";

const REPORT_VERSION = 1;
const MAX_REPORTED_ISSUES = 500;
const NORMALIZED_PREFIX = "normalized/";
const REPORT_PATH = "validation/report.json";
const REPORT_CHECKSUM_PATH = "validation/report.sha256";
const CHECKSUMS_PATH = "checksums.sha256";

const EXTRA_TABLES = new Map([
  [
    "collection_urls",
    {
      path: "normalized/collection_urls.ndjson",
      key: [{ name: "id", type: "bigint" }],
    },
  ],
  [
    "referenced_drops",
    {
      path: "normalized/referenced_drops.ndjson",
      key: [{ name: "id", type: "bigint" }],
    },
  ],
]);

/**
 * Verify a completed Collections snapshot without mutating its source artifacts.
 *
 * `onlineSchema` is optional. `true` re-runs introspection against the manifest
 * endpoint; an HTTPS string selects another endpoint; a GraphQL response object
 * (or a function returning one) can be supplied by tests and offline callers.
 */
export async function verifyCollectionsSnapshot({ input, onlineSchema = false }) {
  if (!input) throw new Error("verifyCollectionsSnapshot requires input.");
  const root = resolve(input);
  const issues = new IssueCollector();
  const startedAt = new Date().toISOString();
  let manifest = null;
  let manifestMetadata = null;
  let source = null;
  let schemaReport = { checked: false };
  let onlineSchemaReport = { checked: false };
  let artifactReport = { checked: 0, expected: 0, tables: {} };
  let relationshipReport = { checked: false };
  let mediaReport = { checked: false, reason: "not-complete" };

  try {
    manifest = await requiredJson(root, "manifest.json", issues);
    source = await requiredJson(root, "source.json", issues);
    if (manifest) manifestMetadata = await safeFileMetadata(root, "manifest.json", issues);

    if (manifest && source && manifest.endpoint !== source.endpoint) {
      issues.error(
        "SOURCE_ENDPOINT_MISMATCH",
        "source.json endpoint differs from manifest.json.",
        "source.json",
      );
    }

    if (manifest) {
      schemaReport = await verifyCapturedSchema({ root, manifest, issues });
      artifactReport = await verifyNormalizedArtifacts({ root, manifest, issues });
      relationshipReport = verifyRelationships({
        manifest,
        tables: artifactReport.rows ?? new Map(),
        referencedDropIds: artifactReport.referencedDropIds ?? [],
        issues,
      });
      if (onlineSchema) {
        onlineSchemaReport = await verifyOnlineSchema({
          onlineSchema,
          endpoint: manifest.endpoint,
          capturedSha256: manifest.schema?.sha256,
          issues,
        });
      }
      mediaReport = await verifyCompletedMedia({
        root,
        manifest,
        collections: artifactReport.rows?.get("collections") ?? [],
        issues,
      });
    }
  } catch (error) {
    issues.error("VERIFY_INTERNAL_ERROR", error.message, null, {
      name: error.name,
      code: error.code ?? null,
    });
  }

  const checksumEntries = await buildChecksumEntries(root, issues);
  await writeChecksums(root, checksumEntries);
  const checksumsMetadata = await sha256File(resolve(root, CHECKSUMS_PATH));

  const report = {
    version: REPORT_VERSION,
    dataset: manifest?.dataset ?? source?.dataset ?? "poap-compass-collections",
    verified: issues.errorCount === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    manifest: manifestMetadata,
    schema: schemaReport,
    onlineSchema: onlineSchemaReport,
    normalized: withoutRows(artifactReport),
    relationships: relationshipReport,
    media: mediaReport,
    checksums: {
      path: CHECKSUMS_PATH,
      entries: checksumEntries.length,
      ...checksumsMetadata,
    },
    issues: issues.report(),
  };
  await writeJsonAtomic(resolve(root, REPORT_PATH), report);
  const reportMetadata = await sha256File(resolve(root, REPORT_PATH));
  const reportChecksumTemporary = resolve(
    root,
    `${REPORT_CHECKSUM_PATH}.tmp-${process.pid}-${Date.now()}`,
  );
  await writeFile(reportChecksumTemporary, `${reportMetadata.sha256}  ${REPORT_PATH}\n`, {
    mode: 0o600,
  });
  await rename(reportChecksumTemporary, resolve(root, REPORT_CHECKSUM_PATH));

  if (!report.verified) {
    const first = report.issues.items.find((issue) => issue.severity === "error");
    const error = new Error(
      `Collections snapshot verification failed with ${issues.errorCount} error(s)` +
        (first ? `: ${first.message}` : "."),
    );
    error.code = "COLLECTIONS_SNAPSHOT_INVALID";
    error.report = report;
    throw error;
  }
  return report;
}

async function verifyCapturedSchema({ root, manifest, issues }) {
  const schemaPath = "schema/introspection.json";
  const metadata = await safeFileMetadata(root, schemaPath, issues);
  const report = {
    checked: true,
    path: schemaPath,
    expectedSha256: manifest.schema?.sha256 ?? null,
    expectedByteLength: manifest.schema?.bytes ?? null,
    ...metadata,
  };
  if (!metadata) return report;
  if (!isSha256(manifest.schema?.sha256)) {
    issues.error("SCHEMA_MANIFEST_INVALID", "Manifest schema SHA-256 is missing or invalid.");
  } else if (metadata.sha256 !== manifest.schema.sha256) {
    issues.error(
      "SCHEMA_CHECKSUM_MISMATCH",
      "Captured introspection checksum differs from manifest.json.",
      schemaPath,
      { expected: manifest.schema.sha256, actual: metadata.sha256 },
    );
  }
  if (manifest.schema?.bytes !== undefined && metadata.byteLength !== manifest.schema.bytes) {
    issues.error(
      "SCHEMA_SIZE_MISMATCH",
      "Captured introspection byte length differs from manifest.json.",
      schemaPath,
      { expected: manifest.schema.bytes, actual: metadata.byteLength },
    );
  }
  if (manifest.schema?.querySha256 !== sha256(INTROSPECTION_QUERY)) {
    issues.error(
      "INTROSPECTION_QUERY_MISMATCH",
      "Manifest introspection query checksum does not match this verifier.",
    );
  }
  try {
    const body = await readJson(resolve(root, schemaPath));
    if (!body?.data?.__schema || !Array.isArray(body.data.__schema.types)) {
      issues.error(
        "SCHEMA_DOCUMENT_INVALID",
        "Captured introspection does not contain data.__schema.types.",
        schemaPath,
      );
    }
  } catch (error) {
    issues.error("SCHEMA_JSON_INVALID", error.message, schemaPath);
  }
  return report;
}

async function verifyNormalizedArtifacts({ root, manifest, issues }) {
  const artifacts = manifest.normalized?.artifacts;
  if (!Array.isArray(artifacts)) {
    issues.error(
      "NORMALIZED_MANIFEST_MISSING",
      "Manifest does not list normalized artifacts.",
      "manifest.json",
    );
    return { checked: 0, expected: 0, tables: {}, rows: new Map(), referencedDropIds: [] };
  }

  const expectedTables = new Map(
    ENTITY_CONFIGS.map((config) => [
      config.name,
      {
        path: `normalized/${config.name}.ndjson`,
        key: config.cursor,
        manifestEntity: config.name,
      },
    ]),
  );
  for (const [name, config] of EXTRA_TABLES) expectedTables.set(name, config);

  const expectedEntityNames = ENTITY_CONFIGS.map((config) => config.name).sort();
  const actualEntityNames =
    manifest.entities && typeof manifest.entities === "object" && !Array.isArray(manifest.entities)
      ? Object.keys(manifest.entities).sort()
      : [];
  if (
    actualEntityNames.length !== expectedEntityNames.length ||
    actualEntityNames.some((name, index) => name !== expectedEntityNames[index])
  ) {
    issues.error(
      "ENTITY_SET_MISMATCH",
      "Manifest entity keys are not the exact exporter entity set.",
      "manifest.json",
      { expected: expectedEntityNames, actual: actualEntityNames },
    );
  }

  const artifactByPath = new Map();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.path !== "string") {
      issues.error("ARTIFACT_ENTRY_INVALID", "Normalized artifact entry has no path.");
      continue;
    }
    if (artifactByPath.has(artifact.path)) {
      issues.error(
        "ARTIFACT_PATH_DUPLICATE",
        `Manifest lists normalized artifact ${artifact.path} more than once.`,
        "manifest.json",
      );
      continue;
    }
    artifactByPath.set(artifact.path, artifact);
  }

  const rows = new Map();
  const tables = {};
  for (const [name, config] of expectedTables) {
    const artifact = artifactByPath.get(config.path);
    if (!artifact) {
      issues.error(
        "ARTIFACT_UNLISTED",
        `Manifest does not list required artifact ${config.path}.`,
        "manifest.json",
      );
      tables[name] = { path: config.path, checked: false };
      continue;
    }
    const result = await verifyNdjsonArtifact({ root, name, config, artifact, issues });
    rows.set(name, result.rows);
    tables[name] = result.report;
    const entity = config.manifestEntity ? manifest.entities?.[config.manifestEntity] : null;
    if (entity) {
      if (entity.complete !== true) {
        issues.error(
          "ENTITY_INCOMPLETE",
          `${config.manifestEntity} is not marked complete in manifest.json.`,
          "manifest.json",
        );
      }
      compareCount(
        result.rows.length,
        entity.rows,
        "ENTITY_ROW_COUNT_MISMATCH",
        `${config.manifestEntity} row count differs from its capture report.`,
        config.path,
        issues,
      );
      if (entity.expectedCount !== null && entity.expectedCount !== undefined) {
        compareCount(
          result.rows.length,
          entity.expectedCount,
          "ENTITY_AGGREGATE_COUNT_MISMATCH",
          `${config.manifestEntity} row count differs from its frozen aggregate count.`,
          config.path,
          issues,
        );
      }
    } else if (config.manifestEntity) {
      issues.error(
        "ENTITY_REPORT_MISSING",
        `${config.manifestEntity} has no capture report in manifest.json.`,
        "manifest.json",
      );
    }
  }

  const idsPath = "normalized/referenced_drop_ids.txt";
  const idsArtifact = artifactByPath.get(idsPath);
  let referencedDropIds = [];
  let idsReport = { path: idsPath, checked: false };
  if (!idsArtifact) {
    issues.error(
      "ARTIFACT_UNLISTED",
      `Manifest does not list required artifact ${idsPath}.`,
      "manifest.json",
    );
  } else {
    const result = await verifyReferencedDropIds({ root, artifact: idsArtifact, issues });
    referencedDropIds = result.ids;
    idsReport = result.report;
    compareCount(
      referencedDropIds.length,
      manifest.normalized?.referencedDropIds,
      "REFERENCED_ID_COUNT_MISMATCH",
      "referenced_drop_ids.txt count differs from manifest.json.",
      idsPath,
      issues,
    );
    const digest = sha256(`${referencedDropIds.join("\n")}\n`);
    if (digest !== manifest.normalized?.referencedDropIdsSha256) {
      issues.error(
        "REFERENCED_ID_DIGEST_MISMATCH",
        "Canonical referenced drop ID digest differs from manifest.json.",
        idsPath,
        { expected: manifest.normalized?.referencedDropIdsSha256 ?? null, actual: digest },
      );
    }
  }

  for (const artifact of artifacts) {
    if (!artifactByPath.has(artifact.path)) continue;
    if (!artifact.path.startsWith(NORMALIZED_PREFIX)) {
      issues.error(
        "ARTIFACT_PATH_INVALID",
        `Normalized artifact is outside ${NORMALIZED_PREFIX}: ${artifact.path}.`,
        "manifest.json",
      );
      continue;
    }
    if (
      ![...expectedTables.values()].some((config) => config.path === artifact.path) &&
      artifact.path !== idsPath
    ) {
      await verifyUnrecognizedArtifact({ root, artifact, issues });
    }
  }

  return {
    checked:
      Object.values(tables).filter((table) => table.checked).length + Number(idsReport.checked),
    expected: expectedTables.size + 1,
    tables: { ...tables, referenced_drop_ids: idsReport },
    rows,
    referencedDropIds,
  };
}

async function verifyNdjsonArtifact({ root, name, config, artifact, issues }) {
  const metadata = await verifyArtifactMetadata(root, artifact, issues);
  const rows = [];
  let priorKey = null;
  const seen = new Set();
  if (metadata) {
    try {
      for await (const { line, value } of readNdjson(resolve(root, artifact.path))) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          issues.error(
            "ROW_NOT_OBJECT",
            `${name} line ${line} is not a JSON object.`,
            artifact.path,
          );
          continue;
        }
        rows.push(value);
        const key = rowKey(name, value, config.key, issues, artifact.path, line);
        if (key === null) continue;
        if (seen.has(key.serialized)) {
          issues.error(
            "PRIMARY_KEY_DUPLICATE",
            `${name} contains duplicate primary key ${key.display}.`,
            artifact.path,
            { line },
          );
        }
        seen.add(key.serialized);
        if (priorKey && compareTypedKey(key.values, priorKey.values, config.key) <= 0) {
          issues.error(
            "CANONICAL_ORDER_INVALID",
            `${name} is not strictly ordered by its primary key at line ${line}.`,
            artifact.path,
            { previous: priorKey.display, current: key.display },
          );
        }
        priorKey = key;
      }
    } catch (error) {
      issues.error("NDJSON_INVALID", error.message, artifact.path);
    }
  }
  compareCount(
    rows.length,
    artifact.rows,
    "ARTIFACT_ROW_COUNT_MISMATCH",
    `${name} row count differs from manifest artifact metadata.`,
    artifact.path,
    issues,
  );
  return {
    rows,
    report: {
      path: artifact.path,
      checked: Boolean(metadata),
      rows: rows.length,
      primaryKey: config.key.map((field) => field.name),
      ...metadata,
    },
  };
}

async function verifyReferencedDropIds({ root, artifact, issues }) {
  const metadata = await verifyArtifactMetadata(root, artifact, issues);
  const ids = [];
  if (metadata) {
    try {
      const text = await readFile(resolve(root, artifact.path), "utf8");
      for (const [index, raw] of text.split("\n").entries()) {
        const value = raw.trim();
        if (!value) continue;
        if (!/^[1-9]\d*$/.test(value)) {
          issues.error(
            "REFERENCED_ID_INVALID",
            `Invalid referenced drop ID on line ${index + 1}.`,
            artifact.path,
          );
          continue;
        }
        const id = Number(value);
        if (!Number.isSafeInteger(id)) {
          issues.error(
            "REFERENCED_ID_UNSAFE",
            `Referenced drop ID is not a safe integer on line ${index + 1}.`,
            artifact.path,
          );
          continue;
        }
        if (ids.length > 0 && id <= ids.at(-1)) {
          issues.error(
            "REFERENCED_ID_ORDER_INVALID",
            "Referenced drop IDs are not strictly increasing.",
            artifact.path,
            { line: index + 1, previous: ids.at(-1), current: id },
          );
        }
        ids.push(id);
      }
    } catch (error) {
      issues.error("REFERENCED_ID_FILE_INVALID", error.message, artifact.path);
    }
  }
  compareCount(
    ids.length,
    artifact.rows,
    "ARTIFACT_ROW_COUNT_MISMATCH",
    "referenced_drop_ids.txt row count differs from manifest artifact metadata.",
    artifact.path,
    issues,
  );
  return {
    ids,
    report: { path: artifact.path, checked: Boolean(metadata), rows: ids.length, ...metadata },
  };
}

async function verifyUnrecognizedArtifact({ root, artifact, issues }) {
  const metadata = await verifyArtifactMetadata(root, artifact, issues);
  if (!metadata || !artifact.path.endsWith(".ndjson")) return;
  let rows = 0;
  try {
    for await (const unused of readNdjson(resolve(root, artifact.path))) rows += 1;
  } catch (error) {
    issues.error("NDJSON_INVALID", error.message, artifact.path);
    return;
  }
  compareCount(
    rows,
    artifact.rows,
    "ARTIFACT_ROW_COUNT_MISMATCH",
    `Unrecognized normalized artifact ${artifact.path} has the wrong row count.`,
    artifact.path,
    issues,
  );
}

async function verifyArtifactMetadata(root, artifact, issues) {
  const metadata = await safeFileMetadata(root, artifact.path, issues);
  if (!metadata) return null;
  if (!isSha256(artifact.sha256) || metadata.sha256 !== artifact.sha256) {
    issues.error(
      "ARTIFACT_CHECKSUM_MISMATCH",
      `Artifact checksum differs from manifest: ${artifact.path}.`,
      artifact.path,
      { expected: artifact.sha256 ?? null, actual: metadata.sha256 },
    );
  }
  if (metadata.byteLength !== artifact.byteLength) {
    issues.error(
      "ARTIFACT_SIZE_MISMATCH",
      `Artifact byte length differs from manifest: ${artifact.path}.`,
      artifact.path,
      { expected: artifact.byteLength ?? null, actual: metadata.byteLength },
    );
  }
  return metadata;
}

function verifyRelationships({ manifest, tables, referencedDropIds, issues }) {
  const collections = indexRows(tables.get("collections"), "id");
  const items = indexRows(tables.get("items"), "id");
  const sections = indexRows(tables.get("sections"), "id");
  const artists = indexRows(tables.get("artists"), "id");
  const organizations = indexRows(tables.get("organizations"), "id");
  const referencedDrops = indexRows(tables.get("referenced_drops"), "id");
  const checks = {};

  checks.collectionUrls = checkForeignKeys({
    rows: tables.get("collection_urls"),
    field: "collection_id",
    target: collections,
    label: "collection_urls.collection_id",
    issues,
  });
  checks.uiSettings = checkForeignKeys({
    rows: tables.get("collection_ui_settings"),
    field: "collection_id",
    target: collections,
    label: "collection_ui_settings.collection_id",
    issues,
  });
  checks.itemsCollections = checkForeignKeys({
    rows: tables.get("items"),
    field: "collection_id",
    target: collections,
    label: "items.collection_id",
    issues,
  });
  checks.sectionsCollections = checkForeignKeys({
    rows: tables.get("sections"),
    field: "collection_id",
    target: collections,
    label: "sections.collection_id",
    issues,
  });
  checks.artistsCollections = checkForeignKeys({
    rows: tables.get("artists"),
    field: "collection_id",
    target: collections,
    label: "artists.collection_id",
    required: true,
    issues,
  });
  checks.organizationsCollections = checkForeignKeys({
    rows: tables.get("organizations"),
    field: "collection_id",
    target: collections,
    label: "organizations.collection_id",
    required: true,
    issues,
  });
  checks.verifiedCollections = checkForeignKeys({
    rows: tables.get("verified_collections"),
    field: "collection_id",
    target: collections,
    label: "verified_collections.collection_id",
    issues,
  });
  checks.verifiedOrganizations = checkForeignKeys({
    rows: tables.get("verified_collections"),
    field: "verified_by",
    target: organizations,
    label: "verified_collections.verified_by",
    issues,
  });
  checks.featuredCollections = checkForeignKeys({
    rows: tables.get("featured_collections"),
    field: "collection_id",
    target: collections,
    label: "featured_collections.collection_id",
    issues,
  });
  checks.suggestedCollections = checkForeignKeys({
    rows: tables.get("suggested_drops"),
    field: "collection_id",
    target: collections,
    label: "suggested_drops.collection_id",
    issues,
  });
  checks.viewCollections = checkForeignKeys({
    rows: tables.get("collection_drop_ids"),
    field: "collection_id",
    target: collections,
    label: "collection_drop_ids.collection_id",
    issues,
  });
  checks.itemSectionsItems = checkForeignKeys({
    rows: tables.get("item_sections"),
    field: "item_id",
    target: items,
    label: "item_sections.item_id",
    issues,
  });
  checks.itemSectionsSections = checkForeignKeys({
    rows: tables.get("item_sections"),
    field: "section_id",
    target: sections,
    label: "item_sections.section_id",
    issues,
  });
  checks.artistDropsArtists = checkForeignKeys({
    rows: tables.get("artist_drops"),
    field: "artist_id",
    target: artists,
    label: "artist_drops.artist_id",
    issues,
  });

  const dropRelations = [
    ["items", tables.get("items")],
    ["artist_drops", tables.get("artist_drops")],
    ["suggested_drops", tables.get("suggested_drops")],
  ];
  for (const [name, rows] of dropRelations) {
    checks[`${name}ReferencedDrops`] = checkForeignKeys({
      rows,
      field: "drop_id",
      target: referencedDrops,
      label: `${name}.drop_id`,
      issues,
    });
  }

  let mismatchedCollections = 0;
  for (const relation of tables.get("item_sections") ?? []) {
    const item = items.get(canonicalScalar(relation.item_id));
    const section = sections.get(canonicalScalar(relation.section_id));
    if (!item || !section) continue;
    if (canonicalScalar(item.collection_id) !== canonicalScalar(section.collection_id)) {
      mismatchedCollections += 1;
      issues.error(
        "ITEM_SECTION_COLLECTION_MISMATCH",
        `Item ${relation.item_id} and section ${relation.section_id} belong to different collections.`,
        "normalized/item_sections.ndjson",
      );
    }
  }

  const membership = verifyCollectionDropIds({ tables, collections, issues });
  const referenced = verifyReferencedDropUnion({
    manifest,
    tables,
    referencedDropIds,
    referencedDrops,
    issues,
  });
  const semantics = verifyCollectionTypeRelations({ tables, collections, issues });
  verifyNestedDropRelations(tables.get("referenced_drops") ?? [], issues);

  return {
    checked: true,
    foreignKeys: checks,
    itemSectionCollectionMismatches: mismatchedCollections,
    collectionDropIds: membership,
    referencedDrops: referenced,
    collectionTypes: semantics,
    duplicateSlugs: duplicateValueCount(tables.get("collections") ?? [], "slug"),
  };
}

function verifyCollectionDropIds({ tables, collections, issues }) {
  const itemRows = tables.get("items") ?? [];
  const viewRows = tables.get("collection_drop_ids") ?? [];
  const itemDrops = new Map();
  const pairKeys = new Set();
  let duplicateMemberships = 0;
  for (const row of itemRows) {
    const collectionId = canonicalScalar(row.collection_id);
    const dropId = canonicalScalar(row.drop_id);
    const pair = `${collectionId}\u0000${dropId}`;
    if (pairKeys.has(pair)) {
      duplicateMemberships += 1;
      issues.error(
        "COLLECTION_ITEM_MEMBERSHIP_DUPLICATE",
        `Collection ${collectionId} contains drop ${dropId} more than once.`,
        "normalized/items.ndjson",
      );
    }
    pairKeys.add(pair);
    if (!itemDrops.has(collectionId)) itemDrops.set(collectionId, []);
    itemDrops.get(collectionId).push(dropId);
  }
  for (const values of itemDrops.values()) values.sort(compareCanonicalNumbers);

  const seenCollections = new Set();
  let mismatches = 0;
  for (const row of viewRows) {
    const collectionId = canonicalScalar(row.collection_id);
    seenCollections.add(collectionId);
    if (!Array.isArray(row.drop_ids)) {
      mismatches += 1;
      issues.error(
        "COLLECTION_DROP_IDS_INVALID",
        `Collection ${collectionId} has a non-array drop_ids value.`,
        "normalized/collection_drop_ids.ndjson",
      );
      continue;
    }
    const actual = row.drop_ids.map(canonicalScalar).sort(compareCanonicalNumbers);
    const expected = itemDrops.get(collectionId) ?? [];
    if (!arraysEqual(actual, expected)) {
      mismatches += 1;
      issues.error(
        "COLLECTION_DROP_IDS_MISMATCH",
        `Derived drop IDs differ from items for collection ${collectionId}.`,
        "normalized/collection_drop_ids.ndjson",
        { expectedCount: expected.length, actualCount: actual.length },
      );
    }
  }
  for (const [collectionId, values] of itemDrops) {
    if (values.length > 0 && !seenCollections.has(collectionId)) {
      mismatches += 1;
      issues.error(
        "COLLECTION_DROP_IDS_ROW_MISSING",
        `No collection_drop_ids row exists for collection ${collectionId}.`,
        "normalized/collection_drop_ids.ndjson",
      );
    }
  }
  for (const collectionId of seenCollections) {
    if (!collections.has(collectionId)) continue;
    if (!itemDrops.has(collectionId)) {
      const row = viewRows.find(
        (candidate) => canonicalScalar(candidate.collection_id) === collectionId,
      );
      if (row?.drop_ids?.length) {
        mismatches += 1;
      }
    }
  }
  return {
    itemMemberships: itemRows.length,
    viewRows: viewRows.length,
    mismatches,
    duplicateMemberships,
  };
}

function verifyReferencedDropUnion({
  manifest,
  tables,
  referencedDropIds,
  referencedDrops,
  issues,
}) {
  const union = new Set();
  for (const name of ["items", "artist_drops", "suggested_drops"]) {
    for (const row of tables.get(name) ?? []) union.add(canonicalScalar(row.drop_id));
  }
  const expected = [...union].sort(compareCanonicalNumbers);
  const listed = referencedDropIds.map(String);
  if (!arraysEqual(expected, listed)) {
    issues.error(
      "REFERENCED_DROP_UNION_MISMATCH",
      "referenced_drop_ids.txt is not the exact union of collection drop relations.",
      "normalized/referenced_drop_ids.txt",
      { expected: expected.length, actual: listed.length },
    );
  }
  const captured = [...referencedDrops.keys()].sort(compareCanonicalNumbers);
  if (!arraysEqual(expected, captured)) {
    issues.error(
      "REFERENCED_DROP_METADATA_INCOMPLETE",
      "referenced_drops.ndjson does not contain exactly one row for every referenced drop.",
      "normalized/referenced_drops.ndjson",
      { expected: expected.length, actual: captured.length },
    );
  }
  if (manifest.referencedDrops?.complete !== true) {
    issues.error(
      "REFERENCED_DROP_CAPTURE_INCOMPLETE",
      "Manifest does not mark referenced drop capture complete.",
      "manifest.json",
    );
  }
  if ((manifest.referencedDrops?.missing?.length ?? 0) > 0) {
    issues.error(
      "REFERENCED_DROPS_MISSING",
      `Manifest records ${manifest.referencedDrops.missing.length} missing referenced drops.`,
      "manifest.json",
    );
  }
  compareCount(
    expected.length,
    manifest.referencedDrops?.requested,
    "REFERENCED_DROP_REQUEST_COUNT_MISMATCH",
    "Referenced drop request count differs from the relation union.",
    "manifest.json",
    issues,
  );
  compareCount(
    captured.length,
    manifest.referencedDrops?.captured,
    "REFERENCED_DROP_CAPTURE_COUNT_MISMATCH",
    "Referenced drop metadata count differs from manifest.json.",
    "manifest.json",
    issues,
  );
  return {
    union: expected.length,
    listed: listed.length,
    captured: captured.length,
    missing: expected.filter((id) => !referencedDrops.has(id)).length,
  };
}

function verifyCollectionTypeRelations({ tables, collections, issues }) {
  const artistCollections = new Set(
    (tables.get("artists") ?? []).map((row) => canonicalScalar(row.collection_id)),
  );
  const organizationCollections = new Set(
    (tables.get("organizations") ?? []).map((row) => canonicalScalar(row.collection_id)),
  );
  let mismatches = 0;
  for (const [id, collection] of collections) {
    const hasArtist = artistCollections.has(id);
    const hasOrganization = organizationCollections.has(id);
    const valid =
      (collection.type === "artist" && hasArtist && !hasOrganization) ||
      (collection.type === "organization" && hasOrganization && !hasArtist) ||
      (collection.type === "user" && !hasArtist && !hasOrganization);
    if (!valid) {
      mismatches += 1;
      issues.error(
        "COLLECTION_TYPE_RELATION_MISMATCH",
        `Collection ${id} type ${JSON.stringify(collection.type)} does not match artist/organization relations.`,
        "normalized/collections.ndjson",
      );
    }
  }
  return {
    artistRelations: artistCollections.size,
    organizationRelations: organizationCollections.size,
    mismatches,
  };
}

function verifyNestedDropRelations(rows, issues) {
  for (const row of rows) {
    const id = canonicalScalar(row.id);
    if (row.hidden_drop && canonicalScalar(row.hidden_drop.drop_id) !== id) {
      issues.error(
        "HIDDEN_DROP_RELATION_MISMATCH",
        `Drop ${id} has hidden_drop for ${row.hidden_drop.drop_id}.`,
        "normalized/referenced_drops.ndjson",
      );
    }
    if (
      row.drop_image?.drop_id !== null &&
      row.drop_image?.drop_id !== undefined &&
      canonicalScalar(row.drop_image.drop_id) !== id
    ) {
      issues.error(
        "DROP_IMAGE_RELATION_MISMATCH",
        `Drop ${id} has drop_image for ${row.drop_image.drop_id}.`,
        "normalized/referenced_drops.ndjson",
      );
    }
  }
}

async function verifyCompletedMedia({ root, manifest, collections, issues }) {
  if (manifest.media?.captured !== true || manifest.media?.complete !== true) {
    return {
      checked: false,
      reason: manifest.media?.captured ? "media-incomplete" : "media-not-captured",
    };
  }
  const manifestPath = manifest.media.manifest ?? "media/manifest.json";
  const mediaManifest = await requiredJson(root, manifestPath, issues);
  if (!mediaManifest) return { checked: true, complete: false };

  const planPath = "media/plan.ndjson";
  const checkpointPath = mediaManifest.checkpoint ?? "media/checkpoint.ndjson";
  const plan = [];
  try {
    for await (const { value } of readNdjson(resolve(root, planPath))) plan.push(value);
  } catch (error) {
    issues.error("MEDIA_PLAN_INVALID", error.message, planPath);
  }
  const expectedPlan = expectedMediaReferences(collections);
  if (canonicalJsonLines(plan) !== canonicalJsonLines(expectedPlan)) {
    issues.error(
      "MEDIA_PLAN_MISMATCH",
      "Media plan is not the exact logo/banner reference set from collections.ndjson.",
      planPath,
      { expected: expectedPlan.length, actual: plan.length },
    );
  }
  const referencesSha256 = sha256(canonicalJsonLines(plan));
  if (referencesSha256 !== mediaManifest.referencesSha256) {
    issues.error(
      "MEDIA_PLAN_CHECKSUM_MISMATCH",
      "Media plan checksum differs from media/manifest.json.",
      planPath,
      { expected: mediaManifest.referencesSha256, actual: referencesSha256 },
    );
  }
  if (manifest.media.referencesSha256 !== mediaManifest.referencesSha256) {
    issues.error(
      "MEDIA_MANIFEST_MISMATCH",
      "Root manifest and media manifest reference digests differ.",
      manifestPath,
    );
  }
  compareCount(
    plan.length,
    mediaManifest.references,
    "MEDIA_REFERENCE_COUNT_MISMATCH",
    "Media plan row count differs from media manifest.",
    planPath,
    issues,
  );

  const checkpoint = await readMediaCheckpoint(root, checkpointPath, issues);
  if (checkpoint.header) {
    if (checkpoint.header.referencesSha256 !== referencesSha256) {
      issues.error(
        "MEDIA_CHECKPOINT_CONTEXT_MISMATCH",
        "Media checkpoint is bound to another reference plan.",
        checkpointPath,
      );
    }
    if (checkpoint.header.endpoint !== manifest.endpoint) {
      issues.error(
        "MEDIA_CHECKPOINT_ENDPOINT_MISMATCH",
        "Media checkpoint endpoint differs from snapshot manifest.",
        checkpointPath,
      );
    }
  }

  const expectedById = new Map(plan.map((reference) => [reference.id, reference]));
  const statuses = { stored: 0, missing: 0, quarantined: 0, failed: 0 };
  const objectPaths = new Map();
  for (const [id, expected] of expectedById) {
    const record = checkpoint.records.get(id);
    if (!record) {
      issues.error(
        "MEDIA_CHECKPOINT_RECORD_MISSING",
        `Media checkpoint has no final record for ${id}.`,
        checkpointPath,
      );
      continue;
    }
    for (const field of ["id", "collectionId", "role", "sourceUrl"]) {
      if (record[field] !== expected[field]) {
        issues.error(
          "MEDIA_CHECKPOINT_REFERENCE_MISMATCH",
          `Media checkpoint ${id} field ${field} differs from its plan.`,
          checkpointPath,
        );
      }
    }
    if (record.status in statuses) statuses[record.status] += 1;
    else {
      issues.error(
        "MEDIA_STATUS_INVALID",
        `Media checkpoint ${id} has invalid status ${JSON.stringify(record.status)}.`,
        checkpointPath,
      );
    }
    if (record.status === "stored") {
      if (!isSha256(record.sha256) || typeof record.objectPath !== "string") {
        issues.error(
          "MEDIA_OBJECT_METADATA_INVALID",
          `Stored media record ${id} has invalid object metadata.`,
          checkpointPath,
        );
        continue;
      }
      objectPaths.set(record.objectPath, record);
    }
  }
  for (const id of checkpoint.records.keys()) {
    if (!expectedById.has(id)) {
      issues.error(
        "MEDIA_CHECKPOINT_RECORD_UNEXPECTED",
        `Media checkpoint contains unexpected reference ${id}.`,
        checkpointPath,
      );
    }
  }

  let objectsChecked = 0;
  for (const [objectPath, record] of objectPaths) {
    const metadata = await safeFileMetadata(root, objectPath, issues);
    if (!metadata) continue;
    objectsChecked += 1;
    if (metadata.sha256 !== record.sha256) {
      issues.error(
        "MEDIA_OBJECT_CHECKSUM_MISMATCH",
        `Media object checksum differs from checkpoint: ${objectPath}.`,
        objectPath,
        { expected: record.sha256, actual: metadata.sha256 },
      );
    }
    if (metadata.byteLength !== record.byteLength) {
      issues.error(
        "MEDIA_OBJECT_SIZE_MISMATCH",
        `Media object byte length differs from checkpoint: ${objectPath}.`,
        objectPath,
        { expected: record.byteLength, actual: metadata.byteLength },
      );
    }
  }

  for (const [status, count] of Object.entries(statuses)) {
    compareCount(
      count,
      mediaManifest.counts?.[status],
      "MEDIA_STATUS_COUNT_MISMATCH",
      `Media ${status} count differs from media manifest.`,
      manifestPath,
      issues,
    );
  }
  const uniqueObjects = new Set(
    [...checkpoint.records.values()]
      .filter((row) => row.status === "stored")
      .map((row) => row.sha256),
  ).size;
  compareCount(
    uniqueObjects,
    mediaManifest.uniqueObjects,
    "MEDIA_OBJECT_COUNT_MISMATCH",
    "Unique media object count differs from media manifest.",
    manifestPath,
    issues,
  );

  return {
    checked: true,
    complete: mediaManifest.complete === true,
    references: plan.length,
    checkpointRecords: checkpoint.records.size,
    objectsChecked,
    uniqueObjects,
    statuses,
  };
}

async function readMediaCheckpoint(root, path, issues) {
  const records = new Map();
  let header = null;
  let text;
  try {
    const absolute = safePath(root, path);
    await assertRegularFile(absolute, path);
    text = await readFile(absolute, "utf8");
  } catch (error) {
    issues.error("MEDIA_CHECKPOINT_MISSING", error.message, path);
    return { header, records };
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      issues.error(
        "MEDIA_CHECKPOINT_JSON_INVALID",
        `Invalid JSON on line ${index + 1}: ${error.message}`,
        path,
      );
      continue;
    }
    if (!header) {
      header = record;
      if (record.kind !== "header" || record.version !== 1) {
        issues.error(
          "MEDIA_CHECKPOINT_HEADER_INVALID",
          "Media checkpoint header is invalid.",
          path,
        );
      }
      continue;
    }
    if (record.kind !== "reference" || typeof record.id !== "string") {
      issues.error(
        "MEDIA_CHECKPOINT_RECORD_INVALID",
        `Invalid media checkpoint record on line ${index + 1}.`,
        path,
      );
      continue;
    }
    records.set(record.id, record);
  }
  if (!header) {
    issues.error("MEDIA_CHECKPOINT_HEADER_MISSING", "Media checkpoint is empty.", path);
  }
  return { header, records };
}

async function verifyOnlineSchema({ onlineSchema, endpoint, capturedSha256, issues }) {
  const report = { checked: true, endpoint: null, sha256: null };
  try {
    const resolved = await resolveOnlineSchema(onlineSchema, endpoint);
    report.endpoint = resolved.endpoint;
    report.sha256 = resolved.sha256;
    if (resolved.sha256 !== capturedSha256) {
      issues.error(
        "ONLINE_SCHEMA_MISMATCH",
        "Current online introspection differs from the captured schema.",
        "schema/introspection.json",
        { captured: capturedSha256, online: resolved.sha256 },
      );
    }
  } catch (error) {
    report.error = error.message;
    issues.error("ONLINE_SCHEMA_CHECK_FAILED", error.message);
  }
  return report;
}

async function resolveOnlineSchema(value, fallbackEndpoint) {
  if (typeof value === "string" && isSha256(value)) {
    return { endpoint: null, sha256: value };
  }
  if (typeof value === "function") value = await value({ endpoint: fallbackEndpoint });
  if (value === true || (typeof value === "string" && /^https:\/\//.test(value))) {
    const endpoint = value === true ? fallbackEndpoint : value;
    const client = new GraphqlClient({ endpoint, delayMs: 0, retries: 2 });
    const response = await client.request({
      query: INTROSPECTION_QUERY,
      operationName: "POAPinCollectionsIntrospection",
    });
    return { endpoint, sha256: canonicalJsonSha256(response.body) };
  }
  if (value && typeof value === "object" && typeof value.sha256 === "string") {
    if (!isSha256(value.sha256)) throw new Error("Provided online schema SHA-256 is invalid.");
    return { endpoint: value.endpoint ?? null, sha256: value.sha256 };
  }
  const body = value?.body ?? value;
  if (body?.__schema) {
    return { endpoint: null, sha256: canonicalJsonSha256({ data: body }) };
  }
  if (body?.data?.__schema) {
    return { endpoint: null, sha256: canonicalJsonSha256(body) };
  }
  throw new Error(
    "onlineSchema must be true, an HTTPS endpoint, a schema digest, or introspection JSON.",
  );
}

function canonicalJsonSha256(value) {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

async function requiredJson(root, path, issues) {
  try {
    const absolute = safePath(root, path);
    await assertRegularFile(absolute, path);
    return await readJson(absolute);
  } catch (error) {
    issues.error("REQUIRED_JSON_INVALID", error.message, path);
    return null;
  }
}

async function safeFileMetadata(root, path, issues) {
  try {
    const absolute = safePath(root, path);
    await assertRegularFile(absolute, path);
    return await sha256File(absolute);
  } catch (error) {
    issues.error("ARTIFACT_MISSING_OR_UNSAFE", error.message, path);
    return null;
  }
}

function safePath(root, path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error("Artifact path is empty or invalid.");
  }
  const absolute = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`Artifact path escapes snapshot root: ${path}`);
  }
  return absolute;
}

async function assertRegularFile(path, displayPath) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Expected a regular non-symlink file: ${displayPath}`);
  }
}

async function* readNdjson(path) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid NDJSON on line ${lineNumber}: ${error.message}`);
      }
      yield { line: lineNumber, value };
    }
  } finally {
    lines.close();
  }
}

function rowKey(name, row, fields, issues, path, line) {
  const values = [];
  for (const field of fields) {
    const value = row[field.name];
    if (value === null || value === undefined || value === "") {
      issues.error("PRIMARY_KEY_EMPTY", `${name} primary key field ${field.name} is empty.`, path, {
        line,
      });
      return null;
    }
    if (field.type === "bigint") {
      try {
        BigInt(value);
      } catch {
        issues.error(
          "PRIMARY_KEY_INVALID",
          `${name} primary key field ${field.name} is not an integer.`,
          path,
          { line, value },
        );
        return null;
      }
    }
    if (
      field.type === "uuid" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))
    ) {
      issues.error(
        "PRIMARY_KEY_INVALID",
        `${name} primary key field ${field.name} is not a UUID.`,
        path,
        { line, value },
      );
      return null;
    }
    values.push(String(value));
  }
  return {
    values,
    serialized: JSON.stringify(values),
    display: values.join("/"),
  };
}

function compareTypedKey(left, right, fields) {
  for (let index = 0; index < fields.length; index += 1) {
    let comparison;
    if (fields[index].type === "bigint") {
      const a = BigInt(left[index]);
      const b = BigInt(right[index]);
      comparison = a < b ? -1 : a > b ? 1 : 0;
    } else {
      comparison = left[index].localeCompare(right[index], "en");
    }
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function indexRows(rows = [], field) {
  const index = new Map();
  for (const row of rows) {
    const value = row?.[field];
    if (value !== null && value !== undefined) index.set(canonicalScalar(value), row);
  }
  return index;
}

function checkForeignKeys({ rows = [], field, target, label, required = true, issues }) {
  let checked = 0;
  let missing = 0;
  let empty = 0;
  for (const row of rows ?? []) {
    const value = row[field];
    if (value === null || value === undefined || value === "") {
      empty += 1;
      if (required) {
        issues.error("FOREIGN_KEY_EMPTY", `${label} is empty.`, null, { row });
      }
      continue;
    }
    checked += 1;
    if (!target.has(canonicalScalar(value))) {
      missing += 1;
      issues.error("FOREIGN_KEY_MISSING", `${label} references missing key ${value}.`, null);
    }
  }
  return { rows: rows?.length ?? 0, checked, missing, empty };
}

function compareCount(actual, expected, code, message, path, issues) {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    issues.error(`${code}_EXPECTED_INVALID`, `${message} Expected count is invalid.`, path, {
      expected: expected ?? null,
      actual,
    });
  } else if (actual !== expected) {
    issues.error(code, message, path, { expected, actual });
  }
}

function canonicalScalar(value) {
  return String(value);
}

function compareCanonicalNumbers(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return String(left).localeCompare(String(right), "en");
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function duplicateValueCount(rows, field) {
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const value = canonicalScalar(row[field]);
    if (seen.has(value)) duplicates += 1;
    else seen.add(value);
  }
  return duplicates;
}

function expectedMediaReferences(collections) {
  const references = [];
  for (const collection of collections) {
    for (const [role, sourceUrl] of [
      ["logo", collection.logo_image_url],
      ["banner", collection.banner_image_url],
    ]) {
      if (!sourceUrl) continue;
      references.push({
        id: `${collection.id}:${role}`,
        collectionId: Number(collection.id),
        role,
        sourceUrl,
      });
    }
  }
  references.sort(
    (left, right) => left.collectionId - right.collectionId || left.role.localeCompare(right.role),
  );
  return references;
}

function canonicalJsonLines(values) {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

async function buildChecksumEntries(root, issues) {
  const files = [];
  await walk(root, "", files, issues);
  files.sort((left, right) => left.localeCompare(right, "en"));
  const entries = [];
  for (const path of files) {
    if (path === CHECKSUMS_PATH || path === REPORT_PATH || path === REPORT_CHECKSUM_PATH) continue;
    if (path.includes("\n") || path.includes("\r")) {
      issues.error("CHECKSUM_PATH_UNSAFE", `Cannot encode checksum path ${JSON.stringify(path)}.`);
      continue;
    }
    const metadata = await sha256File(resolve(root, path));
    entries.push({ path, ...metadata });
  }
  return entries;
}

async function walk(root, relativeDirectory, files, issues) {
  const directory = resolve(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    issues.error("SNAPSHOT_DIRECTORY_INVALID", error.message, relativeDirectory || ".");
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = relativeDirectory
      ? `${relativeDirectory.replaceAll("\\", "/")}/${entry.name}`
      : entry.name;
    if (/\.tmp-|\.part$/.test(entry.name)) {
      issues.error(
        "TEMPORARY_ARTIFACT_PRESENT",
        `Temporary artifact remains in snapshot: ${path}.`,
        path,
      );
      continue;
    }
    if (entry.isSymbolicLink()) {
      issues.error("SYMLINK_PRESENT", `Snapshot contains a symbolic link: ${path}.`, path);
      continue;
    }
    if (entry.isDirectory()) await walk(root, path, files, issues);
    else if (entry.isFile()) files.push(path);
    else
      issues.error("SPECIAL_FILE_PRESENT", `Snapshot contains a non-regular file: ${path}.`, path);
  }
}

async function writeChecksums(root, entries) {
  const path = resolve(root, CHECKSUMS_PATH);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const contents = `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

function withoutRows(report) {
  const { rows, referencedDropIds, ...publicReport } = report;
  return publicReport;
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

class IssueCollector {
  constructor() {
    this.items = [];
    this.errorCount = 0;
    this.warningCount = 0;
    this.suppressed = 0;
    this.byCode = new Map();
  }

  error(code, message, path = null, details = null) {
    this.add("error", code, message, path, details);
  }

  warning(code, message, path = null, details = null) {
    this.add("warning", code, message, path, details);
  }

  add(severity, code, message, path, details) {
    if (severity === "error") this.errorCount += 1;
    else this.warningCount += 1;
    this.byCode.set(code, (this.byCode.get(code) ?? 0) + 1);
    if (this.items.length >= MAX_REPORTED_ISSUES) {
      this.suppressed += 1;
      return;
    }
    this.items.push({
      severity,
      code,
      message,
      ...(path ? { path } : {}),
      ...(details ? { details } : {}),
    });
  }

  report() {
    return {
      errors: this.errorCount,
      warnings: this.warningCount,
      suppressed: this.suppressed,
      byCode: Object.fromEntries(
        [...this.byCode].sort(([left], [right]) => left.localeCompare(right, "en")),
      ),
      items: this.items,
    };
  }
}
