import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { GraphqlClient } from "./graphql.mjs";
import { mediaInternals } from "./media.mjs";
import {
  appendJsonLine,
  exists,
  fileMetadata,
  readGzipJson,
  readJson,
  sha256,
  sha256File,
  writeGzipJsonAtomic,
  writeJsonAtomic,
} from "./files.mjs";

const VERSION = 1;
const MAX_REDIRECTS = 5;
const USER_AGENT = "POAPin-Archive-Drop-Supplement/0.1 (+https://poap.in)";
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const STATS_FIELDS = ["chain", "created_on", "drop_id", "poap_count", "transfer_count"];
const EMAIL_FIELDS = ["drop_id", "minted", "reserved", "total"];
const FEATURED_FIELDS = ["drop_id", "featured_on"];
const MOMENTS_FIELDS = ["drop_id", "moments_uploaded"];

export const DROP_SUPPLEMENT_QUERY = `
query ReferencedDropSupplement(
  $dropIds: [Int!]!
  $dropLimit: Int!
) {
  drops(
    where: { id: { _in: $dropIds } }
    order_by: { id: asc }
    limit: $dropLimit
  ) {
    id
    stats_by_chain(
      order_by: [{ drop_id: asc }, { chain: asc }]
      limit: 100
    ) { ${STATS_FIELDS.join(" ")} }
    email_claims_stats { ${EMAIL_FIELDS.join(" ")} }
    featured_drop { ${FEATURED_FIELDS.join(" ")} }
    moments_stats { ${MOMENTS_FIELDS.join(" ")} }
  }
}
`;
const DROP_SUPPLEMENT_QUERY_FILE = `${DROP_SUPPLEMENT_QUERY.trim()}\n`;

export async function captureReferencedDropSupplement({
  input,
  delayMs = 250,
  pageSize = 100,
  concurrency = 3,
  maximumBytes = 50 * 1024 * 1024,
  retryFailures = false,
  archiveCatalogSqlite = null,
  archiveMediaManifest = null,
  archiveUploadReport = null,
  archiveUploadCheckpoint = null,
  archiveSnapshotId = null,
  onProgress = () => {},
  dependencies = {},
}) {
  const root = resolve(input);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("Drop supplement pageSize must be an integer from 1 to 100.");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Drop supplement concurrency must be an integer from 1 to 8.");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) {
    throw new Error("Drop supplement maximumBytes must be at least 1024.");
  }
  const archiveMediaInputs = [
    archiveMediaManifest,
    archiveUploadReport,
    archiveUploadCheckpoint,
  ].filter(Boolean).length;
  if (archiveMediaInputs !== 0 && archiveMediaInputs !== 3) {
    throw new Error(
      "--archive-media-manifest, --archive-upload-report, and --archive-upload-checkpoint must be provided together.",
    );
  }
  const hasArchiveInput = Boolean(
    archiveCatalogSqlite || archiveMediaManifest || archiveUploadReport || archiveUploadCheckpoint,
  );
  if (hasArchiveInput !== Boolean(archiveSnapshotId)) {
    throw new Error("Archive inputs and --archive-snapshot-id must be provided together.");
  }
  if (archiveSnapshotId && !SNAPSHOT_ID.test(archiveSnapshotId)) {
    throw new Error("Archive snapshot ID is invalid.");
  }

  const context = await loadBoundContext(root);
  const supplementRoot = resolve(root, "drop-supplement");
  await mkdir(supplementRoot, { recursive: true });
  await assertExistingManifestBinding(supplementRoot, context);
  await writeQuery(supplementRoot);

  const catalog = archiveCatalogSqlite
    ? await inspectArchiveCatalog({
        path: archiveCatalogSqlite,
        snapshotId: archiveSnapshotId,
        dropIds: context.dropIds,
      })
    : emptyCatalog();
  const archiveMedia = archiveMediaManifest
    ? await inspectArchiveMedia({
        manifestPath: archiveMediaManifest,
        reportPath: archiveUploadReport,
        checkpointPath: archiveUploadCheckpoint,
        snapshotId: archiveSnapshotId,
        supplementRoot,
      })
    : emptyArchiveMedia();
  const client =
    dependencies.client ??
    new GraphqlClient({ endpoint: context.endpoint, delayMs, onRequest: onProgress });
  const graphql = await captureRelations({
    root,
    supplementRoot,
    context,
    client,
    pageSize,
    onProgress,
  });
  const artwork = await captureArtwork({
    root,
    supplementRoot,
    context,
    catalog,
    archiveMedia,
    concurrency,
    maximumBytes,
    retryFailures,
    onProgress,
    fetchImpl: dependencies.fetch ?? globalThis.fetch,
    lookup: dependencies.lookup ?? dnsLookup,
  });

  const manifest = {
    version: VERSION,
    dataset: "poap-compass-referenced-drop-supplement",
    generatedAt: new Date().toISOString(),
    source: context.binding,
    graphql,
    archiveCatalog: catalog.report,
    archiveMedia: archiveMedia.report,
    artwork,
    complete: graphql.complete && artwork.complete,
    publishable: graphql.complete && artwork.publishable,
    quarantinedReferencesAreExcluded: true,
  };
  await writeJsonAtomic(resolve(supplementRoot, "manifest.json"), manifest);
  return manifest;
}

async function loadBoundContext(root) {
  const manifestPath = resolve(root, "manifest.json");
  const schemaPath = resolve(root, "schema/introspection.json");
  const idsPath = resolve(root, "normalized/referenced_drop_ids.txt");
  const dropsPath = resolve(root, "normalized/referenced_drops.ndjson");
  const [manifest, manifestFile, schemaFile, idsFile, dropsFile] = await Promise.all([
    readJson(manifestPath),
    regularFileMetadata(root, manifestPath, "snapshot manifest"),
    regularFileMetadata(root, schemaPath, "captured schema"),
    regularFileMetadata(root, idsPath, "referenced drop IDs"),
    regularFileMetadata(root, dropsPath, "referenced drops"),
  ]);
  if (manifest.version !== 1 || manifest.dataset !== "poap-compass-collections") {
    throw new Error("Drop supplement input is not a supported Collections snapshot.");
  }
  if (
    manifest.schema?.sha256 !== schemaFile.sha256 ||
    manifest.schema?.bytes !== schemaFile.byteLength
  ) {
    throw new Error("Captured schema does not match the Collections manifest.");
  }
  const artifacts = new Map(
    (manifest.normalized?.artifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  assertArtifactBinding(artifacts.get("normalized/referenced_drop_ids.txt"), idsFile);
  assertArtifactBinding(artifacts.get("normalized/referenced_drops.ndjson"), dropsFile);

  const schema = await readJson(schemaPath);
  assertRelationSchema(schema?.data?.__schema);
  const dropIds = await readDropIds(idsPath);
  if (
    dropIds.length !== manifest.normalized?.referencedDropIds ||
    sha256(`${dropIds.join("\n")}\n`) !== manifest.normalized?.referencedDropIdsSha256
  ) {
    throw new Error("Referenced drop IDs do not match the Collections manifest.");
  }
  if (
    manifest.referencedDrops?.complete !== true ||
    manifest.referencedDrops?.captured !== dropIds.length ||
    (manifest.referencedDrops?.missing?.length ?? 0) !== 0
  ) {
    throw new Error("The source snapshot does not contain a complete referenced-drop capture.");
  }
  const drops = await readCanonicalDrops(dropsPath, dropIds);
  const binding = {
    endpoint: manifest.endpoint,
    manifest: manifestFile,
    schema: schemaFile,
    referencedDropIds: idsFile,
    referencedDrops: dropsFile,
    referencedDropCount: dropIds.length,
  };
  return {
    endpoint: manifest.endpoint,
    binding,
    bindingSha256: sha256(JSON.stringify(binding)),
    dropIds,
    drops,
  };
}

async function regularFileMetadata(root, path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(rootRealPath, fileRealPath);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} resolves outside its expected root.`);
  }
  return fileMetadata(root, path);
}

function assertArtifactBinding(artifact, actual) {
  if (!artifact || artifact.sha256 !== actual.sha256 || artifact.byteLength !== actual.byteLength) {
    throw new Error(`${actual.path} does not match its Collections manifest artifact.`);
  }
}

async function assertExistingManifestBinding(supplementRoot, context) {
  const path = resolve(supplementRoot, "manifest.json");
  if (!(await exists(path))) return;
  const prior = await readJson(path);
  if (sha256(JSON.stringify(prior.source)) !== context.bindingSha256) {
    throw new Error("Existing drop supplement is bound to another source snapshot.");
  }
}

function assertRelationSchema(schema) {
  if (!schema || !Array.isArray(schema.types)) {
    throw new Error("Captured GraphQL schema is invalid.");
  }
  const types = new Map(schema.types.map((type) => [type.name, type]));
  for (const [name, expected] of [
    ["drops_stats_by_chain", STATS_FIELDS],
    ["email_claims_stats", EMAIL_FIELDS],
    ["drops_featured_drops", FEATURED_FIELDS],
    ["drops_stats_moments", MOMENTS_FIELDS],
  ]) {
    const type = types.get(name);
    const actual = (type?.fields ?? [])
      .filter((field) => ["SCALAR", "ENUM"].includes(unwrapType(field.type)?.kind))
      .map((field) => field.name)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error(`${name} scalar fields differ from the reviewed drop supplement selection.`);
    }
  }
  const query = types.get(schema.queryType?.name ?? "query_root");
  if (!query?.fields?.some((entry) => entry.name === "drops")) {
    throw new Error("Captured GraphQL schema does not expose drops.");
  }
}

function unwrapType(type) {
  let current = type;
  while (current?.ofType) current = current.ofType;
  return current;
}

async function readDropIds(path) {
  const values = [];
  const text = await readFile(path, "utf8");
  for (const [index, raw] of text.split("\n").entries()) {
    const value = raw.trim();
    if (!value) continue;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`Invalid referenced drop ID on line ${index + 1}.`);
    }
    const id = Number(value);
    if (values.length > 0 && id <= values.at(-1)) {
      throw new Error("Referenced drop IDs are not strictly increasing.");
    }
    values.push(id);
  }
  return values;
}

async function readCanonicalDrops(path, expectedIds) {
  const rows = new Map();
  let prior = 0;
  for await (const row of readNdjson(path)) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= prior) {
      throw new Error("Referenced drops are not in strict numeric ID order.");
    }
    prior = id;
    rows.set(id, row);
  }
  if (rows.size !== expectedIds.length || expectedIds.some((id) => !rows.has(id))) {
    throw new Error("Referenced drops are not the exact referenced drop ID set.");
  }
  return rows;
}

async function writeQuery(supplementRoot) {
  const path = resolve(supplementRoot, "queries/referenced-drop-supplement.graphql");
  const contents = DROP_SUPPLEMENT_QUERY_FILE;
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    if ((await readFile(path, "utf8")) !== contents) {
      throw new Error("Stored drop supplement query differs from this exporter.");
    }
    return;
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.write(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function captureRelations({ supplementRoot, context, client, pageSize, onProgress }) {
  const querySha256 = sha256(DROP_SUPPLEMENT_QUERY);
  const queryFileSha256 = sha256(DROP_SUPPLEMENT_QUERY_FILE);
  const statePath = resolve(supplementRoot, "state/graphql.json");
  let state = (await exists(statePath)) ? await readJson(statePath) : null;
  const expectedState = {
    version: VERSION,
    dataset: "poap-compass-referenced-drop-relations",
    bindingSha256: context.bindingSha256,
    querySha256,
    pageSize,
    referencedDropCount: context.dropIds.length,
  };
  if (state) {
    for (const [key, value] of Object.entries(expectedState)) {
      if (state[key] !== value) throw new Error(`Drop relation checkpoint ${key} does not match.`);
    }
    await verifyRawArtifacts(supplementRoot, state.artifacts ?? []);
  } else {
    state = {
      ...expectedState,
      cursor: 0,
      pages: 0,
      artifacts: [],
      counts: { statsByChain: 0, emailClaimsStats: 0, featuredDrops: 0, momentsStats: 0 },
      complete: context.dropIds.length === 0,
      startedAt: new Date().toISOString(),
      finishedAt: context.dropIds.length === 0 ? new Date().toISOString() : null,
    };
    await writeJsonAtomic(statePath, state);
  }

  while (!state.complete) {
    const ids = context.dropIds.slice(state.cursor, state.cursor + pageSize);
    const variables = {
      dropIds: ids,
      dropLimit: ids.length,
    };
    const response = await client.request({
      query: DROP_SUPPLEMENT_QUERY,
      variables,
      operationName: "ReferencedDropSupplement",
    });
    const drops = response.body.data.drops;
    assertExactDropRows(ids, drops);
    const stats = [];
    for (const drop of drops) {
      if (!Array.isArray(drop.stats_by_chain)) {
        throw new Error(`Drop ${drop.id} stats_by_chain relation is invalid.`);
      }
      if (drop.stats_by_chain.length >= 100) {
        throw new Error(`Drop ${drop.id} reached the fixed stats_by_chain safety ceiling.`);
      }
      stats.push(...drop.stats_by_chain);
    }
    validateStatsRows(stats, new Set(ids));
    validateSmallRelations(drops);

    const page = state.pages + 1;
    const path = resolve(supplementRoot, `raw/${String(page).padStart(6, "0")}.json.gz`);
    const metadata = await writeGzipJsonAtomic(path, {
      version: VERSION,
      dataset: "poap-compass-referenced-drop-relations",
      page,
      fetchedAt: new Date().toISOString(),
      querySha256,
      variables,
      status: response.status,
      headers: response.headers,
      response: response.body,
      operationName: "ReferencedDropSupplement",
      query: "queries/referenced-drop-supplement.graphql",
    });
    const pageCounts = relationCounts(drops, stats);
    state.cursor += ids.length;
    state.pages = page;
    for (const [name, count] of Object.entries(pageCounts)) state.counts[name] += count;
    state.artifacts.push({
      path: relative(supplementRoot, path).replaceAll("\\", "/"),
      ...metadata,
      firstDropId: ids[0],
      lastDropId: ids.at(-1),
      requested: ids.length,
      counts: pageCounts,
    });
    if (state.cursor === context.dropIds.length) {
      state.complete = true;
      state.finishedAt = new Date().toISOString();
    }
    await writeJsonAtomic(statePath, state);
    onProgress({ entity: "drop_relations", rows: state.cursor, pages: state.pages });
  }

  const normalized = await normalizeRelations(supplementRoot, state);
  for (const [name, count] of Object.entries(state.counts)) {
    if (normalized.counts[name] !== count) {
      throw new Error(`Normalized ${name} count differs from the GraphQL checkpoint.`);
    }
  }
  return {
    query: "queries/referenced-drop-supplement.graphql",
    querySha256,
    queryFileSha256,
    pageSize,
    referencedDrops: context.dropIds.length,
    pages: state.pages,
    counts: normalized.counts,
    artifacts: normalized.artifacts,
    rawArtifacts: state.artifacts,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    complete: state.complete,
  };
}

async function verifyRawArtifacts(root, artifacts) {
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.path !== `raw/${String(index + 1).padStart(6, "0")}.json.gz`) {
      throw new Error("Drop relation checkpoint has a non-canonical raw page path.");
    }
    const path = safePath(root, artifact.path);
    const metadata = await regularFileMetadata(root, path, "drop relation raw page");
    if (metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.byteLength) {
      throw new Error(`Drop relation raw page checksum mismatch: ${artifact.path}.`);
    }
  }
}

function assertExactDropRows(ids, rows) {
  if (!Array.isArray(rows) || rows.length !== ids.length) {
    throw new Error("Drop supplement did not return every requested referenced drop.");
  }
  for (let index = 0; index < ids.length; index += 1) {
    if (Number(rows[index]?.id) !== ids[index]) {
      throw new Error("Drop supplement response IDs are incomplete or out of order.");
    }
  }
}

function validateStatsRows(rows, requested) {
  let prior = null;
  const seen = new Set();
  for (const row of rows) {
    const dropId = Number(row.drop_id);
    if (!requested.has(dropId) || typeof row.chain !== "string" || row.chain.length === 0) {
      throw new Error("Drop stats row has an invalid drop_id/chain identity.");
    }
    const key = `${dropId}\u0000${row.chain}`;
    if (seen.has(key)) throw new Error("Drop stats response contains a duplicate identity.");
    if (prior && compareStatsIdentity(prior, row) >= 0) {
      throw new Error("Drop stats response is not in canonical identity order.");
    }
    seen.add(key);
    prior = row;
  }
}

function validateSmallRelations(drops) {
  for (const drop of drops) {
    for (const [field, fields] of [
      ["email_claims_stats", EMAIL_FIELDS],
      ["featured_drop", FEATURED_FIELDS],
      ["moments_stats", MOMENTS_FIELDS],
    ]) {
      const row = drop[field];
      if (row === null) continue;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Drop ${drop.id} ${field} relation is invalid.`);
      }
      if (Number(row.drop_id) !== Number(drop.id)) {
        throw new Error(`Drop ${drop.id} ${field} relation points to another drop.`);
      }
      const actualFields = Object.keys(row).sort();
      if (JSON.stringify(actualFields) !== JSON.stringify([...fields].sort())) {
        throw new Error(`Drop ${drop.id} ${field} does not contain the reviewed scalar fields.`);
      }
    }
  }
}

function relationCounts(drops, stats) {
  return {
    statsByChain: stats.length,
    emailClaimsStats: drops.filter((drop) => drop.email_claims_stats !== null).length,
    featuredDrops: drops.filter((drop) => drop.featured_drop !== null).length,
    momentsStats: drops.filter((drop) => drop.moments_stats !== null).length,
  };
}

async function normalizeRelations(supplementRoot, state) {
  const rows = {
    statsByChain: [],
    emailClaimsStats: [],
    featuredDrops: [],
    momentsStats: [],
  };
  for (const artifact of state.artifacts) {
    const page = await readGzipJson(safePath(supplementRoot, artifact.path));
    const drops = page.response?.data?.drops;
    if (!Array.isArray(drops)) {
      throw new Error(`Stored drop relation response is invalid: ${artifact.path}.`);
    }
    const stats = drops.flatMap((drop) => drop.stats_by_chain ?? []);
    rows.statsByChain.push(...stats);
    for (const drop of drops) {
      if (drop.email_claims_stats) rows.emailClaimsStats.push(drop.email_claims_stats);
      if (drop.featured_drop) rows.featuredDrops.push(drop.featured_drop);
      if (drop.moments_stats) rows.momentsStats.push(drop.moments_stats);
    }
  }
  rows.statsByChain.sort(compareStatsIdentity);
  for (const name of ["emailClaimsStats", "featuredDrops", "momentsStats"]) {
    rows[name].sort((left, right) => Number(left.drop_id) - Number(right.drop_id));
  }
  const definitions = [
    ["statsByChain", "drop_stats_by_chain"],
    ["emailClaimsStats", "email_claims_stats"],
    ["featuredDrops", "featured_drops"],
    ["momentsStats", "moments_stats"],
  ];
  const artifacts = [];
  for (const [name, fileName] of definitions) {
    const path = resolve(supplementRoot, `normalized/${fileName}.ndjson`);
    artifacts.push(await writeNdjsonAtomic(supplementRoot, path, rows[name]));
  }
  return {
    artifacts,
    counts: Object.fromEntries(definitions.map(([name]) => [name, rows[name].length])),
  };
}

function compareStatsIdentity(left, right) {
  return (
    Number(left.drop_id) - Number(right.drop_id) ||
    String(left.chain).localeCompare(String(right.chain), "en")
  );
}

async function inspectArchiveCatalog({ path, snapshotId, dropIds }) {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Archive catalog SQLite must be a regular file.");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(absolute, { readOnly: true });
  const rows = new Map();
  try {
    database.exec("PRAGMA query_only = ON;");
    const actualSnapshot = database
      .prepare("SELECT value FROM archive_meta WHERE key = 'snapshot_id' LIMIT 1")
      .get()?.value;
    if (actualSnapshot !== snapshotId) {
      throw new Error("Archive catalog snapshot_id does not match --archive-snapshot-id.");
    }
    const columns = database
      .prepare("PRAGMA table_info('drops')")
      .all()
      .map((row) => row.name);
    for (const name of ["drop_id", "token_count", "has_artwork"]) {
      if (!columns.includes(name))
        throw new Error(`Archive catalog drops table is missing ${name}.`);
    }
    for (let offset = 0; offset < dropIds.length; offset += 100) {
      const ids = dropIds.slice(offset, offset + 100);
      const placeholders = ids.map(() => "?").join(", ");
      const found = database
        .prepare(
          `SELECT drop_id, token_count, has_artwork FROM drops WHERE drop_id IN (${placeholders}) ORDER BY drop_id`,
        )
        .all(...ids);
      for (const row of found) {
        const dropId = Number(row.drop_id);
        const tokenCount = Number(row.token_count);
        const hasArtwork = Number(row.has_artwork);
        if (
          !Number.isSafeInteger(dropId) ||
          !Number.isSafeInteger(tokenCount) ||
          tokenCount < 0 ||
          ![0, 1].includes(hasArtwork)
        ) {
          throw new Error("Archive catalog returned invalid drop projection data.");
        }
        rows.set(dropId, {
          dropId,
          tokenCount,
          hasArtwork: hasArtwork === 1,
        });
      }
    }
  } finally {
    database.close();
  }
  const metadata = await sha256File(absolute);
  return {
    rows,
    report: {
      used: true,
      path: basename(absolute),
      snapshotId,
      ...metadata,
      matchedDrops: rows.size,
      catalogArtworkFlags: [...rows.values()].filter((row) => row.hasArtwork).length,
    },
  };
}

function emptyCatalog() {
  return { rows: new Map(), report: { used: false, matchedDrops: 0, catalogArtworkFlags: 0 } };
}

async function inspectArchiveMedia({
  manifestPath,
  reportPath,
  checkpointPath,
  snapshotId,
  supplementRoot,
}) {
  const manifestAbsolute = resolve(manifestPath);
  const reportAbsolute = resolve(reportPath);
  const checkpointAbsolute = resolve(checkpointPath);
  const [manifestStat, reportStat, checkpointStat] = await Promise.all([
    lstat(manifestAbsolute),
    lstat(reportAbsolute),
    lstat(checkpointAbsolute),
  ]);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    !reportStat.isFile() ||
    reportStat.isSymbolicLink() ||
    !checkpointStat.isFile() ||
    checkpointStat.isSymbolicLink()
  ) {
    throw new Error("Archive media manifest, upload report, and checkpoint must be regular files.");
  }
  const [manifestMetadata, reportMetadata, checkpointMetadata, report] = await Promise.all([
    sha256File(manifestAbsolute),
    sha256File(reportAbsolute),
    sha256File(checkpointAbsolute),
    readJson(reportAbsolute),
  ]);
  if (
    report.version !== 1 ||
    report.ok !== true ||
    report.complete !== true ||
    report.publishable !== true ||
    report.snapshotId !== snapshotId ||
    report.target?.snapshotId !== snapshotId ||
    report.stopReason !== null ||
    report.fatalFailure !== null ||
    (report.failures?.length ?? 0) !== 0 ||
    Number(report.counts?.failed) !== 0
  ) {
    throw new Error("Archive media upload report is not a complete publishable release.");
  }
  if (
    report.source?.kind !== "local" ||
    !Number.isSafeInteger(report.source?.actualByteLength) ||
    report.source.actualByteLength <= 0 ||
    !SHA256.test(report.source?.sha256 ?? "") ||
    report.validations?.sourceComplete !== true ||
    report.validations?.sourceByteLength?.checked !== true ||
    report.validations.sourceByteLength.matches !== true ||
    report.validations.sourceByteLength.actual !== report.source.actualByteLength ||
    report.validations.sourceByteLength.expected !== report.source.advertisedByteLength ||
    report.validations?.sourceSha256?.checked !== true ||
    report.validations.sourceSha256.matches !== true ||
    report.validations.sourceSha256.actual !== report.source.sha256 ||
    report.validations.sourceSha256.expected !== report.source.sha256 ||
    report.validations?.artworkCount?.checked !== true ||
    report.validations.artworkCount.matches !== true ||
    report.validations.artworkCount.actual !== report.manifest?.rows ||
    report.validations.artworkCount.expected !== report.manifest?.rows
  ) {
    throw new Error("Archive media upload report is not bound to a verified source archive.");
  }
  if (
    report.manifest?.sha256 !== manifestMetadata.sha256 ||
    Number(report.manifest?.byteLength) !== manifestMetadata.byteLength ||
    !Number.isSafeInteger(report.manifest?.rows) ||
    report.manifest.rows < 0 ||
    report.manifest.eligible !== report.manifest.rows ||
    report.manifest.ineligible !== 0
  ) {
    throw new Error("Archive upload report is not bound to the supplied media manifest.");
  }
  const accounted =
    Number(report.counts?.uploaded ?? 0) +
    Number(report.counts?.reused ?? 0) +
    Number(report.counts?.checkpointSkipped ?? 0);
  if (accounted !== report.manifest.eligible) {
    throw new Error("Archive upload report does not account for every eligible media object.");
  }

  const rows = new Map();
  let lineCount = 0;
  for await (const row of readNdjson(manifestAbsolute)) {
    lineCount += 1;
    const dropId = Number(row.dropId);
    const expectedKey = `snapshots/${snapshotId}/artwork/${dropId}.webp`;
    if (
      row.snapshotId !== snapshotId ||
      !Number.isSafeInteger(dropId) ||
      dropId <= 0 ||
      row.eligibleForPublish !== true ||
      row.object?.key !== expectedKey ||
      row.object?.contentType !== "image/webp" ||
      row.object?.cacheControl !== report.target?.cacheControl ||
      rows.has(dropId)
    ) {
      throw new Error(`Archive media manifest row ${lineCount} is invalid or duplicated.`);
    }
    rows.set(dropId, {
      dropId,
      objectKey: expectedKey,
      contentType: row.object.contentType,
      cacheControl: row.object.cacheControl ?? report.target.cacheControl,
    });
  }
  if (lineCount !== report.manifest.rows) {
    throw new Error("Archive media manifest row count differs from its upload report.");
  }
  const checkpoint = await inspectArchiveUploadCheckpoint({
    path: checkpointAbsolute,
    snapshotId,
    report,
    manifestMetadata,
    manifestRows: rows,
  });
  for (const [dropId, row] of rows) {
    const proof = checkpoint.objects.get(row.objectKey);
    rows.set(dropId, {
      ...row,
      byteLength: proof.byteLength,
      sha256: proof.sha256,
      disposition: proof.disposition,
      etag: proof.etag ?? null,
    });
  }
  const provenance = await preserveArchiveProvenance({
    supplementRoot,
    manifestAbsolute,
    reportAbsolute,
    checkpointAbsolute,
    manifestMetadata,
    reportMetadata,
    checkpointMetadata,
    manifestRows: lineCount,
    checkpointRows: checkpoint.rows,
  });
  return {
    rows,
    report: {
      used: true,
      snapshotId,
      manifest: provenance.manifest,
      uploadReport: provenance.uploadReport,
      uploadCheckpoint: { ...provenance.uploadCheckpoint, objects: checkpoint.objects.size },
      artifacts: provenance.artifacts,
      sourceArchive: {
        label: report.source.label ?? null,
        byteLength: report.source.actualByteLength,
        sha256: report.source.sha256,
      },
      targetBucket: report.target?.bucket ?? null,
      verifiedPublishedObjects: rows.size,
      publishable: true,
    },
  };
}

async function preserveArchiveProvenance({
  supplementRoot,
  manifestAbsolute,
  reportAbsolute,
  checkpointAbsolute,
  manifestMetadata,
  reportMetadata,
  checkpointMetadata,
  manifestRows,
  checkpointRows,
}) {
  const definitions = [
    {
      name: "manifest",
      source: manifestAbsolute,
      destination: "provenance/archive/artwork-manifest.ndjson",
      metadata: manifestMetadata,
      rows: manifestRows,
    },
    {
      name: "uploadReport",
      source: reportAbsolute,
      destination: "provenance/archive/upload-report.json",
      metadata: reportMetadata,
      rows: 1,
    },
    {
      name: "uploadCheckpoint",
      source: checkpointAbsolute,
      destination: "provenance/archive/upload-checkpoint.jsonl",
      metadata: checkpointMetadata,
      rows: checkpointRows,
    },
  ];
  const values = {};
  for (const definition of definitions) {
    const path = resolve(supplementRoot, definition.destination);
    const artifact = await copyProvenanceFileAtomic({
      supplementRoot,
      source: definition.source,
      destination: path,
      expected: definition.metadata,
      label: `archive provenance ${definition.name}`,
    });
    values[definition.name] = { ...artifact, rows: definition.rows };
  }
  return {
    ...values,
    artifacts: definitions.map((definition) => values[definition.name]),
  };
}

async function copyProvenanceFileAtomic({ supplementRoot, source, destination, expected, label }) {
  if (await exists(destination)) {
    const existing = await regularFileMetadata(supplementRoot, destination, label);
    if (existing.sha256 !== expected.sha256 || existing.byteLength !== expected.byteLength) {
      throw new Error(`${label} differs from the previously preserved file.`);
    }
    return existing;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    const copied = await sha256File(temporary);
    if (copied.sha256 !== expected.sha256 || copied.byteLength !== expected.byteLength) {
      throw new Error(`${label} changed while it was copied.`);
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return regularFileMetadata(supplementRoot, destination, label);
}

async function inspectArchiveUploadCheckpoint({
  path,
  snapshotId,
  report,
  manifestMetadata,
  manifestRows,
}) {
  let header = null;
  let rows = 0;
  const objects = new Map();
  for await (const row of readNdjson(path)) {
    rows += 1;
    if (rows === 1) {
      header = row;
      const expected = {
        kind: "header",
        version: 1,
        snapshotId,
        archiveSha256: report.source.sha256,
        manifestSha256: manifestMetadata.sha256,
        endpoint: report.target.endpoint,
        bucket: report.target.bucket,
        cacheControl: report.target.cacheControl,
        objectPrefix: `snapshots/${snapshotId}/artwork/`,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (header?.[key] !== value) {
          throw new Error(`Archive upload checkpoint header ${key} does not match.`);
        }
      }
      continue;
    }
    if (
      row.kind !== "object" ||
      row.version !== 1 ||
      typeof row.key !== "string" ||
      !Number.isSafeInteger(row.byteLength) ||
      row.byteLength <= 0 ||
      !SHA256.test(row.sha256 ?? "") ||
      !["uploaded", "reused"].includes(row.disposition) ||
      objects.has(row.key)
    ) {
      throw new Error(`Archive upload checkpoint object row ${rows} is invalid or duplicated.`);
    }
    objects.set(row.key, row);
  }
  if (!header) throw new Error("Archive upload checkpoint is empty.");
  const manifestKeys = new Set([...manifestRows.values()].map((row) => row.objectKey));
  if (
    objects.size !== manifestKeys.size ||
    [...objects.keys()].some((key) => !manifestKeys.has(key)) ||
    [...manifestKeys].some((key) => !objects.has(key))
  ) {
    throw new Error(
      "Archive upload checkpoint does not prove every eligible manifest key exactly once.",
    );
  }
  return { rows, objects };
}

function emptyArchiveMedia() {
  return { rows: new Map(), report: { used: false, verifiedPublishedObjects: 0 } };
}

async function captureArtwork({
  supplementRoot,
  context,
  catalog,
  archiveMedia,
  concurrency,
  maximumBytes,
  retryFailures,
  onProgress,
  fetchImpl,
  lookup,
}) {
  const catalogRows = [...catalog.rows.values()].sort((left, right) => left.dropId - right.dropId);
  const catalogArtifact = await writeNdjsonAtomic(
    supplementRoot,
    resolve(supplementRoot, "normalized/archive_catalog.ndjson"),
    catalogRows,
  );
  const plan = context.dropIds.map((dropId) => {
    const drop = context.drops.get(dropId);
    const catalogRow = catalog.rows.get(dropId);
    const archivedObject = archiveMedia.rows.get(dropId);
    return {
      id: String(dropId),
      dropId,
      reuseObjectKey: archivedObject?.objectKey ?? null,
      archiveTokenCount: catalogRow?.tokenCount ?? null,
      candidates: artworkCandidates(drop),
    };
  });
  const planPath = resolve(supplementRoot, "artwork/plan.ndjson");
  const planSource = canonicalJsonLines(plan);
  const planSha256 = sha256(planSource);
  await writeImmutablePlan(planPath, planSource, planSha256);

  const checkpointPath = resolve(supplementRoot, "artwork/checkpoint.ndjson");
  const checkpoint = await readArtworkCheckpoint(
    checkpointPath,
    {
      bindingSha256: context.bindingSha256,
      planSha256,
      archiveCatalogSha256: catalog.report.sha256 ?? null,
      archiveMediaManifestSha256: archiveMedia.report.manifest?.sha256 ?? null,
      archiveUploadReportSha256: archiveMedia.report.uploadReport?.sha256 ?? null,
      archiveSnapshotId: archiveMedia.report.snapshotId ?? catalog.report.snapshotId ?? null,
    },
    supplementRoot,
  );
  if (!checkpoint.header) {
    await appendJsonLine(checkpointPath, {
      kind: "header",
      version: VERSION,
      dataset: "poap-compass-referenced-drop-artwork",
      bindingSha256: context.bindingSha256,
      planSha256,
      archiveCatalogSha256: catalog.report.sha256 ?? null,
      archiveMediaManifestSha256: archiveMedia.report.manifest?.sha256 ?? null,
      archiveUploadReportSha256: archiveMedia.report.uploadReport?.sha256 ?? null,
      archiveSnapshotId: archiveMedia.report.snapshotId ?? catalog.report.snapshotId ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  const downloadable = plan.filter((entry) => !entry.reuseObjectKey);
  const pending = downloadable.filter((entry) => {
    const prior = checkpoint.records.get(entry.id);
    if (!prior) return true;
    if (prior.status === "quarantined" && !isCompleteQuarantineRecord(prior)) {
      if (isLegacyEvidenceQuarantine(prior) && hasAllowlistedCandidate(entry)) return true;
      throw new Error(
        `Drop artwork checkpoint has incomplete quarantine evidence for ${entry.id}.`,
      );
    }
    return retryFailures && ["failed", "missing"].includes(prior.status);
  });
  let handled = plan.length - pending.length;
  const writer = new SerializedRecordWriter(checkpointPath);
  await runPool(pending, concurrency, async (entry) => {
    let record;
    try {
      record = await downloadArtwork({
        supplementRoot,
        entry,
        maximumBytes,
        fetchImpl,
        lookup,
      });
    } catch (error) {
      record = {
        id: entry.id,
        dropId: entry.dropId,
        status: isQuarantineError(error.code) ? "quarantined" : "failed",
        eligibleForPublish: false,
        failureCode: error.code ?? "ARTWORK_DOWNLOAD_FAILED",
        failureReason: error.message,
        attempts: error.attempts ?? [],
        completedAt: new Date().toISOString(),
      };
    }
    await writer.record(record);
    checkpoint.records.set(entry.id, record);
    handled += 1;
    onProgress({ entity: "drop_artwork", rows: handled, pages: plan.length });
  });
  await writer.close();

  const records = plan.map((entry) => {
    if (entry.reuseObjectKey) {
      const proof = archiveMedia.rows.get(entry.dropId);
      return {
        id: entry.id,
        dropId: entry.dropId,
        status: "reused",
        eligibleForPublish: true,
        objectKey: entry.reuseObjectKey,
        sha256: proof.sha256,
        byteLength: proof.byteLength,
        contentType: proof.contentType,
        cacheControl: proof.cacheControl,
        disposition: proof.disposition,
        etag: proof.etag,
        tokenCount: entry.archiveTokenCount,
        archiveSnapshotId: archiveMedia.report.snapshotId,
      };
    }
    return (
      checkpoint.records.get(entry.id) ?? {
        id: entry.id,
        dropId: entry.dropId,
        status: "pending",
        eligibleForPublish: false,
      }
    );
  });
  const recordsArtifact = await writeNdjsonAtomic(
    supplementRoot,
    resolve(supplementRoot, "artwork/references.ndjson"),
    records,
  );
  const counts = { reused: 0, downloaded: 0, quarantined: 0, failed: 0, missing: 0, pending: 0 };
  for (const record of records) {
    if (record.status === "stored") counts.downloaded += 1;
    else if (record.status in counts) counts[record.status] += 1;
    else throw new Error(`Unexpected drop artwork status: ${record.status}.`);
  }
  const complete = counts.pending === 0 && counts.failed === 0 && counts.missing === 0;
  return {
    references: plan.length,
    plan: { path: relative(supplementRoot, planPath).replaceAll("\\", "/"), sha256: planSha256 },
    checkpoint: relative(supplementRoot, checkpointPath).replaceAll("\\", "/"),
    artifacts: [catalogArtifact, recordsArtifact],
    counts,
    uniqueDownloadedObjects: new Set(
      records.filter((record) => record.status === "stored").map((record) => record.sha256),
    ).size,
    uniqueQuarantinedObjects: new Set(
      records
        .filter((record) => record.status === "quarantined" && record.quarantinePath)
        .map((record) => record.sha256),
    ).size,
    attemptedAll: counts.pending === 0,
    complete,
    publishable: complete,
    quarantinedReferencesAreExcluded: true,
  };
}

function artworkCandidates(drop) {
  const candidates = [];
  for (const gateway of drop.drop_image?.gateways ?? []) {
    if (gateway?.type === "ORIGINAL" && typeof gateway.url === "string") {
      candidates.push({
        kind: "gateway-original",
        url: gateway.url,
        gatewayId: gateway.id ?? null,
      });
    }
  }
  if (typeof drop.image_url === "string" && drop.image_url.length > 0) {
    candidates.push({ kind: "drop-image-url", url: drop.image_url, gatewayId: null });
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

async function writeImmutablePlan(path, source, digest) {
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    const current = await readFile(path, "utf8");
    if (sha256(current) !== digest || current !== source) {
      throw new Error("Existing drop artwork plan differs from the bound source snapshot.");
    }
    return;
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.write(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readArtworkCheckpoint(path, expected, root) {
  if (!(await exists(path))) return { header: null, records: new Map() };
  const records = new Map();
  let header = null;
  const lines = (await readFile(path, "utf8")).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Drop artwork checkpoint has invalid JSON on line ${index + 1}.`);
    }
    if (!header) {
      header = row;
      if (row.kind !== "header" || row.version !== VERSION) {
        throw new Error("Drop artwork checkpoint header is invalid.");
      }
      for (const [key, value] of Object.entries(expected)) {
        if (row[key] !== value) throw new Error(`Drop artwork checkpoint ${key} does not match.`);
      }
      continue;
    }
    if (
      row.kind !== "reference" ||
      typeof row.id !== "string" ||
      !Number.isSafeInteger(row.dropId)
    ) {
      throw new Error(`Drop artwork checkpoint record is invalid on line ${index + 1}.`);
    }
    records.set(row.id, row);
  }
  for (const row of records.values()) {
    if (row.status === "stored") await verifyStoredArtwork(root, row);
    if (row.status === "quarantined" && row.quarantinePath) {
      await verifyQuarantinedArtwork(root, row);
    }
  }
  return { header, records };
}

async function verifyStoredArtwork(root, record) {
  if (!SHA256.test(record.sha256 ?? "") || typeof record.objectPath !== "string") {
    throw new Error(`Stored drop artwork ${record.id} has invalid object metadata.`);
  }
  const path = safePath(root, record.objectPath);
  const metadata = await regularFileMetadata(root, path, `stored drop artwork ${record.id}`);
  if (metadata.sha256 !== record.sha256 || metadata.byteLength !== record.byteLength) {
    throw new Error(`Stored drop artwork checksum mismatch for ${record.id}.`);
  }
}

async function verifyQuarantinedArtwork(root, record) {
  if (!SHA256.test(record.sha256 ?? "") || typeof record.quarantinePath !== "string") {
    throw new Error(`Quarantined drop artwork ${record.id} has invalid object metadata.`);
  }
  const path = safePath(root, record.quarantinePath);
  const metadata = await regularFileMetadata(root, path, `quarantined drop artwork ${record.id}`);
  if (metadata.sha256 !== record.sha256 || metadata.byteLength !== record.byteLength) {
    throw new Error(`Quarantined drop artwork checksum mismatch for ${record.id}.`);
  }
}

function isCompleteQuarantineRecord(record) {
  if (
    ["INVALID_SOURCE_URL", "PRIVATE_NETWORK_TARGET", "SOURCE_HOST_NOT_ALLOWED"].includes(
      record.failureCode,
    )
  ) {
    return true;
  }
  if (record.failureCode === "EMPTY_MEDIA") {
    return (
      record.byteLength === 0 &&
      record.quarantinePath === null &&
      SHA256.test(record.sha256 ?? "") &&
      Number.isSafeInteger(record.httpStatus)
    );
  }
  if (["CONTENT_TYPE_MISMATCH", "UNSUPPORTED_MEDIA"].includes(record.failureCode)) {
    return (
      record.byteLength > 0 &&
      SHA256.test(record.sha256 ?? "") &&
      typeof record.quarantinePath === "string"
    );
  }
  return true;
}

function isLegacyEvidenceQuarantine(record) {
  return ["CONTENT_TYPE_MISMATCH", "EMPTY_MEDIA", "UNSUPPORTED_MEDIA"].includes(record.failureCode);
}

function hasAllowlistedCandidate(entry) {
  return entry.candidates.some((candidate) => mediaInternals.resolveSourceUrl(candidate.url).ok);
}

async function downloadArtwork({ supplementRoot, entry, maximumBytes, fetchImpl, lookup }) {
  if (entry.candidates.length === 0) {
    return {
      id: entry.id,
      dropId: entry.dropId,
      status: "missing",
      eligibleForPublish: false,
      failureCode: "NO_SOURCE_URL",
      failureReason: "Referenced drop has no original gateway or image_url.",
      completedAt: new Date().toISOString(),
    };
  }
  const attempts = [];
  let finalError = null;
  for (const candidate of entry.candidates) {
    try {
      const result = await downloadCandidate({
        supplementRoot,
        entry,
        candidate,
        maximumBytes,
        fetchImpl,
        lookup,
      });
      if (result.status === "missing") {
        attempts.push({ kind: candidate.kind, url: candidate.url, status: "missing" });
        continue;
      }
      return { ...result, attempts };
    } catch (error) {
      finalError = error;
      attempts.push({
        kind: candidate.kind,
        url: candidate.url,
        status: isQuarantineError(error.code) ? "quarantined" : "failed",
        failureCode: error.code ?? "ARTWORK_DOWNLOAD_FAILED",
        failureReason: error.message,
      });
    }
  }
  if (finalError) {
    const error = mediaError(finalError.message, finalError.code ?? "ARTWORK_DOWNLOAD_FAILED");
    error.attempts = attempts;
    throw error;
  }
  return {
    id: entry.id,
    dropId: entry.dropId,
    status: "missing",
    eligibleForPublish: false,
    attempts,
    failureCode: "ALL_SOURCES_MISSING",
    failureReason: "All referenced artwork sources returned missing.",
    completedAt: new Date().toISOString(),
  };
}

async function downloadCandidate({
  supplementRoot,
  entry,
  candidate,
  maximumBytes,
  fetchImpl,
  lookup,
}) {
  let resolved = mediaInternals.resolveSourceUrl(candidate.url);
  if (!resolved.ok) throw mediaError(resolved.reason, resolved.code);
  let current = resolved.url;
  const redirectChain = [];
  let response;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await validateNetworkTarget(current, lookup);
    response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "image/*", "user-agent": USER_AGENT },
    });
    redirectChain.push({ url: current.toString(), status: response.status });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location)
      throw mediaError("Redirect response did not include Location.", "INVALID_REDIRECT");
    resolved = mediaInternals.resolveSourceUrl(new URL(location, current).toString());
    if (!resolved.ok) throw mediaError(resolved.reason, resolved.code);
    current = resolved.url;
    if (redirect === MAX_REDIRECTS) {
      throw mediaError("Media exceeded the redirect limit.", "TOO_MANY_REDIRECTS");
    }
  }
  if (response.status === 404 || response.status === 410) {
    return { status: "missing", httpStatus: response.status };
  }
  if (!response.ok || !response.body) {
    throw mediaError(`Media returned HTTP ${response.status}.`, "HTTP_ERROR");
  }
  const advertisedLength = parseContentLength(response.headers.get("content-length"));
  if (advertisedLength !== null && advertisedLength > maximumBytes) {
    throw mediaError(`Media exceeds the ${maximumBytes} byte limit.`, "MEDIA_TOO_LARGE");
  }

  const temporary = resolve(
    supplementRoot,
    `artwork/tmp/${entry.dropId}-${process.pid}-${Date.now()}.part`,
  );
  await mkdir(dirname(temporary), { recursive: true });
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        throw mediaError(`Media exceeded the ${maximumBytes} byte limit.`, "MEDIA_TOO_LARGE");
      }
      if (prefix.byteLength < 512) {
        prefix = Buffer.concat([prefix, Buffer.from(chunk)]).subarray(0, 512);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const digest = hash.digest("hex");
  if (byteLength === 0) {
    await rm(temporary, { force: true });
    return {
      ...downloadEvidence({ entry, candidate, current, redirectChain, response, contentType }),
      status: "quarantined",
      eligibleForPublish: false,
      failureCode: "EMPTY_MEDIA",
      failureReason: "Media response was empty.",
      advertisedByteLength: advertisedLength,
      byteLength: 0,
      sha256: digest,
      detectedContentType: null,
      quarantinePath: null,
      completedAt: new Date().toISOString(),
    };
  }
  const detected = mediaInternals.detectImage(prefix);
  if (!detected) {
    const quarantinePath = await preserveQuarantinedBytes({
      supplementRoot,
      temporary,
      digest,
      byteLength,
      dropId: entry.dropId,
    });
    return {
      ...downloadEvidence({ entry, candidate, current, redirectChain, response, contentType }),
      status: "quarantined",
      eligibleForPublish: false,
      failureCode: "UNSUPPORTED_MEDIA",
      failureReason: "Media bytes were not a supported image format.",
      advertisedByteLength: advertisedLength,
      byteLength,
      sha256: digest,
      detectedContentType: null,
      quarantinePath,
      completedAt: new Date().toISOString(),
    };
  }
  if (
    contentType &&
    contentType !== "application/octet-stream" &&
    !contentType.startsWith("image/")
  ) {
    const quarantinePath = await preserveQuarantinedBytes({
      supplementRoot,
      temporary,
      digest,
      byteLength,
      dropId: entry.dropId,
    });
    return {
      ...downloadEvidence({ entry, candidate, current, redirectChain, response, contentType }),
      status: "quarantined",
      eligibleForPublish: false,
      failureCode: "CONTENT_TYPE_MISMATCH",
      failureReason: `Media Content-Type was ${contentType}.`,
      advertisedByteLength: advertisedLength,
      byteLength,
      sha256: digest,
      detectedContentType: detected.contentType,
      quarantinePath,
      completedAt: new Date().toISOString(),
    };
  }
  const objectPath = resolve(
    supplementRoot,
    `artwork/objects/sha256/${digest.slice(0, 2)}/${digest}.${detected.extension}`,
  );
  await mkdir(dirname(objectPath), { recursive: true });
  if (await exists(objectPath)) {
    const existing = await regularFileMetadata(
      supplementRoot,
      objectPath,
      `content-addressed drop artwork ${entry.dropId}`,
    );
    if (existing.sha256 !== digest || existing.byteLength !== byteLength) {
      await rm(temporary, { force: true });
      throw mediaError(
        "Existing content-addressed artwork failed verification.",
        "OBJECT_TAMPERED",
      );
    }
    await rm(temporary, { force: true });
  } else {
    await rename(temporary, objectPath);
  }
  return {
    id: entry.id,
    dropId: entry.dropId,
    sourceKind: candidate.kind,
    sourceUrl: candidate.url,
    resolvedSourceUrl: current.toString(),
    redirectChain,
    status: "stored",
    eligibleForPublish: true,
    httpStatus: response.status,
    contentType: detected.contentType,
    advertisedContentType: contentType || null,
    advertisedByteLength: advertisedLength,
    byteLength,
    sha256: digest,
    extension: detected.extension,
    objectPath: relative(supplementRoot, objectPath).replaceAll("\\", "/"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    completedAt: new Date().toISOString(),
  };
}

function downloadEvidence({ entry, candidate, current, redirectChain, response, contentType }) {
  return {
    id: entry.id,
    dropId: entry.dropId,
    sourceKind: candidate.kind,
    sourceUrl: candidate.url,
    resolvedSourceUrl: current.toString(),
    redirectChain,
    httpStatus: response.status,
    advertisedContentType: contentType || null,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function preserveQuarantinedBytes({ supplementRoot, temporary, digest, byteLength, dropId }) {
  const path = resolve(
    supplementRoot,
    `artwork/quarantine/sha256/${digest.slice(0, 2)}/${digest}.bin`,
  );
  await commitContentAddressedFile({
    supplementRoot,
    temporary,
    path,
    digest,
    byteLength,
    label: `content-addressed quarantined artwork ${dropId}`,
  });
  return relative(supplementRoot, path).replaceAll("\\", "/");
}

async function commitContentAddressedFile({
  supplementRoot,
  temporary,
  path,
  digest,
  byteLength,
  label,
}) {
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    const existing = await regularFileMetadata(supplementRoot, path, label);
    if (existing.sha256 !== digest || existing.byteLength !== byteLength) {
      await rm(temporary, { force: true });
      throw mediaError("Existing content-addressed object failed verification.", "OBJECT_TAMPERED");
    }
    await rm(temporary, { force: true });
  } else {
    await rename(temporary, path);
  }
}

async function validateNetworkTarget(url, lookup) {
  const reviewed = mediaInternals.resolveSourceUrl(url.toString());
  if (!reviewed.ok || reviewed.url.toString() !== url.toString()) {
    throw mediaError(
      "Redirect target is not an allowlisted HTTPS host.",
      "SOURCE_HOST_NOT_ALLOWED",
    );
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => mediaInternals.isPrivateAddress(entry.address))
  ) {
    throw mediaError(
      "Media host resolved to a private or invalid address.",
      "PRIVATE_NETWORK_TARGET",
    );
  }
}

class SerializedRecordWriter {
  constructor(path) {
    this.path = path;
    this.chain = Promise.resolve();
  }

  async record(record) {
    this.chain = this.chain.then(() =>
      appendJsonLine(this.path, { kind: "reference", version: VERSION, ...record }),
    );
    await this.chain;
  }

  async close() {
    await this.chain;
  }
}

async function runPool(values, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

async function writeNdjsonAtomic(root, path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    for (const row of rows) await handle.write(`${JSON.stringify(row)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return { ...(await fileMetadata(root, path)), rows: rows.length };
}

async function* readNdjson(path) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid NDJSON in ${path}: ${error.message}`);
    }
  }
}

function canonicalJsonLines(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function safePath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe drop supplement path: ${relativePath}.`);
  }
  const absolute = resolve(root, relativePath);
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Drop supplement path escapes its root: ${relativePath}.`);
  }
  return absolute;
}

function parseContentLength(value) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isQuarantineError(code) {
  return [
    "CONTENT_TYPE_MISMATCH",
    "EMPTY_MEDIA",
    "INVALID_SOURCE_URL",
    "PRIVATE_NETWORK_TARGET",
    "SOURCE_HOST_NOT_ALLOWED",
    "UNSUPPORTED_MEDIA",
  ].includes(code);
}

function mediaError(message, code) {
  return Object.assign(new Error(message), { code });
}

export const dropSupplementInternals = {
  artworkCandidates,
  assertRelationSchema,
  compareStatsIdentity,
  loadBoundContext,
  readArtworkCheckpoint,
};
