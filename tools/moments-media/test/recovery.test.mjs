import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readNdjsonArray, sha256File } from "../lib/io.mjs";
import { buildMomentsMediaRecoveryPlan, recoveryUrlValidators } from "../lib/recovery.mjs";

const SNAPSHOT = "moments-2026-07-23-v1";
const RETRY = "11111111-1111-4111-8111-111111111111";
const FORBIDDEN = "22222222-2222-4222-8222-222222222222";
const ALIAS = "33333333-3333-4333-8333-333333333333";
const OVERSIZE = "44444444-4444-4444-8444-444444444444";
const LEGACY = "55555555-5555-4555-8555-555555555555";
const INVALID = "66666666-6666-4666-8666-666666666666";
const PUBLIC_MISSING = "77777777-7777-4777-8777-777777777777";
const VIDEO_FORBIDDEN = "88888888-8888-4888-8888-888888888888";
const PUBLIC_QUARANTINED = "99999999-9999-4999-8999-999999999999";
const POLICY_425 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POLICY_425_NO_SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BRIDGE_403 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KNOWN_SHA = "a".repeat(64);

test("builds a non-mutating, fixed-origin recovery plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-media-recovery-test-"));
  const mediaRoot = join(root, "media");
  const normalized = join(root, "normalized");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(normalized, { recursive: true });
  const plan = [
    planned(RETRY, "public"),
    planned(FORBIDDEN, "private"),
    planned(ALIAS, "public"),
    planned(OVERSIZE, "public"),
    { ...planned(LEGACY, null), sourceUrl: null },
    { ...planned(INVALID, null), sourceUrl: null, sourceStatus: "INVALID" },
    {
      ...planned(PUBLIC_MISSING, "public"),
      gatewayId: null,
      sourceUrl: null,
      target: null,
    },
    planned(VIDEO_FORBIDDEN, "private"),
  ];
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    {
      schemaVersion: "poapin-moments-media-checkpoint-v1",
      version: 1,
      kind: "header",
      snapshotId: SNAPSHOT,
      planSha256,
      planRows: plan.length,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: 100_000_000,
    },
    failed(RETRY, "authorization_failed", 401),
    failed(FORBIDDEN, "SOURCE_HTTP_ERROR", 403),
    {
      ...failed(ALIAS, null, null),
      status: "public_stored",
      target: "public",
      objectKey: `snapshots/${SNAPSHOT}/moments/original/sha256/aa/${KNOWN_SHA}.jpg`,
      sha256: KNOWN_SHA,
      byteLength: 42,
      contentType: "image/jpeg",
    },
    { ...failed(OVERSIZE, "SOURCE_OVERSIZE", null), status: "oversize" },
    { ...failed(LEGACY, "NO_CANONICAL_SOURCE", null), status: "source_missing" },
    { ...failed(INVALID, "NO_CANONICAL_SOURCE", null), status: "source_missing" },
    { ...failed(PUBLIC_MISSING, "NO_CANONICAL_SOURCE", null), status: "source_missing" },
    failed(VIDEO_FORBIDDEN, "SOURCE_HTTP_ERROR", 403),
  ]);
  await writeRows(join(normalized, "moment_media.ndjson"), [
    media(RETRY),
    media(FORBIDDEN, KNOWN_SHA),
    media(ALIAS, KNOWN_SHA),
    media(OVERSIZE),
    media(LEGACY),
    { ...media(INVALID), status: "INVALID" },
    media(PUBLIC_MISSING),
    { ...media(VIDEO_FORBIDDEN), mime_type: "video/mp4" },
  ]);
  await writeRows(join(normalized, "gateways.ndjson"), [
    original(RETRY, "a"),
    original(FORBIDDEN, "b"),
    {
      id: uuid("c"),
      moment_media_id: FORBIDDEN,
      type: "image/webp",
      url: `https://cdn.media.poap.tech/thumbnails/${FORBIDDEN}.webp`,
      metadata: null,
    },
    original(VIDEO_FORBIDDEN, "1", "video/mp4"),
    {
      id: "99999999-9999-4999-8999-999999999999",
      moment_media_id: VIDEO_FORBIDDEN,
      type: "application/vnd.apple.mpegurl",
      url: `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/${VIDEO_FORBIDDEN}/${VIDEO_FORBIDDEN}.m3u8`,
      metadata: null,
    },
    original(ALIAS, "d"),
    original(OVERSIZE, "e", "video/mp4"),
    {
      id: uuid("f"),
      moment_media_id: OVERSIZE,
      type: "application/vnd.apple.mpegurl",
      url: `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/${OVERSIZE}/${OVERSIZE}.m3u8`,
      metadata: null,
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      moment_media_id: LEGACY,
      type: "image/png",
      url: "https://cdn.registry.poap.tech/legacy-original.png",
      metadata: null,
    },
  ]);

  try {
    const output = join(root, "recovery.ndjson");
    const result = await buildMomentsMediaRecoveryPlan({
      input: root,
      snapshotId: SNAPSHOT,
      output,
      reportPath: join(root, "recovery.json"),
    });
    const rows = await readNdjsonArray(output);
    const byId = new Map(rows.map((row) => [row.planId, row]));
    assert.deepEqual(
      byId.get(RETRY).strategies.map((row) => row.kind),
      ["retry_primary"],
    );
    assert.deepEqual(
      byId.get(FORBIDDEN).strategies.map((row) => row.kind),
      ["hash_alias_original", "thumbnail_derivative"],
    );
    assert.equal(byId.get(FORBIDDEN).strategies[0].requireSha256, KNOWN_SHA);
    assert.equal(byId.get(FORBIDDEN).strategies[0].candidates[0].mediaKey, ALIAS);
    assert.equal(
      byId.get(FORBIDDEN).strategies[0].candidates[0].preservedObject.objectKey,
      `snapshots/${SNAPSHOT}/moments/original/sha256/aa/${KNOWN_SHA}.jpg`,
    );
    assert.deepEqual(
      byId.get(OVERSIZE).strategies.map((row) => row.kind),
      ["multipart_original", "hls_derivative"],
    );
    assert.deepEqual(
      byId.get(LEGACY).strategies.map((row) => row.kind),
      ["legacy_original"],
    );
    assert.deepEqual(
      byId.get(INVALID).strategies.map((row) => row.kind),
      ["metadata_only"],
    );
    assert.deepEqual(
      byId.get(PUBLIC_MISSING).strategies.map((row) => row.kind),
      ["public_original_required"],
    );
    assert.equal(byId.get(PUBLIC_MISSING).target, "public");
    assert.equal(byId.get(PUBLIC_MISSING).publicEligible, true);
    assert.deepEqual(
      byId.get(VIDEO_FORBIDDEN).strategies.map((row) => row.kind),
      ["hls_derivative"],
    );
    assert.equal(result.report.counts.unresolved, 7);
    assert.equal(result.report.counts.originalCandidates, 4);
    assert.equal(result.report.counts.derivativeOnly, 1);
    assert.equal(result.report.counts.metadataOnly, 1);
    assert.equal(result.report.counts.publicOriginalRequired, 1);
    assert.equal(result.report.counts.alreadyPreservedBySha, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery URL allowlists reject query strings and lookalike hosts", () => {
  assert.equal(
    recoveryUrlValidators.isThumbnail(
      `https://cdn.media.poap.tech/thumbnails/${FORBIDDEN}.webp`,
      FORBIDDEN,
    ),
    true,
  );
  assert.equal(
    recoveryUrlValidators.isThumbnail(
      `https://cdn.media.poap.tech.evil.example/thumbnails/${FORBIDDEN}.webp`,
      FORBIDDEN,
    ),
    false,
  );
  assert.equal(
    recoveryUrlValidators.isThumbnail(
      `https://cdn.media.poap.tech:8443/thumbnails/${FORBIDDEN}.webp`,
      FORBIDDEN,
    ),
    false,
  );
  assert.equal(
    recoveryUrlValidators.isHlsManifest(
      `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/${OVERSIZE}/${OVERSIZE}.m3u8?x=1`,
      OVERSIZE,
    ),
    false,
  );
  assert.equal(
    recoveryUrlValidators.isLegacyOriginal("https://cdn.registry.poap.tech/file.png"),
    true,
  );
  assert.equal(
    recoveryUrlValidators.isLegacyOriginal("https://cdn.registry.poap.tech/file.png?x=1"),
    false,
  );
  assert.equal(
    recoveryUrlValidators.isLegacyOriginal("https://cdn.registry.poap.tech:8443/file.png"),
    false,
  );
});

test("a quarantined public capture remains in the generated recovery plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-public-quarantine-recovery-plan-test-"));
  const mediaRoot = join(root, "media");
  const normalized = join(root, "normalized");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(normalized, { recursive: true });
  const plan = [planned(PUBLIC_QUARANTINED, "public")];
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    {
      schemaVersion: "poapin-moments-media-checkpoint-v1",
      version: 1,
      kind: "header",
      snapshotId: SNAPSHOT,
      planSha256,
      planRows: 1,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: 100_000_000,
    },
    {
      ...failed(PUBLIC_QUARANTINED, null, null),
      status: "quarantined_stored",
      target: "private",
      objectKey: `snapshots/${SNAPSHOT}/moments/private/original/sha256/aa/` + `${KNOWN_SHA}.jpg`,
      sha256: KNOWN_SHA,
      byteLength: 42,
      contentType: "image/jpeg",
    },
  ]);
  await writeRows(join(normalized, "moment_media.ndjson"), [media(PUBLIC_QUARANTINED)]);
  await writeRows(join(normalized, "gateways.ndjson"), [original(PUBLIC_QUARANTINED, "a")]);

  try {
    await buildMomentsMediaRecoveryPlan({ input: root, snapshotId: SNAPSHOT });
    const rows = await readNdjsonArray(join(mediaRoot, "recovery-plan.ndjson"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].planId, PUBLIC_QUARANTINED);
    assert.equal(rows[0].target, "public");
    assert.deepEqual(
      rows[0].strategies.map((strategy) => strategy.kind),
      ["public_original_required"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-deterministic 4xx capture failures remain retryable recovery work", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-private-425-recovery-plan-test-"));
  const mediaRoot = join(root, "media");
  const normalized = join(root, "normalized");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(normalized, { recursive: true });
  const withPrimary = planned(POLICY_425, "private");
  const withoutPrimary = {
    ...planned(POLICY_425_NO_SOURCE, "private"),
    gatewayId: null,
    sourceUrl: null,
    target: null,
  };
  const bridge403 = planned(BRIDGE_403, "private");
  const plan = [withPrimary, withoutPrimary, bridge403];
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    {
      schemaVersion: "poapin-moments-media-checkpoint-v1",
      version: 1,
      kind: "header",
      snapshotId: SNAPSHOT,
      planSha256,
      planRows: plan.length,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: 100_000_000,
    },
    failed(POLICY_425, "SOURCE_HTTP_ERROR", 425),
    failed(POLICY_425_NO_SOURCE, "SOURCE_HTTP_ERROR", 425),
    failed(BRIDGE_403, "MOMENTS_BRIDGE_REQUEST_FAILED", 403),
  ]);
  await writeRows(join(normalized, "moment_media.ndjson"), [
    media(POLICY_425),
    media(POLICY_425_NO_SOURCE),
    media(BRIDGE_403),
  ]);
  await writeRows(join(normalized, "gateways.ndjson"), [
    original(POLICY_425, "1"),
    original(BRIDGE_403, "2"),
  ]);

  try {
    const result = await buildMomentsMediaRecoveryPlan({ input: root, snapshotId: SNAPSHOT });
    const rows = await readNdjsonArray(join(mediaRoot, "recovery-plan.ndjson"));
    const byId = new Map(rows.map((row) => [row.planId, row]));
    assert.deepEqual(
      byId.get(POLICY_425).strategies.map((strategy) => strategy.kind),
      ["retry_primary"],
    );
    assert.deepEqual(
      byId.get(POLICY_425_NO_SOURCE).strategies.map((strategy) => strategy.kind),
      ["private_recovery_required"],
    );
    assert.deepEqual(
      byId.get(BRIDGE_403).strategies.map((strategy) => strategy.kind),
      ["retry_primary"],
    );
    assert.equal(
      rows.some((row) => row.strategies.some((strategy) => strategy.kind === "metadata_only")),
      false,
    );
    assert.equal(result.report.counts.privateRecoveryRequired, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function planned(mediaKey, target) {
  return {
    planId: mediaKey,
    mediaKey,
    momentId: target === "public" ? uuid("8") : null,
    gatewayId: target === null ? null : uuid("9"),
    sourceUrl: target === null ? null : `https://cdn.media.poap.tech/${mediaKey}`,
    declaredContentType: "image/jpeg",
    declaredByteLength: null,
    sourceStatus: "PROCESSED",
    publicEligible: target === "public",
    target,
    eligibility: target === "public" ? "public" : "orphan_media",
    dropIds: target === "public" ? ["42"] : [],
    alternateOriginalGateways: 0,
  };
}

function media(key, hash = null) {
  return {
    key,
    moment_id: null,
    hash,
    mime_type: "image/jpeg",
    status: "PROCESSED",
  };
}

function failed(mediaKey, errorCode, httpStatus) {
  return {
    kind: "media",
    planId: mediaKey,
    mediaKey,
    gatewayId: uuid("9"),
    status: "failed",
    errorCode,
    httpStatus,
  };
}

function original(mediaKey, digit, type = "image/jpeg") {
  return {
    id: uuid(digit),
    moment_media_id: mediaKey,
    type,
    url: `https://cdn.media.poap.tech/${mediaKey}`,
    metadata: null,
  };
}

function uuid(digit) {
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

async function writeRows(path, rows) {
  await writeFile(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}
