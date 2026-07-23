import { join, resolve } from "node:path";

import { readNdjsonArray, sha256File, writeJsonAtomic, writeNdjsonAtomic } from "./io.mjs";
import { isCanonicalOriginal } from "./plan.mjs";
import {
  momentsCaptureFailureRequiresRetry,
  momentsMediaNeedsRecovery,
} from "./recovery-policy.mjs";

const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORED = new Set(["public_stored", "private_stored", "quarantined_stored"]);

export async function buildMomentsMediaRecoveryPlan({
  input,
  snapshotId,
  checkpointPath,
  output,
  reportPath,
} = {}) {
  if (!SNAPSHOT.test(snapshotId ?? "")) throw new Error("Snapshot ID is invalid.");
  const root = resolve(input ?? "");
  const mediaRoot = join(root, "media");
  const planPath = join(mediaRoot, "plan.ndjson");
  const checkpoint = resolve(checkpointPath ?? join(mediaRoot, "capture-checkpoint.ndjson"));
  const outputPath = resolve(output ?? join(mediaRoot, "recovery-plan.ndjson"));
  const report = resolve(reportPath ?? join(mediaRoot, "recovery-plan-report.json"));

  const [plan, planMetadata, checkpointRows, media, gateways] = await Promise.all([
    readNdjsonArray(planPath),
    sha256File(planPath),
    readNdjsonArray(checkpoint),
    readNdjsonArray(join(root, "normalized", "moment_media.ndjson")),
    readNdjsonArray(join(root, "normalized", "gateways.ndjson")),
  ]);
  const { header, latest, historyRows } = validateCheckpoint({
    rows: checkpointRows,
    snapshotId,
    planSha256: planMetadata.sha256,
    planRows: plan.length,
  });
  validateMediaPlanVisibility(plan);
  const planById = uniqueMap(plan, "planId", "media plan");
  const mediaByKey = uniqueMap(media, "key", "moment media");
  const gatewaysByMedia = groupBy(gateways, "moment_media_id");
  const mediaKeysByHash = new Map();
  for (const row of media) {
    if (!SHA256.test(row.hash ?? "")) continue;
    const values = mediaKeysByHash.get(row.hash) ?? [];
    values.push(row.key);
    mediaKeysByHash.set(row.hash, values);
  }

  for (const record of latest.values()) {
    const planned = planById.get(record.planId);
    const mediaRow = mediaByKey.get(record.mediaKey);
    if (
      !planned ||
      !mediaRow ||
      record.planId !== record.mediaKey ||
      planned.planId !== planned.mediaKey ||
      planned.mediaKey !== record.mediaKey
    ) {
      throw new Error(`Checkpoint media ${record.planId} is absent from the normalized plan.`);
    }
  }

  const rows = [];
  for (const record of latest.values()) {
    const planned = planById.get(record.planId);
    if (!momentsMediaNeedsRecovery(planned, record)) continue;
    const mediaRow = mediaByKey.get(record.mediaKey);
    const expectedSha256 = SHA256.test(mediaRow.hash ?? "") ? mediaRow.hash : null;
    const target =
      planned.publicEligible === true || planned.target === "public" ? "public" : "private";
    const ownGateways = gatewaysByMedia.get(record.mediaKey) ?? [];
    const strategies = recoveryStrategies({
      record,
      planned,
      expectedSha256,
      target,
      ownGateways,
      gatewaysByMedia,
      mediaKeysByHash,
      checkpointByMedia: latest,
    });
    rows.push({
      schemaVersion: "poapin-moments-media-recovery-row-v1",
      planId: record.planId,
      mediaKey: record.mediaKey,
      checkpointStatus: record.status,
      errorCode: record.errorCode ?? null,
      httpStatus: Number.isSafeInteger(record.httpStatus) ? record.httpStatus : null,
      target,
      publicEligible: planned.publicEligible,
      eligibility: planned.eligibility,
      expectedSha256,
      strategies,
    });
  }
  rows.sort((left, right) => left.planId.localeCompare(right.planId));
  const outputSha256 = await writeNdjsonAtomic(outputPath, rows);
  const reportValue = buildReport({
    snapshotId,
    header,
    plan,
    planSha256: planMetadata.sha256,
    latest,
    historyRows,
    rows,
    outputPath,
    outputSha256,
  });
  await writeJsonAtomic(report, reportValue);
  return { outputPath, reportPath: report, report: reportValue };
}

function recoveryStrategies({
  record,
  planned,
  expectedSha256,
  target,
  ownGateways,
  gatewaysByMedia,
  mediaKeysByHash,
  checkpointByMedia,
}) {
  const strategies = [];
  const primary = canonicalOriginal(ownGateways, record.mediaKey);
  const retryableSourceFailure = momentsCaptureFailureRequiresRetry(record);
  if (primary && retryableSourceFailure) {
    strategies.push({
      kind: "retry_primary",
      fidelity: "original",
      target,
      gatewayId: primary.id,
      sourceUrl: primary.url,
      requireSha256: expectedSha256,
    });
  }

  if (record.status === "oversize" && primary) {
    strategies.push({
      kind: "multipart_original",
      fidelity: "original",
      target,
      gatewayId: primary.id,
      sourceUrl: primary.url,
      requireSha256: expectedSha256,
      note: "Use bounded multipart parts; the one-request bridge is limited to 100000000 bytes.",
    });
  }

  if (record.httpStatus === 403 && expectedSha256) {
    const aliases = [];
    for (const aliasKey of mediaKeysByHash.get(expectedSha256) ?? []) {
      if (aliasKey === record.mediaKey) continue;
      const alias = canonicalOriginal(gatewaysByMedia.get(aliasKey) ?? [], aliasKey);
      if (!alias) continue;
      const candidate = { mediaKey: aliasKey, gatewayId: alias.id, sourceUrl: alias.url };
      const preserved = checkpointByMedia.get(aliasKey);
      if (
        STORED.has(preserved?.status) &&
        preserved.sha256 === expectedSha256 &&
        typeof preserved.objectKey === "string"
      ) {
        candidate.preservedObject = {
          status: preserved.status,
          target: preserved.target,
          objectKey: preserved.objectKey,
          sha256: preserved.sha256,
          byteLength: preserved.byteLength,
          contentType: preserved.contentType,
        };
      }
      aliases.push(candidate);
    }
    aliases.sort((left, right) => left.mediaKey.localeCompare(right.mediaKey));
    if (aliases.length > 0) {
      strategies.push({
        kind: "hash_alias_original",
        fidelity: "original",
        target,
        requireSha256: expectedSha256,
        candidates: aliases,
      });
    }
  }

  if (record.status === "source_missing") {
    const legacy = ownGateways.filter((gateway) => isLegacyOriginal(gateway.url));
    legacy.sort(compareGateway);
    if (legacy.length > 0) {
      strategies.push({
        kind: "legacy_original",
        fidelity: "original",
        target,
        requireSha256: expectedSha256,
        candidates: legacy.map((gateway) => ({
          gatewayId: gateway.id,
          sourceUrl: gateway.url,
          declaredContentType: normalizeContentType(gateway.type),
        })),
      });
    }
  }

  const thumbnail = ownGateways
    .filter((gateway) => isThumbnail(gateway.url, record.mediaKey))
    .sort(compareGateway)[0];
  if (
    thumbnail &&
    (record.status === "source_missing" || [403, 404, 410].includes(record.httpStatus))
  ) {
    strategies.push({
      kind: "thumbnail_derivative",
      fidelity: "derivative",
      target: "private",
      gatewayId: thumbnail.id,
      sourceUrl: thumbnail.url,
      declaredContentType: "image/webp",
    });
  }

  const hls = ownGateways
    .filter((gateway) => isHlsManifest(gateway.url, record.mediaKey))
    .sort(compareGateway)[0];
  if (
    hls &&
    (record.status === "oversize" ||
      record.status === "source_missing" ||
      [403, 404, 410].includes(record.httpStatus))
  ) {
    strategies.push({
      kind: "hls_derivative",
      fidelity: "derivative",
      target: "private",
      gatewayId: hls.id,
      sourceUrl: hls.url,
      declaredContentType: "application/vnd.apple.mpegurl",
      note: "Capture the playlist and every fixed relative segment as one private derivative set.",
    });
  }

  if (strategies.length === 0) {
    const reason =
      planned.sourceStatus === "INVALID"
        ? "invalid_media_without_recoverable_gateway"
        : "no_fixed_recovery_candidate";
    if (target === "public" || planned.publicEligible) {
      strategies.push({
        kind: "public_original_required",
        fidelity: "none",
        target: "public",
        reason,
      });
    } else if (retryableSourceFailure) {
      strategies.push({
        kind: "private_recovery_required",
        fidelity: "none",
        target: "private",
        reason: "retryable_source_without_fixed_candidate",
      });
    } else {
      strategies.push({
        kind: "metadata_only",
        fidelity: "none",
        target: "private",
        reason,
      });
    }
  }
  return strategies;
}

function validateCheckpoint({ rows, snapshotId, planSha256, planRows }) {
  const headers = rows.filter((row) => row.kind === "header");
  if (headers.length !== 1) throw new Error("Media checkpoint must contain exactly one header.");
  const header = headers[0];
  if (
    header.schemaVersion !== "poapin-moments-media-checkpoint-v1" ||
    header.snapshotId !== snapshotId ||
    header.planSha256 !== planSha256 ||
    header.planRows !== planRows
  ) {
    throw new Error("Media checkpoint does not match the selected snapshot plan.");
  }
  const latest = new Map();
  let historyRows = 0;
  for (const row of rows) {
    if (row.kind === "header") continue;
    if (row.kind !== "media" || typeof row.planId !== "string") {
      throw new Error("Media checkpoint contains an invalid row.");
    }
    historyRows += 1;
    latest.set(row.planId, row);
  }
  return { header, latest, historyRows };
}

function buildReport({
  snapshotId,
  header,
  plan,
  planSha256,
  latest,
  historyRows,
  rows,
  outputPath,
  outputSha256,
}) {
  const statuses = countBy(rows, (row) => row.checkpointStatus);
  const strategies = countBy(
    rows.flatMap((row) => row.strategies),
    (strategy) => strategy.kind,
  );
  const originalCandidates = rows.filter((row) =>
    row.strategies.some((strategy) => strategy.fidelity === "original"),
  ).length;
  const derivativeOnly = rows.filter(
    (row) =>
      row.strategies.some((strategy) => strategy.fidelity === "derivative") &&
      !row.strategies.some((strategy) => strategy.fidelity === "original"),
  ).length;
  const metadataOnly = rows.filter((row) => row.strategies[0]?.kind === "metadata_only").length;
  const publicOriginalRequired = rows.filter(
    (row) => row.strategies[0]?.kind === "public_original_required",
  ).length;
  const privateRecoveryRequired = rows.filter(
    (row) => row.strategies[0]?.kind === "private_recovery_required",
  ).length;
  const alreadyPreservedBySha = rows.filter((row) =>
    row.strategies.some(
      (strategy) =>
        strategy.kind === "hash_alias_original" &&
        strategy.candidates.some((candidate) => candidate.preservedObject),
    ),
  ).length;
  return {
    schemaVersion: "poapin-moments-media-recovery-plan-v1",
    snapshotId,
    generatedAt: new Date().toISOString(),
    completeCheckpoint: latest.size === plan.length,
    source: {
      planSha256,
      planRows: plan.length,
      checkpointMaximumObjectBytes: header.maximumObjectBytes,
      checkpointHistoryRows: historyRows,
      checkpointLatestRows: latest.size,
      checkpointUnattemptedRows: plan.length - latest.size,
    },
    counts: {
      unresolved: rows.length,
      statuses,
      strategies,
      originalCandidates,
      derivativeOnly,
      metadataOnly,
      publicOriginalRequired,
      privateRecoveryRequired,
      alreadyPreservedBySha,
    },
    artifact: { path: outputPath, sha256: outputSha256, rows: rows.length },
  };
}

function canonicalOriginal(gateways, mediaKey) {
  return [...gateways]
    .filter((gateway) => isCanonicalOriginal(gateway.url, mediaKey))
    .sort(compareGateway)[0];
}

function isThumbnail(value, mediaKey) {
  return exactUrl(value, "cdn.media.poap.tech", `/thumbnails/${mediaKey}.webp`);
}

function isHlsManifest(value, mediaKey) {
  return exactUrl(
    value,
    "poap-media-hls-production.s3.us-east-2.amazonaws.com",
    `/${mediaKey}/${mediaKey}.m3u8`,
  );
}

function isLegacyOriginal(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return Boolean(
    url.protocol === "https:" &&
    url.hostname === "cdn.registry.poap.tech" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/[A-Za-z0-9._-]{1,500}$/.test(url.pathname),
  );
}

function exactUrl(value, hostname, pathname) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return Boolean(
    url.protocol === "https:" &&
    url.hostname === hostname &&
    !url.port &&
    url.pathname === pathname &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
  );
}

function uniqueMap(rows, field, label) {
  const result = new Map();
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== "string" || result.has(key)) {
      throw new Error(`${label} contains a missing or duplicate ${field}.`);
    }
    result.set(key, row);
  }
  return result;
}

function validateMediaPlanVisibility(rows) {
  for (const row of rows) {
    if (
      typeof row?.publicEligible !== "boolean" ||
      (row.target !== null && !["public", "private"].includes(row.target)) ||
      (row.publicEligible === true && row.target === "private") ||
      (row.publicEligible === false && row.target === "public")
    ) {
      throw new Error("Media plan contains an inconsistent public target.");
    }
  }
}

function groupBy(rows, field) {
  const result = new Map();
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== "string") continue;
    result.set(key, [...(result.get(key) ?? []), row]);
  }
  return result;
}

function countBy(rows, select) {
  const result = {};
  for (const row of rows) {
    const key = select(row);
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function compareGateway(left, right) {
  return String(left.id).localeCompare(String(right.id));
}

function normalizeContentType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() || null : null;
}

export const recoveryUrlValidators = Object.freeze({
  isThumbnail,
  isHlsManifest,
  isLegacyOriginal,
});
