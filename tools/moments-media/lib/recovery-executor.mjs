import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createMomentsBridge } from "../bridge/client.mjs";
import {
  MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS,
  MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES,
  classifyMomentsMediaObject,
  validateMomentsBucketPair,
} from "../bridge/protocol.mjs";
import {
  appendJsonLine,
  readNdjsonBound,
  sha256File,
  writeJsonAtomic,
  writeNdjsonAtomic,
} from "./io.mjs";
import { momentsMediaObjectKey } from "./object-identity.mjs";
import { recoveryUrlValidators } from "./recovery.mjs";
import {
  momentsCaptureFailureRequiresRetry,
  momentsMediaNeedsRecovery,
} from "./recovery-policy.mjs";
import { detectMediaType, isDeclaredTypeCompatible } from "./sniff.mjs";
import { buildMomentsStoredObjectSet } from "./verification.mjs";

const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEDIA_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NON_PUBLIC_TERMINAL_RECOVERY = new Set([
  "original_stored",
  "derivative_stored",
  "metadata_only",
]);
const CAPTURE_STORED = new Set(["public_stored", "private_stored", "quarantined_stored"]);
const MAXIMUM_HLS_RESOURCES = 10_000;
const MAXIMUM_HLS_PLAYLIST_BYTES = 5_000_000;
const EXHAUSTED_RECOVERY_REASON = "all_recovery_candidates_exhausted";
// This is a reviewed retired-origin policy, not a generic DNS-error allowlist.
const RETIRED_LEGACY_SOURCE_HOST = "cdn.registry.poap.tech";
const EXHAUSTED_RECOVERY_FAILURE_CODES = new Set([
  "HLS_RESOURCE_LIMIT",
  "HLS_TOTAL_SIZE_LIMIT",
  "INVALID_HLS_RESOURCE_URI",
  "INVALID_HLS_RESOURCE_URL",
  "RECOVERY_CONTENT_ENCODING",
  "RECOVERY_SHA256_MISMATCH",
  "RECOVERY_SOURCE_EMPTY",
  "RECOVERY_SOURCE_LENGTH_MISMATCH",
  "RECOVERY_SOURCE_OVERSIZE",
  "THUMBNAIL_TYPE_MISMATCH",
]);
const USER_AGENT = "POAPin-Archive-Moments-Recovery/0.1 (+https://poap.in)";

export async function recoverMomentsMedia({
  input,
  snapshotId,
  bridgeUrl,
  publicBucket,
  privateBucket,
  concurrency = 1,
  attempts = 4,
  maximumObjectBytes = 100_000_000,
  maximumRecoveryObjectBytes = 5_000_000_000,
  multipartPartBytes = 16_777_216,
  captureCheckpointPath,
  recoveryPlanPath,
  checkpointPath,
  manifestPath,
  reportPath,
  signal,
  bridge: injectedBridge,
  fetchImpl = fetch,
  onProgress = () => {},
} = {}) {
  validateRecoveryOptions({
    snapshotId,
    concurrency,
    attempts,
    maximumObjectBytes,
    maximumRecoveryObjectBytes,
    multipartPartBytes,
    publicBucket,
    privateBucket,
  });
  const paths = recoveryPaths({
    input,
    captureCheckpointPath,
    recoveryPlanPath,
    checkpointPath,
    manifestPath,
    reportPath,
  });
  const [mediaPlanInput, recoveryPlanInput, normalizedMediaInput, captureCheckpointInput] =
    await Promise.all([
      readNdjsonBound(paths.mediaPlan),
      readNdjsonBound(paths.recoveryPlan),
      readNdjsonBound(paths.normalizedMedia),
      readNdjsonBound(paths.captureCheckpoint),
    ]);
  const mediaPlan = mediaPlanInput.rows;
  const recoveryPlan = recoveryPlanInput.rows;
  const normalizedMedia = normalizedMediaInput.rows;
  const mediaPlanMetadata = boundMetadata(mediaPlanInput);
  const recoveryPlanMetadata = boundMetadata(recoveryPlanInput);
  const normalizedMediaMetadata = boundMetadata(normalizedMediaInput);
  const captureCheckpointMetadata = boundMetadata(captureCheckpointInput);
  const planById = validatePlans(mediaPlan, recoveryPlan);
  const normalizedByKey = validateMediaPlanCoverage(mediaPlan, normalizedMedia);
  const capture = parseCaptureCheckpoint(captureCheckpointInput.rows, {
    snapshotId,
    planSha256: mediaPlanMetadata.sha256,
    planRows: mediaPlan.length,
  });
  validateCaptureJournal({ capture, mediaPlan, snapshotId });
  validateRecoveryPlanCoverage({
    mediaPlan,
    recoveryPlan,
    capture,
    normalizedByKey,
  });
  validateMomentsBucketPair(capture.header.publicBucket, capture.header.privateBucket);
  if (
    capture.header.publicBucket !== publicBucket ||
    capture.header.privateBucket !== privateBucket ||
    capture.header.maximumObjectBytes !== maximumObjectBytes
  ) {
    throw new Error("Recovery targets do not match the capture checkpoint.");
  }
  await Promise.all([
    assertFileDigest(paths.mediaPlan, mediaPlanMetadata.sha256, "Media plan"),
    assertFileDigest(paths.recoveryPlan, recoveryPlanMetadata.sha256, "Recovery plan"),
    assertFileDigest(paths.normalizedMedia, normalizedMediaMetadata.sha256, "Normalized media"),
    assertFileDigest(paths.captureCheckpoint, captureCheckpointMetadata.sha256),
  ]);
  const header = {
    schemaVersion: "poapin-moments-media-recovery-checkpoint-v1",
    version: 1,
    kind: "header",
    snapshotId,
    mediaPlanSha256: mediaPlanMetadata.sha256,
    mediaPlanRows: mediaPlan.length,
    normalizedMediaSha256: normalizedMediaMetadata.sha256,
    normalizedMediaRows: normalizedMedia.length,
    captureCheckpointSha256: captureCheckpointMetadata.sha256,
    recoveryPlanSha256: recoveryPlanMetadata.sha256,
    recoveryPlanRows: recoveryPlan.length,
    publicBucket,
    privateBucket,
    maximumObjectBytes,
    maximumRecoveryObjectBytes,
    multipartPartBytes,
  };
  const journal = await openRecoveryCheckpoint(paths.checkpoint, header);
  validateRecoveryJournal({
    journal,
    mediaPlan,
    recoveryPlan,
    snapshotId,
  });
  const bridge =
    injectedBridge ??
    createMomentsBridge({
      bridgeUrl,
      snapshotId,
      publicBucket,
      privateBucket,
      maximumObjectBytes,
      maximumMultipartObjectBytes: maximumRecoveryObjectBytes,
      multipartPartBytes,
      attempts,
    });
  await bridge.verifyTargets({ signal });

  const pending = recoveryPlan.filter((row) => {
    if (isCaptureTerminal(planById.get(row.planId), capture.records.get(row.planId))) return false;
    return !isRecoveryTerminal(row, journal.media.get(row.planId));
  });
  const tempRoot = await mkdtemp(join(tmpdir(), "poapin-moments-recovery-"));
  let settled = 0;
  try {
    await runPool(pending, concurrency, async (recoveryRow, index) => {
      throwIfAborted(signal);
      const planRow = planById.get(recoveryRow.planId);
      const temporaryRoot = join(tempRoot, String(index).padStart(6, "0"));
      await mkdir(temporaryRoot, { recursive: true });
      let record;
      try {
        record = await recoverOne({
          recoveryRow,
          planRow,
          temporaryRoot,
          snapshotId,
          attempts,
          maximumObjectBytes,
          maximumRecoveryObjectBytes,
          multipartPartBytes,
          bridge,
          journal,
          fetchImpl,
          signal,
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        record = mediaRecoveryRecord(recoveryRow, {
          status: "failed",
          errorCode: safeCode(error),
          httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
        });
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      await journal.record(record);
      settled += 1;
      onProgress({
        settled,
        total: pending.length,
        status: record.status,
        records: journal.media,
      });
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  return finalizeMomentsMediaRecovery({
    input,
    snapshotId,
    captureCheckpointPath: paths.captureCheckpoint,
    recoveryPlanPath: paths.recoveryPlan,
    checkpointPath: paths.checkpoint,
    manifestPath: paths.manifest,
    reportPath: paths.report,
  });
}

export async function finalizeMomentsMediaRecovery({
  input,
  snapshotId,
  captureCheckpointPath,
  recoveryPlanPath,
  checkpointPath,
  manifestPath,
  reportPath,
} = {}) {
  const evaluation = await evaluateMomentsMediaRecovery({
    input,
    snapshotId,
    captureCheckpointPath,
    recoveryPlanPath,
    checkpointPath,
    manifestPath,
    reportPath,
  });
  validateRecoveryOutputPaths(evaluation.paths);
  const manifestSha256 = await writeNdjsonAtomic(evaluation.paths.manifest, evaluation.manifest);
  if (manifestSha256 !== evaluation.manifestSha256) {
    throw new Error("D1 media manifest serialization changed after evaluation.");
  }
  await assertRecoveryEvaluationInputsCurrent(evaluation);

  const generatedAt = new Date().toISOString();
  const proof = {
    schemaVersion: evaluation.proof.schemaVersion,
    snapshotId: evaluation.proof.snapshotId,
    generatedAt,
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
  await writeJsonAtomic(evaluation.paths.proof, proof);
  const report = {
    schemaVersion: "poapin-moments-media-capture-v1",
    snapshotId,
    generatedAt,
    complete: evaluation.complete,
    publicProjectionReady: evaluation.publicProjectionReady,
    counts: evaluation.counts,
    recovery: evaluation.recovery,
    artifacts: evaluation.artifacts,
  };
  await writeJsonAtomic(evaluation.paths.report, report);
  await assertRecoveryEvaluationInputsCurrent(evaluation);
  return report;
}

export async function evaluateMomentsMediaRecovery({
  input,
  snapshotId,
  captureCheckpointPath,
  recoveryPlanPath,
  checkpointPath,
  manifestPath,
  reportPath,
} = {}) {
  if (!SNAPSHOT.test(snapshotId ?? "")) throw new Error("Snapshot ID is invalid.");
  const paths = recoveryPaths({
    input,
    captureCheckpointPath,
    recoveryPlanPath,
    checkpointPath,
    manifestPath,
    reportPath,
  });
  const [
    mediaPlanInput,
    recoveryPlanInput,
    normalizedMediaInput,
    captureCheckpointInput,
    recoveryCheckpointInput,
  ] = await Promise.all([
    readNdjsonBound(paths.mediaPlan),
    readNdjsonBound(paths.recoveryPlan),
    readNdjsonBound(paths.normalizedMedia),
    readNdjsonBound(paths.captureCheckpoint),
    readNdjsonBound(paths.checkpoint),
  ]);
  const mediaPlan = mediaPlanInput.rows;
  const recoveryPlan = recoveryPlanInput.rows;
  const normalizedMedia = normalizedMediaInput.rows;
  const mediaPlanMetadata = boundMetadata(mediaPlanInput);
  const recoveryPlanMetadata = boundMetadata(recoveryPlanInput);
  const normalizedMediaMetadata = boundMetadata(normalizedMediaInput);
  const captureCheckpointMetadata = boundMetadata(captureCheckpointInput);
  const recoveryCheckpointMetadata = boundMetadata(recoveryCheckpointInput);
  const planById = validatePlans(mediaPlan, recoveryPlan);
  const normalizedByKey = validateMediaPlanCoverage(mediaPlan, normalizedMedia);
  const capture = parseCaptureCheckpoint(captureCheckpointInput.rows, {
    snapshotId,
    planSha256: mediaPlanMetadata.sha256,
    planRows: mediaPlan.length,
  });
  validateCaptureJournal({ capture, mediaPlan, snapshotId });
  validateRecoveryPlanCoverage({
    mediaPlan,
    recoveryPlan,
    capture,
    normalizedByKey,
  });
  const recovery = parseRecoveryCheckpointRows(recoveryCheckpointInput.rows);
  if (!recovery.header) throw new Error("Recovery checkpoint does not exist.");
  if (
    recovery.header.schemaVersion !== "poapin-moments-media-recovery-checkpoint-v1" ||
    recovery.header.version !== 1 ||
    recovery.header.kind !== "header" ||
    recovery.header.snapshotId !== snapshotId ||
    recovery.header.mediaPlanSha256 !== mediaPlanMetadata.sha256 ||
    recovery.header.mediaPlanRows !== mediaPlan.length ||
    recovery.header.normalizedMediaSha256 !== normalizedMediaMetadata.sha256 ||
    recovery.header.normalizedMediaRows !== normalizedMedia.length ||
    recovery.header.captureCheckpointSha256 !== captureCheckpointMetadata.sha256 ||
    recovery.header.recoveryPlanSha256 !== recoveryPlanMetadata.sha256 ||
    recovery.header.recoveryPlanRows !== recoveryPlan.length
  ) {
    throw new Error("Recovery checkpoint does not match the selected plans.");
  }
  validateMomentsBucketPair(capture.header.publicBucket, capture.header.privateBucket);
  validateMomentsBucketPair(recovery.header.publicBucket, recovery.header.privateBucket);
  if (
    recovery.header.publicBucket !== capture.header.publicBucket ||
    recovery.header.privateBucket !== capture.header.privateBucket ||
    recovery.header.maximumObjectBytes !== capture.header.maximumObjectBytes
  ) {
    throw new Error("Recovery checkpoint bucket targets do not match the capture checkpoint.");
  }
  validateRecoveryCheckpointLimits(recovery.header);
  validateRecoveryJournal({
    journal: recovery,
    mediaPlan,
    recoveryPlan,
    snapshotId,
  });

  const recoveryPlanIds = new Set(recoveryPlan.map((row) => row.planId));
  const unresolvedRecovery = recoveryPlan.filter((row) => {
    if (isCaptureTerminal(planById.get(row.planId), capture.records.get(row.planId))) return false;
    return !isRecoveryTerminal(row, recovery.media.get(row.planId));
  });
  const manifest = mediaPlan.map((planRow) =>
    effectiveManifestRow({
      planRow,
      captureRecord: capture.records.get(planRow.planId),
      recoveryRecord: recovery.media.get(planRow.planId),
      wasPlannedForRecovery: recoveryPlanIds.has(planRow.planId),
    }),
  );
  const manifestSha256 = canonicalNdjsonSha256(manifest);
  const counts = captureCounts(mediaPlan, manifest);
  const publicProjectionReady =
    unresolvedRecovery.length === 0 &&
    mediaPlan.every(
      (row, index) => row.publicEligible !== true || manifest[index].status === "public_stored",
    );
  const complete =
    unresolvedRecovery.length === 0 &&
    counts.failed === 0 &&
    counts.oversize === 0 &&
    counts.unattempted === 0;
  const proofPath = mediaProofPath(paths.manifest);
  const storedObjectSet = buildMomentsStoredObjectSet(
    [...capture.storedRecords, ...recovery.storedRecords],
    { snapshotId },
  );
  const proof = {
    schemaVersion: "poapin-moments-d1-media-proof-v1",
    snapshotId,
    planSha256: mediaPlanMetadata.sha256,
    manifestSha256,
    manifestRows: manifest.length,
    complete,
    publicProjectionReady,
    checkpointMode: "recovery-finalized",
    publicBucket: recovery.header.publicBucket,
    privateBucket: recovery.header.privateBucket,
    normalizedMediaSha256: normalizedMediaMetadata.sha256,
    captureCheckpointSha256: captureCheckpointMetadata.sha256,
    recovery: {
      planSha256: recoveryPlanMetadata.sha256,
      normalizedMediaSha256: normalizedMediaMetadata.sha256,
      captureCheckpointSha256: captureCheckpointMetadata.sha256,
      checkpointSha256: recoveryCheckpointMetadata.sha256,
    },
  };
  const recoverySummary = {
    schemaVersion: "poapin-moments-media-recovery-finalization-v1",
    planned: recoveryPlan.length,
    terminal: recoveryPlan.length - unresolvedRecovery.length,
    unresolved: unresolvedRecovery.length,
    statuses: countBy(
      recoveryPlan.map((row) => {
        if (isCaptureTerminal(planById.get(row.planId), capture.records.get(row.planId))) {
          return "already_captured";
        }
        return recovery.media.get(row.planId)?.status ?? "unattempted";
      }),
    ),
    unresolvedPlanIds: unresolvedRecovery.slice(0, 100).map((row) => row.planId),
  };
  const artifacts = {
    plan: {
      path: relativeArtifact(paths.report, paths.mediaPlan),
      sha256: mediaPlanMetadata.sha256,
    },
    normalizedMedia: {
      path: relativeArtifact(paths.report, paths.normalizedMedia),
      sha256: normalizedMediaMetadata.sha256,
      rows: normalizedMedia.length,
    },
    checkpoint: {
      path: relativeArtifact(paths.report, paths.captureCheckpoint),
      sha256: captureCheckpointMetadata.sha256,
      records: capture.records.size,
    },
    recoveryPlan: {
      path: relativeArtifact(paths.report, paths.recoveryPlan),
      sha256: recoveryPlanMetadata.sha256,
      rows: recoveryPlan.length,
    },
    recoveryCheckpoint: {
      path: relativeArtifact(paths.report, paths.checkpoint),
      sha256: recoveryCheckpointMetadata.sha256,
      records: recovery.media.size,
    },
    d1MediaManifest: {
      path: relativeArtifact(paths.report, paths.manifest),
      sha256: manifestSha256,
      rows: manifest.length,
    },
    d1MediaProof: { path: relativeArtifact(paths.report, proofPath) },
  };
  const inputDigests = {
    mediaPlan: mediaPlanMetadata.sha256,
    normalizedMedia: normalizedMediaMetadata.sha256,
    captureCheckpoint: captureCheckpointMetadata.sha256,
    recoveryPlan: recoveryPlanMetadata.sha256,
    recoveryCheckpoint: recoveryCheckpointMetadata.sha256,
  };
  await assertRecoveryEvaluationInputsCurrent({ paths, inputDigests });

  return {
    schemaVersion: "poapin-moments-media-recovery-evaluation-v1",
    snapshotId,
    paths: { ...paths, proof: proofPath },
    limits: {
      maximumObjectBytes: recovery.header.maximumObjectBytes,
      maximumMultipartObjectBytes: recovery.header.maximumRecoveryObjectBytes,
      multipartPartBytes: recovery.header.multipartPartBytes,
    },
    manifest,
    manifestSha256,
    proof,
    binding: {
      snapshotId,
      checkpointMode: "recovery-finalized",
      publicBucket: recovery.header.publicBucket,
      privateBucket: recovery.header.privateBucket,
      mediaPlanSha256: mediaPlanMetadata.sha256,
      mediaPlanRows: mediaPlan.length,
      mediaManifestSha256: manifestSha256,
      mediaManifestRows: manifest.length,
      normalizedMediaSha256: normalizedMediaMetadata.sha256,
      captureCheckpointSha256: captureCheckpointMetadata.sha256,
      recoveryPlanSha256: recoveryPlanMetadata.sha256,
      recoveryPlanRows: recoveryPlan.length,
      recoveryCheckpointSha256: recoveryCheckpointMetadata.sha256,
      stored: storedObjectSet.stored,
      storedObjectSetSha256: storedObjectSet.sha256,
    },
    complete,
    publicProjectionReady,
    counts,
    recovery: recoverySummary,
    artifacts,
    storedObjectSet,
    inputDigests,
  };
}

async function recoverOne(context) {
  const errors = [];
  let allStrategiesExhausted = true;
  for (const strategy of context.recoveryRow.strategies) {
    throwIfAborted(context.signal);
    try {
      if (strategy.kind === "public_original_required") {
        throw Object.assign(new Error("Public recovery requires an original."), {
          code: "PUBLIC_ORIGINAL_REQUIRED",
        });
      }
      if (strategy.kind === "private_recovery_required") {
        throw Object.assign(new Error("Private recovery still requires a retryable source."), {
          code: "PRIVATE_RECOVERY_REQUIRED",
        });
      }
      if (strategy.kind === "metadata_only") {
        if (
          context.recoveryRow.publicEligible !== false ||
          context.recoveryRow.target !== "private" ||
          isPublicPlanRow(context.planRow)
        ) {
          throw Object.assign(new Error("Public recovery requires an original."), {
            code: "PUBLIC_ORIGINAL_REQUIRED",
          });
        }
        return mediaRecoveryRecord(context.recoveryRow, {
          status: "metadata_only",
          fidelity: "none",
          strategy: strategy.kind,
          reason: strategy.reason,
        });
      }
      if (["retry_primary", "multipart_original", "legacy_original"].includes(strategy.kind)) {
        const candidates =
          strategy.kind === "legacy_original"
            ? strategy.candidates
            : [
                {
                  gatewayId: strategy.gatewayId,
                  sourceUrl: strategy.sourceUrl,
                },
              ];
        const original = await recoverOriginalCandidates(context, strategy, candidates);
        return mediaRecoveryRecord(context.recoveryRow, {
          status: "original_stored",
          fidelity: "original",
          strategy: strategy.kind,
          ...original,
        });
      }
      if (strategy.kind === "hash_alias_original") {
        const original = await recoverHashAlias(context, strategy);
        return mediaRecoveryRecord(context.recoveryRow, {
          status: "original_stored",
          fidelity: "original",
          strategy: strategy.kind,
          ...original,
        });
      }
      if (strategy.kind === "thumbnail_derivative") {
        const derivative = await recoverThumbnail(context, strategy);
        return mediaRecoveryRecord(context.recoveryRow, {
          status: "derivative_stored",
          fidelity: "derivative",
          strategy: strategy.kind,
          derivativeKind: "thumbnail",
          ...derivative,
        });
      }
      if (strategy.kind === "hls_derivative") {
        const derivative = await recoverHls(context, strategy);
        return mediaRecoveryRecord(context.recoveryRow, {
          status: "derivative_stored",
          fidelity: "derivative",
          strategy: strategy.kind,
          derivativeKind: "hls",
          ...derivative,
        });
      }
      throw Object.assign(new Error("Recovery strategy is unsupported."), {
        code: "UNSUPPORTED_RECOVERY_STRATEGY",
      });
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) throw error;
      allStrategiesExhausted &&= isExhaustedRecoveryFailure(error, strategy.kind);
      const audit = recoveryFailureAudit(error);
      errors.push({
        strategy: strategy.kind,
        code: safeCode(error),
        httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
        ...audit,
      });
      await context.journal.record({
        kind: "strategy",
        planId: context.recoveryRow.planId,
        mediaKey: context.recoveryRow.mediaKey,
        strategy: strategy.kind,
        status: "failed",
        errorCode: safeCode(error),
        httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
        ...audit,
        recordedAt: new Date().toISOString(),
      });
    }
  }
  if (
    context.recoveryRow.publicEligible === false &&
    context.recoveryRow.target === "private" &&
    !isPublicPlanRow(context.planRow) &&
    !context.recoveryRow.strategies.some((strategy) => strategy.kind === "metadata_only") &&
    allStrategiesExhausted &&
    isAllowedExhaustedStrategySet(context.recoveryRow.strategies, errors) &&
    errors.length === context.recoveryRow.strategies.length
  ) {
    return mediaRecoveryRecord(context.recoveryRow, {
      status: "metadata_only",
      fidelity: "none",
      strategy: null,
      reason: EXHAUSTED_RECOVERY_REASON,
      attempts: errors,
    });
  }
  return mediaRecoveryRecord(context.recoveryRow, {
    status: "failed",
    errorCode: errors.at(-1)?.code ?? "NO_RECOVERY_STRATEGY_SUCCEEDED",
    attempts: errors,
  });
}

async function recoverOriginalCandidates(context, strategy, candidates) {
  let latest;
  let allCandidatesExhausted = true;
  let sawLegacyDnsMissing = false;
  let allCandidatesLegacyDnsMissing = strategy.kind === "legacy_original";
  let legacyDnsAttemptCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const validator =
        strategy.kind === "legacy_original"
          ? (value) => recoveryUrlValidators.isLegacyOriginal(value)
          : (value) => isCanonicalOriginalUrl(value, context.recoveryRow.mediaKey);
      return await recoverOriginalSource(
        context,
        strategy,
        candidate.sourceUrl,
        validator,
        `${strategy.kind}-${index}`,
      );
    } catch (error) {
      const failure = normalizeLegacySourceFailure(error, {
        context,
        strategy,
        candidate,
      });
      const legacyDnsMissing = failure?.code === "RECOVERY_LEGACY_SOURCE_DNS_MISSING";
      latest = failure;
      sawLegacyDnsMissing ||= legacyDnsMissing;
      allCandidatesLegacyDnsMissing &&= legacyDnsMissing;
      if (legacyDnsMissing) legacyDnsAttemptCount += failure.recoveryAttemptCount;
      allCandidatesExhausted &&= isExhaustedRecoveryCandidateFailure(failure, strategy.kind);
    }
  }
  throw markCandidateExhaustion(
    latest ??
      Object.assign(new Error("Original recovery has no candidates."), {
        code: "NO_ORIGINAL_CANDIDATE",
      }),
    allCandidatesExhausted &&
      (!sawLegacyDnsMissing || allCandidatesLegacyDnsMissing) &&
      latest !== undefined,
    {
      allLegacyCandidatesDnsMissing: allCandidatesLegacyDnsMissing && latest !== undefined,
      candidateCount: candidates.length,
      attemptCount: legacyDnsAttemptCount,
    },
  );
}

function normalizeLegacySourceFailure(error, { context, strategy, candidate }) {
  if (
    error?.code !== "RECOVERY_SOURCE_DNS_NOT_FOUND" ||
    error.allRecoveryAttemptsDnsNotFound !== true ||
    !Number.isSafeInteger(error.recoveryAttemptCount) ||
    error.recoveryAttemptCount < 1 ||
    strategy.kind !== "legacy_original" ||
    strategy.target !== "private" ||
    context.recoveryRow.publicEligible !== false ||
    context.recoveryRow.target !== "private" ||
    context.planRow.publicEligible !== false ||
    isPublicPlanRow(context.planRow) ||
    !recoveryUrlValidators.isLegacyOriginal(candidate.sourceUrl) ||
    new URL(candidate.sourceUrl).hostname !== RETIRED_LEGACY_SOURCE_HOST
  ) {
    return error;
  }
  return Object.assign(new Error("The reviewed legacy source origin no longer resolves."), {
    code: "RECOVERY_LEGACY_SOURCE_DNS_MISSING",
    allRecoveryAttemptsDnsNotFound: true,
    recoveryAttemptCount: error.recoveryAttemptCount,
  });
}

async function recoverHashAlias(context, strategy) {
  if (!SHA256.test(strategy.requireSha256 ?? "")) {
    throw Object.assign(new Error("Hash-alias recovery requires an exact SHA-256."), {
      code: "HASH_ALIAS_SHA256_REQUIRED",
    });
  }
  let latest;
  let allCandidatesExhausted = true;
  for (let index = 0; index < strategy.candidates.length; index += 1) {
    const candidate = strategy.candidates[index];
    try {
      if (
        candidate.preservedObject?.target === strategy.target &&
        candidate.preservedObject.sha256 === strategy.requireSha256
      ) {
        const object = {
          target: candidate.preservedObject.target,
          key: candidate.preservedObject.objectKey,
          byteLength: candidate.preservedObject.byteLength,
          sha256: candidate.preservedObject.sha256,
          contentType: candidate.preservedObject.contentType,
        };
        if (
          classifyMomentsMediaObject({ snapshotId: context.snapshotId, ...object })?.fidelity ===
            "original" &&
          (await context.bridge.head(object, { signal: context.signal }))
        ) {
          return {
            target: object.target,
            objectKey: object.key,
            sha256: object.sha256,
            byteLength: object.byteLength,
            contentType: object.contentType,
            sourceUrl: candidate.sourceUrl,
            disposition: "reused",
            quarantined: object.target === "private" && isPublicPlanRow(context.planRow),
          };
        }
      }
      return await recoverOriginalSource(
        context,
        strategy,
        candidate.sourceUrl,
        (value) => isCanonicalOriginalUrl(value, candidate.mediaKey),
        `hash-alias-${index}`,
      );
    } catch (error) {
      latest = error;
      allCandidatesExhausted &&= isExhaustedRecoveryFailure(error, strategy.kind);
    }
  }
  throw markCandidateExhaustion(
    latest ??
      Object.assign(new Error("Hash-alias recovery has no candidates."), {
        code: "NO_HASH_ALIAS_CANDIDATE",
      }),
    allCandidatesExhausted && latest !== undefined,
  );
}

async function recoverOriginalSource(context, strategy, sourceUrl, validateUrl, label) {
  const path = join(context.temporaryRoot, `${label}.media`);
  const source = await downloadToFile({
    url: sourceUrl,
    path,
    maximumBytes: context.maximumRecoveryObjectBytes,
    attempts: context.attempts,
    fetchImpl: context.fetchImpl,
    signal: context.signal,
    validateUrl,
  });
  if (strategy.requireSha256 && source.sha256 !== strategy.requireSha256) {
    throw Object.assign(new Error("Recovered original does not match the required SHA-256."), {
      code: "RECOVERY_SHA256_MISMATCH",
    });
  }
  const detected = detectMediaType(source.prefix, context.planRow.declaredContentType);
  const compatible =
    detected && isDeclaredTypeCompatible(context.planRow.declaredContentType, detected.contentType);
  const target = isPublicPlanRow(context.planRow) && compatible ? "public" : "private";
  const contentType = detected?.contentType ?? "application/octet-stream";
  const extension = detected?.extension ?? "bin";
  const object = {
    target,
    key: momentsMediaObjectKey(context.snapshotId, target, source.sha256, extension),
    byteLength: source.byteLength,
    sha256: source.sha256,
    contentType,
  };
  const uploaded = await uploadImmutableFile(context, object, path);
  return {
    target,
    objectKey: object.key,
    sha256: object.sha256,
    byteLength: object.byteLength,
    contentType: object.contentType,
    sourceUrl,
    sourceContentType: source.responseContentType,
    sourceEtag: source.etag,
    disposition: uploaded.disposition,
    etag: uploaded.etag,
    quarantined: target === "private" && isPublicPlanRow(context.planRow),
  };
}

async function recoverThumbnail(context, strategy) {
  if (
    strategy.target !== "private" ||
    !recoveryUrlValidators.isThumbnail(strategy.sourceUrl, context.recoveryRow.mediaKey)
  ) {
    throw Object.assign(new Error("Thumbnail recovery URL or target is invalid."), {
      code: "INVALID_THUMBNAIL_RECOVERY",
    });
  }
  const path = join(context.temporaryRoot, "thumbnail.webp");
  const source = await downloadToFile({
    url: strategy.sourceUrl,
    path,
    maximumBytes: context.maximumObjectBytes,
    attempts: context.attempts,
    fetchImpl: context.fetchImpl,
    signal: context.signal,
    validateUrl: (value) => recoveryUrlValidators.isThumbnail(value, context.recoveryRow.mediaKey),
  });
  const detected = detectMediaType(source.prefix, "image/webp");
  if (detected?.contentType !== "image/webp") {
    throw Object.assign(new Error("Thumbnail bytes are not WebP."), {
      code: "THUMBNAIL_TYPE_MISMATCH",
    });
  }
  const object = {
    target: "private",
    key: momentsMediaDerivativeObjectKey(context.snapshotId, "thumbnail", source.sha256, "webp"),
    byteLength: source.byteLength,
    sha256: source.sha256,
    contentType: "image/webp",
  };
  const uploaded = await uploadImmutableFile(context, object, path);
  return {
    rootObject: objectResult(object, uploaded),
    objectCount: 1,
    byteLength: object.byteLength,
  };
}

async function recoverHls(context, strategy) {
  if (
    strategy.target !== "private" ||
    !recoveryUrlValidators.isHlsManifest(strategy.sourceUrl, context.recoveryRow.mediaKey)
  ) {
    throw Object.assign(new Error("HLS recovery URL or target is invalid."), {
      code: "INVALID_HLS_RECOVERY",
    });
  }
  const queue = [strategy.sourceUrl];
  const seen = new Set();
  const recovered = [];
  let totalBytes = 0;
  let rootObject = null;
  while (queue.length > 0) {
    throwIfAborted(context.signal);
    const sourceUrl = queue.shift();
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    if (seen.size > MAXIMUM_HLS_RESOURCES) {
      throw Object.assign(new Error("HLS derivative exceeds the resource-count bound."), {
        code: "HLS_RESOURCE_LIMIT",
      });
    }
    const isPlaylist = new URL(sourceUrl).pathname.toLowerCase().endsWith(".m3u8");
    const existing = context.journal.objects.get(
      objectEventIdentity(context.recoveryRow.planId, sourceUrl),
    );
    if (existing && !isPlaylist) {
      const remote = await context.bridge.head(remoteObject(existing), {
        signal: context.signal,
      });
      if (remote) {
        assertHlsTotalBytes(totalBytes, existing.byteLength, context.maximumRecoveryObjectBytes);
        recovered.push(existing);
        totalBytes += existing.byteLength;
        continue;
      }
    }

    const path = join(context.temporaryRoot, `hls-${String(seen.size).padStart(5, "0")}`);
    const source = await downloadToFile({
      url: sourceUrl,
      path,
      maximumBytes: isPlaylist ? MAXIMUM_HLS_PLAYLIST_BYTES : context.maximumRecoveryObjectBytes,
      attempts: context.attempts,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
      validateUrl: (value) =>
        isFixedHlsResourceUrl(value, context.recoveryRow.mediaKey, strategy.sourceUrl),
    });
    if (existing && existing.sha256 !== source.sha256) {
      throw Object.assign(new Error("An HLS resource changed during recovery resume."), {
        code: "HLS_RESOURCE_CHANGED",
      });
    }
    assertHlsTotalBytes(totalBytes, source.byteLength, context.maximumRecoveryObjectBytes);
    const mediaType = isPlaylist
      ? {
          contentType: "application/vnd.apple.mpegurl",
          extension: "m3u8",
          derivativeKind: "hls-playlist",
        }
      : hlsSegmentType(sourceUrl, source.prefix, source.responseContentType);
    const object = {
      target: "private",
      key: momentsMediaDerivativeObjectKey(
        context.snapshotId,
        mediaType.derivativeKind,
        source.sha256,
        mediaType.extension,
      ),
      byteLength: source.byteLength,
      sha256: source.sha256,
      contentType: mediaType.contentType,
    };
    const uploaded =
      existing && (await context.bridge.head(object, { signal: context.signal }))
        ? { disposition: "reused", etag: existing.etag }
        : await uploadImmutableFile(context, object, path);
    const event = {
      kind: "object",
      planId: context.recoveryRow.planId,
      mediaKey: context.recoveryRow.mediaKey,
      sourceUrl,
      derivativeKind: mediaType.derivativeKind,
      target: object.target,
      objectKey: object.key,
      sha256: object.sha256,
      byteLength: object.byteLength,
      contentType: object.contentType,
      disposition: uploaded.disposition,
      etag: uploaded.etag,
      recordedAt: new Date().toISOString(),
    };
    await context.journal.record(event);
    recovered.push(event);
    totalBytes += object.byteLength;
    if (sourceUrl === strategy.sourceUrl) rootObject = objectResult(object, uploaded);
    if (isPlaylist) {
      const text = await readUtf8File(path);
      for (const reference of parseHlsReferences(text)) {
        queue.push(resolveFixedHlsReference(sourceUrl, reference, context.recoveryRow.mediaKey));
      }
    }
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  if (!rootObject) {
    throw Object.assign(new Error("HLS recovery did not preserve its root playlist."), {
      code: "HLS_ROOT_MISSING",
    });
  }
  return {
    rootObject,
    objectCount: recovered.length,
    byteLength: totalBytes,
  };
}

function assertHlsTotalBytes(totalBytes, nextByteLength, maximumBytes) {
  if (nextByteLength > maximumBytes - totalBytes) {
    throw Object.assign(new Error("HLS derivative exceeds the total-byte bound."), {
      code: "HLS_TOTAL_SIZE_LIMIT",
    });
  }
}

async function uploadImmutableFile(context, object, path) {
  if (object.byteLength <= context.maximumObjectBytes) {
    const existing = await context.bridge.head(object, { signal: context.signal });
    if (existing) return { disposition: "reused", etag: existing.etag };
    return context.bridge.uploadFile(object, path, { signal: context.signal });
  }
  return uploadMultipartFile(context, object, path);
}

async function uploadMultipartFile(context, object, path, allowRestart = true) {
  const partCount = Math.ceil(object.byteLength / context.multipartPartBytes);
  if (partCount > MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS) {
    throw Object.assign(new Error("Multipart object needs too many parts."), {
      code: "MULTIPART_PART_LIMIT",
    });
  }
  let state = context.journal.multipart.get(
    multipartEventIdentity(context.recoveryRow.planId, object.key),
  );
  const remote = await context.bridge.head(object, { signal: context.signal });
  if (remote) {
    if (state?.active) {
      const aborted = await context.bridge.abortMultipartUpload(object, state.uploadId, {
        signal: context.signal,
      });
      await context.journal.record(
        multipartEvent(context, object, {
          event: "completed",
          uploadId: state.uploadId,
          disposition: "reused",
          orphanUploadDisposition: aborted.disposition,
          etag: remote.etag,
        }),
      );
    }
    return { disposition: "reused", etag: remote.etag };
  }
  if (!state?.active) {
    const created = await context.bridge.createMultipartUpload(object, {
      signal: context.signal,
    });
    if (created.disposition === "reused") {
      return { disposition: "reused", etag: created.etag };
    }
    await context.journal.record(
      multipartEvent(context, object, {
        event: "created",
        uploadId: created.uploadId,
      }),
    );
    state = context.journal.multipart.get(
      multipartEventIdentity(context.recoveryRow.planId, object.key),
    );
  }

  const handle = await open(path, "r");
  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      throwIfAborted(context.signal);
      const offset = (partNumber - 1) * context.multipartPartBytes;
      const byteLength = Math.min(context.multipartPartBytes, object.byteLength - offset);
      const recorded = state.parts.get(partNumber);
      if (recorded) {
        if (recorded.byteLength !== byteLength) {
          throw Object.assign(new Error("Multipart resume part size changed."), {
            code: "MULTIPART_RESUME_CONFLICT",
          });
        }
        continue;
      }
      const bytes = Buffer.allocUnsafe(byteLength);
      const { bytesRead } = await handle.read(bytes, 0, byteLength, offset);
      if (bytesRead !== byteLength) {
        throw Object.assign(new Error("Local multipart file changed during upload."), {
          code: "MULTIPART_LOCAL_FILE_CHANGED",
        });
      }
      const uploaded = await context.bridge.uploadMultipartPart(
        object,
        state.uploadId,
        partNumber,
        bytes,
        { signal: context.signal },
      );
      await context.journal.record(
        multipartEvent(context, object, {
          event: "part",
          uploadId: state.uploadId,
          partNumber,
          byteLength,
          sha256: uploaded.sha256,
          etag: uploaded.etag,
        }),
      );
      state = context.journal.multipart.get(
        multipartEventIdentity(context.recoveryRow.planId, object.key),
      );
    }
  } catch (error) {
    if (error?.code !== "multipart_upload_not_found" || !allowRestart) throw error;
    await context.journal.record(
      multipartEvent(context, object, {
        event: "aborted",
        uploadId: state.uploadId,
        reason: "remote_upload_expired",
      }),
    );
    return uploadMultipartFile(context, object, path, false);
  } finally {
    await handle.close();
  }

  const parts = [...state.parts.values()].sort((left, right) => left.partNumber - right.partNumber);
  try {
    const completed = await context.bridge.completeMultipartUpload(object, state.uploadId, parts, {
      signal: context.signal,
    });
    await context.journal.record(
      multipartEvent(context, object, {
        event: "completed",
        uploadId: state.uploadId,
        disposition: completed.disposition,
        etag: completed.etag,
      }),
    );
    return { disposition: completed.disposition, etag: completed.etag };
  } catch (error) {
    if (error?.code !== "multipart_upload_not_found" || !allowRestart) throw error;
    await context.journal.record(
      multipartEvent(context, object, {
        event: "aborted",
        uploadId: state.uploadId,
        reason: "remote_upload_expired",
      }),
    );
    return uploadMultipartFile(context, object, path, false);
  }
}

async function downloadToFile({
  url,
  path,
  maximumBytes,
  attempts,
  fetchImpl,
  signal,
  validateUrl,
}) {
  let latest;
  let allAttemptsDnsNotFound = true;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadOnce({
        url,
        path,
        maximumBytes,
        fetchImpl,
        signal,
        validateUrl,
      });
    } catch (error) {
      latest = error;
      allAttemptsDnsNotFound &&= error?.code === "RECOVERY_SOURCE_DNS_NOT_FOUND";
      await unlink(path).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      if (
        signal?.aborted ||
        error?.code === "RECOVERY_SOURCE_OVERSIZE" ||
        error?.code === "INVALID_RECOVERY_SOURCE_URL" ||
        (error?.httpStatus && !isRetryableStatus(error.httpStatus)) ||
        attempt === attempts
      ) {
        throw markDownloadAttemptDnsOutcome(error, allAttemptsDnsNotFound, attempt);
      }
      await delay(500 * 2 ** (attempt - 1), undefined, { signal });
    }
  }
  throw latest;
}

async function downloadOnce({ url, path, maximumBytes, fetchImpl, signal, validateUrl }) {
  if (!validateUrl(url)) {
    throw Object.assign(new Error("Recovery source URL is outside its fixed allowlist."), {
      code: "INVALID_RECOVERY_SOURCE_URL",
    });
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isFetchDnsNotFound(error, url)) {
      throw Object.assign(new Error("Recovery source hostname could not be resolved."), {
        code: "RECOVERY_SOURCE_DNS_NOT_FOUND",
      });
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Recovery source returned HTTP ${response.status}.`), {
      code: [404, 410].includes(response.status)
        ? "RECOVERY_SOURCE_MISSING"
        : "RECOVERY_SOURCE_HTTP_ERROR",
      httpStatus: response.status,
    });
  }
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw recoveryOversizeError();
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw Object.assign(new Error("Compressed recovery responses are not accepted."), {
      code: "RECOVERY_CONTENT_ENCODING",
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
      if (byteLength > maximumBytes) throw recoveryOversizeError();
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
    throw Object.assign(new Error("Recovery source was empty."), {
      code: "RECOVERY_SOURCE_EMPTY",
    });
  }
  if (declaredLength !== null && declaredLength !== byteLength) {
    throw Object.assign(new Error("Recovery Content-Length did not match its bytes."), {
      code: "RECOVERY_SOURCE_LENGTH_MISMATCH",
    });
  }
  const details = await stat(path);
  if (!details.isFile() || details.size !== byteLength) {
    throw new Error("Temporary recovery file length mismatch.");
  }
  return {
    sha256: hash.digest("hex"),
    byteLength,
    prefix,
    responseContentType: normalizeContentType(response.headers.get("content-type")),
    etag: safeHeader(response.headers.get("etag")),
  };
}

function momentsMediaDerivativeObjectKey(snapshotId, kind, sha256, extension) {
  const derivative = {
    thumbnail: "thumbnail",
    "hls-playlist": "hls-playlist",
    "hls-segment": "hls-segment",
  }[kind];
  if (
    !SNAPSHOT.test(snapshotId ?? "") ||
    !derivative ||
    !SHA256.test(sha256 ?? "") ||
    !/^[a-z0-9]{2,5}$/.test(extension ?? "")
  ) {
    throw new Error("Derivative media identity is invalid.");
  }
  const key =
    `snapshots/${snapshotId}/moments/private/derivative/${derivative}/` +
    `sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
  const classification = classifyMomentsMediaObject({
    snapshotId,
    target: "private",
    key,
    sha256,
    contentType: derivativeContentType(extension),
  });
  if (!classification || classification.derivativeKind !== derivative) {
    throw new Error("Derivative media key is outside the bridge allowlist.");
  }
  return key;
}

function derivativeContentType(extension) {
  return {
    webp: "image/webp",
    m3u8: "application/vnd.apple.mpegurl",
    ts: "video/mp2t",
    m4s: "video/iso.segment",
    mp4: "video/mp4",
    aac: "audio/aac",
    bin: "application/octet-stream",
  }[extension];
}

function hlsSegmentType(url, prefix, declaredContentType) {
  const extension = extname(new URL(url).pathname).toLowerCase();
  if (extension === ".ts") {
    return { contentType: "video/mp2t", extension: "ts", derivativeKind: "hls-segment" };
  }
  if (extension === ".m4s") {
    return {
      contentType: "video/iso.segment",
      extension: "m4s",
      derivativeKind: "hls-segment",
    };
  }
  if (extension === ".aac") {
    return { contentType: "audio/aac", extension: "aac", derivativeKind: "hls-segment" };
  }
  const detected = detectMediaType(prefix, declaredContentType);
  if (detected?.contentType === "video/mp4") {
    return { contentType: "video/mp4", extension: "mp4", derivativeKind: "hls-segment" };
  }
  return {
    contentType: "application/octet-stream",
    extension: "bin",
    derivativeKind: "hls-segment",
  };
}

function parseHlsReferences(text) {
  const references = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("#")) {
      references.push(line);
      continue;
    }
    for (const match of line.matchAll(/(?:^|[:,])URI=(?:"([^"]+)"|([^,]*))/g)) {
      const value = match[1] ?? match[2];
      if (value) references.push(value.trim());
    }
  }
  return [...new Set(references)];
}

function resolveFixedHlsReference(baseUrl, reference, mediaKey) {
  if (
    typeof reference !== "string" ||
    reference.length < 1 ||
    reference.length > 1_000 ||
    reference.startsWith("/") ||
    reference.startsWith("//") ||
    reference.includes("\\") ||
    reference.includes("?") ||
    reference.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference) ||
    /%2f|%5c/i.test(reference)
  ) {
    throw Object.assign(new Error("HLS playlist contains a non-fixed resource URI."), {
      code: "INVALID_HLS_RESOURCE_URI",
    });
  }
  const resolved = new URL(reference, baseUrl).href;
  if (!isFixedHlsResourceUrl(resolved, mediaKey, baseUrl)) {
    throw Object.assign(new Error("HLS resource escapes its fixed source prefix."), {
      code: "INVALID_HLS_RESOURCE_URL",
    });
  }
  return resolved;
}

function isFixedHlsResourceUrl(value, mediaKey, rootUrl) {
  let url;
  let root;
  try {
    url = new URL(value);
    root = new URL(rootUrl);
  } catch {
    return false;
  }
  return Boolean(
    url.protocol === "https:" &&
    url.hostname === "poap-media-hls-production.s3.us-east-2.amazonaws.com" &&
    url.hostname === root.hostname &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname.startsWith(`/${mediaKey}/`) &&
    !/%2f|%5c/i.test(url.pathname),
  );
}

function isCanonicalOriginalUrl(value, mediaKey) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return Boolean(
    url.protocol === "https:" &&
    url.hostname === "cdn.media.poap.tech" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === `/${mediaKey}`,
  );
}

async function readUtf8File(path) {
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    const bytes = Buffer.allocUnsafe(details.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error("HLS playlist changed while reading.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function parseCaptureCheckpoint(rows, expected) {
  let header = null;
  const records = new Map();
  const history = [];
  const storedRecords = [];
  for (const row of rows) {
    if (row.kind === "header") {
      if (header) throw new Error("Capture checkpoint contains multiple headers.");
      header = row;
    } else if (row.kind === "media" && typeof row.planId === "string") {
      records.set(row.planId, row);
      history.push(row);
      if (CAPTURE_STORED.has(row.status)) storedRecords.push(row);
    } else {
      throw new Error("Capture checkpoint contains an invalid row.");
    }
  }
  if (
    header?.schemaVersion !== "poapin-moments-media-checkpoint-v1" ||
    header.version !== 1 ||
    header.kind !== "header" ||
    header.snapshotId !== expected.snapshotId ||
    header.planSha256 !== expected.planSha256 ||
    header.planRows !== expected.planRows
  ) {
    throw new Error("Capture checkpoint does not match the selected media plan.");
  }
  return { header, records, history, storedRecords };
}

function parseRecoveryCheckpointRows(rows) {
  let header = null;
  const media = new Map();
  const mediaHistory = [];
  const objects = new Map();
  const objectHistory = [];
  const storedRecords = [];
  const multipart = new Map();
  for (const row of rows) {
    if (row.kind === "header") {
      if (header) throw new Error("Recovery checkpoint contains multiple headers.");
      header = row;
    } else if (row.kind === "media" && typeof row.planId === "string") {
      media.set(row.planId, row);
      mediaHistory.push(row);
      storedRecords.push(...recoveryStoredRecords(row));
    } else if (
      row.kind === "object" &&
      typeof row.planId === "string" &&
      typeof row.sourceUrl === "string"
    ) {
      objects.set(objectEventIdentity(row.planId, row.sourceUrl), row);
      objectHistory.push(row);
      storedRecords.push(row);
    } else if (
      row.kind === "multipart" &&
      typeof row.planId === "string" &&
      typeof row.objectKey === "string"
    ) {
      applyMultipartEvent(multipart, row);
    } else if (row.kind !== "strategy" || typeof row.planId !== "string") {
      throw new Error("Recovery checkpoint contains an invalid row.");
    }
  }
  return {
    header,
    media,
    mediaHistory,
    objects,
    objectHistory,
    storedRecords,
    multipart,
  };
}

async function openRecoveryCheckpoint(path, expectedHeader, create = true) {
  let rows = [];
  try {
    rows = (await readNdjsonBound(path)).rows;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const checkpoint = parseRecoveryCheckpointRows(rows);
  let { header } = checkpoint;
  if (!header) {
    if (!create || !expectedHeader) throw new Error("Recovery checkpoint does not exist.");
    await appendJsonLine(path, expectedHeader);
    header = expectedHeader;
    checkpoint.header = expectedHeader;
  }
  if (expectedHeader && JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    throw new Error("Recovery checkpoint belongs to a different plan or R2 target.");
  }
  let writes = Promise.resolve();
  return {
    ...checkpoint,
    async record(value) {
      writes = writes.then(async () => {
        await appendJsonLine(path, value);
        if (value.kind === "media") {
          checkpoint.media.set(value.planId, value);
          checkpoint.mediaHistory.push(value);
          checkpoint.storedRecords.push(...recoveryStoredRecords(value));
        }
        if (value.kind === "object") {
          checkpoint.objects.set(objectEventIdentity(value.planId, value.sourceUrl), value);
          checkpoint.objectHistory.push(value);
          checkpoint.storedRecords.push(value);
        }
        if (value.kind === "multipart") applyMultipartEvent(checkpoint.multipart, value);
      });
      return writes;
    },
  };
}

function applyMultipartEvent(states, row) {
  const identity = multipartEventIdentity(row.planId, row.objectKey);
  let state = states.get(identity);
  if (row.event === "created") {
    state = {
      active: true,
      uploadId: row.uploadId,
      objectKey: row.objectKey,
      parts: new Map(),
    };
    states.set(identity, state);
    return;
  }
  if (!state || state.uploadId !== row.uploadId) return;
  if (row.event === "part" && state.active) state.parts.set(row.partNumber, row);
  if (["completed", "aborted"].includes(row.event)) state.active = false;
}

function multipartEvent(context, object, fields) {
  return {
    kind: "multipart",
    planId: context.recoveryRow.planId,
    mediaKey: context.recoveryRow.mediaKey,
    target: object.target,
    objectKey: object.key,
    objectByteLength: object.byteLength,
    objectSha256: object.sha256,
    contentType: object.contentType,
    ...fields,
    recordedAt: new Date().toISOString(),
  };
}

function mediaRecoveryRecord(row, fields) {
  return {
    kind: "media",
    planId: row.planId,
    mediaKey: row.mediaKey,
    ...fields,
    recordedAt: new Date().toISOString(),
  };
}

function isPublicPlanRow(row) {
  return row?.publicEligible === true || row?.target === "public";
}

function isLegacyNullPublicRecovery(planned, recovery) {
  return Boolean(
    planned?.publicEligible === true &&
    planned.target === null &&
    recovery?.publicEligible === true &&
    recovery.target === "private",
  );
}

function validateCaptureJournal({ capture, mediaPlan, snapshotId }) {
  const planById = new Map(mediaPlan.map((row) => [row.planId, row]));
  for (const record of capture.history) {
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
    if (!CAPTURE_STORED.has(record.status)) continue;
    const classification = classifyCheckpointObject(record, snapshotId);
    const plannedPublic = isPublicPlanRow(planned);
    const legacyNullPublic = planned.publicEligible === true && planned.target === null;
    const validStatus =
      (record.status === "public_stored" &&
        plannedPublic &&
        record.target === "public" &&
        record.quarantined !== true) ||
      (record.status === "private_stored" &&
        (!plannedPublic || legacyNullPublic) &&
        record.target === "private") ||
      (record.status === "quarantined_stored" && plannedPublic && record.target === "private");
    if (classification?.fidelity !== "original" || !validStatus) {
      throw new Error("Capture checkpoint contains an invalid stored media result.");
    }
  }
}

function validateRecoveryPlanCoverage({ mediaPlan, recoveryPlan, capture, normalizedByKey }) {
  const expected = new Set(
    mediaPlan
      .filter((row) => momentsMediaNeedsRecovery(row, capture.records.get(row.planId)))
      .map((row) => row.planId),
  );
  const actual = new Set(recoveryPlan.map((row) => row.planId));
  if (expected.size !== actual.size || [...expected].some((planId) => !actual.has(planId))) {
    throw new Error(
      "Moments recovery plan must exactly cover capture results that require recovery.",
    );
  }
  const recoveryById = new Map(recoveryPlan.map((row) => [row.planId, row]));
  for (const planId of expected) {
    const recovery = recoveryById.get(planId);
    const captured = capture.records.get(planId);
    const normalized = normalizedByKey.get(planId);
    const expectedSha256 = SHA256.test(normalized?.hash ?? "") ? normalized.hash : null;
    const expectedHttpStatus = Number.isSafeInteger(captured.httpStatus)
      ? captured.httpStatus
      : null;
    if (
      recovery.checkpointStatus !== captured.status ||
      recovery.errorCode !== (captured.errorCode ?? null) ||
      recovery.httpStatus !== expectedHttpStatus ||
      recovery.expectedSha256 !== expectedSha256
    ) {
      throw new Error(
        "Moments recovery plan does not match the latest capture and normalized media.",
      );
    }
  }
}

function validatePlans(mediaPlan, recoveryPlan) {
  const planById = new Map();
  for (const row of mediaPlan) {
    if (
      !row ||
      !MEDIA_KEY.test(row.planId ?? "") ||
      !MEDIA_KEY.test(row.mediaKey ?? "") ||
      row.planId !== row.mediaKey ||
      planById.has(row.planId) ||
      (row.target !== null && !["public", "private"].includes(row.target)) ||
      typeof row.publicEligible !== "boolean" ||
      (row.publicEligible === true && row.target === "private") ||
      (row.publicEligible === false && row.target === "public")
    ) {
      throw new Error("Moments media plan is invalid.");
    }
    planById.set(row.planId, row);
  }
  const recoveryIds = new Set();
  for (const row of recoveryPlan) {
    const planned = planById.get(row?.planId);
    const expectedTarget = isPublicPlanRow(planned) ? "public" : "private";
    const legacyNullPublicTarget =
      planned?.publicEligible === true && planned.target === null && row?.target === "private";
    if (
      row?.schemaVersion !== "poapin-moments-media-recovery-row-v1" ||
      !MEDIA_KEY.test(row.planId ?? "") ||
      !MEDIA_KEY.test(row.mediaKey ?? "") ||
      row.planId !== row.mediaKey ||
      recoveryIds.has(row.planId) ||
      !planned ||
      (row.target !== expectedTarget && !legacyNullPublicTarget) ||
      row.publicEligible !== planned.publicEligible ||
      row.eligibility !== planned.eligibility ||
      (row.expectedSha256 !== null && !SHA256.test(row.expectedSha256 ?? "")) ||
      !Array.isArray(row.strategies) ||
      row.strategies.length < 1 ||
      !row.strategies.every((strategy) => validateRecoveryStrategy(strategy, row, planById))
    ) {
      throw new Error("Moments recovery plan is invalid.");
    }
    recoveryIds.add(row.planId);
  }
  return planById;
}

function validateMediaPlanCoverage(mediaPlan, normalizedMedia) {
  const normalizedByKey = new Map();
  for (const row of normalizedMedia) {
    if (!MEDIA_KEY.test(row?.key ?? "") || normalizedByKey.has(row.key)) {
      throw new Error("Normalized moment media contains a missing or duplicate key.");
    }
    normalizedByKey.set(row.key, row);
  }
  const planKeys = new Set(mediaPlan.map((row) => row.mediaKey));
  if (
    planKeys.size !== normalizedByKey.size ||
    [...planKeys].some((key) => !normalizedByKey.has(key))
  ) {
    throw new Error("Moments media plan must cover normalized moment_media keys exactly once.");
  }
  return normalizedByKey;
}

function validateRecoveryStrategy(strategy, recoveryRow, planById) {
  if (!strategy || typeof strategy.kind !== "string") return false;
  if (["retry_primary", "multipart_original"].includes(strategy.kind)) {
    return Boolean(
      strategy.fidelity === "original" &&
      strategy.target === recoveryRow.target &&
      isCanonicalOriginalUrl(strategy.sourceUrl, recoveryRow.mediaKey) &&
      strategy.requireSha256 === recoveryRow.expectedSha256,
    );
  }
  if (strategy.kind === "hash_alias_original") {
    return Boolean(
      strategy.fidelity === "original" &&
      strategy.target === recoveryRow.target &&
      strategy.requireSha256 === recoveryRow.expectedSha256 &&
      SHA256.test(strategy.requireSha256 ?? "") &&
      Array.isArray(strategy.candidates) &&
      strategy.candidates.length > 0 &&
      strategy.candidates.every(
        (candidate) =>
          planById.has(candidate?.mediaKey) &&
          isCanonicalOriginalUrl(candidate.sourceUrl, candidate.mediaKey),
      ),
    );
  }
  if (strategy.kind === "legacy_original") {
    return Boolean(
      strategy.fidelity === "original" &&
      strategy.target === recoveryRow.target &&
      strategy.requireSha256 === recoveryRow.expectedSha256 &&
      Array.isArray(strategy.candidates) &&
      strategy.candidates.length > 0 &&
      strategy.candidates.every((candidate) =>
        recoveryUrlValidators.isLegacyOriginal(candidate?.sourceUrl),
      ),
    );
  }
  if (strategy.kind === "thumbnail_derivative") {
    return Boolean(
      strategy.fidelity === "derivative" &&
      strategy.target === "private" &&
      recoveryUrlValidators.isThumbnail(strategy.sourceUrl, recoveryRow.mediaKey),
    );
  }
  if (strategy.kind === "hls_derivative") {
    return Boolean(
      strategy.fidelity === "derivative" &&
      strategy.target === "private" &&
      recoveryUrlValidators.isHlsManifest(strategy.sourceUrl, recoveryRow.mediaKey),
    );
  }
  if (strategy.kind === "public_original_required") {
    const planned = planById.get(recoveryRow.planId);
    return Boolean(
      strategy.fidelity === "none" &&
      strategy.target === "public" &&
      recoveryRow.publicEligible === true &&
      (recoveryRow.target === "public" || isLegacyNullPublicRecovery(planned, recoveryRow)) &&
      typeof strategy.reason === "string" &&
      strategy.reason.length > 0,
    );
  }
  if (strategy.kind === "private_recovery_required") {
    return Boolean(
      strategy.fidelity === "none" &&
      strategy.target === "private" &&
      recoveryRow.publicEligible === false &&
      recoveryRow.target === "private" &&
      recoveryRowRequiresRetryGate(recoveryRow) &&
      typeof strategy.reason === "string" &&
      strategy.reason.length > 0,
    );
  }
  return Boolean(
    strategy.kind === "metadata_only" &&
    strategy.fidelity === "none" &&
    strategy.target === "private" &&
    !recoveryRowRequiresRetryGate(recoveryRow) &&
    typeof strategy.reason === "string" &&
    strategy.reason.length > 0,
  );
}

function recoveryRowRequiresRetryGate(row) {
  return momentsCaptureFailureRequiresRetry({
    status: row?.checkpointStatus,
    errorCode: row?.errorCode,
    httpStatus: row?.httpStatus,
  });
}

function validateRecoveryJournal({ journal, mediaPlan, recoveryPlan, snapshotId }) {
  const planById = new Map(mediaPlan.map((row) => [row.planId, row]));
  const recoveryById = new Map(recoveryPlan.map((row) => [row.planId, row]));
  for (const record of journal.mediaHistory) {
    const planned = planById.get(record.planId);
    const recovery = recoveryById.get(record.planId);
    if (
      !planned ||
      !recovery ||
      record.mediaKey !== record.planId ||
      !["original_stored", "derivative_stored", "metadata_only", "failed"].includes(record.status)
    ) {
      throw new Error("Recovery checkpoint contains an invalid media result.");
    }
    const strategy = recovery.strategies.find((candidate) => candidate.kind === record.strategy);
    if (record.status === "original_stored") {
      const classification = classifyCheckpointObject(record, snapshotId);
      const plannedPublic = isPublicPlanRow(planned);
      const legacyNullPublicRecovery = isLegacyNullPublicRecovery(planned, recovery);
      if (
        strategy?.fidelity !== "original" ||
        classification?.fidelity !== "original" ||
        (record.target === "public" && (!plannedPublic || record.quarantined === true)) ||
        (record.target === "private" &&
          plannedPublic &&
          record.quarantined !== true &&
          !legacyNullPublicRecovery)
      ) {
        throw new Error("Recovery checkpoint contains an invalid original result.");
      }
    } else if (record.status === "derivative_stored") {
      const classification = classifyCheckpointObject(record.rootObject, snapshotId);
      if (
        strategy?.fidelity !== "derivative" ||
        classification?.fidelity !== "derivative" ||
        record.rootObject?.target !== "private" ||
        !Number.isSafeInteger(record.objectCount) ||
        record.objectCount < 1 ||
        !Number.isSafeInteger(record.byteLength) ||
        record.byteLength < 1
      ) {
        throw new Error("Recovery checkpoint contains an invalid derivative result.");
      }
    } else if (record.status === "metadata_only") {
      const nonPublic =
        planned.publicEligible === false &&
        !isPublicPlanRow(planned) &&
        recovery.publicEligible === false &&
        recovery.target === "private";
      const explicitMetadataOnly =
        strategy?.kind === "metadata_only" &&
        strategy.fidelity === "none" &&
        record.fidelity === "none" &&
        record.reason === strategy.reason &&
        record.attempts === undefined;
      const exhaustedCandidates =
        record.strategy === null &&
        record.fidelity === "none" &&
        record.reason === EXHAUSTED_RECOVERY_REASON &&
        recovery.strategies.every((candidate) => candidate.kind !== "metadata_only") &&
        validateExhaustedAttempts(record.attempts, recovery.strategies);
      const legacyPublicPlaceholder =
        isPublicPlanRow(planned) &&
        recovery.publicEligible === true &&
        (recovery.target === "public" || isLegacyNullPublicRecovery(planned, recovery)) &&
        explicitMetadataOnly;
      if (
        (!(nonPublic && (explicitMetadataOnly || exhaustedCandidates)) &&
          !legacyPublicPlaceholder) ||
        (legacyPublicPlaceholder && isRecoveryTerminal(recovery, record))
      ) {
        throw new Error("Recovery checkpoint contains an invalid metadata-only result.");
      }
    }
  }
  for (const record of journal.objectHistory) {
    const recovery = recoveryById.get(record.planId);
    const hls = recovery?.strategies.find((strategy) => strategy.kind === "hls_derivative");
    if (
      record.mediaKey !== record.planId ||
      classifyCheckpointObject(record, snapshotId)?.fidelity !== "derivative" ||
      record.target !== "private" ||
      !hls ||
      !isFixedHlsResourceUrl(record.sourceUrl, record.mediaKey, hls.sourceUrl)
    ) {
      throw new Error("Recovery checkpoint contains an invalid derivative object.");
    }
  }
}

function validateExhaustedAttempts(attempts, strategies) {
  return Boolean(
    Array.isArray(attempts) &&
    attempts.length === strategies.length &&
    isAllowedExhaustedStrategySet(strategies, attempts) &&
    attempts.every(
      (attempt, index) =>
        attempt &&
        attempt.strategy === strategies[index].kind &&
        /^[A-Za-z0-9_-]{1,80}$/.test(attempt.code ?? "") &&
        (attempt.httpStatus === null ||
          (Number.isSafeInteger(attempt.httpStatus) &&
            attempt.httpStatus >= 100 &&
            attempt.httpStatus <= 599)) &&
        isExhaustedRecoveryFailure(attempt, strategies[index].kind) &&
        validateRecoveryFailureAudit(attempt, strategies[index]),
    ),
  );
}

function isAllowedExhaustedStrategySet(strategies, attempts) {
  const hasLegacyDnsMissing = attempts.some(
    (attempt) => attempt?.code === "RECOVERY_LEGACY_SOURCE_DNS_MISSING",
  );
  return Boolean(
    !hasLegacyDnsMissing ||
    (strategies.length === 1 && strategies[0]?.kind === "legacy_original" && attempts.length === 1),
  );
}

function recoveryFailureAudit(error) {
  if (
    safeCode(error) !== "RECOVERY_LEGACY_SOURCE_DNS_MISSING" ||
    error?.allRecoveryCandidatesExhausted !== true ||
    error.allLegacyCandidatesDnsMissing !== true ||
    !Number.isSafeInteger(error.recoveryCandidateCount) ||
    error.recoveryCandidateCount < 1 ||
    !Number.isSafeInteger(error.recoveryAttemptCount) ||
    error.recoveryAttemptCount < error.recoveryCandidateCount
  ) {
    return {};
  }
  return {
    candidateCount: error.recoveryCandidateCount,
    attemptCount: error.recoveryAttemptCount,
  };
}

function validateRecoveryFailureAudit(attempt, strategy) {
  if (attempt.code !== "RECOVERY_LEGACY_SOURCE_DNS_MISSING") {
    return attempt.candidateCount === undefined && attempt.attemptCount === undefined;
  }
  return Boolean(
    strategy.kind === "legacy_original" &&
    Array.isArray(strategy.candidates) &&
    attempt.candidateCount === strategy.candidates.length &&
    Number.isSafeInteger(attempt.attemptCount) &&
    attempt.attemptCount >= attempt.candidateCount &&
    attempt.attemptCount % attempt.candidateCount === 0 &&
    attempt.attemptCount / attempt.candidateCount <= 10,
  );
}

function isFetchDnsNotFound(error, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const cause = error?.cause;
  return Boolean(
    error?.name === "TypeError" &&
    cause &&
    !(cause instanceof AggregateError) &&
    cause.code === "ENOTFOUND" &&
    cause.syscall === "getaddrinfo" &&
    cause.hostname === RETIRED_LEGACY_SOURCE_HOST &&
    parsed.protocol === "https:" &&
    parsed.hostname === RETIRED_LEGACY_SOURCE_HOST,
  );
}

function markDownloadAttemptDnsOutcome(error, allAttemptsDnsNotFound, attemptCount) {
  try {
    Object.defineProperty(error, "allRecoveryAttemptsDnsNotFound", {
      configurable: true,
      value: allAttemptsDnsNotFound,
    });
    Object.defineProperty(error, "recoveryAttemptCount", {
      configurable: true,
      value: attemptCount,
    });
    return error;
  } catch {
    return Object.assign(new Error(error?.message ?? "Recovery download failed."), {
      code: safeCode(error),
      allRecoveryAttemptsDnsNotFound,
      recoveryAttemptCount: attemptCount,
    });
  }
}

function isExhaustedRecoveryFailure(error, strategyKind) {
  if (error?.allRecoveryCandidatesExhausted === false) return false;
  const code = safeCode(error);
  if (code === "RECOVERY_SOURCE_MISSING") {
    return [404, 410].includes(error?.httpStatus);
  }
  if (code === "RECOVERY_SOURCE_HTTP_ERROR") return error?.httpStatus === 403;
  if (code === "RECOVERY_LEGACY_SOURCE_DNS_MISSING") {
    return (
      strategyKind === "legacy_original" &&
      (error?.allLegacyCandidatesDnsMissing === true ||
        error?.allLegacyCandidatesDnsMissing === undefined) &&
      (error?.httpStatus === null || error?.httpStatus === undefined)
    );
  }
  return Boolean(
    EXHAUSTED_RECOVERY_FAILURE_CODES.has(code) &&
    (error?.httpStatus === null || error?.httpStatus === undefined),
  );
}

function isExhaustedRecoveryCandidateFailure(error, strategyKind) {
  if (error?.code === "RECOVERY_LEGACY_SOURCE_DNS_MISSING" && strategyKind === "legacy_original") {
    return error.allRecoveryAttemptsDnsNotFound === true;
  }
  return isExhaustedRecoveryFailure(error, strategyKind);
}

function markCandidateExhaustion(
  error,
  exhausted,
  { allLegacyCandidatesDnsMissing = false, candidateCount = null, attemptCount = null } = {},
) {
  try {
    Object.defineProperty(error, "allRecoveryCandidatesExhausted", {
      configurable: true,
      value: exhausted,
    });
    Object.defineProperty(error, "allLegacyCandidatesDnsMissing", {
      configurable: true,
      value: allLegacyCandidatesDnsMissing,
    });
    if (allLegacyCandidatesDnsMissing) {
      Object.defineProperty(error, "recoveryCandidateCount", {
        configurable: true,
        value: candidateCount,
      });
      Object.defineProperty(error, "recoveryAttemptCount", {
        configurable: true,
        value: attemptCount,
      });
    }
    return error;
  } catch {
    const wrapped = Object.assign(new Error(error?.message ?? "Recovery candidate failed."), {
      code: safeCode(error),
      httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
      allRecoveryCandidatesExhausted: exhausted,
      allLegacyCandidatesDnsMissing,
    });
    if (allLegacyCandidatesDnsMissing) {
      wrapped.recoveryCandidateCount = candidateCount;
      wrapped.recoveryAttemptCount = attemptCount;
    }
    return wrapped;
  }
}

function isCaptureTerminal(planRow, record) {
  if (!CAPTURE_STORED.has(record?.status)) return false;
  return !isPublicPlanRow(planRow) || record.status === "public_stored";
}

function isRecoveryTerminal(recoveryRow, record) {
  if (!record) return false;
  if (recoveryRow.publicEligible || recoveryRow.target === "public") {
    return (
      record.status === "original_stored" &&
      record.target === "public" &&
      record.quarantined !== true
    );
  }
  return NON_PUBLIC_TERMINAL_RECOVERY.has(record.status);
}

function classifyCheckpointObject(record, snapshotId) {
  if (
    !record ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1 ||
    !SHA256.test(record.sha256 ?? "") ||
    typeof record.contentType !== "string"
  ) {
    return null;
  }
  return classifyMomentsMediaObject({
    snapshotId,
    target: record.target,
    key: record.objectKey,
    sha256: record.sha256,
    contentType: record.contentType,
  });
}

function effectiveManifestRow({ planRow, captureRecord, recoveryRecord, wasPlannedForRecovery }) {
  if (isCaptureTerminal(planRow, captureRecord)) return manifestFromCapture(captureRecord);
  if (recoveryRecord?.status === "original_stored") {
    return {
      mediaKey: planRow.mediaKey,
      objectKey: recoveryRecord.target === "public" ? recoveryRecord.objectKey : null,
      sha256: recoveryRecord.sha256,
      byteLength: recoveryRecord.byteLength,
      contentType: recoveryRecord.contentType,
      status:
        recoveryRecord.target === "public"
          ? "public_stored"
          : recoveryRecord.quarantined
            ? "quarantined_stored"
            : "private_stored",
    };
  }
  if (CAPTURE_STORED.has(captureRecord?.status)) return manifestFromCapture(captureRecord);
  if (
    wasPlannedForRecovery &&
    ["derivative_stored", "metadata_only"].includes(recoveryRecord?.status)
  ) {
    return {
      mediaKey: planRow.mediaKey,
      objectKey: null,
      sha256: null,
      byteLength: null,
      contentType: null,
      status: "source_missing",
    };
  }
  return {
    mediaKey: planRow.mediaKey,
    objectKey: null,
    sha256: captureRecord?.sha256 ?? null,
    byteLength: captureRecord?.byteLength ?? null,
    contentType: captureRecord?.contentType ?? null,
    status: captureRecord?.status ?? "unattempted",
  };
}

function manifestFromCapture(record) {
  return {
    mediaKey: record.mediaKey,
    objectKey: record.status === "public_stored" ? record.objectKey : null,
    sha256: record.sha256 ?? null,
    byteLength: record.byteLength ?? null,
    contentType: record.contentType ?? null,
    status: record.status,
  };
}

function captureCounts(mediaPlan, manifest) {
  const counts = {
    planned: mediaPlan.length,
    publicEligible: mediaPlan.filter((row) => row.publicEligible).length,
    publicStored: 0,
    privateStored: 0,
    quarantinedStored: 0,
    sourceMissing: 0,
    oversize: 0,
    failed: 0,
    unattempted: 0,
  };
  for (const row of manifest) {
    const field = {
      public_stored: "publicStored",
      private_stored: "privateStored",
      quarantined_stored: "quarantinedStored",
      source_missing: "sourceMissing",
      oversize: "oversize",
      failed: "failed",
      unattempted: "unattempted",
    }[row.status];
    if (field) counts[field] += 1;
  }
  return counts;
}

function recoveryPaths({
  input,
  captureCheckpointPath,
  recoveryPlanPath,
  checkpointPath,
  manifestPath,
  reportPath,
}) {
  const root = resolve(input ?? "");
  const media = join(root, "media");
  return {
    mediaPlan: join(media, "plan.ndjson"),
    normalizedMedia: join(root, "normalized", "moment_media.ndjson"),
    captureCheckpoint: resolve(captureCheckpointPath ?? join(media, "capture-checkpoint.ndjson")),
    recoveryPlan: resolve(recoveryPlanPath ?? join(media, "recovery-plan.ndjson")),
    checkpoint: resolve(checkpointPath ?? join(media, "recovery-checkpoint.ndjson")),
    manifest: resolve(manifestPath ?? join(media, "d1-media-manifest.ndjson")),
    report: resolve(reportPath ?? join(media, "capture-report.json")),
  };
}

function validateRecoveryOutputPaths(paths) {
  const immutable = new Set(
    [
      paths.mediaPlan,
      paths.normalizedMedia,
      paths.captureCheckpoint,
      paths.recoveryPlan,
      paths.checkpoint,
    ].map((path) => resolve(path)),
  );
  const outputs = [paths.manifest, paths.proof, paths.report].map((path) => resolve(path));
  if (outputs.some((path) => immutable.has(path)) || new Set(outputs).size !== outputs.length) {
    throw new Error("Recovery outputs must not overwrite immutable inputs or each other.");
  }
}

function validateRecoveryCheckpointLimits(header) {
  if (
    !Number.isSafeInteger(header.maximumObjectBytes) ||
    header.maximumObjectBytes < 1 ||
    header.maximumObjectBytes > 100_000_000 ||
    !Number.isSafeInteger(header.maximumRecoveryObjectBytes) ||
    header.maximumRecoveryObjectBytes < header.maximumObjectBytes ||
    header.maximumRecoveryObjectBytes > 5_000_000_000_000 ||
    !Number.isSafeInteger(header.multipartPartBytes) ||
    header.multipartPartBytes < MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES ||
    header.multipartPartBytes > header.maximumObjectBytes ||
    Math.ceil(header.maximumRecoveryObjectBytes / header.multipartPartBytes) >
      MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS
  ) {
    throw new Error("Recovery checkpoint contains invalid object-size limits.");
  }
}

function validateRecoveryOptions({
  snapshotId,
  concurrency,
  attempts,
  maximumObjectBytes,
  maximumRecoveryObjectBytes,
  multipartPartBytes,
  publicBucket,
  privateBucket,
}) {
  if (!SNAPSHOT.test(snapshotId ?? "")) throw new Error("Snapshot ID is invalid.");
  validateMomentsBucketPair(publicBucket, privateBucket);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Recovery concurrency must be from 1 to 4.");
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
  if (
    !Number.isSafeInteger(maximumRecoveryObjectBytes) ||
    maximumRecoveryObjectBytes < maximumObjectBytes ||
    maximumRecoveryObjectBytes > 5_000_000_000_000
  ) {
    throw new Error("Maximum recovery object bytes are outside the R2 bound.");
  }
  if (
    !Number.isSafeInteger(multipartPartBytes) ||
    multipartPartBytes < MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES ||
    multipartPartBytes > maximumObjectBytes
  ) {
    throw new Error("Multipart part bytes are outside the bridge bound.");
  }
  if (
    Math.ceil(maximumRecoveryObjectBytes / multipartPartBytes) >
    MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS
  ) {
    throw new Error("Maximum recovery object bytes require too many multipart parts.");
  }
}

function objectResult(object, upload) {
  return {
    target: object.target,
    objectKey: object.key,
    sha256: object.sha256,
    byteLength: object.byteLength,
    contentType: object.contentType,
    disposition: upload.disposition,
    etag: upload.etag,
  };
}

function recoveryStoredRecords(row) {
  if (row?.kind !== "media") return [];
  if (row.status === "original_stored") return [row];
  if (row.status === "derivative_stored" && row.rootObject) return [row.rootObject];
  return [];
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

function objectEventIdentity(planId, sourceUrl) {
  return `${planId}\0${sourceUrl}`;
}

function multipartEventIdentity(planId, objectKey) {
  return `${planId}\0${objectKey}`;
}

function parseContentLength(value) {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizeContentType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() || null : null;
}

function safeHeader(value) {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function recoveryOversizeError() {
  return Object.assign(new Error("Recovery source exceeds its configured byte limit."), {
    code: "RECOVERY_SOURCE_OVERSIZE",
  });
}

function safeCode(error) {
  const value = error?.code ?? error?.name ?? "RECOVERY_FAILED";
  return (
    String(value)
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80) || "RECOVERY_FAILED"
  );
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function mediaProofPath(manifestPath) {
  if (!manifestPath.endsWith(".ndjson")) {
    throw new Error("D1 media manifest path must end with .ndjson.");
  }
  return `${manifestPath.slice(0, -".ndjson".length)}.json`;
}

function relativeArtifact(reportPath, artifactPath) {
  return basename(artifactPath) === artifactPath
    ? artifactPath
    : resolve(artifactPath).replace(`${resolve(dirname(reportPath))}/`, "");
}

async function assertFileDigest(path, expectedSha256, label = "Capture checkpoint") {
  if ((await sha256File(path)).sha256 !== expectedSha256) {
    throw new Error(`${label} changed while it was being validated.`);
  }
}

async function assertRecoveryEvaluationInputsCurrent({ paths, inputDigests }) {
  await Promise.all([
    assertFileDigest(paths.mediaPlan, inputDigests.mediaPlan, "Media plan"),
    assertFileDigest(paths.normalizedMedia, inputDigests.normalizedMedia, "Normalized media"),
    assertFileDigest(paths.captureCheckpoint, inputDigests.captureCheckpoint, "Capture checkpoint"),
    assertFileDigest(paths.recoveryPlan, inputDigests.recoveryPlan, "Recovery plan"),
    assertFileDigest(paths.checkpoint, inputDigests.recoveryCheckpoint, "Recovery checkpoint"),
  ]);
}

function canonicalNdjsonSha256(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function boundMetadata(input) {
  return { sha256: input.sha256, byteLength: input.byteLength };
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

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}
