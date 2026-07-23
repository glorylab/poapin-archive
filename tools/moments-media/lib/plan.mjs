import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readNdjsonArray, writeJsonAtomic, writeNdjsonAtomic } from "./io.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_HOST = "cdn.media.poap.tech";

export async function buildMomentsMediaPlan({ input, snapshotId, output } = {}) {
  if (!SNAPSHOT.test(snapshotId ?? "")) throw new Error("Snapshot ID is invalid.");
  const root = resolve(input ?? "");
  const normalized = join(root, "normalized");
  const outputRoot = resolve(output ?? join(root, "media"));
  await mkdir(outputRoot, { recursive: true });

  const [moments, momentDrops, media, gateways, momentsHidden, dropsHidden] = await Promise.all([
    readNdjsonArray(join(normalized, "moments.ndjson")),
    readNdjsonArray(join(normalized, "moment_drops.ndjson")),
    readNdjsonArray(join(normalized, "moment_media.ndjson")),
    readNdjsonArray(join(normalized, "gateways.ndjson")),
    readNdjsonArray(join(normalized, "moments_hidden_drops.ndjson")),
    readNdjsonArray(join(normalized, "drops_hidden_drops.ndjson")),
  ]);

  const momentIds = uniqueIds(moments, "id", "Moment");
  // Only the Moments-specific set controls the Moments Explore projection.
  // Generic Drops hidden rows remain in the relational backup for fidelity.
  const hiddenDrops = new Set(
    momentsHidden.map((row) => normalizedDropId(row.drop_id, "Moments hidden drop")),
  );
  const dropsByMoment = new Map();
  for (const row of momentDrops) {
    const momentId = requiredUuid(row.moment_id, "moment_drops.moment_id");
    const dropId = normalizedDropId(row.drop_id, "moment_drops.drop_id");
    const values = dropsByMoment.get(momentId) ?? new Set();
    values.add(dropId);
    dropsByMoment.set(momentId, values);
  }

  const candidatesByMedia = new Map();
  let rejectedGatewayUrls = 0;
  for (const gateway of gateways) {
    const mediaKey = typeof gateway.moment_media_id === "string" ? gateway.moment_media_id : null;
    if (!mediaKey || !UUID.test(mediaKey) || !isCanonicalOriginal(gateway.url, mediaKey)) {
      rejectedGatewayUrls += 1;
      continue;
    }
    const values = candidatesByMedia.get(mediaKey) ?? [];
    values.push(gateway);
    candidatesByMedia.set(mediaKey, values);
  }

  const seenMedia = new Set();
  const rows = [];
  for (const item of media) {
    const mediaKey = requiredUuid(item.key, "moment_media.key");
    if (seenMedia.has(mediaKey)) throw new Error(`Duplicate media key ${mediaKey}.`);
    seenMedia.add(mediaKey);
    const momentId =
      item.moment_id === null ? null : requiredUuid(item.moment_id, "moment_media.moment_id");
    const dropIds = momentId ? [...(dropsByMoment.get(momentId) ?? [])].sort(compareDropIds) : [];
    const hiddenDrop = dropIds.find((dropId) => hiddenDrops.has(dropId)) ?? null;
    const eligibility = eligibilityReason({
      momentId,
      momentExists: momentId ? momentIds.has(momentId) : false,
      status: item.status,
      dropIds,
      hiddenDrop,
    });
    const candidates = (candidatesByMedia.get(mediaKey) ?? []).sort(compareGateway);
    const gateway = candidates[0] ?? null;
    const metadata = isObject(gateway?.metadata) ? gateway.metadata : null;
    rows.push({
      planId: mediaKey,
      mediaKey,
      momentId,
      gatewayId: gateway?.id ?? null,
      sourceUrl: gateway?.url ?? null,
      declaredContentType: normalizeContentType(gateway?.type ?? item.mime_type),
      declaredByteLength: positiveInteger(metadata?.size),
      sourceStatus: item.status ?? null,
      publicEligible: eligibility === "public",
      target: gateway ? (eligibility === "public" ? "public" : "private") : null,
      eligibility,
      dropIds,
      alternateOriginalGateways: Math.max(0, candidates.length - 1),
    });
  }
  rows.sort((left, right) => left.mediaKey.localeCompare(right.mediaKey));

  const planPath = join(outputRoot, "plan.ndjson");
  const planSha256 = await writeNdjsonAtomic(planPath, rows);
  const counts = countPlan(rows);
  const report = {
    schemaVersion: "poapin-moments-media-plan-v1",
    snapshotId,
    generatedAt: new Date().toISOString(),
    input: { normalized: "normalized/" },
    plan: { path: "media/plan.ndjson", sha256: planSha256, rows: rows.length },
    counts: {
      ...counts,
      normalizedMoments: moments.length,
      normalizedMedia: media.length,
      normalizedGateways: gateways.length,
      hiddenDrops: hiddenDrops.size,
      genericDropHiddenRows: dropsHidden.length,
      rejectedOrDerivedGatewayRows: rejectedGatewayUrls,
      gatewayRowsNotSelected: gateways.length - rows.filter((row) => row.gatewayId).length,
    },
  };
  await writeJsonAtomic(join(outputRoot, "plan-report.json"), report);
  return { planPath, reportPath: join(outputRoot, "plan-report.json"), report };
}

export function isCanonicalOriginal(rawUrl, mediaKey) {
  if (typeof rawUrl !== "string") return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return Boolean(
    url.protocol === "https:" &&
    url.hostname === SOURCE_HOST &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === `/${mediaKey}`,
  );
}

function eligibilityReason({ momentId, momentExists, status, dropIds, hiddenDrop }) {
  if (!momentId || !momentExists) return "orphan_media";
  if (status !== "PROCESSED") return "source_not_processed";
  if (dropIds.length === 0) return "moment_without_drop";
  if (hiddenDrop !== null) return "hidden_drop";
  return "public";
}

function uniqueIds(rows, field, label) {
  const values = new Set();
  for (const row of rows) {
    const value = requiredUuid(row[field], `${label}.${field}`);
    if (values.has(value)) throw new Error(`${label} ID ${value} is duplicated.`);
    values.add(value);
  }
  return values;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid.`);
  return value.toLowerCase();
}

function normalizedDropId(value, label) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeContentType(value) {
  const normalized = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : null;
  return normalized === "image/jpg" ? "image/jpeg" : normalized || null;
}

function compareDropIds(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareGateway(left, right) {
  return String(left.id).localeCompare(String(right.id));
}

function countPlan(rows) {
  const counts = {
    planned: rows.length,
    sourceAvailable: 0,
    sourceMissing: 0,
    public: 0,
    private: 0,
    alternateOriginalGateways: 0,
  };
  for (const row of rows) {
    if (row.sourceUrl) counts.sourceAvailable += 1;
    else counts.sourceMissing += 1;
    if (row.target === "public") counts.public += 1;
    if (row.target === "private") counts.private += 1;
    counts.alternateOriginalGateways += row.alternateOriginalGateways;
  }
  return counts;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
