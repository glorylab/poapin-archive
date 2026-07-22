#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sqlLiteral } from "../archive-import/lib/sql-shards.mjs";
import { sha256File, toErrorMessage } from "../archive-import/lib/util.mjs";
import { bindCollectionsSnapshotInputs } from "./lib/d1.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_WRANGLER = resolve(PROJECT_ROOT, "node_modules/wrangler/bin/wrangler.js");
const DEFAULT_CONFIG = resolve(PROJECT_ROOT, "wrangler.jsonc");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const BUSINESS_TABLES = [
  "collections",
  "collection_drop_cards",
  "collection_drop_stats_by_chain",
  "collection_items",
  "collection_sections",
  "collection_item_sections",
  "collection_urls",
  "collection_ui_settings",
  "collection_media",
  "collection_artists",
  "collection_artist_drops",
  "collection_organizations",
  "verified_collections",
  "featured_collections",
  "suggested_drops",
];

const REQUIRED_SCHEMA_TABLES = [
  "collections_meta",
  ...BUSINESS_TABLES,
  "collections_fts",
  "import_shards",
];

const REQUIRED_SCHEMA_INDEXES = [
  "idx_collections_slug",
  "idx_collections_recent",
  "idx_collections_type_recent",
  "idx_collections_year_recent",
  "idx_collection_items_collection",
  "idx_collection_items_drop",
  "idx_collection_drop_cards_private",
  "idx_collection_drop_stats_chain",
  "idx_collection_sections_collection",
  "idx_collection_item_sections_item",
  "idx_collection_urls_collection",
  "idx_collection_media_status",
  "idx_collection_artists_collection",
  "idx_collection_artist_drops_drop",
  "idx_collection_organizations_collection",
  "idx_featured_collections_recent",
  "idx_suggested_drops_collection",
  "idx_suggested_drops_status",
  "idx_suggested_drops_approved",
];

const REQUIRED_SCHEMA_TRIGGERS = [
  "collections_fts_after_insert",
  "collections_fts_after_delete",
  "collections_fts_after_update",
  "collection_drop_cards_private_after_insert",
  "collection_drop_cards_private_after_source_update",
  "collection_drop_cards_private_guard",
];

const HELP = `POAP.in fail-closed Collections D1 staging loader

Usage:
  node tools/collections-backup/d1-loader.mjs <preflight|load|verify|activate> \\
    --input <snapshot-directory> \\
    --database-name <name> --database-id <uuid>

The Collections migrations must already have been applied to an empty D1 database.
Generated prepare SQL is validated and recognized, but never executed again.
The preflight/load/verify phases never import the finalizer. The activate phase is
the only supported activation path and additionally requires --media-report to be
a second-pass R2 report where every immutable object was verified by HEAD.

Safety overrides for a database ID already present in wrangler.jsonc:
  --allow-configured-empty-target
  --confirm-worker-not-activated

The second flag is an operator attestation. This tool can prove that D1 is empty,
but cannot prove that no deployed Worker is bound to it. The target is always placed
in an isolated temporary Wrangler config; repository binding names are never used.
`;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const context = await loadContext(options);
  await enforceConfiguredTargetGate(context, options);
  const client = await createWranglerClient(context.target, options, dependencies);
  try {
    if (options.phase === "preflight") await preflight(context, client);
    else if (options.phase === "load") await load(context, client);
    else if (options.phase === "verify") await verify(context, client);
    else await activate(context, client, options.mediaReport);
    process.stdout.write(
      `${JSON.stringify({ ok: true, phase: options.phase, snapshotId: context.snapshotId })}\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

function parseOptions(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const phase = argv[0];
  if (!new Set(["preflight", "load", "verify", "activate"]).has(phase)) {
    throw new Error("First argument must be preflight, load, verify, or activate.");
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      "database-name": { type: "string" },
      "database-id": { type: "string" },
      "account-id": { type: "string" },
      "wrangler-bin": { type: "string", default: DEFAULT_WRANGLER },
      "project-config": { type: "string", default: DEFAULT_CONFIG },
      "media-report": { type: "string" },
      "allow-configured-empty-target": { type: "boolean", default: false },
      "confirm-worker-not-activated": { type: "boolean", default: false },
    },
  });
  for (const name of ["input", "database-name", "database-id"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  if (!UUID.test(values["database-id"])) {
    throw new Error("--database-id must be a D1 UUID.");
  }
  if (phase === "activate" && !values["media-report"]) {
    throw new Error("--media-report is required for activate.");
  }
  return {
    help: false,
    phase,
    inputDirectory: resolve(values.input),
    target: { name: values["database-name"], id: values["database-id"] },
    accountId: values["account-id"] ?? null,
    wranglerBin: resolve(values["wrangler-bin"]),
    projectConfig: resolve(values["project-config"]),
    mediaReport: values["media-report"] ? resolve(values["media-report"]) : null,
    allowConfiguredEmptyTarget: values["allow-configured-empty-target"],
    confirmWorkerNotActivated: values["confirm-worker-not-activated"],
  };
}

export async function loadContext(options) {
  const root = resolve(options.inputDirectory);
  const rootRealPath = await realpath(root);
  const manifestPath = resolve(root, "manifest.json");
  const validationPath = resolve(root, "validation/report.json");
  const reportPath = resolve(root, "d1/report.json");
  const [manifest, validation, report] = await Promise.all([
    readJson(manifestPath, "source manifest"),
    readJson(validationPath, "validation report"),
    readJson(reportPath, "D1 build report"),
  ]);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Source manifest must be a regular file.");
  }
  const manifestSha256 = await sha256File(manifestPath);

  if (
    validation?.version !== 1 ||
    validation?.verified !== true ||
    validation?.normalized?.checked !== validation?.normalized?.expected ||
    validation?.relationships?.checked !== true
  ) {
    throw new Error("Collections validation report is not verified and complete.");
  }
  if (
    validation.manifest?.sha256 !== manifestSha256 ||
    Number(validation.manifest?.byteLength) !== manifestStat.size
  ) {
    throw new Error("Collections validation report is not bound to the current manifest.");
  }
  if (validation.dataset !== manifest.dataset) {
    throw new Error("Collections validation dataset differs from the source manifest.");
  }

  if (report?.version !== 1) {
    throw new Error(`Unsupported Collections D1 report version: ${report?.version ?? "missing"}.`);
  }
  if (
    !SNAPSHOT_ID.test(report.snapshotId ?? "") ||
    !SHA256.test(report.sourceDatabaseSha256 ?? "")
  ) {
    throw new Error("Collections D1 report snapshot/source identity is invalid.");
  }
  if (
    report.sourceManifestSha256 !== manifestSha256 ||
    report.schemaSha256 !== manifest.schema?.sha256 ||
    validation.schema?.checked !== true ||
    validation.schema?.sha256 !== report.schemaSha256
  ) {
    throw new Error("Collections D1 report is not bound to the verified source manifest/schema.");
  }
  const sourceInputs = await bindCollectionsSnapshotInputs({
    root,
    manifest,
    validation,
    snapshotId: report.snapshotId,
  });
  if (
    report.sourceValidationSha256 !== sourceInputs.validation.sha256 ||
    report.sourceInputsSha256 !== sourceInputs.sha256 ||
    JSON.stringify(report.sourceInputs) !== JSON.stringify(sourceInputs)
  ) {
    throw new Error("Collections D1 report is not bound to the current normalized/media inputs.");
  }
  if (
    report.mediaProof?.version !== 2 ||
    !SHA256.test(report.mediaProof.sha256 ?? "") ||
    !Number.isSafeInteger(report.mediaProof.objects) ||
    report.mediaProof.objects < 0 ||
    report.mediaProof.manifest?.path !== "d1/media/publication-plan.ndjson" ||
    report.mediaProof.manifest?.sha256 !== report.mediaProof.sha256 ||
    report.mediaProof.manifest?.rows !== report.mediaProof.objects
  ) {
    throw new Error("Collections D1 report has no valid final media proof plan.");
  }
  const mediaProofManifest = await validateMediaProofManifest({
    root,
    rootRealPath,
    mediaProof: report.mediaProof,
  });
  if (
    report.mediaProof.provenance?.snapshotId !== report.snapshotId ||
    report.mediaProof.provenance?.collectionsMediaSha256 !==
      sourceInputs.media.eligibleObjectsSha256 ||
    report.mediaProof.provenance?.dropSupplementSha256 !== sourceInputs.dropSupplement.sha256 ||
    JSON.stringify(report.mediaProof.provenance?.archiveMedia) !==
      JSON.stringify(sourceInputs.dropSupplement.provenance.archiveMedia) ||
    report.mediaProof.counts?.collectionMedia !== sourceInputs.media.uniqueObjects ||
    report.mediaProof.counts?.archiveDropArtwork !==
      sourceInputs.dropSupplement.artwork.reusedObjects ||
    report.mediaProof.counts?.collectionDropArtwork !==
      sourceInputs.dropSupplement.artwork.downloadedObjects ||
    report.mediaProof.counts?.upload + report.mediaProof.counts?.reuse !== report.mediaProof.objects
  ) {
    throw new Error("Collections D1 media proof is not bound to all media source inputs.");
  }

  validateTablePlan(report.tables);
  assertSourceTablePlan(report.tables, sourceInputs);
  const artifacts = new Map();
  for (const artifact of report.artifacts ?? []) {
    const checked = await validateArtifact({ artifact, root, rootRealPath });
    if (artifacts.has(checked.path)) {
      throw new Error(`D1 report repeats artifact path: ${checked.path}`);
    }
    artifacts.set(checked.path, checked);
  }

  const prepareArtifacts = [...artifacts.values()]
    .filter((artifact) => artifact.phase === "prepare")
    .sort(compareArtifactPaths);
  const dataArtifacts = [...artifacts.values()]
    .filter((artifact) => artifact.phase === "load")
    .sort(compareArtifactPaths);
  const finalizeArtifacts = [...artifacts.values()].filter(
    (artifact) => artifact.phase === "finalize",
  );
  if (prepareArtifacts.length < 3 || dataArtifacts.length === 0 || finalizeArtifacts.length !== 1) {
    throw new Error("Collections D1 report has an invalid prepare/load/finalize plan.");
  }
  if (
    prepareArtifacts.length !== 3 ||
    prepareArtifacts[0].path !== "d1/prepare/000001_schema.sql" ||
    prepareArtifacts[1].path !== "d1/prepare/000002_import_shards.sql" ||
    prepareArtifacts[2].path !== "d1/prepare/000003_drop_supplement.sql" ||
    finalizeArtifacts[0].path !== "d1/finalize/999999_finalize.sql"
  ) {
    throw new Error("Collections D1 report does not use the canonical prepare/finalize plan.");
  }
  await assertCanonicalMigrations(prepareArtifacts);
  assertArtifactTableTotals(report.tables, dataArtifacts);
  const expectedSchemaObjects = await expectedSchemaObjectsFromMigrations();

  return {
    root,
    report,
    validation,
    manifest,
    reportSha256: await sha256File(reportPath),
    manifestSha256,
    snapshotId: report.snapshotId,
    sourceDatabaseSha256: report.sourceDatabaseSha256,
    sourceInputs,
    target: options.target,
    projectConfig: options.projectConfig,
    artifacts,
    prepareArtifacts,
    dataArtifacts,
    finalizeArtifact: finalizeArtifacts[0],
    mediaProofManifest,
    expectedSchemaObjects,
    loadPlan: [...prepareArtifacts, ...dataArtifacts],
  };
}

function validateTablePlan(tables) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error("Collections D1 report has no table count plan.");
  }
  const actual = Object.keys(tables).sort();
  const expected = [...BUSINESS_TABLES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("Collections D1 report table plan is incompatible with this loader.");
  }
  for (const table of BUSINESS_TABLES) {
    if (!Number.isSafeInteger(tables[table]) || tables[table] < 0) {
      throw new Error(`Collections D1 report has an invalid count for ${table}.`);
    }
  }
}

function assertSourceTablePlan(tables, sourceInputs) {
  const source = sourceInputs.normalized.tables;
  const expected = {
    collections: source.collections,
    collection_drop_cards: source.referenced_drops,
    collection_drop_stats_by_chain: sourceInputs.dropSupplement.normalized.counts.statsByChain,
    collection_items: source.items,
    collection_sections: source.sections,
    collection_item_sections: source.item_sections,
    collection_urls: source.collection_urls,
    collection_ui_settings: source.collection_ui_settings,
    collection_media: sourceInputs.media.references,
    collection_artists: source.artists,
    collection_artist_drops: source.artist_drops,
    collection_organizations: source.organizations,
    verified_collections: source.verified_collections,
    featured_collections: source.featured_collections,
    suggested_drops: source.suggested_drops,
  };
  for (const table of BUSINESS_TABLES) {
    if (!Number.isSafeInteger(expected[table]) || tables[table] !== expected[table]) {
      throw new Error(`Collections D1 table plan is not bound to source rows for ${table}.`);
    }
  }
}

async function assertCanonicalMigrations(prepareArtifacts) {
  const expected = [
    resolve(PROJECT_ROOT, "migrations/collections/0001_schema.sql"),
    resolve(PROJECT_ROOT, "migrations/collections/0002_import_shards.sql"),
    resolve(PROJECT_ROOT, "migrations/collections/0003_drop_supplement.sql"),
  ];
  for (const [index, path] of expected.entries()) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Canonical Collections migration is not a regular file: ${path}`);
    }
    if (
      metadata.size !== prepareArtifacts[index].byteLength ||
      (await sha256File(path)) !== prepareArtifacts[index].sha256
    ) {
      throw new Error(`Collections prepare artifact differs from migration ${index + 1}.`);
    }
  }
}

async function expectedSchemaObjectsFromMigrations() {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    for (const path of [
      resolve(PROJECT_ROOT, "migrations/collections/0001_schema.sql"),
      resolve(PROJECT_ROOT, "migrations/collections/0002_import_shards.sql"),
      resolve(PROJECT_ROOT, "migrations/collections/0003_drop_supplement.sql"),
    ]) {
      database.exec(await readFile(path, "utf8"));
    }
    const required = new Set([
      ...REQUIRED_SCHEMA_TABLES,
      ...REQUIRED_SCHEMA_INDEXES,
      ...REQUIRED_SCHEMA_TRIGGERS,
    ]);
    const rows = database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name;",
      )
      .all()
      .filter((row) => required.has(row.name));
    if (rows.length !== required.size) {
      throw new Error("Canonical Collections migrations do not define the required schema set.");
    }
    return rows.map((row) => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: canonicalSchemaSql(row.sql),
    }));
  } finally {
    database.close();
  }
}

function canonicalSchemaSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}

async function validateMediaProofManifest({ root, rootRealPath, mediaProof }) {
  const descriptor = mediaProof.manifest;
  if (
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength <= 0 ||
    !Number.isSafeInteger(descriptor.rows) ||
    descriptor.rows < 0
  ) {
    throw new Error("Collections media proof manifest metadata is invalid.");
  }
  const absolutePath = resolve(root, descriptor.path);
  assertContained(root, absolutePath, descriptor.path);
  const stat = await lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Collections media proof manifest is not a regular file.");
  }
  const realPath = await realpath(absolutePath);
  assertContained(rootRealPath, realPath, descriptor.path);
  if (
    stat.size !== descriptor.byteLength ||
    (await sha256File(absolutePath)) !== descriptor.sha256
  ) {
    throw new Error("Collections media proof manifest checksum/size differs from d1/report.json.");
  }
  const rows = (await readFile(absolutePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (rows.length !== descriptor.rows || rows.length !== mediaProof.objects) {
    throw new Error("Collections media proof manifest row count differs from d1/report.json.");
  }
  const counts = {
    collectionMedia: 0,
    archiveDropArtwork: 0,
    collectionDropArtwork: 0,
    upload: 0,
    reuse: 0,
  };
  let priorKey = null;
  for (const row of rows) {
    if (
      typeof row.key !== "string" ||
      row.key.length === 0 ||
      (priorKey !== null && row.key.localeCompare(priorKey, "en") <= 0) ||
      !["upload", "reuse"].includes(row.disposition)
    ) {
      throw new Error("Collections media proof contains an invalid/duplicate object identity.");
    }
    priorKey = row.key;
    if (row.kind === "collection-media") counts.collectionMedia += 1;
    else if (row.kind === "archive-drop-artwork") counts.archiveDropArtwork += 1;
    else if (row.kind === "collection-drop-artwork") counts.collectionDropArtwork += 1;
    else throw new Error(`Collections media proof contains an unknown object kind: ${row.kind}.`);
    counts[row.disposition] += 1;
    if (row.disposition === "upload") {
      if (
        typeof row.sourcePath !== "string" ||
        !Number.isSafeInteger(row.byteLength) ||
        row.byteLength <= 0 ||
        !SHA256.test(row.sha256 ?? "") ||
        typeof row.contentType !== "string" ||
        !row.contentType.startsWith("image/")
      ) {
        throw new Error(`Collections media upload proof is incomplete for ${row.key}.`);
      }
      const source = resolve(root, row.sourcePath);
      assertContained(root, source, row.sourcePath);
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Collections media proof source is not a regular file: ${row.sourcePath}.`);
      }
      assertContained(rootRealPath, await realpath(source), row.sourcePath);
      if (sourceStat.size !== row.byteLength || (await sha256File(source)) !== row.sha256) {
        throw new Error(`Collections media proof source changed: ${row.sourcePath}.`);
      }
    } else if (
      row.kind !== "archive-drop-artwork" ||
      row.contentType !== "image/webp" ||
      !Number.isSafeInteger(row.byteLength) ||
      row.byteLength <= 0 ||
      !SHA256.test(row.sha256 ?? "") ||
      typeof row.cacheControl !== "string" ||
      row.cacheControl.length === 0 ||
      !Number.isSafeInteger(row.dropId) ||
      row.dropId <= 0 ||
      row.key !== `snapshots/${row.archiveSnapshotId}/artwork/${row.dropId}.webp`
    ) {
      throw new Error(`Collections media reuse proof is invalid for ${row.key}.`);
    }
  }
  if (Object.entries(counts).some(([name, count]) => mediaProof.counts?.[name] !== count)) {
    throw new Error("Collections media proof category counts differ from its publication plan.");
  }
  return { ...descriptor, absolutePath, counts };
}

async function validateArtifact({ artifact, root, rootRealPath }) {
  if (
    !artifact ||
    typeof artifact.path !== "string" ||
    artifact.kind !== "d1-sql" ||
    artifact.database !== "collections" ||
    !new Set(["prepare", "load", "finalize"]).has(artifact.phase)
  ) {
    throw new Error(`Invalid Collections SQL artifact: ${artifact?.path ?? "<missing>"}`);
  }
  if (
    artifact.path.includes("\\") ||
    isAbsolute(artifact.path) ||
    artifact.path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe Collections SQL artifact path: ${artifact.path}`);
  }
  const expectedPrefix = `d1/${artifact.phase}/`;
  if (!artifact.path.startsWith(expectedPrefix)) {
    throw new Error(`Collections SQL artifact phase/path mismatch: ${artifact.path}`);
  }
  if (
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    !SHA256.test(artifact.sha256 ?? "")
  ) {
    throw new Error(`Collections SQL artifact metadata is invalid: ${artifact.path}`);
  }

  const absolutePath = resolve(root, artifact.path);
  assertContained(root, absolutePath, artifact.path);
  const fileStat = await lstat(absolutePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Collections SQL artifact is not a regular file: ${artifact.path}`);
  }
  const artifactRealPath = await realpath(absolutePath);
  assertContained(rootRealPath, artifactRealPath, artifact.path);
  if (fileStat.size !== artifact.byteLength) {
    throw new Error(`Collections SQL artifact size mismatch: ${artifact.path}`);
  }
  if ((await sha256File(absolutePath)) !== artifact.sha256) {
    throw new Error(`Collections SQL artifact checksum mismatch: ${artifact.path}`);
  }

  if (artifact.phase === "load") {
    if (
      !BUSINESS_TABLES.includes(artifact.table) ||
      !SHA256.test(artifact.payloadSha256 ?? "") ||
      !Number.isSafeInteger(artifact.rowCount) ||
      artifact.rowCount <= 0 ||
      !Number.isSafeInteger(artifact.statementCount) ||
      artifact.statementCount <= 0
    ) {
      throw new Error(`Collections data shard lacks valid journal metadata: ${artifact.path}`);
    }
  }
  return { ...artifact, absolutePath };
}

function assertArtifactTableTotals(tables, dataArtifacts) {
  const totals = Object.fromEntries(BUSINESS_TABLES.map((table) => [table, 0]));
  for (const artifact of dataArtifacts) totals[artifact.table] += artifact.rowCount;
  for (const table of BUSINESS_TABLES) {
    if (totals[table] !== tables[table]) {
      throw new Error(`Collections D1 shard row total differs from report for ${table}.`);
    }
  }
}

function assertContained(root, candidate, label) {
  const relativePath = relative(root, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Collections SQL artifact escapes the snapshot directory: ${label}`);
  }
}

function compareArtifactPaths(left, right) {
  return left.path.localeCompare(right.path, "en");
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${toErrorMessage(error)}`);
  }
}

async function configuredDatabaseIds(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  return new Set([...source.matchAll(/"database_id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
}

export async function enforceConfiguredTargetGate(context, options) {
  const configured = await configuredDatabaseIds(context.projectConfig);
  if (!configured.has(context.target.id)) return;
  if (!options.allowConfiguredEmptyTarget || !options.confirmWorkerNotActivated) {
    throw new Error(
      "Target collections is present in wrangler.jsonc. Pass both " +
        "--allow-configured-empty-target and --confirm-worker-not-activated only after " +
        "independently proving that no deployed Worker uses it.",
    );
  }
}

function parseWranglerJson(stdout) {
  const source = stdout.trim();
  const candidates = [0];
  for (const match of source.matchAll(/\n(?=[{[])/g)) candidates.push(match.index + 1);
  const parsed = [];
  for (const offset of candidates) {
    try {
      parsed.push(JSON.parse(source.slice(offset)));
    } catch {
      // Wrangler can print a human-readable file upload prelude before JSON.
    }
  }
  if (parsed.length === 1) return parsed[0];
  throw new Error("Wrangler output does not contain a complete JSON document.");
}

function assertSuccessfulD1Response(response, targetName) {
  if (
    !Array.isArray(response) ||
    response.length === 0 ||
    response.some((item) => item?.success !== true)
  ) {
    throw new Error(`Wrangler reported an unsuccessful D1 operation for ${targetName}.`);
  }
  return response;
}

async function createWranglerClient(target, options, dependencies) {
  if (dependencies.createClient) return dependencies.createClient(target);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-loader-"));
  const configPath = resolve(temporaryRoot, "wrangler.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: "poapin-collections-d1-loader",
        compatibility_date: "2026-03-10",
        ...(options.accountId ? { account_id: options.accountId } : {}),
        d1_databases: [
          {
            binding: "POAP_COLLECTIONS_IMPORT_DB",
            database_name: target.name,
            database_id: target.id,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );

  const runJson = async (args) => {
    const child = spawn(process.execPath, [options.wranglerBin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = await once(child, "close");
    if (code !== 0) {
      throw new Error(
        `Wrangler failed for ${target.name}: ${stdout.trim() || stderr.trim() || `exit ${code}`}`,
      );
    }
    try {
      return parseWranglerJson(stdout);
    } catch {
      throw new Error(`Wrangler returned invalid JSON for ${target.name}.`);
    }
  };

  try {
    const identity = await runJson([
      "d1",
      "info",
      "POAP_COLLECTIONS_IMPORT_DB",
      "--config",
      configPath,
      "--json",
    ]);
    if (identity?.uuid !== target.id || identity?.name !== target.name) {
      throw new Error(`Wrangler resolved a different D1 identity for ${target.name}.`);
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  const execute = async (argument, value) => {
    const response = await runJson([
      "d1",
      "execute",
      "POAP_COLLECTIONS_IMPORT_DB",
      "--config",
      configPath,
      "--remote",
      "--yes",
      "--json",
      argument,
      value,
    ]);
    return assertSuccessfulD1Response(response, target.name);
  };

  return {
    target,
    async query(sql) {
      const response = await execute("--command", sql);
      return response.flatMap((item) => item.results ?? []);
    },
    async importFile(filePath) {
      return execute("--file", filePath);
    },
    async close() {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

export async function inspectTarget(context, client) {
  const schemaRows = await client.query(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name;",
  );
  const found = new Map();
  for (const row of schemaRows) {
    if (found.has(row.name))
      throw new Error(`Collections target repeats schema object ${row.name}.`);
    found.set(row.name, row);
  }
  for (const expected of context.expectedSchemaObjects) {
    const actual = found.get(expected.name);
    if (
      !actual ||
      actual.type !== expected.type ||
      actual.tbl_name !== expected.table ||
      canonicalSchemaSql(actual.sql) !== expected.sql
    ) {
      throw new Error(`Collections target schema object mismatch: ${expected.name}.`);
    }
  }
  const fts = found.get("collections_fts");
  if (!fts || !canonicalSchemaSql(fts.sql).startsWith("create virtual table collections_fts")) {
    throw new Error("Collections target FTS virtual table definition is missing or invalid.");
  }

  const countedTables = ["collections_meta", "import_shards", ...BUSINESS_TABLES];
  const aliases = countedTables.map((_, index) => `count_${index}`);
  const rows = await client.query(
    `SELECT\n${countedTables
      .map((table, index) => `  (SELECT COUNT(*) FROM "${table}") AS "${aliases[index]}"`)
      .join(",\n")};`,
  );
  if (rows.length !== 1) throw new Error("Collections target count inspection returned no row.");
  const counts = {};
  for (const [index, table] of countedTables.entries()) {
    const value = Number(rows[0][aliases[index]]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Collections target returned an invalid count for ${table}.`);
    }
    counts[table] = value;
  }
  return counts;
}

function assertUnactivated(counts) {
  if (counts.collections_meta !== 0) {
    throw new Error("Collections target metadata is populated; staging must remain unactivated.");
  }
}

export async function preflight(context, client) {
  const counts = await inspectTarget(context, client);
  assertUnactivated(counts);
  if (counts.import_shards !== 0 || BUSINESS_TABLES.some((table) => counts[table] !== 0)) {
    throw new Error("Collections target is not an empty staging database.");
  }
}

export async function load(context, client) {
  let counts = await inspectTarget(context, client);
  assertUnactivated(counts);
  const existing = await journalMap(client);
  assertKnownJournal(context, existing);
  assertAllExistingMarkers(context, existing);
  if (existing.size === 0 && BUSINESS_TABLES.some((table) => counts[table] !== 0)) {
    throw new Error("Collections target contains unjournaled data; use a fresh staging database.");
  }
  assertCountsMatchMarkers(counts, existing);

  for (const [index, artifact] of context.loadPlan.entries()) {
    if (artifact.phase === "prepare") {
      process.stderr.write(
        `[collections-d1-loader] ${index + 1}/${context.loadPlan.length} recognized existing migration ${artifact.path}\n`,
      );
      continue;
    }
    if (existing.has(artifact.path)) {
      assertMarker(context, artifact, existing.get(artifact.path));
      process.stderr.write(
        `[collections-d1-loader] ${index + 1}/${context.loadPlan.length} verified existing ${artifact.path}\n`,
      );
      continue;
    }

    process.stderr.write(
      `[collections-d1-loader] ${index + 1}/${context.loadPlan.length} importing ${artifact.path}\n`,
    );
    await client.importFile(artifact.absolutePath);
    const marker = await journalMarker(client, context.snapshotId, artifact.path);
    assertMarker(context, artifact, marker);
    existing.set(artifact.path, marker);
    const actualCount = await tableCount(client, artifact.table);
    const expectedCount = markerCountForTable(existing, artifact.table);
    if (actualCount !== expectedCount) {
      throw new Error(`Collections remote table count mismatch after ${artifact.path}.`);
    }
  }

  counts = await inspectTarget(context, client);
  assertUnactivated(counts);
  assertCountsMatchMarkers(counts, existing);
}

export async function verify(context, client) {
  const counts = await inspectTarget(context, client);
  assertUnactivated(counts);
  const existing = await journalMap(client);
  assertKnownJournal(context, existing);
  for (const artifact of context.dataArtifacts) {
    assertMarker(context, artifact, existing.get(artifact.path));
  }
  assertCountsMatchMarkers(counts, existing);
  for (const table of BUSINESS_TABLES) {
    if (counts[table] !== context.report.tables[table]) {
      throw new Error(`Collections remote table count mismatch for ${table}.`);
    }
  }

  // Cloudflare D1 rejects PRAGMA integrity_check with SQLITE_AUTH. The exact
  // same SQL plan is integrity-checked in the portable SQLite build; remotely,
  // signed shard journals plus exact table totals prove that plan was applied.
  const foreignKeyRows = await client.query("PRAGMA foreign_key_check;");
  if (foreignKeyRows.length !== 0) {
    throw new Error("Collections remote D1 failed PRAGMA foreign_key_check.");
  }
  await verifySearchAndQueryPlans(context, client, counts);
}

export async function activate(context, client, mediaReportPath) {
  await verify(context, client);
  await validateMediaPublishReport(context, mediaReportPath);
  await client.importFile(context.finalizeArtifact.absolutePath);

  const rows = await client.query("SELECT key, value FROM collections_meta ORDER BY key;");
  const actual = new Map(rows.map((row) => [row.key, String(row.value)]));
  const expected = expectedActivationMetadata(context);
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, value]) => actual.get(key) !== value)
  ) {
    throw new Error(
      "Collections finalizer guard rejected activation or returned unexpected metadata; ready was not accepted.",
    );
  }

  const counts = await inspectTarget(context, client);
  for (const table of BUSINESS_TABLES) {
    if (counts[table] !== context.report.tables[table]) {
      throw new Error(`Collections activated table count mismatch for ${table}.`);
    }
  }
}

async function validateMediaPublishReport(context, mediaReportPath) {
  const reportStat = await lstat(mediaReportPath);
  if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
    throw new Error("Collections media publish verification report must be a regular file.");
  }
  const report = await readJson(mediaReportPath, "media publish verification report");
  const expectedObjects = context.report.mediaProof.objects;
  const verifiedObjects = report.counts?.proofVerified ?? report.counts?.checkpointVerified;
  if (
    report.version !== 1 ||
    report.dataset !== "poapin-collections-media-publication" ||
    report.ok !== true ||
    report.complete !== true ||
    report.publishable !== true ||
    report.snapshotId !== context.snapshotId ||
    typeof report.target?.bucket !== "string" ||
    report.target.bucket.length === 0 ||
    report.counts?.uniqueObjects !== expectedObjects ||
    verifiedObjects !== expectedObjects ||
    report.counts?.uploaded !== 0 ||
    report.counts?.reused !== 0 ||
    report.counts?.failed !== 0 ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0
  ) {
    throw new Error(
      "Collections media report is not a complete second-pass remote object verification.",
    );
  }
  const manifests = report.manifests ?? {};
  const mediaProof = manifests.mediaProof;
  if (
    manifests.snapshot?.sha256 !== context.manifestSha256 ||
    Number(manifests.snapshot?.byteLength) !== context.sourceInputs.manifest.byteLength ||
    manifests.validationReport?.sha256 !== context.sourceInputs.validation.sha256 ||
    manifests.dropSupplement?.sha256 !== context.sourceInputs.dropSupplement.manifest.sha256 ||
    manifests.dropSupplement?.byteLength !==
      context.sourceInputs.dropSupplement.manifest.byteLength ||
    manifests.d1?.sha256 !== context.reportSha256 ||
    mediaProof?.sha256 !== context.report.mediaProof.sha256 ||
    mediaProof?.objects !== expectedObjects ||
    mediaProof?.manifest?.sha256 !== context.report.mediaProof.manifest.sha256 ||
    mediaProof?.manifest?.byteLength !== context.report.mediaProof.manifest.byteLength ||
    mediaProof?.manifest?.rows !== context.report.mediaProof.manifest.rows
  ) {
    throw new Error("Collections media report is not bound to this snapshot/D1/object set.");
  }
}

function expectedActivationMetadata(context) {
  const tables = context.report.tables;
  return new Map(
    Object.entries({
      snapshot_id: context.snapshotId,
      snapshot_at: context.manifest.finishedAt,
      schema_version: "3",
      importer_version: "collections-backup-v2",
      source_schema_sha256: context.manifest.schema.sha256,
      source_database_sha256: context.sourceDatabaseSha256,
      source_inputs_sha256: context.sourceInputs.sha256,
      media_proof_sha256: context.report.mediaProof.sha256,
      media_objects_count: String(context.report.mediaProof.objects),
      consistency: "stable-two-pass",
      collections_count: String(tables.collections),
      items_count: String(tables.collection_items),
      sections_count: String(tables.collection_sections),
      item_sections_count: String(tables.collection_item_sections),
      drop_cards_count: String(tables.collection_drop_cards),
      drop_stats_by_chain_count: String(tables.collection_drop_stats_by_chain),
      media_count: String(tables.collection_media),
      ready: "1",
    }),
  );
}

async function verifySearchAndQueryPlans(context, client, counts) {
  const ftsCounts = await client.query(
    "SELECT (SELECT COUNT(*) FROM collections) AS source_count, (SELECT COUNT(*) FROM collections_fts) AS search_count;",
  );
  if (
    ftsCounts.length !== 1 ||
    Number(ftsCounts[0].source_count) !== counts.collections ||
    Number(ftsCounts[0].search_count) !== counts.collections
  ) {
    throw new Error("Collections FTS content row count differs from collections.");
  }

  // FTS5's rank=1 integrity-check compares the external-content table to the
  // search index and raises an SQL error on any missing or stale token row.
  await client.query(
    "INSERT INTO collections_fts(collections_fts, rank) VALUES('integrity-check', 1);",
  );
  await client.query(
    "SELECT rowid FROM collections_fts WHERE collections_fts MATCH 'collection*' LIMIT 1;",
  );

  const recentPlan = await client.query(
    "EXPLAIN QUERY PLAN SELECT collection_id FROM collections ORDER BY updated_on DESC, collection_id DESC LIMIT 48;",
  );
  if (!recentPlan.some((row) => String(row.detail ?? "").includes("idx_collections_recent"))) {
    throw new Error("Collections recent-list query plan does not use idx_collections_recent.");
  }
  const searchPlan = await client.query(
    "EXPLAIN QUERY PLAN SELECT rowid FROM collections_fts WHERE collections_fts MATCH 'collection*' LIMIT 48;",
  );
  if (!searchPlan.some((row) => /virtual table index/i.test(String(row.detail ?? "")))) {
    throw new Error("Collections search query plan does not use the FTS virtual table index.");
  }
  const approvedSuggestionsPlan = await client.query(
    "EXPLAIN QUERY PLAN SELECT suggestion_id FROM suggested_drops WHERE collection_id = 1 AND curation_status = 'approved' ORDER BY created_on DESC, suggestion_id DESC LIMIT 48;",
  );
  if (
    !approvedSuggestionsPlan.some((row) =>
      String(row.detail ?? "").includes("idx_suggested_drops_approved"),
    )
  ) {
    throw new Error(
      "Collections approved-suggestion query plan does not use idx_suggested_drops_approved.",
    );
  }
}

async function journalMap(client) {
  const rows = await client.query(
    "SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards ORDER BY snapshot_id, shard_path;",
  );
  const markers = new Map();
  for (const row of rows) {
    if (markers.has(row.shard_path)) {
      throw new Error(`Collections remote journal repeats a shard path: ${row.shard_path}`);
    }
    markers.set(row.shard_path, row);
  }
  return markers;
}

async function journalMarker(client, snapshotId, shardPath) {
  const rows = await client.query(
    `SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards WHERE snapshot_id = ${sqlLiteral(snapshotId)} AND shard_path = ${sqlLiteral(shardPath)};`,
  );
  if (rows.length > 1) throw new Error(`Collections remote journal repeats ${shardPath}.`);
  return rows[0] ?? null;
}

function assertKnownJournal(context, existing) {
  const expected = new Set(context.dataArtifacts.map((artifact) => artifact.path));
  for (const [path, marker] of existing) {
    if (marker.snapshot_id !== context.snapshotId) {
      throw new Error(`Collections marker belongs to another snapshot: ${path}`);
    }
    if (!expected.has(path)) {
      throw new Error(`Collections target has an unexpected import marker: ${path}`);
    }
  }
}

function assertAllExistingMarkers(context, existing) {
  const byPath = new Map(context.dataArtifacts.map((artifact) => [artifact.path, artifact]));
  for (const [path, marker] of existing) assertMarker(context, byPath.get(path), marker);
}

function assertMarker(context, artifact, marker) {
  if (
    !artifact ||
    !marker ||
    marker.snapshot_id !== context.snapshotId ||
    marker.source_database_sha256 !== context.sourceDatabaseSha256 ||
    marker.shard_path !== artifact.path ||
    marker.payload_sha256 !== artifact.payloadSha256 ||
    marker.table_name !== artifact.table ||
    Number(marker.row_count) !== artifact.rowCount ||
    Number(marker.statement_count) !== artifact.statementCount
  ) {
    throw new Error(`Collections remote journal marker mismatch: ${artifact?.path ?? "<unknown>"}`);
  }
}

function assertCountsMatchMarkers(counts, existing) {
  for (const table of BUSINESS_TABLES) {
    const expected = markerCountForTable(existing, table);
    if (counts[table] !== expected) {
      throw new Error(`Collections remote data/journal count mismatch for ${table}.`);
    }
  }
}

function markerCountForTable(existing, table) {
  let count = 0;
  for (const marker of existing.values()) {
    if (marker.table_name === table) count += Number(marker.row_count);
  }
  return count;
}

async function tableCount(client, table) {
  if (!BUSINESS_TABLES.includes(table)) throw new Error(`Unknown Collections table: ${table}`);
  const rows = await client.query(`SELECT COUNT(*) AS row_count FROM "${table}";`);
  const count = Number(rows[0]?.row_count);
  if (rows.length !== 1 || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Collections target returned an invalid count for ${table}.`);
  }
  return count;
}

export { BUSINESS_TABLES, REQUIRED_SCHEMA_TABLES, parseWranglerJson, assertSuccessfulD1Response };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[collections-d1-loader] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
