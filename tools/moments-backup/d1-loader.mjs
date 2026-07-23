#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sqlLiteral } from "../archive-import/lib/sql-shards.mjs";
import {
  MOMENTS_MEDIA_VERIFICATION_CHAIN_SCHEMA,
  canonicalMomentsBridgeOrigin,
  momentsMediaVerificationBindingSha256,
  momentsMediaVerificationChainSha256,
  validateMomentsBucketPair,
} from "../moments-media/lib/verification.mjs";
import { sha256File, writeJsonAtomic } from "./lib/files.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_WRANGLER = resolve(PROJECT_ROOT, "node_modules/wrangler/bin/wrangler.js");
const DEFAULT_CONFIG = resolve(PROJECT_ROOT, "wrangler.jsonc");
const DATABASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERIFICATION_RUN_ID = /^[0-9a-f]{32}$/;
const VERIFICATION_ALGORITHM = "poapin-r2-head-all-v1";
const VERIFICATION_RUN_ID_ALGORITHM = "os-csprng-128-bit-hex-v1";
const D1_MAX_STATEMENT_BYTES = 100_000;
const D1_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const MEDIA_STATUSES = [
  "failed",
  "missing",
  "pending",
  "private_stored",
  "public_stored",
  "quarantined",
];
const IMMUTABLE_TABLES = [
  "moments",
  "moment_visibility",
  "moment_drops",
  "moment_hidden_drops",
  "moment_media",
  "moment_links",
  "moment_user_tags",
  "capsules",
  "capsule_visibility",
  "capsule_moments",
  "moment_collections",
];
const BUSINESS_TABLES = [
  "moments_meta",
  "moments_import_plan",
  "moments",
  "moment_visibility",
  "moment_drops",
  "moment_hidden_drops",
  "moment_suppressions",
  "moment_media",
  "moment_links",
  "moment_user_tags",
  "capsules",
  "capsule_visibility",
  "capsule_suppressions",
  "capsule_moments",
  "moment_collections",
];
const MIGRATION_FILES = ["0001_schema.sql", "0002_import_shards.sql", "0003_import_guards.sql"];
const PREPARE_PATHS = [
  "prepare/000001_schema.sql",
  "prepare/000002_import_shards.sql",
  "prepare/000003_import_guards.sql",
];

const HELP = `POAP.in fail-closed Moments D1 staging loader

Usage:
  node tools/moments-backup/d1-loader.mjs <preflight|load|verify|activate> \\
    --input <d1-build-directory> \\
    --database-name <name> --database-id <uuid>

The build directory must contain manifest.json plus canonical prepare/load SQL
artifacts. preflight requires a pristine D1 target. load applies the schema and
resumable data shards. verify writes a target-bound report while ready remains 0.
activate additionally requires --verification-report <path>.

Metadata-only activation is explicit:
  --allow-metadata-only

Safety overrides for a database ID already present in wrangler.jsonc:
  --allow-configured-empty-target
  --confirm-worker-not-activated

The loader always uses an isolated temporary Wrangler config and the exact D1
name/UUID pair supplied on the command line.
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
    let result = null;
    if (options.phase === "preflight") await preflight(context, client);
    else if (options.phase === "load") await load(context, client);
    else if (options.phase === "verify") result = await verify(context, client);
    else {
      result = await activate(context, client, options.verificationReport, {
        allowMetadataOnly: options.allowMetadataOnly,
      });
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        phase: options.phase,
        snapshotId: context.snapshotId,
        ...(result?.reportPath ? { reportPath: result.reportPath } : {}),
      })}\n`,
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
      "verification-report": { type: "string" },
      "allow-metadata-only": { type: "boolean", default: false },
      "allow-configured-empty-target": { type: "boolean", default: false },
      "confirm-worker-not-activated": { type: "boolean", default: false },
    },
  });
  for (const name of ["input", "database-name", "database-id"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  if (!DATABASE_UUID.test(values["database-id"])) {
    throw new Error("--database-id must be a D1 UUID.");
  }
  if (phase === "activate" && !values["verification-report"]) {
    throw new Error("activate requires --verification-report.");
  }
  if (phase !== "activate" && (values["verification-report"] || values["allow-metadata-only"])) {
    throw new Error("Activation options are only valid for activate.");
  }
  return {
    help: false,
    phase,
    inputDirectory: resolve(values.input),
    target: { name: values["database-name"], id: values["database-id"] },
    accountId: values["account-id"] ?? null,
    wranglerBin: resolve(values["wrangler-bin"]),
    projectConfig: resolve(values["project-config"]),
    verificationReport: values["verification-report"]
      ? resolve(values["verification-report"])
      : null,
    allowMetadataOnly: values["allow-metadata-only"],
    allowConfiguredEmptyTarget: values["allow-configured-empty-target"],
    confirmWorkerNotActivated: values["confirm-worker-not-activated"],
  };
}

export async function loadContext(options) {
  const root = resolve(options.inputDirectory);
  const rootRealPath = await realpath(root);
  const manifestPath = resolve(root, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Moments D1 manifest must be a regular file.");
  }
  const manifestInput = await readJsonWithMetadata(manifestPath, "Moments D1 manifest");
  const manifest = manifestInput.value;
  const manifestMetadata = manifestInput.metadata;
  if (
    manifest?.version !== 2 ||
    manifest.dataset !== "poapin-moments-d1-import" ||
    !SNAPSHOT_ID.test(manifest.snapshotId ?? "") ||
    !SHA256.test(manifest.sourceDatabaseSha256 ?? "")
  ) {
    throw new Error("Moments D1 manifest identity/version is invalid.");
  }
  validateSettings(manifest.settings);
  validateSourcePlan(manifest.source);
  validateTablePlan(manifest.tables);
  validateProjection(manifest.projection);
  validateMediaPlan(manifest.media, manifest.tables.moment_media);
  validateMediaDescriptor(manifest.mediaManifest, manifest.media);
  validateMediaVerificationDescriptor(
    manifest.mediaVerification,
    manifest.mediaManifest,
    manifest.media,
    manifest.snapshotId,
  );
  await validateMediaVerificationEvidence({
    root,
    rootRealPath,
    mediaVerification: manifest.mediaVerification,
  });
  validateCollectionPlan(
    manifest.collectionMap,
    manifest.source.manifest,
    manifest.tables.moment_collections,
  );
  if (manifest.sourceDatabaseSha256 !== calculateSourceDatabaseSha256(manifest)) {
    throw new Error("Moments D1 source database digest does not match its source descriptors.");
  }

  const artifacts = new Map();
  for (const artifact of manifest.artifacts ?? []) {
    const checked = await validateArtifact({ root, rootRealPath, artifact });
    if (artifacts.has(checked.path)) {
      throw new Error(`Moments D1 manifest repeats artifact ${checked.path}.`);
    }
    artifacts.set(checked.path, checked);
  }
  const prepareArtifacts = PREPARE_PATHS.map((path) => artifacts.get(path));
  if (prepareArtifacts.some((artifact) => !artifact)) {
    throw new Error("Moments D1 manifest omits a canonical prepare migration.");
  }
  const dataArtifacts = [...artifacts.values()]
    .filter((artifact) => artifact.phase === "load")
    .sort(compareArtifactPaths);
  if (
    dataArtifacts.length === 0 ||
    artifacts.size !== prepareArtifacts.length + dataArtifacts.length
  ) {
    throw new Error("Moments D1 manifest has an invalid prepare/load artifact plan.");
  }
  const sourceTables = new Set();
  for (const artifact of dataArtifacts) {
    if (
      artifact.kind !== "d1-sql" ||
      artifact.database !== "moments" ||
      artifact.byteLength > manifest.settings.maxShardBytes ||
      !BUSINESS_TABLES.includes(artifact.table) ||
      !SHA256.test(artifact.payloadSha256 ?? "") ||
      !Number.isSafeInteger(artifact.rowCount) ||
      artifact.rowCount <= 0 ||
      !Number.isSafeInteger(artifact.statementCount) ||
      artifact.statementCount <= 0 ||
      !Number.isSafeInteger(artifact.maxStatementByteLength) ||
      artifact.maxStatementByteLength <= 0 ||
      artifact.maxStatementByteLength > manifest.settings.maxStatementBytes
    ) {
      throw new Error(`Moments load artifact lacks valid journal metadata: ${artifact.path}.`);
    }
    sourceTables.add(artifact.table);
  }
  const importPlanArtifacts = dataArtifacts.filter(
    (artifact) => artifact.table === "moments_import_plan",
  );
  if (
    manifest.tables.moments_import_plan !== IMMUTABLE_TABLES.length ||
    importPlanArtifacts.length !== 1 ||
    importPlanArtifacts[0] !== dataArtifacts[0]
  ) {
    throw new Error("Moments import plan must be one complete first load shard.");
  }
  for (const table of BUSINESS_TABLES) {
    if (manifest.tables[table] > 0 && !sourceTables.has(table)) {
      throw new Error(`Moments D1 manifest has no load shard for ${table}.`);
    }
    if (manifest.tables[table] === 0 && sourceTables.has(table)) {
      throw new Error(`Moments D1 manifest unexpectedly shards empty table ${table}.`);
    }
  }
  assertArtifactTableTotals(manifest.tables, dataArtifacts);
  await assertCanonicalMigrations(prepareArtifacts);
  const expectedSchemaPrefixes = await buildExpectedSchemaPrefixes();

  return {
    root,
    rootRealPath,
    manifest,
    manifestPath,
    manifestMetadata,
    snapshotId: manifest.snapshotId,
    sourceDatabaseSha256: manifest.sourceDatabaseSha256,
    target: options.target,
    projectConfig: options.projectConfig,
    artifacts,
    prepareArtifacts,
    dataArtifacts,
    expectedSchemaPrefixes,
  };
}

function validateSourcePlan(source) {
  const manifest = source?.manifest;
  const validation = source?.validation;
  const stability = source?.stability;
  if (
    typeof source?.snapshotDirectory !== "string" ||
    source.snapshotDirectory.length === 0 ||
    manifest?.path !== "manifest.json" ||
    !SHA256.test(manifest.sha256 ?? "") ||
    !Number.isSafeInteger(manifest.byteLength) ||
    manifest.byteLength <= 0 ||
    validation?.path !== "validation/report.json" ||
    !SHA256.test(validation.sha256 ?? "") ||
    !Number.isSafeInteger(validation.byteLength) ||
    validation.byteLength <= 0 ||
    stability?.path !== "validation/stability.json" ||
    !SHA256.test(stability.sha256 ?? "") ||
    !Number.isSafeInteger(stability.byteLength) ||
    stability.byteLength <= 0 ||
    stability.stable !== true ||
    stability.primary?.manifestSha256 !== manifest.sha256 ||
    stability.primary?.manifestByteLength !== manifest.byteLength ||
    !validCaptureWindow(stability.primary) ||
    !validCaptureWindow(stability.secondary) ||
    !SHA256.test(stability.secondary?.manifestSha256 ?? "") ||
    stability.secondary.manifestSha256 === manifest.sha256 ||
    !Number.isSafeInteger(stability.secondary?.manifestByteLength) ||
    stability.secondary.manifestByteLength <= 0 ||
    Date.parse(stability.primary.finishedAt) > Date.parse(stability.secondary.startedAt) ||
    !Number.isSafeInteger(stability.normalizedArtifacts) ||
    stability.normalizedArtifacts <= 0 ||
    !SHA256.test(source.schemaSha256 ?? "")
  ) {
    throw new Error("Moments D1 source plan lacks a complete stable two-pass binding.");
  }
}

function validCaptureWindow(value) {
  return (
    typeof value?.startedAt === "string" &&
    typeof value?.finishedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    Number.isFinite(Date.parse(value.finishedAt)) &&
    Date.parse(value.startedAt) <= Date.parse(value.finishedAt)
  );
}

function validateSettings(settings) {
  if (
    !Number.isSafeInteger(settings?.maxShardBytes) ||
    settings.maxShardBytes <= 0 ||
    settings.maxShardBytes > D1_MAX_FILE_BYTES ||
    !Number.isSafeInteger(settings?.maxStatementBytes) ||
    settings.maxStatementBytes <= 0 ||
    settings.maxStatementBytes > D1_MAX_STATEMENT_BYTES ||
    !Number.isSafeInteger(settings?.rowsPerStatement) ||
    settings.rowsPerStatement <= 0 ||
    settings.explicitTransactions !== false
  ) {
    throw new Error("Moments D1 build settings are incompatible with D1 import limits.");
  }
}

function validateTablePlan(tables) {
  const actual =
    tables && typeof tables === "object" && !Array.isArray(tables)
      ? Object.keys(tables).sort()
      : [];
  const expected = [...BUSINESS_TABLES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("Moments D1 table plan is incomplete or unexpected.");
  }
  for (const table of BUSINESS_TABLES) {
    if (!Number.isSafeInteger(tables[table]) || tables[table] < 0) {
      throw new Error(`Moments D1 table count is invalid for ${table}.`);
    }
  }
}

function validateProjection(projection) {
  for (const key of ["publicMoments", "publicCapsules", "momentsHiddenDrops"]) {
    if (!Number.isSafeInteger(projection?.[key]) || projection[key] < 0) {
      throw new Error(`Moments D1 projection count is invalid for ${key}.`);
    }
  }
}

function validateMediaPlan(media, mediaRows) {
  if (
    !["metadata-only", "media-bound"].includes(media?.mode) ||
    media.ready !== (media.mode === "media-bound") ||
    media.rows !== mediaRows
  ) {
    throw new Error("Moments D1 media plan is invalid.");
  }
  let total = 0;
  for (const status of MEDIA_STATUSES) {
    const count = media.statuses?.[status];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Moments D1 media status count is invalid for ${status}.`);
    }
    total += count;
  }
  if (
    Object.keys(media.statuses ?? {})
      .sort()
      .join("\0") !== MEDIA_STATUSES.join("\0")
  ) {
    throw new Error("Moments D1 media status set is incomplete or unexpected.");
  }
  if (total !== mediaRows) throw new Error("Moments D1 media status counts do not sum to rows.");
  if (media.mode === "metadata-only" && media.statuses.pending !== mediaRows) {
    throw new Error("Metadata-only Moments D1 builds must keep every media row pending.");
  }
}

function validateMediaDescriptor(mediaManifest, media) {
  if (media.mode === "metadata-only") {
    if (mediaManifest !== null) {
      throw new Error("Metadata-only Moments D1 builds cannot claim a media manifest.");
    }
    return;
  }
  const proof = mediaManifest?.proof;
  if (proof) {
    validateMomentsBucketPair(proof.publicBucket, proof.privateBucket);
  }
  const checkpointBindingValid =
    (proof?.checkpointMode === "capture-only" &&
      proof.recovery === null &&
      SHA256.test(proof.normalizedMediaSha256 ?? "") &&
      SHA256.test(proof.captureCheckpointSha256 ?? "")) ||
    (proof?.checkpointMode === "recovery-finalized" &&
      SHA256.test(proof.normalizedMediaSha256 ?? "") &&
      SHA256.test(proof.captureCheckpointSha256 ?? "") &&
      SHA256.test(proof.recovery?.planSha256 ?? "") &&
      SHA256.test(proof.recovery?.checkpointSha256 ?? ""));
  if (
    typeof mediaManifest?.path !== "string" ||
    !mediaManifest.path.endsWith(".ndjson") ||
    !SHA256.test(mediaManifest.sha256 ?? "") ||
    !Number.isSafeInteger(mediaManifest.byteLength) ||
    mediaManifest.byteLength < 0 ||
    mediaManifest.rows !== media.rows ||
    !SHA256.test(proof?.sha256 ?? "") ||
    !Number.isSafeInteger(proof?.byteLength) ||
    proof.byteLength <= 0 ||
    proof.manifestSha256 !== mediaManifest.sha256 ||
    proof.manifestRows !== mediaManifest.rows ||
    proof.schemaVersion !== "poapin-moments-d1-media-proof-v1" ||
    proof.complete !== true ||
    proof.publicProjectionReady !== true ||
    !SHA256.test(proof.planSha256 ?? "") ||
    !checkpointBindingValid
  ) {
    throw new Error("Media-bound Moments D1 build lacks a complete source-bound media proof.");
  }
}

function validateMediaVerificationDescriptor(mediaVerification, mediaManifest, media, snapshotId) {
  if (media.mode === "metadata-only") {
    if (mediaVerification !== null) {
      throw new Error("Metadata-only Moments D1 builds cannot claim remote media verification.");
    }
    return;
  }
  const binding = mediaVerification?.binding;
  const reports = mediaVerification?.reports;
  const canonicalBinding = binding
    ? {
        snapshotId: binding.snapshotId,
        checkpointMode: binding.checkpointMode,
        publicBucket: binding.publicBucket,
        privateBucket: binding.privateBucket,
        bridgeOrigin: binding.bridgeOrigin,
        mediaPlanSha256: binding.mediaPlanSha256,
        mediaManifestSha256: binding.mediaManifestSha256,
        mediaProofSha256: binding.mediaProofSha256,
        normalizedMediaSha256: binding.normalizedMediaSha256,
        captureCheckpointSha256: binding.captureCheckpointSha256,
        recoveryPlanSha256: binding.recoveryPlanSha256,
        recoveryCheckpointSha256: binding.recoveryCheckpointSha256,
        stored: binding.stored,
        storedObjectSetSha256: binding.storedObjectSetSha256,
      }
    : null;
  const canonicalReports = Array.isArray(reports)
    ? reports.map((report) => ({
        sequence: report?.sequence,
        path: report?.path,
        sha256: report?.sha256,
        byteLength: report?.byteLength,
        pass: report?.pass,
        runId: report?.runId,
        runIdAlgorithm: report?.runIdAlgorithm,
        algorithm: report?.algorithm,
        startedAt: report?.startedAt,
        verifiedAt: report?.verifiedAt,
        previousReportSha256: report?.previousReportSha256,
        limits: canonicalVerificationLimits(report?.limits),
      }))
    : null;
  if (binding) {
    validateMomentsBucketPair(binding.publicBucket, binding.privateBucket);
  }
  if (
    mediaVerification?.schemaVersion !== MOMENTS_MEDIA_VERIFICATION_CHAIN_SCHEMA ||
    !binding ||
    JSON.stringify(binding) !== JSON.stringify(canonicalBinding) ||
    binding.snapshotId !== snapshotId ||
    canonicalMomentsBridgeOrigin(binding.bridgeOrigin) !== binding.bridgeOrigin ||
    binding.mediaPlanSha256 !== mediaManifest.proof.planSha256 ||
    binding.mediaManifestSha256 !== mediaManifest.sha256 ||
    binding.mediaProofSha256 !== mediaManifest.proof.sha256 ||
    binding.checkpointMode !== mediaManifest.proof.checkpointMode ||
    binding.publicBucket !== mediaManifest.proof.publicBucket ||
    binding.privateBucket !== mediaManifest.proof.privateBucket ||
    binding.normalizedMediaSha256 !== mediaManifest.proof.normalizedMediaSha256 ||
    binding.captureCheckpointSha256 !== mediaManifest.proof.captureCheckpointSha256 ||
    binding.recoveryPlanSha256 !== (mediaManifest.proof.recovery?.planSha256 ?? null) ||
    binding.recoveryCheckpointSha256 !== (mediaManifest.proof.recovery?.checkpointSha256 ?? null) ||
    !Number.isSafeInteger(binding.stored) ||
    binding.stored < 0 ||
    !SHA256.test(binding.storedObjectSetSha256 ?? "") ||
    mediaVerification.bindingSha256 !== momentsMediaVerificationBindingSha256(binding) ||
    !Array.isArray(reports) ||
    reports.length !== 2 ||
    JSON.stringify(reports) !== JSON.stringify(canonicalReports) ||
    reports.some(
      (report, index) =>
        report?.sequence !== index + 1 ||
        report.pass !== index + 1 ||
        typeof report.path !== "string" ||
        report.path !== `evidence/media-verification/pass${index + 1}-${report.sha256}.json` ||
        !SHA256.test(report.sha256 ?? "") ||
        !Number.isSafeInteger(report.byteLength) ||
        report.byteLength <= 0 ||
        !VERIFICATION_RUN_ID.test(report.runId ?? "") ||
        report.runIdAlgorithm !== VERIFICATION_RUN_ID_ALGORITHM ||
        report.algorithm !== VERIFICATION_ALGORITHM ||
        !isCanonicalInstant(report.startedAt) ||
        !isCanonicalInstant(report.verifiedAt) ||
        Date.parse(report.startedAt) > Date.parse(report.verifiedAt),
    ) ||
    reports[0].path === reports[1].path ||
    reports[0].sha256 === reports[1].sha256 ||
    reports[0].runId === reports[1].runId ||
    reports[0].previousReportSha256 !== null ||
    reports[1].previousReportSha256 !== reports[0].sha256 ||
    Date.parse(reports[0].verifiedAt) >= Date.parse(reports[1].startedAt) ||
    mediaVerification.chainSha256 !==
      momentsMediaVerificationChainSha256(mediaVerification.bindingSha256, canonicalReports)
  ) {
    throw new Error("Media-bound Moments D1 build lacks a valid two-pass verification chain.");
  }
}

function canonicalVerificationLimits(value) {
  const limits = {
    concurrency: value?.concurrency,
    attempts: value?.attempts,
    maximumObjectBytes: value?.maximumObjectBytes,
    maximumMultipartObjectBytes: value?.maximumMultipartObjectBytes,
    multipartPartBytes: value?.multipartPartBytes,
  };
  if (
    !Number.isSafeInteger(limits.concurrency) ||
    limits.concurrency < 1 ||
    limits.concurrency > 12 ||
    !Number.isSafeInteger(limits.attempts) ||
    limits.attempts < 1 ||
    limits.attempts > 10 ||
    !Number.isSafeInteger(limits.maximumObjectBytes) ||
    limits.maximumObjectBytes < 1 ||
    limits.maximumObjectBytes > 100_000_000 ||
    !(
      (limits.maximumMultipartObjectBytes === null && limits.multipartPartBytes === null) ||
      (Number.isSafeInteger(limits.maximumMultipartObjectBytes) &&
        limits.maximumMultipartObjectBytes >= limits.maximumObjectBytes &&
        limits.maximumMultipartObjectBytes <= 5_000_000_000_000 &&
        Number.isSafeInteger(limits.multipartPartBytes) &&
        limits.multipartPartBytes >= 5_242_880 &&
        limits.multipartPartBytes <= limits.maximumObjectBytes &&
        Math.ceil(limits.maximumMultipartObjectBytes / limits.multipartPartBytes) <= 10_000)
    )
  ) {
    throw new Error("Moments media verification limits are invalid.");
  }
  return limits;
}

function validateCollectionPlan(collectionMap, sourceManifest, collectionRows) {
  if (collectionMap === null) {
    if (collectionRows !== 0) {
      throw new Error("Moments collection rows require a collection-map proof.");
    }
    return;
  }
  if (
    typeof collectionMap?.path !== "string" ||
    !collectionMap.path.endsWith(".ndjson") ||
    !SHA256.test(collectionMap.sha256 ?? "") ||
    !Number.isSafeInteger(collectionMap.byteLength) ||
    collectionMap.byteLength < 0 ||
    !Number.isSafeInteger(collectionMap.rows) ||
    collectionMap.rows < 0 ||
    collectionMap.rows !== collectionRows ||
    typeof collectionMap.proof?.path !== "string" ||
    !collectionMap.proof.path.endsWith(".report.json") ||
    !SHA256.test(collectionMap.proof.sha256 ?? "") ||
    !Number.isSafeInteger(collectionMap.proof.byteLength) ||
    collectionMap.proof.byteLength <= 0 ||
    collectionMap.proof.momentsManifestSha256 !== sourceManifest.sha256 ||
    !SHA256.test(collectionMap.proof.collectionsManifestSha256 ?? "")
  ) {
    throw new Error("Moments D1 collection map lacks a source-bound proof.");
  }
}

function calculateSourceDatabaseSha256(manifest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        snapshotId: manifest.snapshotId,
        sourceManifest: {
          sha256: manifest.source.manifest.sha256,
          byteLength: manifest.source.manifest.byteLength,
        },
        stability: {
          sha256: manifest.source.stability.sha256,
          byteLength: manifest.source.stability.byteLength,
          secondaryManifestSha256: manifest.source.stability.secondary.manifestSha256,
        },
        mediaManifest: manifest.mediaManifest
          ? {
              sha256: manifest.mediaManifest.sha256,
              byteLength: manifest.mediaManifest.byteLength,
              rows: manifest.mediaManifest.rows,
              proofSha256: manifest.mediaManifest.proof.sha256,
            }
          : null,
        mediaVerification: manifest.mediaVerification
          ? {
              chainSha256: manifest.mediaVerification.chainSha256,
              bindingSha256: manifest.mediaVerification.bindingSha256,
              stored: manifest.mediaVerification.binding.stored,
              storedObjectSetSha256: manifest.mediaVerification.binding.storedObjectSetSha256,
              reports: manifest.mediaVerification.reports.map((report) => ({
                sha256: report.sha256,
                byteLength: report.byteLength,
                verifiedAt: report.verifiedAt,
              })),
            }
          : null,
        collectionMap: manifest.collectionMap
          ? {
              sha256: manifest.collectionMap.sha256,
              byteLength: manifest.collectionMap.byteLength,
              rows: manifest.collectionMap.rows,
              proofSha256: manifest.collectionMap.proof.sha256,
            }
          : null,
      }),
    )
    .digest("hex");
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  );
}

async function validateMediaVerificationEvidence({ root, rootRealPath, mediaVerification }) {
  if (mediaVerification === null) return;
  for (const report of mediaVerification.reports) {
    const absolutePath = resolve(root, report.path);
    assertContained(root, absolutePath, report.path);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Moments media verification evidence is not a regular file: ${report.path}.`);
    }
    assertContained(rootRealPath, await realpath(absolutePath), report.path);
    const actual = await sha256File(absolutePath);
    if (actual.sha256 !== report.sha256 || actual.byteLength !== report.byteLength) {
      throw new Error(
        `Moments media verification evidence checksum/size mismatch: ${report.path}.`,
      );
    }
  }
}

async function validateArtifact({ root, rootRealPath, artifact }) {
  if (
    !artifact ||
    typeof artifact.path !== "string" ||
    !["prepare", "load"].includes(artifact.phase) ||
    artifact.kind !== "d1-sql" ||
    artifact.database !== "moments" ||
    !SHA256.test(artifact.sha256 ?? "") ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > D1_MAX_FILE_BYTES
  ) {
    throw new Error(`Invalid Moments D1 artifact: ${artifact?.path ?? "<missing>"}.`);
  }
  const absolutePath = resolve(root, artifact.path);
  assertContained(root, absolutePath, artifact.path);
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Moments D1 artifact is not a regular file: ${artifact.path}.`);
  }
  assertContained(rootRealPath, await realpath(absolutePath), artifact.path);
  const actual = await sha256File(absolutePath);
  if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) {
    throw new Error(`Moments D1 artifact checksum/size mismatch: ${artifact.path}.`);
  }
  const audit = auditD1Sql(await readFile(absolutePath, "utf8"));
  if (audit.maxStatementBytes > D1_MAX_STATEMENT_BYTES) {
    throw new Error(`Moments D1 artifact has a statement over 100,000 bytes: ${artifact.path}.`);
  }
  if (audit.explicitTransactions.length > 0) {
    throw new Error(`Moments D1 artifact contains an explicit transaction: ${artifact.path}.`);
  }
  return { ...artifact, absolutePath, auditedMaxStatementBytes: audit.maxStatementBytes };
}

function assertContained(root, path, label) {
  const value = relative(root, path);
  if (value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`Moments D1 artifact escapes its build directory: ${label}.`);
  }
}

async function importValidatedPrivateCopy(client, artifact) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "poapin-moments-d1-artifact-"));
  const privatePath = resolve(temporaryRoot, "artifact.sql");
  try {
    await copyFile(artifact.absolutePath, privatePath);
    await chmod(privatePath, 0o400);
    const before = await sha256File(privatePath);
    if (before.sha256 !== artifact.sha256 || before.byteLength !== artifact.byteLength) {
      throw new Error(`Moments D1 artifact changed before import: ${artifact.path}.`);
    }
    const audit = auditD1Sql(await readFile(privatePath, "utf8"));
    if (
      audit.maxStatementBytes !== artifact.auditedMaxStatementBytes ||
      audit.maxStatementBytes > D1_MAX_STATEMENT_BYTES ||
      audit.explicitTransactions.length > 0
    ) {
      throw new Error(`Moments D1 private artifact audit changed before import: ${artifact.path}.`);
    }
    await client.importFile(privatePath);
    const after = await sha256File(privatePath);
    if (after.sha256 !== artifact.sha256 || after.byteLength !== artifact.byteLength) {
      throw new Error(
        `Moments D1 private artifact changed during import; discard this staging target: ${artifact.path}.`,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertArtifactTableTotals(tables, artifacts) {
  for (const table of BUSINESS_TABLES) {
    const rows = artifacts
      .filter((artifact) => artifact.table === table)
      .reduce((sum, artifact) => sum + artifact.rowCount, 0);
    if (rows !== tables[table]) {
      throw new Error(`Moments D1 shard rows differ from table plan for ${table}.`);
    }
  }
}

async function assertCanonicalMigrations(artifacts) {
  for (const [index, path] of PREPARE_PATHS.entries()) {
    const migrationPath = resolve(PROJECT_ROOT, "migrations/moments", MIGRATION_FILES[index]);
    const metadata = await sha256File(migrationPath);
    if (
      metadata.sha256 !== artifacts[index].sha256 ||
      metadata.byteLength !== artifacts[index].byteLength
    ) {
      throw new Error(`Moments prepare artifact differs from canonical migration ${path}.`);
    }
  }
}

async function buildExpectedSchemaPrefixes() {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  const result = [];
  try {
    for (const file of MIGRATION_FILES) {
      const path = resolve(PROJECT_ROOT, "migrations/moments", file);
      database.exec(await readFile(path, "utf8"));
      result.push(
        database
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name;",
          )
          .all()
          .map(schemaRow),
      );
    }
    return result;
  } finally {
    database.close();
  }
}

function schemaRow(row) {
  return {
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name ?? row.table),
    sql: canonicalSchemaSql(row.sql),
  };
}

function canonicalSchemaSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
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
  if (!(await configuredDatabaseIds(context.projectConfig)).has(context.target.id)) return;
  if (!options.allowConfiguredEmptyTarget || !options.confirmWorkerNotActivated) {
    throw new Error(
      "The target appears in wrangler.jsonc. Pass both --allow-configured-empty-target and " +
        "--confirm-worker-not-activated only for a verified empty staging target.",
    );
  }
}

async function createWranglerClient(target, options, dependencies) {
  if (dependencies.createClient) return dependencies.createClient(target);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "poapin-moments-d1-loader-"));
  const configPath = resolve(temporaryRoot, "wrangler.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: "poapin-moments-d1-loader",
        compatibility_date: "2026-07-23",
        ...(options.accountId ? { account_id: options.accountId } : {}),
        d1_databases: [
          {
            binding: "POAP_IMPORT_DB",
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
        `Wrangler failed for ${target.name}: ${stderr.trim() || stdout.trim() || `exit ${code}`}`,
      );
    }
    return parseWranglerJson(stdout);
  };
  try {
    const identity = await runJson([
      "d1",
      "info",
      "POAP_IMPORT_DB",
      "--config",
      configPath,
      "--json",
    ]);
    if (identity?.uuid !== target.id || identity?.name !== target.name) {
      throw new Error("Wrangler resolved a different D1 target identity.");
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const execute = async (argument, value) => {
    const response = await runJson([
      "d1",
      "execute",
      "POAP_IMPORT_DB",
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
    async importFile(path) {
      return execute("--file", path);
    },
    async close() {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
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
      // Wrangler can print an upload prelude before its JSON payload.
    }
  }
  if (parsed.length === 1) return parsed[0];
  throw new Error("Wrangler output does not contain one complete JSON document.");
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

async function schemaPrefixState(context, client) {
  const remote = (
    await client.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY type, name;",
    )
  ).map(schemaRow);
  if (remote.length === 0) return 0;
  for (let index = 0; index < context.expectedSchemaPrefixes.length; index += 1) {
    if (sameSchema(remote, context.expectedSchemaPrefixes[index])) return index + 1;
  }
  throw new Error("Moments target schema is partial, changed, or contains unexpected objects.");
}

function sameSchema(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.type === right[index].type &&
        row.name === right[index].name &&
        row.table === right[index].table &&
        row.sql === right[index].sql,
    )
  );
}

export async function preflight(context, client) {
  const state = await schemaPrefixState(context, client);
  if (state !== 0) throw new Error("Moments preflight requires a pristine D1 database.");
}

export async function load(context, client) {
  let schemaState = await schemaPrefixState(context, client);
  for (let index = schemaState; index < context.prepareArtifacts.length; index += 1) {
    const artifact = context.prepareArtifacts[index];
    process.stderr.write(
      `[moments-d1-loader] prepare ${index + 1}/${context.prepareArtifacts.length} ${artifact.path}\n`,
    );
    await importValidatedPrivateCopy(client, artifact);
    schemaState = await schemaPrefixState(context, client);
    if (schemaState !== index + 1) {
      throw new Error(`Moments schema did not reach canonical prepare phase ${index + 1}.`);
    }
  }

  const existing = await journalMap(client);
  assertKnownMarkers(context, existing);
  assertAllExistingMarkers(context, existing);
  const existingCounts = await readTableCounts(client);
  assertCountsMatchMarkers(existingCounts, existing);
  const meta = await readMeta(client);
  if (meta.ready === "1") throw new Error("Moments target is already activated.");
  let importPlanReady = existing.has(context.dataArtifacts[0].path);
  if (importPlanReady) await assertImportPlan(context, client, existingCounts);

  for (const [index, artifact] of context.dataArtifacts.entries()) {
    if (artifact.table !== "moments_import_plan" && !importPlanReady) {
      throw new Error("Moments source shards cannot load before the import plan.");
    }
    if (existing.has(artifact.path)) {
      process.stderr.write(
        `[moments-d1-loader] load ${index + 1}/${context.dataArtifacts.length} verified ${artifact.path}\n`,
      );
      continue;
    }
    process.stderr.write(
      `[moments-d1-loader] load ${index + 1}/${context.dataArtifacts.length} importing ${artifact.path}\n`,
    );
    await importValidatedPrivateCopy(client, artifact);
    const marker = await journalMarker(client, context.snapshotId, artifact.path);
    assertMarker(context, artifact, marker);
    existing.set(artifact.path, marker);
    if (artifact.table === "moments_import_plan") {
      await assertImportPlan(context, client);
      importPlanReady = true;
    }
  }
}

export async function verify(context, client, { writeReport = true } = {}) {
  const report = await collectVerification(context, client);
  if (!writeReport) return report;
  const reportPath = resolve(context.root, "verification", `${context.target.id}.json`);
  await writeJsonAtomic(reportPath, report);
  return { ...report, reportPath, reportMetadata: await sha256File(reportPath) };
}

async function collectVerification(context, client) {
  if ((await schemaPrefixState(context, client)) !== context.prepareArtifacts.length) {
    throw new Error("Moments target does not have the complete canonical schema.");
  }
  const markers = await journalMap(client);
  assertKnownMarkers(context, markers);
  for (const artifact of context.dataArtifacts)
    assertMarker(context, artifact, markers.get(artifact.path));
  const counts = await readTableCounts(client);
  assertCountsMatchPlan(context.manifest.tables, counts);
  assertCountsMatchMarkers(counts, markers);
  await assertImportPlan(context, client, counts);
  const meta = await readMeta(client);
  assertStagedMeta(context, meta);

  const foreignKeys = await client.query("PRAGMA foreign_key_check;");
  if (foreignKeys.length !== 0) throw new Error("Moments target has foreign-key violations.");
  const integrity = await client.query("PRAGMA quick_check;");
  if (integrity.length !== 1 || String(integrity[0].quick_check).toLowerCase() !== "ok") {
    throw new Error("Moments target did not pass PRAGMA quick_check.");
  }

  const [projection] = await client.query(`SELECT
    (SELECT COUNT(*) FROM public_moments) AS public_moments,
    (SELECT COUNT(*) FROM public_capsules) AS public_capsules,
    (SELECT COUNT(*) FROM moment_visibility WHERE is_public = 1) AS visible_moments,
    (SELECT COUNT(*) FROM public_moments public_moment
      WHERE NOT EXISTS (SELECT 1 FROM moment_drops relation WHERE relation.moment_id = public_moment.moment_id)
        OR EXISTS (
          SELECT 1 FROM moment_drops relation
          JOIN moment_hidden_drops hidden ON hidden.drop_id = relation.drop_id
          WHERE relation.moment_id = public_moment.moment_id
        )
        OR EXISTS (
          SELECT 1 FROM moment_suppressions suppression
          WHERE suppression.moment_id = public_moment.moment_id AND suppression.active = 1
        )
    ) AS invalid_public_moments;`);
  const publicMoments = safeCount(projection?.public_moments, "public_moments");
  const publicCapsules = safeCount(projection?.public_capsules, "public_capsules");
  const visibleMoments = safeCount(projection?.visible_moments, "visible_moments");
  const invalidPublicMoments = safeCount(
    projection?.invalid_public_moments,
    "invalid_public_moments",
  );
  if (
    publicMoments !== context.manifest.projection.publicMoments ||
    publicCapsules !== context.manifest.projection.publicCapsules ||
    visibleMoments !== publicMoments ||
    invalidPublicMoments !== 0
  ) {
    throw new Error("Moments public projection differs from the fail-closed build plan.");
  }

  const mediaStatuses = Object.fromEntries(MEDIA_STATUSES.map((status) => [status, 0]));
  for (const row of await client.query(
    "SELECT archive_status, COUNT(*) AS row_count FROM moment_media GROUP BY archive_status ORDER BY archive_status;",
  )) {
    if (!(row.archive_status in mediaStatuses)) {
      throw new Error(`Moments target has an unknown media status ${row.archive_status}.`);
    }
    mediaStatuses[row.archive_status] = safeCount(row.row_count, `media ${row.archive_status}`);
  }
  if (JSON.stringify(mediaStatuses) !== JSON.stringify(context.manifest.media.statuses)) {
    throw new Error("Moments media status counts differ from the build manifest.");
  }
  const indexes = await verifyQueryPlans(client);

  return {
    schemaVersion: "poapin-moments-d1-verification-v1",
    verified: true,
    verifiedAt: new Date().toISOString(),
    snapshotId: context.snapshotId,
    sourceDatabaseSha256: context.sourceDatabaseSha256,
    target: context.target,
    buildManifest: {
      path: "manifest.json",
      ...context.manifestMetadata,
    },
    ready: false,
    tables: counts,
    journal: {
      expectedShards: context.dataArtifacts.length,
      verifiedShards: markers.size,
    },
    integrity: {
      foreignKeyViolations: 0,
      result: "ok",
    },
    publicProjection: {
      publicMoments,
      visibleMoments,
      publicCapsules,
      invalidPublicMoments,
    },
    media: {
      mode: context.manifest.media.mode,
      ready: context.manifest.media.ready,
      rows: context.manifest.media.rows,
      statuses: mediaStatuses,
      note:
        context.manifest.media.mode === "metadata-only"
          ? "Media bodies are not part of this release; every media row remains pending."
          : "Media rows are bound to the completed archive capture proof.",
    },
    indexes,
  };
}

async function verifyQueryPlans(client) {
  const checks = [
    [
      "recent",
      "EXPLAIN QUERY PLAN SELECT moment_id FROM moments ORDER BY created_on DESC, moment_id DESC LIMIT 48;",
      "idx_moments_recent",
    ],
    [
      "author",
      "EXPLAIN QUERY PLAN SELECT moment_id FROM moments WHERE author_address_norm = '0x0000000000000000000000000000000000000000' ORDER BY created_on DESC, moment_id DESC LIMIT 48;",
      "idx_moments_author_recent",
    ],
    [
      "drop",
      "EXPLAIN QUERY PLAN SELECT moment_id FROM moment_drops WHERE drop_id = 1 ORDER BY moment_id LIMIT 48;",
      "idx_moment_drops_drop",
    ],
    [
      "collection",
      "EXPLAIN QUERY PLAN SELECT moment_id FROM moment_collections WHERE collection_id = 1 ORDER BY moment_id LIMIT 48;",
      "idx_moment_collections_collection",
    ],
    [
      "media",
      "EXPLAIN QUERY PLAN SELECT media_key FROM moment_media WHERE moment_id = '00000000-0000-4000-8000-000000000000' ORDER BY position, created_at, media_key LIMIT 48;",
      "idx_moment_media_moment",
    ],
  ];
  const verified = [];
  for (const [name, sql, index] of checks) {
    const plan = await client.query(sql);
    if (!plan.some((row) => String(row.detail ?? "").includes(index))) {
      throw new Error(`Moments ${name} query plan does not use ${index}.`);
    }
    verified.push(index);
  }
  return verified;
}

export async function activate(
  context,
  client,
  verificationReportPath,
  { allowMetadataOnly = false } = {},
) {
  const reportPath = resolve(verificationReportPath);
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Moments verification report must be a regular file.");
  }
  const reportInput = await readJsonWithMetadata(reportPath, "Moments verification report");
  const report = reportInput.value;
  validateVerificationReport(context, report);
  if (report.media.mode === "metadata-only" && !allowMetadataOnly) {
    throw new Error("Metadata-only activation requires --allow-metadata-only.");
  }
  const reportMetadata = reportInput.metadata;
  const currentMeta = await readMeta(client);
  if (currentMeta.ready === "1") {
    assertActivatedMeta(context, currentMeta, reportMetadata.sha256);
    return { activated: true, alreadyActivated: true };
  }

  const current = await collectVerification(context, client);
  assertVerificationStateMatches(report, current);
  const proposedActivatedAt = new Date().toISOString();
  await client.query(`INSERT INTO moments_meta (key, value) VALUES
    ('activation_database_id', ${sqlLiteral(context.target.id)}),
    ('activation_report_sha256', ${sqlLiteral(reportMetadata.sha256)}),
    ('build_manifest_sha256', ${sqlLiteral(context.manifestMetadata.sha256)}),
    ('activated_at', ${sqlLiteral(proposedActivatedAt)})
    ON CONFLICT(key) DO NOTHING;`);
  const activationMeta = await readMeta(client);
  const activatedAt = assertPendingActivationMeta(context, activationMeta, reportMetadata.sha256);
  await client.query(buildAtomicActivationSql(context, reportMetadata.sha256, activatedAt));
  const activatedMeta = await readMeta(client);
  if (activatedMeta.ready !== "1") {
    throw new Error(
      "Moments atomic activation gate rejected the target; discard this staging database.",
    );
  }
  assertActivatedMeta(context, activatedMeta, reportMetadata.sha256);
  return { activated: true, alreadyActivated: false, activatedAt };
}

function buildAtomicActivationSql(context, reportSha256, activatedAt) {
  const expectedMeta = {
    ...expectedStagedMeta(context),
    activation_database_id: context.target.id,
    activation_report_sha256: reportSha256,
    build_manifest_sha256: context.manifestMetadata.sha256,
    activated_at: activatedAt,
  };
  const conditions = [
    ...Object.entries(expectedMeta).map(
      ([key, value]) =>
        `(SELECT value FROM moments_meta WHERE key = ${sqlLiteral(key)}) = ${sqlLiteral(value)}`,
    ),
    `(SELECT COUNT(*) FROM moments_meta) = ${context.manifest.tables.moments_meta + 4}`,
    `(SELECT COUNT(*) FROM import_shards) = ${context.dataArtifacts.length}`,
    `(SELECT COUNT(*) FROM public_moments) = ${context.manifest.projection.publicMoments}`,
    `(SELECT COUNT(*) FROM public_capsules) = ${context.manifest.projection.publicCapsules}`,
    `(SELECT COUNT(*) FROM moment_visibility WHERE is_public = 1) = ${context.manifest.projection.publicMoments}`,
    `(SELECT COUNT(*) FROM public_moments public_moment
      WHERE NOT EXISTS (SELECT 1 FROM moment_drops relation WHERE relation.moment_id = public_moment.moment_id)
        OR EXISTS (
          SELECT 1 FROM moment_drops relation
          JOIN moment_hidden_drops hidden ON hidden.drop_id = relation.drop_id
          WHERE relation.moment_id = public_moment.moment_id
        )
        OR EXISTS (
          SELECT 1 FROM moment_suppressions suppression
          WHERE suppression.moment_id = public_moment.moment_id AND suppression.active = 1
        )) = 0`,
  ];
  for (const table of BUSINESS_TABLES) {
    const expected =
      table === "moments_meta"
        ? context.manifest.tables.moments_meta + 4
        : context.manifest.tables[table];
    conditions.push(`(SELECT COUNT(*) FROM "${table}") = ${expected}`);
  }
  for (const table of IMMUTABLE_TABLES) {
    conditions.push(
      `EXISTS (SELECT 1 FROM moments_import_plan WHERE table_name = ${sqlLiteral(table)} AND expected_rows = ${context.manifest.tables[table]} AND loaded_rows = expected_rows)`,
    );
  }
  for (const status of MEDIA_STATUSES) {
    conditions.push(
      `(SELECT COUNT(*) FROM moment_media WHERE archive_status = ${sqlLiteral(status)}) = ${context.manifest.media.statuses[status]}`,
    );
  }
  return `UPDATE moments_meta SET value = '1'
    WHERE key = 'ready' AND value = '0'
      AND ${conditions.join("\n      AND ")};`;
}

function validateVerificationReport(context, report) {
  if (
    report?.schemaVersion !== "poapin-moments-d1-verification-v1" ||
    report.verified !== true ||
    report.ready !== false ||
    report.snapshotId !== context.snapshotId ||
    report.sourceDatabaseSha256 !== context.sourceDatabaseSha256 ||
    report.target?.id !== context.target.id ||
    report.target?.name !== context.target.name ||
    report.buildManifest?.path !== "manifest.json" ||
    report.buildManifest.sha256 !== context.manifestMetadata.sha256 ||
    report.buildManifest.byteLength !== context.manifestMetadata.byteLength ||
    report.journal?.expectedShards !== context.dataArtifacts.length ||
    report.journal?.verifiedShards !== context.dataArtifacts.length ||
    report.integrity?.foreignKeyViolations !== 0 ||
    report.integrity?.result !== "ok" ||
    JSON.stringify(report.tables) !== JSON.stringify(context.manifest.tables) ||
    report.publicProjection?.publicMoments !== context.manifest.projection.publicMoments ||
    report.publicProjection?.visibleMoments !== context.manifest.projection.publicMoments ||
    report.publicProjection?.publicCapsules !== context.manifest.projection.publicCapsules ||
    report.publicProjection?.invalidPublicMoments !== 0 ||
    report.media?.mode !== context.manifest.media.mode ||
    report.media?.ready !== context.manifest.media.ready ||
    report.media?.rows !== context.manifest.media.rows ||
    JSON.stringify(report.media?.statuses) !== JSON.stringify(context.manifest.media.statuses)
  ) {
    throw new Error("Moments verification report is not bound to this build and target.");
  }
}

function assertVerificationStateMatches(report, current) {
  for (const key of ["tables", "publicProjection", "media", "journal", "integrity", "indexes"]) {
    if (JSON.stringify(report[key]) !== JSON.stringify(current[key])) {
      throw new Error(`Moments target changed after verification: ${key}.`);
    }
  }
}

function assertActivatedMeta(context, meta, reportSha256) {
  const expected = {
    ready: "1",
    snapshot_id: context.snapshotId,
    source_database_sha256: context.sourceDatabaseSha256,
    activation_database_id: context.target.id,
    activation_report_sha256: reportSha256,
    build_manifest_sha256: context.manifestMetadata.sha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== value) throw new Error(`Moments activation metadata mismatch for ${key}.`);
  }
  if (!Number.isFinite(Date.parse(meta.activated_at ?? ""))) {
    throw new Error("Moments activation metadata has an invalid activated_at value.");
  }
}

function assertStagedMeta(context, meta) {
  const expected = expectedStagedMeta(context);
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== value) throw new Error(`Moments staged metadata mismatch for ${key}.`);
  }
  if (Object.keys(meta).length !== context.manifest.tables.moments_meta) {
    throw new Error("Moments staged metadata contains unexpected or missing rows.");
  }
}

function expectedStagedMeta(context) {
  const expected = {
    ready: "0",
    snapshot_id: context.snapshotId,
    dataset: "poap-compass-moments",
    source_manifest_sha256: context.manifest.source.manifest.sha256,
    source_database_sha256: context.sourceDatabaseSha256,
    source_started_at: context.manifest.source.stability.primary.startedAt,
    source_finished_at: context.manifest.source.stability.primary.finishedAt,
    snapshot_at: context.manifest.source.stability.primary.finishedAt,
    source_moments_count: String(context.manifest.tables.moments),
    public_moments_count: String(context.manifest.projection.publicMoments),
    media_count: String(context.manifest.media.rows),
    media_mode: context.manifest.media.mode,
    capsules_count: String(context.manifest.tables.capsules),
    public_capsules_count: String(context.manifest.projection.publicCapsules),
    media_manifest: context.manifest.mediaManifest?.path ?? "",
    collection_map: context.manifest.collectionMap?.path ?? "",
  };
  for (const status of MEDIA_STATUSES) {
    expected[`media_status_${status}`] = String(context.manifest.media.statuses[status]);
  }
  if (Object.keys(expected).length !== context.manifest.tables.moments_meta) {
    throw new Error("Moments build manifest has an unexpected staged metadata row count.");
  }
  return expected;
}

function assertPendingActivationMeta(context, meta, reportSha256) {
  const expected = {
    ...expectedStagedMeta(context),
    activation_database_id: context.target.id,
    activation_report_sha256: reportSha256,
    build_manifest_sha256: context.manifestMetadata.sha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== value) {
      throw new Error(`Moments pending activation metadata mismatch for ${key}.`);
    }
  }
  if (
    Object.keys(meta).length !== context.manifest.tables.moments_meta + 4 ||
    !Number.isFinite(Date.parse(meta.activated_at ?? ""))
  ) {
    throw new Error("Moments pending activation metadata is incomplete or unexpected.");
  }
  return meta.activated_at;
}

async function readMeta(client) {
  try {
    const rows = await client.query("SELECT key, value FROM moments_meta ORDER BY key;");
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } catch (error) {
    if (/no such table/i.test(String(error?.message))) return {};
    throw error;
  }
}

async function readJsonWithMetadata(path, label) {
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return {
    value,
    metadata: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    },
  };
}

async function assertImportPlan(context, client, counts = null) {
  const rows = await client.query(
    "SELECT table_name, expected_rows, loaded_rows FROM moments_import_plan ORDER BY table_name;",
  );
  const actualCounts = counts ?? (await readTableCounts(client));
  const expected = [...IMMUTABLE_TABLES].sort().map((table) => ({
    table_name: table,
    expected_rows: context.manifest.tables[table],
    loaded_rows: actualCounts[table],
  }));
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        row.table_name !== expected[index].table_name ||
        safeCount(row.expected_rows, `import plan ${row.table_name}`) !==
          expected[index].expected_rows ||
        safeCount(row.loaded_rows, `import counter ${row.table_name}`) !==
          expected[index].loaded_rows,
    )
  ) {
    throw new Error("Moments target import plan differs from the build manifest.");
  }
}

async function readTableCounts(client) {
  const [row] = await client.query(
    `SELECT ${BUSINESS_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(",\n")};`,
  );
  if (!row) throw new Error("Moments target did not return table counts.");
  return Object.fromEntries(BUSINESS_TABLES.map((table) => [table, safeCount(row[table], table)]));
}

function safeCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Moments target returned an invalid count for ${label}.`);
  }
  return count;
}

function assertCountsMatchPlan(expected, actual) {
  for (const table of BUSINESS_TABLES) {
    if (actual[table] !== expected[table]) {
      throw new Error(`Moments target count mismatch for ${table}.`);
    }
  }
}

function assertCountsMatchMarkers(counts, markers) {
  for (const table of BUSINESS_TABLES) {
    let expected = 0;
    for (const marker of markers.values()) {
      if (marker.table_name === table) expected += Number(marker.row_count);
    }
    if (counts[table] !== expected) {
      throw new Error(`Moments target has unjournaled or missing rows for ${table}.`);
    }
  }
}

async function journalMap(client) {
  const rows = await client.query(
    "SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards ORDER BY snapshot_id, shard_path;",
  );
  const result = new Map();
  for (const row of rows) {
    if (result.has(row.shard_path)) throw new Error(`Moments target repeats ${row.shard_path}.`);
    result.set(row.shard_path, row);
  }
  return result;
}

async function journalMarker(client, snapshotId, path) {
  const rows = await client.query(
    `SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards WHERE snapshot_id = ${sqlLiteral(snapshotId)} AND shard_path = ${sqlLiteral(path)};`,
  );
  if (rows.length > 1) throw new Error(`Moments target repeats marker ${path}.`);
  return rows[0] ?? null;
}

function assertKnownMarkers(context, markers) {
  const expected = new Set(context.dataArtifacts.map((artifact) => artifact.path));
  for (const [path, marker] of markers) {
    if (marker.snapshot_id !== context.snapshotId || !expected.has(path)) {
      throw new Error(`Moments target has an unexpected import marker: ${path}.`);
    }
  }
}

function assertAllExistingMarkers(context, markers) {
  const byPath = new Map(context.dataArtifacts.map((artifact) => [artifact.path, artifact]));
  for (const [path, marker] of markers) assertMarker(context, byPath.get(path), marker);
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
    throw new Error(`Moments import marker mismatch: ${artifact?.path ?? "<unknown>"}.`);
  }
}

function compareArtifactPaths(left, right) {
  return left.path.localeCompare(right.path, "en");
}

export function auditD1Sql(source) {
  const statements = splitSqlStatements(source);
  const explicitTransactions = [];
  let maxStatementBytes = 0;
  for (const statement of statements) {
    maxStatementBytes = Math.max(maxStatementBytes, Buffer.byteLength(statement));
    const prefix = executablePrefix(statement);
    if (["begin", "commit", "end", "rollback", "savepoint", "release"].includes(prefix)) {
      explicitTransactions.push(prefix);
    }
  }
  return { statements: statements.length, maxStatementBytes, explicitTransactions };
}

function splitSqlStatements(source) {
  const statements = [];
  let start = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (quote === "]") {
        if (char === "]") quote = null;
      } else if (char === quote) {
        if (source[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (["'", '"', "`"].includes(char)) quote = char;
    else if (char === "[") quote = "]";
    else if (char === ";") {
      const statement = source.slice(start, index + 1);
      if (isIncompleteTriggerStatement(statement)) continue;
      if (executablePrefix(statement)) statements.push(statement);
      start = index + 1;
    }
  }
  const tail = source.slice(start);
  if (executablePrefix(tail)) statements.push(tail);
  return statements;
}

function isIncompleteTriggerStatement(statement) {
  if (executablePrefix(statement) !== "create") return false;
  const withoutLeadingComments = statement
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .trimStart();
  return (
    /^create\s+(?:(?:temp|temporary)\s+)?trigger\b/i.test(withoutLeadingComments) &&
    !/\bend\s*;\s*$/i.test(statement)
  );
}

function executablePrefix(statement) {
  let index = 0;
  while (index < statement.length) {
    while (/\s/.test(statement[index] ?? "")) index += 1;
    if (statement[index] === "-" && statement[index + 1] === "-") {
      index = statement.indexOf("\n", index + 2);
      if (index < 0) return "";
      continue;
    }
    if (statement[index] === "/" && statement[index + 1] === "*") {
      index = statement.indexOf("*/", index + 2);
      if (index < 0) return "";
      index += 2;
      continue;
    }
    break;
  }
  return (
    statement
      .slice(index)
      .match(/^([a-z]+)/i)?.[1]
      ?.toLowerCase() ?? ""
  );
}

export { BUSINESS_TABLES, parseWranglerJson, assertSuccessfulD1Response };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[moments-d1-loader] ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
