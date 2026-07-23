import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createMomentsBridge } from "../bridge/client.mjs";
import {
  appendJsonLine,
  readNdjson,
  readNdjsonBound,
  sha256File,
  writeJsonAtomic,
  writeNdjsonAtomic,
} from "./io.mjs";
import { momentsMediaObjectKey } from "./object-identity.mjs";
import { evaluateMomentsMediaRecovery } from "./recovery-executor.mjs";
import { detectMediaType, isDeclaredTypeCompatible } from "./sniff.mjs";
import {
  MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA,
  buildMomentsStoredObjectSet,
  canonicalMomentsBridgeOrigin,
  validateMomentsBucketPair,
} from "./verification.mjs";

const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEDIA_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_HOST = "cdn.media.poap.tech";
const USER_AGENT = "POAPin-Archive-Moments-Media/0.1 (+https://poap.in)";
const CHECKPOINT_VERSION = 1;
const D1_MEDIA_PROOF_SCHEMA = "poapin-moments-d1-media-proof-v1";
const VERIFICATION_ALGORITHM = "poapin-r2-head-all-v1";
const VERIFICATION_RUN_ID_ALGORITHM = "os-csprng-128-bit-hex-v1";
const VERIFICATION_RUN_ID = /^[0-9a-f]{32}$/;
const TERMINAL = new Set([
  "public_stored",
  "private_stored",
  "quarantined_stored",
  "source_missing",
  "oversize",
]);

export { momentsMediaObjectKey } from "./object-identity.mjs";

export async function captureMomentsMedia({
  input,
  snapshotId,
  bridgeUrl,
  publicBucket,
  privateBucket,
  concurrency = 3,
  attempts = 4,
  maximumObjectBytes = 100_000_000,
  checkpointPath,
  manifestPath,
  reportPath,
  signal,
  bridge: injectedBridge,
  fetchImpl = fetch,
  onProgress = () => {},
} = {}) {
  validateOptions({ snapshotId, concurrency, attempts, maximumObjectBytes });
  validateMomentsBucketPair(publicBucket, privateBucket);
  const root = resolve(input ?? "");
  const planPath = join(root, "media", "plan.ndjson");
  const planInput = await readNdjsonBound(planPath);
  const plan = planInput.rows;
  validatePlan(plan);
  validateCapturePlanCoverage(
    plan,
    (await readNdjsonBound(join(root, "normalized", "moment_media.ndjson"))).rows,
  );
  const planMetadata = boundNdjsonMetadata(planInput);
  const paths = {
    checkpoint: resolve(checkpointPath ?? join(root, "media", "capture-checkpoint.ndjson")),
    manifest: resolve(manifestPath ?? join(root, "media", "d1-media-manifest.ndjson")),
    report: resolve(reportPath ?? join(root, "media", "capture-report.json")),
  };
  const bridge =
    injectedBridge ??
    createMomentsBridge({
      bridgeUrl,
      snapshotId,
      publicBucket,
      privateBucket,
      maximumObjectBytes,
      attempts,
    });
  await bridge.verifyTargets({ signal });

  const context = {
    schemaVersion: "poapin-moments-media-checkpoint-v1",
    version: CHECKPOINT_VERSION,
    kind: "header",
    snapshotId,
    planSha256: planMetadata.sha256,
    planRows: plan.length,
    publicBucket,
    privateBucket,
    maximumObjectBytes,
  };
  const checkpoint = await openCheckpoint(paths.checkpoint, context);
  const pending = plan.filter((row) => !TERMINAL.has(checkpoint.records.get(row.planId)?.status));
  const tempRoot = await mkdtemp(join(tmpdir(), "poapin-moments-media-"));
  let settled = 0;

  try {
    await runPool(pending, concurrency, async (row, index) => {
      throwIfAborted(signal);
      const temporary = join(tempRoot, `${String(index).padStart(6, "0")}.media`);
      let record;
      try {
        record = await captureOne({
          row,
          temporary,
          snapshotId,
          maximumObjectBytes,
          attempts,
          bridge,
          fetchImpl,
          signal,
        });
      } catch (error) {
        const status =
          error?.code === "SOURCE_OVERSIZE"
            ? "oversize"
            : error?.code === "SOURCE_MISSING"
              ? "source_missing"
              : "failed";
        record = {
          kind: "media",
          planId: row.planId,
          mediaKey: row.mediaKey,
          gatewayId: row.gatewayId,
          status,
          errorCode: safeCode(error),
          httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
          recordedAt: new Date().toISOString(),
        };
      } finally {
        await unlink(temporary).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      await checkpoint.record(record);
      settled += 1;
      onProgress({
        settled,
        total: pending.length,
        status: record.status,
        records: checkpoint.records,
      });
    });
  } finally {
    await rmdir(tempRoot).catch(() => undefined);
  }

  const manifest = buildD1MediaManifest(plan, checkpoint.records);
  const manifestSha256 = await writeNdjsonAtomic(paths.manifest, manifest);
  const evaluation = await evaluateMomentsMediaCapture({
    input: root,
    snapshotId,
    publicBucket,
    privateBucket,
    checkpointPath: paths.checkpoint,
    manifestPath: paths.manifest,
    reportPath: paths.report,
  });
  if (
    manifestSha256 !== evaluation.manifestSha256 ||
    JSON.stringify(manifest) !== JSON.stringify(evaluation.manifest)
  ) {
    throw new Error("D1 media manifest serialization changed after capture evaluation.");
  }
  const report = buildCaptureReport({
    snapshotId,
    plan,
    planSha256: planMetadata.sha256,
    checkpoint,
    manifest,
    manifestSha256,
    paths,
  });
  report.complete = evaluation.complete;
  report.publicProjectionReady = evaluation.publicProjectionReady;
  await writeJsonAtomic(evaluation.paths.proof, {
    schemaVersion: evaluation.proof.schemaVersion,
    snapshotId: evaluation.proof.snapshotId,
    generatedAt: new Date().toISOString(),
    planSha256: evaluation.proof.planSha256,
    manifestSha256: evaluation.proof.manifestSha256,
    manifestRows: evaluation.proof.manifestRows,
    complete: evaluation.proof.complete,
    publicProjectionReady: evaluation.proof.publicProjectionReady,
    checkpointMode: evaluation.proof.checkpointMode,
    publicBucket: evaluation.proof.publicBucket,
    privateBucket: evaluation.proof.privateBucket,
    normalizedMediaSha256: evaluation.proof.normalizedMediaSha256,
    captureCheckpointSha256: evaluation.proof.captureCheckpointSha256,
    recovery: evaluation.proof.recovery,
  });
  report.artifacts.d1MediaProof = {
    path: relativeArtifact(paths.report, evaluation.paths.proof),
  };
  await writeJsonAtomic(paths.report, report);
  return report;
}

export async function evaluateMomentsMediaCapture({
  input,
  snapshotId,
  publicBucket,
  privateBucket,
  checkpointPath,
  manifestPath,
  reportPath,
} = {}) {
  if (!SNAPSHOT.test(snapshotId ?? "")) throw new Error("Snapshot ID is invalid.");
  validateMomentsBucketPair(publicBucket, privateBucket);
  const root = resolve(input ?? "");
  const paths = {
    mediaPlan: join(root, "media", "plan.ndjson"),
    normalizedMedia: join(root, "normalized", "moment_media.ndjson"),
    captureCheckpoint: resolve(checkpointPath ?? join(root, "media", "capture-checkpoint.ndjson")),
    manifest: resolve(manifestPath ?? join(root, "media", "d1-media-manifest.ndjson")),
    report: resolve(reportPath ?? join(root, "media", "capture-report.json")),
  };
  const [mediaPlanInput, normalizedMediaInput, captureInput] = await Promise.all([
    readNdjsonBound(paths.mediaPlan),
    readNdjsonBound(paths.normalizedMedia),
    readNdjsonBound(paths.captureCheckpoint),
  ]);
  const plan = mediaPlanInput.rows;
  const normalizedMedia = normalizedMediaInput.rows;
  const mediaPlanMetadata = boundNdjsonMetadata(mediaPlanInput);
  const normalizedMediaMetadata = boundNdjsonMetadata(normalizedMediaInput);
  const captureMetadata = boundNdjsonMetadata(captureInput);
  validatePlan(plan);
  validateCapturePlanCoverage(plan, normalizedMedia);
  const checkpoint = captureEvaluationCheckpoint(captureInput.rows, {
    snapshotId,
    planSha256: mediaPlanMetadata.sha256,
    planRows: plan.length,
    publicBucket,
    privateBucket,
  });
  validateCaptureEvaluationRecords(plan, checkpoint, snapshotId);
  const manifest = buildD1MediaManifest(plan, checkpoint.records);
  const manifestSha256 = canonicalNdjsonSha256(manifest);
  const recoveryRequired = plan.filter((row) =>
    captureRowRequiresRecovery(row, checkpoint.records.get(row.planId)),
  );
  const publicProjectionReady = plan.every(
    (row) =>
      row.publicEligible !== true || checkpoint.records.get(row.planId)?.status === "public_stored",
  );
  const complete = recoveryRequired.length === 0 && publicProjectionReady;
  const storedObjectSet = buildMomentsStoredObjectSet(checkpoint.storedRecords, {
    snapshotId,
  });
  const proof = {
    schemaVersion: D1_MEDIA_PROOF_SCHEMA,
    snapshotId,
    planSha256: mediaPlanMetadata.sha256,
    manifestSha256,
    manifestRows: manifest.length,
    complete,
    publicProjectionReady,
    checkpointMode: "capture-only",
    publicBucket,
    privateBucket,
    normalizedMediaSha256: normalizedMediaMetadata.sha256,
    captureCheckpointSha256: captureMetadata.sha256,
    recovery: null,
  };
  const inputDigests = {
    mediaPlan: mediaPlanMetadata.sha256,
    normalizedMedia: normalizedMediaMetadata.sha256,
    captureCheckpoint: captureMetadata.sha256,
  };
  await assertCaptureEvaluationInputsCurrent(paths, inputDigests);
  return {
    schemaVersion: "poapin-moments-media-capture-evaluation-v1",
    snapshotId,
    paths: { ...paths, proof: mediaProofPath(paths.manifest) },
    manifest,
    manifestSha256,
    proof,
    binding: {
      snapshotId,
      checkpointMode: "capture-only",
      publicBucket,
      privateBucket,
      mediaPlanSha256: mediaPlanMetadata.sha256,
      mediaPlanRows: plan.length,
      mediaManifestSha256: manifestSha256,
      mediaManifestRows: manifest.length,
      normalizedMediaSha256: normalizedMediaMetadata.sha256,
      captureCheckpointSha256: captureMetadata.sha256,
      recoveryPlanSha256: null,
      recoveryPlanRows: null,
      recoveryCheckpointSha256: null,
      stored: storedObjectSet.stored,
      storedObjectSetSha256: storedObjectSet.sha256,
    },
    complete,
    publicProjectionReady,
    recoveryRequired: recoveryRequired.map((row) => row.planId),
    storedObjectSet,
    limits: {
      maximumObjectBytes: checkpoint.header.maximumObjectBytes,
      maximumMultipartObjectBytes: null,
      multipartPartBytes: null,
    },
    inputDigests,
  };
}

function captureEvaluationCheckpoint(rows, expected) {
  let header = null;
  const records = new Map();
  const history = [];
  const storedRecords = [];
  for (const row of rows) {
    if (row?.kind === "header") {
      if (header) throw new Error("Capture checkpoint contains multiple headers.");
      header = row;
      continue;
    }
    if (row?.kind !== "media" || typeof row.planId !== "string") {
      throw new Error("Capture checkpoint contains an invalid row.");
    }
    records.set(row.planId, row);
    history.push(row);
    if (isStored(row.status)) storedRecords.push(row);
  }
  if (
    header?.schemaVersion !== "poapin-moments-media-checkpoint-v1" ||
    header.version !== CHECKPOINT_VERSION ||
    header.kind !== "header" ||
    header.snapshotId !== expected.snapshotId ||
    header.planSha256 !== expected.planSha256 ||
    header.planRows !== expected.planRows ||
    header.publicBucket !== expected.publicBucket ||
    header.privateBucket !== expected.privateBucket ||
    !Number.isSafeInteger(header.maximumObjectBytes) ||
    header.maximumObjectBytes < 1 ||
    header.maximumObjectBytes > 100_000_000
  ) {
    throw new Error("Capture checkpoint does not match the selected immutable inputs.");
  }
  validateMomentsBucketPair(header.publicBucket, header.privateBucket);
  return { header, records, history, storedRecords };
}

function validateCaptureEvaluationRecords(plan, checkpoint, snapshotId) {
  const planById = new Map(plan.map((row) => [row.planId, row]));
  for (const record of checkpoint.history) {
    const planned = planById.get(record.planId);
    if (
      !planned ||
      record.mediaKey !== record.planId ||
      ![
        "public_stored",
        "private_stored",
        "quarantined_stored",
        "source_missing",
        "oversize",
        "failed",
      ].includes(record.status)
    ) {
      throw new Error("Capture checkpoint contains an invalid media result.");
    }
    if (!isStored(record.status)) {
      if (
        record.target !== undefined ||
        record.objectKey !== undefined ||
        record.sha256 !== undefined ||
        record.byteLength !== undefined ||
        record.contentType !== undefined
      ) {
        throw new Error("Non-stored capture result contains stored object metadata.");
      }
      continue;
    }
    const validRouting =
      (record.status === "public_stored" &&
        planned.publicEligible === true &&
        planned.target === "public" &&
        record.target === "public") ||
      (record.status === "private_stored" &&
        planned.publicEligible === false &&
        planned.target !== "public" &&
        record.target === "private") ||
      (record.status === "quarantined_stored" &&
        planned.publicEligible === true &&
        planned.target === "public" &&
        record.target === "private");
    if (!validRouting) {
      throw new Error("Capture checkpoint contains an invalid stored media result.");
    }
    buildMomentsStoredObjectSet([record], { snapshotId });
  }
}

function validateCapturePlanCoverage(plan, normalizedMedia) {
  const normalizedKeys = new Set();
  for (const row of normalizedMedia) {
    if (!MEDIA_KEY.test(row?.key ?? "") || normalizedKeys.has(row.key)) {
      throw new Error("Normalized moment media contains a missing or duplicate key.");
    }
    normalizedKeys.add(row.key);
  }
  const planKeys = new Set(plan.map((row) => row.mediaKey));
  if (
    planKeys.size !== normalizedKeys.size ||
    [...planKeys].some((key) => !normalizedKeys.has(key))
  ) {
    throw new Error("Moments media plan must cover normalized moment_media keys exactly once.");
  }
}

function captureRowRequiresRecovery(planRow, record) {
  if (planRow.publicEligible === true) return record?.status !== "public_stored";
  return !["public_stored", "private_stored", "quarantined_stored", "source_missing"].includes(
    record?.status,
  );
}

function canonicalNdjsonSha256(rows) {
  const text = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  return createHash("sha256").update(text).digest("hex");
}

function boundNdjsonMetadata(input) {
  return { sha256: input.sha256, byteLength: input.byteLength };
}

async function assertCaptureEvaluationInputsCurrent(paths, inputDigests) {
  await Promise.all([
    assertFileDigest(paths.mediaPlan, inputDigests.mediaPlan, "Media plan"),
    assertFileDigest(paths.normalizedMedia, inputDigests.normalizedMedia, "Normalized media"),
    assertFileDigest(paths.captureCheckpoint, inputDigests.captureCheckpoint, "Capture checkpoint"),
  ]);
}

export async function verifyMomentsMedia({
  input,
  snapshotId,
  bridgeUrl,
  publicBucket,
  privateBucket,
  attempts = 4,
  maximumObjectBytes = 100_000_000,
  concurrency = 6,
  checkpointPath,
  recoveryPlanPath,
  recoveryCheckpointPath,
  manifestPath,
  reportPath,
  previousVerificationReportPath,
  signal,
  bridge: injectedBridge,
  now = Date.now,
  randomBytesImpl = randomBytes,
  onProgress = () => {},
} = {}) {
  validateOptions({
    snapshotId,
    concurrency,
    attempts,
    maximumObjectBytes,
    maximumConcurrency: 12,
  });
  validateMomentsBucketPair(publicBucket, privateBucket);
  const bridgeOrigin = canonicalMomentsBridgeOrigin(bridgeUrl);
  const root = resolve(input ?? "");
  const paths = {
    mediaPlan: join(root, "media", "plan.ndjson"),
    normalizedMedia: join(root, "normalized", "moment_media.ndjson"),
    captureCheckpoint: resolve(checkpointPath ?? join(root, "media", "capture-checkpoint.ndjson")),
    recoveryPlan: resolve(recoveryPlanPath ?? join(root, "media", "recovery-plan.ndjson")),
    recoveryCheckpoint: resolve(
      recoveryCheckpointPath ?? join(root, "media", "recovery-checkpoint.ndjson"),
    ),
    manifest: resolve(manifestPath ?? join(root, "media", "d1-media-manifest.ndjson")),
    report: resolve(reportPath ?? join(root, "media", "verify-report.json")),
  };
  paths.proof = mediaProofPath(paths.manifest);
  const previousPath = previousVerificationReportPath
    ? resolve(previousVerificationReportPath)
    : null;
  const immutablePaths = new Set(
    [
      paths.mediaPlan,
      paths.normalizedMedia,
      paths.captureCheckpoint,
      paths.recoveryPlan,
      paths.recoveryCheckpoint,
      paths.manifest,
      paths.proof,
    ].map((path) => resolve(path)),
  );
  if (immutablePaths.has(paths.report)) {
    throw new Error("Verification report path must not overwrite an immutable input.");
  }
  if (previousPath && (immutablePaths.has(previousPath) || previousPath === paths.report)) {
    throw new Error("Previous verification report must be a distinct, non-input report file.");
  }

  const initialFiles = await readVerificationMediaFiles(paths);
  const checkpointMode = explicitVerificationCheckpointMode(initialFiles.proof.value, {
    snapshotId,
    publicBucket,
    privateBucket,
  });
  const evaluation = await evaluateVerificationMediaState({
    checkpointMode,
    root,
    snapshotId,
    publicBucket,
    privateBucket,
    paths,
  });
  validateVerificationEvaluation(evaluation, {
    snapshotId,
    publicBucket,
    privateBucket,
    maximumObjectBytes,
  });
  validateVerificationMediaFiles(initialFiles, evaluation);
  const binding = mediaVerificationBinding({
    evaluation,
    bridgeOrigin,
    mediaProofSha256: initialFiles.proof.metadata.sha256,
  });
  const previous = previousPath
    ? await readPreviousVerificationReport(previousPath, {
        snapshotId,
        binding,
      })
    : null;
  const pass = previous ? 2 : 1;
  const startedAt = canonicalVerificationNow(now);
  if (previous && Date.parse(previous.verifiedAt) >= Date.parse(startedAt)) {
    throw new Error("Verification pass 2 must start strictly after pass 1 has finished.");
  }
  const runId = createVerificationRunId(randomBytesImpl, previous?.runId ?? null);
  const limits = canonicalVerificationLimits({
    concurrency,
    attempts,
    ...evaluation.limits,
  });
  const bridge =
    injectedBridge ??
    createMomentsBridge({
      bridgeUrl: bridgeOrigin,
      snapshotId,
      publicBucket,
      privateBucket,
      maximumObjectBytes: limits.maximumObjectBytes,
      ...(limits.maximumMultipartObjectBytes === null
        ? {}
        : {
            maximumMultipartObjectBytes: limits.maximumMultipartObjectBytes,
            multipartPartBytes: limits.multipartPartBytes,
          }),
      attempts,
    });
  await bridge.verifyTargets({ signal });

  const records = evaluation.storedObjectSet.objects;
  let verified = 0;
  const failures = [];
  await runPool(records, concurrency, async (record) => {
    try {
      const remote = await bridge.head(remoteObject(record), { signal });
      if (!remote) {
        throw Object.assign(new Error("Remote object is missing."), {
          code: "REMOTE_MISSING",
        });
      }
      verified += 1;
    } catch (error) {
      failures.push({
        objectKey: record.objectKey,
        target: record.target,
        code: safeCode(error),
      });
    }
    onProgress({
      settled: verified + failures.length,
      total: records.length,
      verified,
      failures: failures.length,
    });
  });

  const finalEvaluation = await evaluateVerificationMediaState({
    checkpointMode,
    root,
    snapshotId,
    publicBucket,
    privateBucket,
    paths,
  });
  const finalFiles = await readVerificationMediaFiles(paths);
  validateVerificationEvaluation(finalEvaluation, {
    snapshotId,
    publicBucket,
    privateBucket,
    maximumObjectBytes,
  });
  validateVerificationMediaFiles(finalFiles, finalEvaluation);
  const finalBinding = mediaVerificationBinding({
    evaluation: finalEvaluation,
    bridgeOrigin,
    mediaProofSha256: finalFiles.proof.metadata.sha256,
  });
  if (
    JSON.stringify(finalEvaluation.binding) !== JSON.stringify(evaluation.binding) ||
    JSON.stringify(finalBinding) !== JSON.stringify(binding) ||
    finalFiles.manifest.metadata.sha256 !== initialFiles.manifest.metadata.sha256 ||
    finalFiles.proof.metadata.sha256 !== initialFiles.proof.metadata.sha256
  ) {
    throw new Error("Finalized media evidence changed during remote verification.");
  }

  const verifiedAt = canonicalVerificationNow(now);
  if (Date.parse(verifiedAt) < Date.parse(startedAt)) {
    throw new Error("Verification completion time precedes its start time.");
  }
  const report = {
    schemaVersion: MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA,
    snapshotId,
    pass,
    runId,
    runIdAlgorithm: VERIFICATION_RUN_ID_ALGORITHM,
    algorithm: VERIFICATION_ALGORITHM,
    startedAt,
    verifiedAt,
    previousReportSha256: previous?.sha256 ?? null,
    complete:
      evaluation.complete === true &&
      evaluation.publicProjectionReady === true &&
      failures.length === 0 &&
      verified === records.length,
    binding,
    limits,
    counts: {
      stored: records.length,
      verified,
      failed: failures.length,
    },
    failures: failures.slice(0, 100),
  };
  await writeJsonAtomic(paths.report, report);
  return report;
}

async function evaluateVerificationMediaState({
  checkpointMode,
  root,
  snapshotId,
  publicBucket,
  privateBucket,
  paths,
}) {
  if (checkpointMode === "capture-only") {
    return evaluateMomentsMediaCapture({
      input: root,
      snapshotId,
      publicBucket,
      privateBucket,
      checkpointPath: paths.captureCheckpoint,
      manifestPath: paths.manifest,
      reportPath: paths.report,
    });
  }
  return evaluateMomentsMediaRecovery({
    input: root,
    snapshotId,
    captureCheckpointPath: paths.captureCheckpoint,
    recoveryPlanPath: paths.recoveryPlan,
    checkpointPath: paths.recoveryCheckpoint,
    manifestPath: paths.manifest,
    reportPath: paths.report,
  });
}

function validateVerificationEvaluation(
  evaluation,
  { snapshotId, publicBucket, privateBucket, maximumObjectBytes },
) {
  if (
    evaluation?.snapshotId !== snapshotId ||
    evaluation.binding?.snapshotId !== snapshotId ||
    evaluation.binding.publicBucket !== publicBucket ||
    evaluation.binding.privateBucket !== privateBucket ||
    evaluation.proof?.publicBucket !== publicBucket ||
    evaluation.proof?.privateBucket !== privateBucket ||
    evaluation.limits?.maximumObjectBytes !== maximumObjectBytes ||
    evaluation.storedObjectSet?.stored !== evaluation.binding.stored ||
    evaluation.storedObjectSet?.sha256 !== evaluation.binding.storedObjectSetSha256
  ) {
    throw new Error("Finalized media evaluation does not match verification options.");
  }
  validateMomentsBucketPair(publicBucket, privateBucket);
}

function explicitVerificationCheckpointMode(proof, { snapshotId, publicBucket, privateBucket }) {
  if (
    proof?.schemaVersion !== D1_MEDIA_PROOF_SCHEMA ||
    proof.snapshotId !== snapshotId ||
    proof.publicBucket !== publicBucket ||
    proof.privateBucket !== privateBucket
  ) {
    throw new Error("D1 media proof does not match the selected verification target.");
  }
  validateMomentsBucketPair(proof.publicBucket, proof.privateBucket);
  if (proof.checkpointMode === "capture-only" && proof.recovery === null) {
    return "capture-only";
  }
  if (proof.checkpointMode === "recovery-finalized" && proof.recovery) {
    return "recovery-finalized";
  }
  throw new Error("D1 media proof must declare an explicit finalized checkpoint mode.");
}

async function readVerificationMediaFiles(paths) {
  const [manifest, proof] = await Promise.all([
    readBoundNdjsonBytes(paths.manifest, "D1 media manifest"),
    readBoundJsonBytes(paths.proof, "D1 media proof"),
  ]);
  return { manifest, proof };
}

async function readBoundNdjsonBytes(path, label) {
  const bytes = await readFile(path);
  const text = decodeUtf8(bytes, label);
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${label} contains invalid NDJSON at line ${index + 1}.`);
    }
  }
  return { rows, metadata: bytesMetadata(bytes) };
}

async function readBoundJsonBytes(path, label) {
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    if (error?.message?.startsWith(`${label} is not valid UTF-8`)) throw error;
    throw new Error(`${label} is not valid JSON.`);
  }
  return { value, metadata: bytesMetadata(bytes) };
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function bytesMetadata(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function validateVerificationMediaFiles(files, evaluation) {
  if (
    files.manifest.metadata.sha256 !== evaluation.manifestSha256 ||
    JSON.stringify(files.manifest.rows) !== JSON.stringify(evaluation.manifest)
  ) {
    throw new Error("D1 media manifest is not the exact evaluator output.");
  }
  const proof = files.proof.value;
  const expectedProof = {
    schemaVersion: evaluation.proof.schemaVersion,
    snapshotId: evaluation.proof.snapshotId,
    generatedAt: proof?.generatedAt,
    planSha256: evaluation.proof.planSha256,
    manifestSha256: evaluation.proof.manifestSha256,
    manifestRows: evaluation.proof.manifestRows,
    complete: evaluation.proof.complete,
    publicProjectionReady: evaluation.proof.publicProjectionReady,
    checkpointMode: evaluation.proof.checkpointMode,
    publicBucket: evaluation.proof.publicBucket,
    privateBucket: evaluation.proof.privateBucket,
    normalizedMediaSha256: evaluation.proof.normalizedMediaSha256,
    captureCheckpointSha256: evaluation.proof.captureCheckpointSha256,
    recovery: evaluation.proof.recovery,
  };
  if (
    !isCanonicalInstant(proof?.generatedAt) ||
    JSON.stringify(proof) !== JSON.stringify(expectedProof)
  ) {
    throw new Error("D1 media proof is not the exact evaluator output.");
  }
}

function mediaVerificationBinding({ evaluation, bridgeOrigin, mediaProofSha256 }) {
  return {
    snapshotId: evaluation.binding.snapshotId,
    checkpointMode: evaluation.binding.checkpointMode,
    publicBucket: evaluation.binding.publicBucket,
    privateBucket: evaluation.binding.privateBucket,
    bridgeOrigin,
    mediaPlanSha256: evaluation.binding.mediaPlanSha256,
    mediaManifestSha256: evaluation.binding.mediaManifestSha256,
    mediaProofSha256,
    normalizedMediaSha256: evaluation.binding.normalizedMediaSha256,
    captureCheckpointSha256: evaluation.binding.captureCheckpointSha256,
    recoveryPlanSha256: evaluation.binding.recoveryPlanSha256,
    recoveryCheckpointSha256: evaluation.binding.recoveryCheckpointSha256,
    stored: evaluation.binding.stored,
    storedObjectSetSha256: evaluation.binding.storedObjectSetSha256,
  };
}

async function readPreviousVerificationReport(path, { snapshotId, binding }) {
  const input = await readBoundJsonBytes(path, "Previous remote verification report");
  const report = input.value;
  const limits = canonicalVerificationLimits(report?.limits);
  const expected = {
    schemaVersion: MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA,
    snapshotId,
    pass: 1,
    runId: report?.runId,
    runIdAlgorithm: VERIFICATION_RUN_ID_ALGORITHM,
    algorithm: VERIFICATION_ALGORITHM,
    startedAt: report?.startedAt,
    verifiedAt: report?.verifiedAt,
    previousReportSha256: null,
    complete: true,
    binding,
    limits,
    counts: {
      stored: binding.stored,
      verified: binding.stored,
      failed: 0,
    },
    failures: [],
  };
  if (
    !VERIFICATION_RUN_ID.test(report?.runId ?? "") ||
    !isCanonicalInstant(report?.startedAt) ||
    !isCanonicalInstant(report?.verifiedAt) ||
    Date.parse(report.startedAt) > Date.parse(report.verifiedAt) ||
    JSON.stringify(report) !== JSON.stringify(expected)
  ) {
    throw new Error("Previous remote verification report is not a complete canonical pass 1.");
  }
  return {
    runId: report.runId,
    verifiedAt: report.verifiedAt,
    sha256: input.metadata.sha256,
  };
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
    throw new Error("Remote media verification limits are invalid.");
  }
  return limits;
}

function canonicalVerificationNow(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Verification clock returned an invalid time.");
  }
  return value.toISOString();
}

function createVerificationRunId(randomBytesImpl, previousRunId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = Buffer.from(randomBytesImpl(16));
    if (bytes.byteLength !== 16) {
      throw new Error("Verification run ID source must return exactly 16 bytes.");
    }
    const runId = bytes.toString("hex");
    if (!VERIFICATION_RUN_ID.test(runId)) {
      throw new Error("Verification run ID source returned invalid random bytes.");
    }
    if (runId !== previousRunId) return runId;
  }
  throw new Error("Verification run ID collided repeatedly with the previous pass.");
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

async function captureOne({
  row,
  temporary,
  snapshotId,
  maximumObjectBytes,
  attempts,
  bridge,
  fetchImpl,
  signal,
}) {
  if (!row.sourceUrl) {
    return checkpointRecord(row, { status: "source_missing", errorCode: "NO_CANONICAL_SOURCE" });
  }
  const source = await downloadWithRetries({
    url: row.sourceUrl,
    path: temporary,
    maximumObjectBytes,
    attempts,
    fetchImpl,
    signal,
  });
  const detected = detectMediaType(source.prefix, row.declaredContentType);
  const compatible =
    detected && isDeclaredTypeCompatible(row.declaredContentType, detected.contentType);
  const target = row.target === "public" && compatible ? "public" : "private";
  const contentType = detected?.contentType ?? "application/octet-stream";
  const extension = detected?.extension ?? "bin";
  const key = momentsMediaObjectKey(snapshotId, target, source.sha256, extension);
  const object = {
    target,
    key,
    byteLength: source.byteLength,
    sha256: source.sha256,
    contentType,
  };
  const existing = await bridge.head(object, { signal });
  const upload = existing
    ? { disposition: "reused", etag: existing.etag }
    : await bridge.uploadFile(object, temporary, { signal });
  const quarantined = target === "private" && row.target === "public";
  return checkpointRecord(row, {
    status: quarantined ? "quarantined_stored" : `${target}_stored`,
    target,
    objectKey: key,
    sha256: source.sha256,
    byteLength: source.byteLength,
    contentType,
    sourceContentType: source.responseContentType,
    sourceEtag: source.etag,
    declaredTypeCompatible: Boolean(compatible),
    disposition: upload.disposition,
    etag: upload.etag,
  });
}

async function downloadWithRetries(options) {
  let latest;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await downloadSource(options);
    } catch (error) {
      latest = error;
      if (
        options.signal?.aborted ||
        error?.code === "SOURCE_OVERSIZE" ||
        error?.code === "SOURCE_MISSING" ||
        (!isRetryableStatus(error?.httpStatus) && error?.httpStatus) ||
        attempt === options.attempts
      ) {
        throw error;
      }
      await delay(500 * 2 ** (attempt - 1), undefined, { signal: options.signal });
    }
  }
  throw latest;
}

async function downloadSource({ url, path, maximumObjectBytes, fetchImpl, signal }) {
  validateSourceUrl(url);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": USER_AGENT },
    redirect: "error",
    signal,
  });
  if ([404, 410].includes(response.status)) {
    const error = Object.assign(new Error("Source media is no longer available."), {
      code: "SOURCE_MISSING",
      httpStatus: response.status,
    });
    throw error;
  }
  if (!response.ok || !response.body) {
    const error = Object.assign(new Error(`Source media returned HTTP ${response.status}.`), {
      code: "SOURCE_HTTP_ERROR",
      httpStatus: response.status,
    });
    throw error;
  }
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > maximumObjectBytes) throw oversizeError();
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw Object.assign(new Error("Compressed source responses are not accepted."), {
      code: "SOURCE_CONTENT_ENCODING",
    });
  }

  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const rawChunk of response.body) {
      throwIfAborted(signal);
      const chunk = Buffer.from(rawChunk);
      byteLength += chunk.byteLength;
      if (byteLength > maximumObjectBytes) throw oversizeError();
      hash.update(chunk);
      if (prefix.byteLength < 64) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.byteLength)]);
      }
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (byteLength < 1) {
    throw Object.assign(new Error("Source media was empty."), { code: "SOURCE_EMPTY" });
  }
  if (contentLength !== null && contentLength !== byteLength) {
    throw Object.assign(new Error("Source Content-Length did not match the downloaded bytes."), {
      code: "SOURCE_LENGTH_MISMATCH",
    });
  }
  const details = await stat(path);
  if (details.size !== byteLength) throw new Error("Temporary media file length mismatch.");
  return {
    sha256: hash.digest("hex"),
    byteLength,
    prefix,
    responseContentType: normalizeContentType(response.headers.get("content-type")),
    etag: safeHeader(response.headers.get("etag")),
  };
}

function buildD1MediaManifest(plan, records) {
  return plan.map((row) => {
    const record = records.get(row.planId);
    return {
      mediaKey: row.mediaKey,
      objectKey: record?.status === "public_stored" ? record.objectKey : null,
      sha256: record?.sha256 ?? null,
      byteLength: record?.byteLength ?? null,
      contentType: record?.contentType ?? null,
      status: record?.status ?? (row.sourceUrl ? "unattempted" : "source_missing"),
    };
  });
}

function buildCaptureReport({
  snapshotId,
  plan,
  planSha256,
  checkpoint,
  manifest,
  manifestSha256,
  paths,
}) {
  const counts = {
    planned: plan.length,
    publicEligible: plan.filter((row) => row.publicEligible).length,
    publicStored: 0,
    privateStored: 0,
    quarantinedStored: 0,
    sourceMissing: 0,
    oversize: 0,
    failed: 0,
    unattempted: 0,
  };
  for (const row of manifest) {
    const name = {
      public_stored: "publicStored",
      private_stored: "privateStored",
      quarantined_stored: "quarantinedStored",
      source_missing: "sourceMissing",
      oversize: "oversize",
      failed: "failed",
      unattempted: "unattempted",
    }[row.status];
    if (name) counts[name] += 1;
  }
  return {
    schemaVersion: "poapin-moments-media-capture-v1",
    snapshotId,
    generatedAt: new Date().toISOString(),
    complete: counts.failed === 0 && counts.oversize === 0 && counts.unattempted === 0,
    publicProjectionReady:
      counts.failed === 0 &&
      counts.oversize === 0 &&
      counts.unattempted === 0 &&
      plan.every((row) => {
        if (!row.publicEligible || !row.sourceUrl) return true;
        return checkpoint.records.get(row.planId)?.status === "public_stored";
      }),
    counts,
    artifacts: {
      plan: {
        path: relativeArtifact(paths.report, join(dirname(paths.checkpoint), "plan.ndjson")),
        sha256: planSha256,
      },
      checkpoint: {
        path: relativeArtifact(paths.report, paths.checkpoint),
        records: checkpoint.records.size,
      },
      d1MediaManifest: {
        path: relativeArtifact(paths.report, paths.manifest),
        sha256: manifestSha256,
        rows: manifest.length,
      },
    },
  };
}

async function openCheckpoint(path, expectedHeader, create = true) {
  let header = null;
  const records = new Map();
  try {
    for await (const row of readNdjson(path)) {
      if (row.kind === "header") {
        if (header) throw new Error("Media checkpoint contains multiple headers.");
        header = row;
      } else if (row.kind === "media" && typeof row.planId === "string") {
        records.set(row.planId, row);
      } else {
        throw new Error("Media checkpoint contains an invalid row.");
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!header) {
    if (!create) throw new Error("Media checkpoint does not exist.");
    await appendJsonLine(path, expectedHeader);
    header = expectedHeader;
  }
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    throw new Error("Media checkpoint belongs to a different plan or R2 target.");
  }
  return {
    header,
    records,
    async record(value) {
      await appendJsonLine(path, value);
      records.set(value.planId, value);
    },
  };
}

function checkpointRecord(row, fields) {
  return {
    kind: "media",
    planId: row.planId,
    mediaKey: row.mediaKey,
    gatewayId: row.gatewayId,
    ...fields,
    recordedAt: new Date().toISOString(),
  };
}

function remoteObject(record) {
  return {
    target: record.target,
    key: record.objectKey,
    byteLength: record.byteLength,
    sha256: record.sha256,
    contentType: record.contentType,
  };
}

function validatePlan(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (
      !row ||
      !MEDIA_KEY.test(row.planId ?? "") ||
      !MEDIA_KEY.test(row.mediaKey ?? "") ||
      ids.has(row.planId) ||
      row.planId !== row.mediaKey ||
      (row.sourceUrl !== null && typeof row.sourceUrl !== "string") ||
      (row.target !== null && !["public", "private"].includes(row.target)) ||
      typeof row.publicEligible !== "boolean" ||
      (row.publicEligible === true && row.target === "private") ||
      (row.publicEligible === false && row.target === "public")
    ) {
      throw new Error("Moments media plan is invalid or contains duplicate IDs.");
    }
    ids.add(row.planId);
  }
}

function validateOptions({
  snapshotId,
  concurrency,
  attempts,
  maximumObjectBytes,
  maximumConcurrency = 8,
}) {
  if (!SNAPSHOT.test(snapshotId ?? "")) throw new Error("Snapshot ID is invalid.");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > maximumConcurrency) {
    throw new Error(`Concurrency must be from 1 to ${maximumConcurrency}.`);
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("Attempts must be from 1 to 10.");
  }
  if (
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > 100_000_000
  ) {
    throw new Error("Maximum object bytes must be from 1 to 100000000.");
  }
}

function validateSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Source URL is invalid."), { code: "INVALID_SOURCE_URL" });
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== SOURCE_HOST ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw Object.assign(new Error("Source URL is outside the fixed media origin."), {
      code: "INVALID_SOURCE_URL",
    });
  }
}

function parseContentLength(value) {
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizeContentType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() || null : null;
}

function safeHeader(value) {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function oversizeError() {
  return Object.assign(new Error("Source media exceeds the single-object bridge limit."), {
    code: "SOURCE_OVERSIZE",
  });
}

function safeCode(error) {
  const value = error?.code ?? error?.name ?? "CAPTURE_FAILED";
  return (
    String(value)
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80) || "CAPTURE_FAILED"
  );
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isStored(status) {
  return ["public_stored", "private_stored", "quarantined_stored"].includes(status);
}

function relativeArtifact(reportPath, artifactPath) {
  return basename(artifactPath) === artifactPath
    ? artifactPath
    : resolve(artifactPath).replace(`${resolve(dirname(reportPath))}/`, "");
}

function mediaProofPath(manifestPath) {
  if (!manifestPath.endsWith(".ndjson")) {
    throw new Error("D1 media manifest path must end with .ndjson.");
  }
  return `${manifestPath.slice(0, -".ndjson".length)}.json`;
}

async function assertFileDigest(path, expectedSha256, label) {
  if ((await sha256File(path)).sha256 !== expectedSha256) {
    throw new Error(`${label} changed while remote verification was running.`);
  }
}

async function runPool(items, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
