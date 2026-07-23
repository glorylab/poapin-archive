import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { momentsMediaObjectKey } from "../lib/capture.mjs";
import { readNdjsonArray, sha256File } from "../lib/io.mjs";
import {
  evaluateMomentsMediaRecovery,
  finalizeMomentsMediaRecovery,
  recoverMomentsMedia,
} from "../lib/recovery-executor.mjs";
import { buildMomentsMediaRecoveryPlan } from "../lib/recovery.mjs";

const SNAPSHOT = "moments-2026-07-23-v1";
const LARGE = "11111111-1111-4111-8111-111111111111";
const THUMBNAIL = "22222222-2222-4222-8222-222222222222";
const ALIAS = "33333333-3333-4333-8333-333333333333";
const HLS = "44444444-4444-4444-8444-444444444444";
const DRIFT = "55555555-5555-4555-8555-555555555555";
const PART_BYTES = 5_242_880;

test("recovery resumes multipart, labels derivatives, and finalizes a public-only manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-executor-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(LARGE, "public", "video/mp4"), planned(THUMBNAIL, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, plan.length),
    captureFailure(LARGE, "oversize", "SOURCE_OVERSIZE", null),
    captureFailure(THUMBNAIL, "failed", "SOURCE_HTTP_ERROR", 403),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(LARGE, "public", [
      {
        kind: "multipart_original",
        fidelity: "original",
        target: "public",
        gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceUrl: `https://cdn.media.poap.tech/${LARGE}`,
        requireSha256: null,
      },
    ]),
    recoveryRow(THUMBNAIL, "private", [
      {
        kind: "thumbnail_derivative",
        fidelity: "derivative",
        target: "private",
        gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sourceUrl: `https://cdn.media.poap.tech/thumbnails/${THUMBNAIL}.webp`,
        declaredContentType: "image/webp",
      },
    ]),
  ]);

  const original = Buffer.alloc(PART_BYTES + 29, 0x00);
  original.write("ftyp", 4, "ascii");
  original.write("isom", 8, "ascii");
  const thumbnail = Buffer.from("524946460000000057454250", "hex");
  const fetches = { original: 0, thumbnail: 0 };
  const fetchImpl = async (url) => {
    if (url === `https://cdn.media.poap.tech/${LARGE}`) {
      fetches.original += 1;
      return byteResponse(original, "video/mp4");
    }
    if (url === `https://cdn.media.poap.tech/thumbnails/${THUMBNAIL}.webp`) {
      fetches.thumbnail += 1;
      return byteResponse(thumbnail, "image/webp");
    }
    return new Response(null, { status: 404 });
  };
  const bridge = new RecoveryBridge({ failSecondPartOnce: true });
  const captureBefore = await sha256File(join(mediaRoot, "capture-checkpoint.ndjson"));
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge,
    fetchImpl,
  };

  try {
    const first = await recoverMomentsMedia(options);
    assert.equal(first.complete, false);
    assert.equal(first.recovery.unresolved, 1);
    const checkpointAfterFirst = await readNdjsonArray(
      join(mediaRoot, "recovery-checkpoint.ndjson"),
    );
    assert.equal(
      checkpointAfterFirst.filter((row) => row.kind === "multipart" && row.event === "part").length,
      1,
    );
    assert.equal(
      checkpointAfterFirst.find((row) => row.planId === THUMBNAIL && row.kind === "media").status,
      "derivative_stored",
    );

    const second = await recoverMomentsMedia(options);
    assert.equal(second.complete, true);
    assert.equal(second.publicProjectionReady, true);
    assert.equal(second.recovery.unresolved, 0);
    assert.equal(bridge.partCalls.filter((part) => part === 1).length, 1);
    assert.equal(bridge.partCalls.filter((part) => part === 2).length, 2);
    assert.equal(fetches.thumbnail, 1);

    const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "public_stored");
    assert.match(
      manifest[0].objectKey,
      new RegExp(`^snapshots/${SNAPSHOT}/moments/original/sha256/`),
    );
    assert.deepEqual(manifest[1], {
      mediaKey: THUMBNAIL,
      objectKey: null,
      sha256: null,
      byteLength: null,
      contentType: null,
      status: "source_missing",
    });
    const derivative = (await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"))).find(
      (row) => row.planId === THUMBNAIL && row.kind === "media",
    );
    assert.match(
      derivative.rootObject.objectKey,
      new RegExp(`^snapshots/${SNAPSHOT}/moments/private/derivative/thumbnail/sha256/`),
    );
    assert.equal(manifest[1].objectKey, null);

    const checkpointDigest = await sha256File(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const fetchCount = fetches.original + fetches.thumbnail;
    const third = await recoverMomentsMedia(options);
    assert.equal(third.complete, true);
    assert.equal(fetches.original + fetches.thumbnail, fetchCount);
    assert.deepEqual(
      await sha256File(join(mediaRoot, "recovery-checkpoint.ndjson")),
      checkpointDigest,
    );
    assert.deepEqual(await sha256File(join(mediaRoot, "capture-checkpoint.ndjson")), captureBefore);

    await Promise.all([
      rm(join(mediaRoot, "d1-media-manifest.ndjson"), { force: true }),
      rm(join(mediaRoot, "d1-media-manifest.json"), { force: true }),
      rm(join(mediaRoot, "capture-report.json"), { force: true }),
    ]);
    const evaluated = await evaluateMomentsMediaRecovery({
      input: root,
      snapshotId: SNAPSHOT,
    });
    assert.equal(evaluated.complete, true);
    assert.equal(evaluated.publicProjectionReady, true);
    assert.equal(evaluated.manifestSha256, evaluated.proof.manifestSha256);
    assert.equal(evaluated.binding.stored, 2);
    assert.equal(evaluated.binding.storedObjectSetSha256, evaluated.storedObjectSet.sha256);
    assert.deepEqual(evaluated.limits, {
      maximumObjectBytes: PART_BYTES,
      maximumMultipartObjectBytes: 20_000_000,
      multipartPartBytes: PART_BYTES,
    });
    await Promise.all(
      [
        join(mediaRoot, "d1-media-manifest.ndjson"),
        join(mediaRoot, "d1-media-manifest.json"),
        join(mediaRoot, "capture-report.json"),
      ].map((path) => assert.rejects(readFile(path), (error) => error?.code === "ENOENT")),
    );

    const finalized = await finalizeMomentsMediaRecovery({
      input: root,
      snapshotId: SNAPSHOT,
    });
    assert.equal(finalized.complete, true);
    const proof = JSON.parse(await readFile(join(mediaRoot, "d1-media-manifest.json"), "utf8"));
    assert.equal(proof.complete, true);
    assert.equal(proof.publicProjectionReady, true);
    assert.equal(proof.checkpointMode, "recovery-finalized");
    assert.equal(proof.publicBucket, "poapin-archive");
    assert.equal(proof.privateBucket, "poapin-moments-backups");
    assert.match(proof.normalizedMediaSha256, /^[0-9a-f]{64}$/);
    assert.equal(proof.captureCheckpointSha256, captureBefore.sha256);
    assert.match(proof.recovery.planSha256, /^[0-9a-f]{64}$/);
    assert.equal(proof.recovery.normalizedMediaSha256, proof.normalizedMediaSha256);
    assert.equal(proof.recovery.captureCheckpointSha256, proof.captureCheckpointSha256);
    assert.match(proof.recovery.checkpointSha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a public derivative remains pending and resumes its original multipart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-public-derivative-resume-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(LARGE, "public", "video/mp4")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(LARGE, "oversize", "SOURCE_OVERSIZE", null),
  ]);
  const hlsUrl =
    `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/` + `${LARGE}/${LARGE}.m3u8`;
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(LARGE, "public", [
      {
        kind: "multipart_original",
        fidelity: "original",
        target: "public",
        gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceUrl: `https://cdn.media.poap.tech/${LARGE}`,
        requireSha256: null,
      },
      {
        kind: "hls_derivative",
        fidelity: "derivative",
        target: "private",
        gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sourceUrl: hlsUrl,
        declaredContentType: "application/vnd.apple.mpegurl",
      },
    ]),
  ]);

  const original = Buffer.alloc(PART_BYTES + 29, 0x00);
  original.write("ftyp", 4, "ascii");
  original.write("isom", 8, "ascii");
  const playlist = Buffer.from("#EXTM3U\n#EXT-X-ENDLIST\n");
  const fetches = { original: 0, hls: 0 };
  const bridge = new RecoveryBridge({ failSecondPartOnce: true });
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge,
    fetchImpl: async (url) => {
      if (url === `https://cdn.media.poap.tech/${LARGE}`) {
        fetches.original += 1;
        return byteResponse(original, "video/mp4");
      }
      if (url === hlsUrl) {
        fetches.hls += 1;
        return byteResponse(playlist, "application/vnd.apple.mpegurl");
      }
      return new Response(null, { status: 404 });
    },
  };

  try {
    const derivativeOnly = await recoverMomentsMedia(options);
    assert.equal(derivativeOnly.complete, false);
    assert.equal(derivativeOnly.publicProjectionReady, false);
    assert.equal(derivativeOnly.recovery.terminal, 0);
    assert.equal(derivativeOnly.recovery.unresolved, 1);
    let records = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    assert.equal(
      records.filter((row) => row.kind === "media" && row.planId === LARGE).at(-1).status,
      "derivative_stored",
    );
    assert.equal(
      (await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson")))[0].status,
      "source_missing",
    );

    const recoveredOriginal = await recoverMomentsMedia(options);
    assert.equal(recoveredOriginal.complete, true);
    assert.equal(recoveredOriginal.publicProjectionReady, true);
    assert.equal(recoveredOriginal.recovery.terminal, 1);
    assert.equal(recoveredOriginal.recovery.unresolved, 0);
    assert.deepEqual(fetches, { original: 2, hls: 1 });
    records = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    assert.equal(
      records.filter((row) => row.kind === "media" && row.planId === LARGE).at(-1).status,
      "original_stored",
    );
    assert.equal(
      (await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson")))[0].status,
      "public_stored",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a public quarantined original remains pending, resumes, and cannot complete its proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-public-quarantine-resume-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [
    {
      ...planned(LARGE, "public", "image/jpeg"),
      gatewayId: null,
      sourceUrl: null,
      target: null,
    },
  ];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(LARGE, "failed", "SOURCE_HTTP_ERROR", 503),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      LARGE,
      "public",
      [
        {
          kind: "retry_primary",
          fidelity: "original",
          target: "public",
          gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceUrl: `https://cdn.media.poap.tech/${LARGE}`,
          requireSha256: null,
        },
      ],
      {
        checkpointStatus: "failed",
        errorCode: "SOURCE_HTTP_ERROR",
        httpStatus: 503,
      },
    ),
  ]);
  const incompatiblePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let fetches = 0;
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async () => {
      fetches += 1;
      return byteResponse(incompatiblePng, "image/png");
    },
  };

  try {
    for (let run = 1; run <= 2; run += 1) {
      const report = await recoverMomentsMedia(options);
      assert.equal(report.complete, false);
      assert.equal(report.publicProjectionReady, false);
      assert.equal(report.recovery.terminal, 0);
      assert.equal(report.recovery.unresolved, 1);
      assert.equal(fetches, run);
      const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
      assert.equal(manifest[0].status, "quarantined_stored");
      const proof = JSON.parse(await readFile(join(mediaRoot, "d1-media-manifest.json"), "utf8"));
      assert.equal(proof.complete, false);
      assert.equal(proof.publicProjectionReady, false);
    }

    const records = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const quarantined = records.filter((row) => row.kind === "media" && row.planId === LARGE);
    assert.equal(quarantined.length, 2);
    assert.ok(
      quarantined.every(
        (row) =>
          row.status === "original_stored" && row.target === "private" && row.quarantined === true,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hash-alias recovery refuses bytes that do not match the required SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-alias-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const requiredSha256 = "a".repeat(64);
  const plan = [planned(ALIAS, "private", "image/jpeg"), planned(LARGE, "public", "image/jpeg")];
  await writeNormalizedMedia(root, plan, { [ALIAS]: requiredSha256 });
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 2),
    captureFailure(ALIAS, "failed", "SOURCE_HTTP_ERROR", 403),
    {
      kind: "media",
      planId: LARGE,
      mediaKey: LARGE,
      gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "public_stored",
      target: "public",
      objectKey: `snapshots/${SNAPSHOT}/moments/original/sha256/aa/${"a".repeat(64)}.jpg`,
      sha256: "a".repeat(64),
      byteLength: 42,
      contentType: "image/jpeg",
    },
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      ALIAS,
      "private",
      [
        {
          kind: "hash_alias_original",
          fidelity: "original",
          target: "private",
          requireSha256: requiredSha256,
          candidates: [
            {
              mediaKey: LARGE,
              gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              sourceUrl: `https://cdn.media.poap.tech/${LARGE}`,
            },
          ],
        },
      ],
      { expectedSha256: requiredSha256 },
    ),
  ]);
  const bridge = new RecoveryBridge();
  try {
    const report = await recoverMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: PART_BYTES,
      maximumRecoveryObjectBytes: 20_000_000,
      multipartPartBytes: PART_BYTES,
      attempts: 1,
      bridge,
      fetchImpl: async () =>
        byteResponse(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg"),
    });
    assert.equal(report.complete, true);
    assert.equal(report.publicProjectionReady, true);
    assert.equal(bridge.objects.size, 0);
    const records = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const exhausted = records.find((row) => row.kind === "media" && row.planId === ALIAS);
    assert.equal(exhausted.status, "metadata_only");
    assert.equal(exhausted.fidelity, "none");
    assert.equal(exhausted.strategy, null);
    assert.equal(exhausted.reason, "all_recovery_candidates_exhausted");
    assert.deepEqual(exhausted.attempts, [
      {
        strategy: "hash_alias_original",
        code: "RECOVERY_SHA256_MISMATCH",
        httpStatus: null,
      },
    ]);
    const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "source_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed private recovery resumes once and becomes audited metadata-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-exhausted-resume-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(ALIAS, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan, { [ALIAS]: "a".repeat(64) });
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(ALIAS, "failed", "SOURCE_HTTP_ERROR", 403),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      ALIAS,
      "private",
      [
        {
          kind: "hash_alias_original",
          fidelity: "original",
          target: "private",
          requireSha256: "a".repeat(64),
          candidates: [
            {
              mediaKey: ALIAS,
              gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              sourceUrl: `https://cdn.media.poap.tech/${ALIAS}`,
            },
            {
              mediaKey: ALIAS,
              gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sourceUrl: `https://cdn.media.poap.tech/${ALIAS}`,
            },
          ],
        },
      ],
      { expectedSha256: "a".repeat(64) },
    ),
  ]);
  const checkpointPath = join(mediaRoot, "recovery-checkpoint.ndjson");
  await writeRows(checkpointPath, [
    await recoveryCheckpointHeader(root, { mediaPlanRows: 1, recoveryPlanRows: 1 }),
    {
      kind: "media",
      planId: ALIAS,
      mediaKey: ALIAS,
      status: "failed",
      errorCode: "RECOVERY_SOURCE_HTTP_ERROR",
      attempts: [
        {
          strategy: "hash_alias_original",
          code: "RECOVERY_SOURCE_HTTP_ERROR",
          httpStatus: 403,
        },
      ],
      recordedAt: "2026-07-23T00:00:00.000Z",
    },
  ]);
  let fetches = 0;
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async () => {
      fetches += 1;
      return new Response(null, { status: 403 });
    },
  };

  try {
    const resumed = await recoverMomentsMedia(options);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.publicProjectionReady, true);
    assert.equal(resumed.recovery.terminal, 1);
    assert.equal(resumed.recovery.unresolved, 0);
    assert.equal(fetches, 2);

    let checkpoint = await readNdjsonArray(checkpointPath);
    const mediaRecords = checkpoint.filter((row) => row.kind === "media");
    assert.equal(mediaRecords.length, 2);
    assert.equal(mediaRecords[0].status, "failed");
    assert.deepEqual(mediaRecords[1], {
      kind: "media",
      planId: ALIAS,
      mediaKey: ALIAS,
      status: "metadata_only",
      fidelity: "none",
      strategy: null,
      reason: "all_recovery_candidates_exhausted",
      attempts: [
        {
          strategy: "hash_alias_original",
          code: "RECOVERY_SOURCE_HTTP_ERROR",
          httpStatus: 403,
        },
      ],
      recordedAt: mediaRecords[1].recordedAt,
    });
    assert.match(mediaRecords[1].recordedAt, /^\d{4}-\d{2}-\d{2}T/);
    const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "source_missing");
    const proof = JSON.parse(await readFile(join(mediaRoot, "d1-media-manifest.json"), "utf8"));
    assert.equal(proof.complete, true);
    assert.equal(proof.publicProjectionReady, true);

    const terminalDigest = await sha256File(checkpointPath);
    const noOpResume = await recoverMomentsMedia(options);
    assert.equal(noOpResume.complete, true);
    assert.equal(fetches, 2);
    assert.deepEqual(await sha256File(checkpointPath), terminalDigest);

    await appendFile(
      checkpointPath,
      `${JSON.stringify({
        ...mediaRecords[1],
        reason: "different_reason",
        recordedAt: "2026-07-23T00:00:01.000Z",
      })}\n`,
    );
    await assert.rejects(
      finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
      /invalid metadata-only result/,
    );
    checkpoint = await readNdjsonArray(checkpointPath);
    assert.equal(checkpoint.filter((row) => row.kind === "media").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a public recovery never falls back to metadata-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-public-exhausted-recovery-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(LARGE, "public", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(LARGE, "failed", "SOURCE_HTTP_ERROR", 503),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      LARGE,
      "public",
      [
        {
          kind: "retry_primary",
          fidelity: "original",
          target: "public",
          gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceUrl: `https://cdn.media.poap.tech/${LARGE}`,
          requireSha256: null,
        },
      ],
      {
        checkpointStatus: "failed",
        errorCode: "SOURCE_HTTP_ERROR",
        httpStatus: 503,
      },
    ),
  ]);
  const checkpointPath = join(mediaRoot, "recovery-checkpoint.ndjson");
  let fetches = 0;

  try {
    const report = await recoverMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: PART_BYTES,
      maximumRecoveryObjectBytes: 20_000_000,
      multipartPartBytes: PART_BYTES,
      attempts: 1,
      concurrency: 1,
      bridge: new RecoveryBridge(),
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 403 });
      },
    });
    assert.equal(report.complete, false);
    assert.equal(report.publicProjectionReady, false);
    assert.equal(report.recovery.terminal, 0);
    assert.equal(report.recovery.unresolved, 1);
    assert.equal(fetches, 1);

    const checkpoint = await readNdjsonArray(checkpointPath);
    const failed = checkpoint.find((row) => row.kind === "media");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "RECOVERY_SOURCE_HTTP_ERROR");
    assert.equal(
      checkpoint.some((row) => row.kind === "media" && row.status === "metadata_only"),
      false,
    );
    const proof = JSON.parse(await readFile(join(mediaRoot, "d1-media-manifest.json"), "utf8"));
    assert.equal(proof.complete, false);
    assert.equal(proof.publicProjectionReady, false);

    await appendFile(
      checkpointPath,
      `${JSON.stringify({
        kind: "media",
        planId: LARGE,
        mediaKey: LARGE,
        status: "metadata_only",
        fidelity: "none",
        strategy: null,
        reason: "all_recovery_candidates_exhausted",
        attempts: [
          {
            strategy: "retry_primary",
            code: "RECOVERY_SOURCE_HTTP_ERROR",
            httpStatus: 403,
          },
        ],
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
    );
    await assert.rejects(
      finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
      /invalid metadata-only result/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy public metadata-only checkpoint resumes into a nonterminal failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-public-metadata-placeholder-test-"));
  const mediaRoot = join(root, "media");
  const checkpointPath = join(mediaRoot, "recovery-checkpoint.ndjson");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [
    {
      ...planned(LARGE, "public", "image/jpeg"),
      gatewayId: null,
      sourceUrl: null,
      target: null,
    },
  ];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(LARGE, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    {
      ...recoveryRow(
        LARGE,
        "private",
        [
          {
            kind: "metadata_only",
            fidelity: "none",
            target: "private",
            reason: "no_fixed_recovery_candidate",
          },
        ],
        {
          checkpointStatus: "source_missing",
          errorCode: "NO_CANONICAL_SOURCE",
          httpStatus: null,
        },
      ),
      publicEligible: true,
      eligibility: "public",
    },
  ]);
  await writeRows(checkpointPath, [
    await recoveryCheckpointHeader(root, { mediaPlanRows: 1, recoveryPlanRows: 1 }),
    {
      kind: "media",
      planId: LARGE,
      mediaKey: LARGE,
      status: "metadata_only",
      fidelity: "none",
      strategy: "metadata_only",
      reason: "no_fixed_recovery_candidate",
      recordedAt: "2026-07-23T00:00:00.000Z",
    },
  ]);
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async () => {
      throw new Error("A no-candidate placeholder must not fetch.");
    },
  };

  try {
    const report = await recoverMomentsMedia(options);
    assert.equal(report.complete, false);
    assert.equal(report.publicProjectionReady, false);
    assert.equal(report.recovery.terminal, 0);
    assert.equal(report.recovery.unresolved, 1);
    const checkpoint = await readNdjsonArray(checkpointPath);
    const media = checkpoint.filter((row) => row.kind === "media");
    assert.deepEqual(
      media.map((row) => row.status),
      ["metadata_only", "failed"],
    );
    assert.equal(media[1].errorCode, "PUBLIC_ORIGINAL_REQUIRED");
    assert.deepEqual(media[1].attempts, [
      {
        strategy: "metadata_only",
        code: "PUBLIC_ORIGINAL_REQUIRED",
        httpStatus: null,
      },
    ]);

    const finalized = await finalizeMomentsMediaRecovery({
      input: root,
      snapshotId: SNAPSHOT,
    });
    assert.equal(finalized.complete, false);
    assert.equal(finalized.publicProjectionReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy outer-private public-null recovery stays public-required", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-legacy-public-null-recovery-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [
    {
      ...planned(LARGE, "public", "image/jpeg"),
      gatewayId: null,
      sourceUrl: null,
      target: null,
    },
  ];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(LARGE, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  const sourceUrl = "https://cdn.registry.poap.tech/public-original.jpg";
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    {
      ...recoveryRow(
        LARGE,
        "private",
        [
          {
            kind: "legacy_original",
            fidelity: "original",
            target: "private",
            requireSha256: null,
            candidates: [
              {
                gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                sourceUrl,
                declaredContentType: "image/jpeg",
              },
            ],
          },
        ],
        {
          checkpointStatus: "source_missing",
          errorCode: "NO_CANONICAL_SOURCE",
          httpStatus: null,
        },
      ),
      publicEligible: true,
      eligibility: "public",
    },
  ]);
  let sourceAvailable = false;
  let fetches = 0;
  const bridge = new RecoveryBridge();
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    bridge,
    fetchImpl: async () => {
      fetches += 1;
      if (!sourceAvailable) throw legacyDnsError();
      return byteResponse(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg");
    },
  };

  try {
    const unavailable = await recoverMomentsMedia(options);
    assert.equal(unavailable.complete, false);
    assert.equal(unavailable.publicProjectionReady, false);
    assert.equal(unavailable.recovery.terminal, 0);
    let checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    assert.equal(
      checkpoint.filter((row) => row.kind === "media").at(-1).errorCode,
      "RECOVERY_SOURCE_DNS_NOT_FOUND",
    );

    sourceAvailable = true;
    const recovered = await recoverMomentsMedia(options);
    assert.equal(recovered.complete, true);
    assert.equal(recovered.publicProjectionReady, true);
    assert.equal(recovered.recovery.terminal, 1);
    assert.equal(fetches, 2);
    checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const latest = checkpoint.filter((row) => row.kind === "media").at(-1);
    assert.equal(latest.status, "original_stored");
    assert.equal(latest.target, "public");
    assert.equal(latest.quarantined, false);
    const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "public_stored");
    assert.equal(bridge.objects.get(latest.objectKey).target, "public");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private infrastructure failures remain failed and resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-private-infrastructure-failure-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(ALIAS, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(ALIAS, "failed", "SOURCE_HTTP_ERROR", 503),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      ALIAS,
      "private",
      [
        {
          kind: "retry_primary",
          fidelity: "original",
          target: "private",
          gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceUrl: `https://cdn.media.poap.tech/${ALIAS}`,
          requireSha256: null,
        },
      ],
      {
        checkpointStatus: "failed",
        errorCode: "SOURCE_HTTP_ERROR",
        httpStatus: 503,
      },
    ),
  ]);
  let fetches = 0;
  let uploads = 0;
  let mode = "source";
  const bridge = new RecoveryBridge();
  bridge.uploadFile = async () => {
    uploads += 1;
    throw Object.assign(new Error("Simulated bridge authorization failure."), {
      code: "MOMENTS_BRIDGE_REQUEST_FAILED",
      httpStatus: 401,
    });
  };
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge,
    fetchImpl: async () => {
      fetches += 1;
      return mode === "source"
        ? new Response(null, { status: 503 })
        : byteResponse(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg");
    },
  };

  try {
    const transientSource = await recoverMomentsMedia(options);
    assert.equal(transientSource.complete, false);
    assert.equal(transientSource.recovery.terminal, 0);
    assert.equal(transientSource.recovery.unresolved, 1);
    assert.equal(fetches, 1);
    assert.equal(uploads, 0);

    mode = "bridge";
    const bridgeFailure = await recoverMomentsMedia(options);
    assert.equal(bridgeFailure.complete, false);
    assert.equal(bridgeFailure.recovery.terminal, 0);
    assert.equal(bridgeFailure.recovery.unresolved, 1);
    assert.equal(fetches, 2);
    assert.equal(uploads, 1);

    const checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const media = checkpoint.filter((row) => row.kind === "media");
    assert.equal(media.length, 2);
    assert.equal(media[0].status, "failed");
    assert.equal(media[0].errorCode, "RECOVERY_SOURCE_HTTP_ERROR");
    assert.equal(media[0].attempts[0].httpStatus, 503);
    assert.equal(media[1].status, "failed");
    assert.equal(media[1].errorCode, "MOMENTS_BRIDGE_REQUEST_FAILED");
    assert.equal(media[1].attempts[0].httpStatus, 401);
    assert.equal(
      media.some((row) => row.status === "metadata_only"),
      false,
    );

    await appendFile(
      join(mediaRoot, "recovery-checkpoint.ndjson"),
      `${JSON.stringify({
        kind: "media",
        planId: ALIAS,
        mediaKey: ALIAS,
        status: "metadata_only",
        fidelity: "none",
        strategy: null,
        reason: "all_recovery_candidates_exhausted",
        attempts: media[1].attempts,
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
    );
    await assert.rejects(
      finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
      /invalid metadata-only result/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source authentication and policy 4xx responses never become exhausted", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-private-source-policy-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(ALIAS, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(ALIAS, "failed", "SOURCE_HTTP_ERROR", 401),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      ALIAS,
      "private",
      [
        {
          kind: "retry_primary",
          fidelity: "original",
          target: "private",
          gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceUrl: `https://cdn.media.poap.tech/${ALIAS}`,
          requireSha256: null,
        },
      ],
      {
        checkpointStatus: "failed",
        errorCode: "SOURCE_HTTP_ERROR",
        httpStatus: 401,
      },
    ),
  ]);
  const statuses = [401, 425];
  let fetches = 0;
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async () => {
      const status = statuses[fetches];
      fetches += 1;
      return new Response(null, { status });
    },
  };

  try {
    for (const expectedStatus of [401, 425]) {
      const report = await recoverMomentsMedia(options);
      assert.equal(report.complete, false);
      assert.equal(report.recovery.terminal, 0);
      assert.equal(report.recovery.unresolved, 1);
      const checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
      const latest = checkpoint.filter((row) => row.kind === "media").at(-1);
      assert.equal(latest.status, "failed");
      assert.equal(latest.errorCode, "RECOVERY_SOURCE_HTTP_ERROR");
      assert.equal(latest.attempts[0].httpStatus, expectedStatus);
    }
    assert.equal(fetches, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired private legacy DNS recovery requires every retry and candidate to match", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-retired-legacy-dns-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(ALIAS, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(ALIAS, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  const firstUrl = "https://cdn.registry.poap.tech/first.png";
  const secondUrl = "https://cdn.registry.poap.tech/second.png";
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      ALIAS,
      "private",
      [
        {
          kind: "legacy_original",
          fidelity: "original",
          target: "private",
          requireSha256: null,
          candidates: [
            {
              gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              sourceUrl: firstUrl,
              declaredContentType: "image/png",
            },
            {
              gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sourceUrl: secondUrl,
              declaredContentType: "image/png",
            },
          ],
        },
      ],
      {
        checkpointStatus: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
        httpStatus: null,
      },
    ),
  ]);
  let mode = "mixed";
  const callsByUrl = new Map();
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 2,
    concurrency: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async (url) => {
      const count = (callsByUrl.get(url) ?? 0) + 1;
      callsByUrl.set(url, count);
      if (mode === "mixed" && url === secondUrl && count === 1) {
        throw legacyDnsError({ code: "EAI_AGAIN" });
      }
      throw legacyDnsError();
    },
  };

  try {
    const mixed = await recoverMomentsMedia(options);
    assert.equal(mixed.complete, false);
    assert.equal(mixed.recovery.terminal, 0);
    assert.equal(mixed.recovery.unresolved, 1);
    let checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    let media = checkpoint.filter((row) => row.kind === "media");
    assert.equal(media.at(-1).status, "failed");
    assert.equal(media.at(-1).errorCode, "RECOVERY_SOURCE_DNS_NOT_FOUND");

    mode = "all-missing";
    callsByUrl.clear();
    const exhausted = await recoverMomentsMedia(options);
    assert.equal(exhausted.complete, true);
    assert.equal(exhausted.recovery.terminal, 1);
    assert.equal(exhausted.recovery.unresolved, 0);
    assert.deepEqual([...callsByUrl.values()], [2, 2]);
    checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    media = checkpoint.filter((row) => row.kind === "media");
    assert.deepEqual(
      media.map((row) => row.status),
      ["failed", "metadata_only"],
    );
    assert.deepEqual(media[1].attempts, [
      {
        strategy: "legacy_original",
        code: "RECOVERY_LEGACY_SOURCE_DNS_MISSING",
        httpStatus: null,
        candidateCount: 2,
        attemptCount: 4,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one transient candidate keeps a mixed private strategy resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-mixed-candidate-failure-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(ALIAS, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(ALIAS, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  const firstUrl = "https://cdn.registry.poap.tech/first.png";
  const secondUrl = "https://cdn.registry.poap.tech/second.png";
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      ALIAS,
      "private",
      [
        {
          kind: "legacy_original",
          fidelity: "original",
          target: "private",
          requireSha256: null,
          candidates: [
            {
              gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              sourceUrl: firstUrl,
              declaredContentType: "image/png",
            },
            {
              gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sourceUrl: secondUrl,
              declaredContentType: "image/png",
            },
          ],
        },
      ],
      {
        checkpointStatus: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
        httpStatus: null,
      },
    ),
  ]);
  let run = 1;
  let fetches = 0;
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async (url) => {
      fetches += 1;
      return new Response(null, { status: run === 1 && url === firstUrl ? 503 : 403 });
    },
  };

  try {
    const mixed = await recoverMomentsMedia(options);
    assert.equal(mixed.complete, false);
    assert.equal(mixed.recovery.terminal, 0);
    assert.equal(mixed.recovery.unresolved, 1);
    assert.equal(fetches, 2);
    let checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    assert.equal(checkpoint.filter((row) => row.kind === "media").at(-1).status, "failed");
    assert.equal(
      checkpoint.filter((row) => row.kind === "media").at(-1).errorCode,
      "RECOVERY_SOURCE_HTTP_ERROR",
    );

    run = 2;
    const exhausted = await recoverMomentsMedia(options);
    assert.equal(exhausted.complete, true);
    assert.equal(exhausted.recovery.terminal, 1);
    assert.equal(exhausted.recovery.unresolved, 0);
    assert.equal(fetches, 4);
    checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const media = checkpoint.filter((row) => row.kind === "media");
    assert.deepEqual(
      media.map((row) => row.status),
      ["failed", "metadata_only"],
    );
    assert.equal(media[1].reason, "all_recovery_candidates_exhausted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HLS recovery follows only fixed relative resources and remains private derivative data", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-hls-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(HLS, "private", "video/mp4")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(HLS, "failed", "SOURCE_HTTP_ERROR", 403),
  ]);
  const rootUrl =
    `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/` + `${HLS}/${HLS}.m3u8`;
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(HLS, "private", [
      {
        kind: "hls_derivative",
        fidelity: "derivative",
        target: "private",
        gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceUrl: rootUrl,
        declaredContentType: "application/vnd.apple.mpegurl",
      },
    ]),
  ]);
  const sources = new Map([
    [rootUrl, ["#EXTM3U\nvariant/playlist.m3u8\n", "application/vnd.apple.mpegurl"]],
    [
      `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/${HLS}/variant/playlist.m3u8`,
      [
        '#EXTM3U\n#EXT-X-MAP:URI="../init.mp4"\n#EXTINF:4,\nseg-1.ts\n',
        "application/vnd.apple.mpegurl",
      ],
    ],
    [
      `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/${HLS}/init.mp4`,
      [isoBytes(), "video/mp4"],
    ],
    [
      `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/${HLS}/variant/seg-1.ts`,
      [Buffer.from([0x47, 1, 2, 3]), "video/mp2t"],
    ],
  ]);
  const bridge = new RecoveryBridge();
  try {
    const report = await recoverMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: PART_BYTES,
      maximumRecoveryObjectBytes: 20_000_000,
      multipartPartBytes: PART_BYTES,
      attempts: 1,
      bridge,
      fetchImpl: async (url) => {
        const source = sources.get(url);
        return source
          ? byteResponse(
              typeof source[0] === "string" ? Buffer.from(source[0]) : source[0],
              source[1],
            )
          : new Response(null, { status: 404 });
      },
    });
    assert.equal(report.complete, true);
    const records = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const objects = records.filter((row) => row.kind === "object");
    assert.equal(objects.length, 4);
    assert.ok(
      objects.every(
        (row) =>
          row.target === "private" && row.objectKey.includes(`/moments/private/derivative/hls-`),
      ),
    );
    const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "source_missing");
    assert.equal(manifest[0].objectKey, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HLS recovery rejects a cumulative byte overflow before uploading that resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-hls-bound-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(HLS, "private", "video/mp4")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(HLS, "failed", "SOURCE_HTTP_ERROR", 403),
  ]);
  const rootUrl =
    `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/` + `${HLS}/${HLS}.m3u8`;
  const segmentUrl =
    `https://poap-media-hls-production.s3.us-east-2.amazonaws.com/` + `${HLS}/segment.ts`;
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(HLS, "private", [
      {
        kind: "hls_derivative",
        fidelity: "derivative",
        target: "private",
        gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceUrl: rootUrl,
        declaredContentType: "application/vnd.apple.mpegurl",
      },
    ]),
  ]);
  const playlist = Buffer.from("#EXTM3U\nsegment.ts\n");
  const segment = Buffer.alloc(PART_BYTES, 0x00);
  segment[0] = 0x47;
  const bridge = new RecoveryBridge();
  try {
    const report = await recoverMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: PART_BYTES,
      maximumRecoveryObjectBytes: PART_BYTES,
      multipartPartBytes: PART_BYTES,
      attempts: 1,
      bridge,
      fetchImpl: async (url) => {
        if (url === rootUrl) {
          return byteResponse(playlist, "application/vnd.apple.mpegurl");
        }
        if (url === segmentUrl) return byteResponse(segment, "video/mp2t");
        return new Response(null, { status: 404 });
      },
    });
    assert.equal(report.complete, true);
    assert.equal(report.publicProjectionReady, true);
    assert.equal(bridge.objects.size, 1);
    const records = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    assert.deepEqual(
      records.filter((row) => row.kind === "object").map((row) => row.sourceUrl),
      [rootUrl],
    );
    const exhausted = records.find((row) => row.kind === "media" && row.planId === HLS);
    assert.equal(exhausted.status, "metadata_only");
    assert.equal(exhausted.reason, "all_recovery_candidates_exhausted");
    assert.deepEqual(exhausted.attempts, [
      {
        strategy: "hls_derivative",
        code: "HLS_TOTAL_SIZE_LIMIT",
        httpStatus: null,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume and finalization reject capture-checkpoint drift after recovery starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-drift-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(DRIFT, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  const capturePath = join(mediaRoot, "capture-checkpoint.ndjson");
  await writeRows(capturePath, [
    captureHeader(planSha256, 1),
    captureFailure(DRIFT, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      DRIFT,
      "private",
      [
        {
          kind: "metadata_only",
          fidelity: "none",
          target: "private",
          reason: "no_fixed_recovery_candidate",
        },
      ],
      {
        checkpointStatus: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
        httpStatus: null,
      },
    ),
  ]);
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    bridge: new RecoveryBridge(),
    fetchImpl: async () => {
      throw new Error("Metadata-only recovery must not fetch.");
    },
  };
  try {
    const first = await recoverMomentsMedia(options);
    assert.equal(first.complete, true);
    const header = (await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson")))[0];
    assert.equal(header.captureCheckpointSha256, (await sha256File(capturePath)).sha256);

    await appendFile(
      capturePath,
      `${JSON.stringify(captureFailure(DRIFT, "failed", "POST_FREEZE_CHANGE", null))}\n`,
    );
    await assert.rejects(
      recoverMomentsMedia(options),
      /recovery plan does not match the latest capture and normalized media/i,
    );
    await assert.rejects(
      finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
      /recovery plan does not match the latest capture and normalized media/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalization rejects a concurrent recovery-checkpoint append", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-concurrent-finalize-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(DRIFT, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(DRIFT, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      DRIFT,
      "private",
      [
        {
          kind: "metadata_only",
          fidelity: "none",
          target: "private",
          reason: "no_fixed_recovery_candidate",
        },
      ],
      {
        checkpointStatus: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
        httpStatus: null,
      },
    ),
  ]);
  const checkpointPath = join(mediaRoot, "recovery-checkpoint.ndjson");
  try {
    await recoverMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: PART_BYTES,
      maximumRecoveryObjectBytes: 20_000_000,
      multipartPartBytes: PART_BYTES,
      attempts: 1,
      bridge: new RecoveryBridge(),
      fetchImpl: async () => {
        throw new Error("Metadata-only recovery must not fetch.");
      },
    });
    const padding = Array.from({ length: 20_000 }, (_, sequence) =>
      JSON.stringify({ kind: "strategy", planId: DRIFT, sequence }),
    ).join("\n");
    await appendFile(checkpointPath, `${padding}\n`);

    let sequence = 20_000;
    let appendError = null;
    const pending = new Set();
    const timer = setInterval(() => {
      const write = appendFile(
        checkpointPath,
        `${JSON.stringify({ kind: "strategy", planId: DRIFT, sequence })}\n`,
      ).catch((error) => {
        appendError = error;
      });
      sequence += 1;
      pending.add(write);
      void write.then(() => pending.delete(write));
    }, 1);
    try {
      await assert.rejects(
        finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
        /changed while (?:its NDJSON bytes were being read|it was being validated)/,
      );
    } finally {
      clearInterval(timer);
      await Promise.all(pending);
    }
    assert.equal(appendError, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery aborts an orphan multipart upload before reusing a completed object", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-orphan-upload-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(LARGE, "public", "video/mp4")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, plan.length),
    captureFailure(LARGE, "oversize", "SOURCE_OVERSIZE", null),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(LARGE, "public", [
      {
        kind: "multipart_original",
        fidelity: "original",
        target: "public",
        gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceUrl: `https://cdn.media.poap.tech/${LARGE}`,
        requireSha256: null,
      },
    ]),
  ]);

  const original = Buffer.alloc(PART_BYTES + 29, 0x00);
  original.write("ftyp", 4, "ascii");
  original.write("isom", 8, "ascii");
  const sha256 = createHash("sha256").update(original).digest("hex");
  const object = {
    target: "public",
    key: momentsMediaObjectKey(SNAPSHOT, "public", sha256, "mp4"),
    byteLength: original.byteLength,
    sha256,
    contentType: "video/mp4",
    etag: "externally-completed-etag",
  };
  const bridge = new RecoveryBridge({ failSecondPartOnce: true });
  const options = {
    input: root,
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
    maximumRecoveryObjectBytes: 20_000_000,
    multipartPartBytes: PART_BYTES,
    attempts: 1,
    concurrency: 1,
    bridge,
    fetchImpl: async () => byteResponse(original, "video/mp4"),
  };

  try {
    const interrupted = await recoverMomentsMedia(options);
    assert.equal(interrupted.complete, false);
    const [orphanUploadId] = bridge.uploads.keys();
    assert.ok(orphanUploadId);

    bridge.objects.set(object.key, object);
    const resumed = await recoverMomentsMedia(options);
    assert.equal(resumed.complete, true);
    assert.deepEqual(bridge.abortCalls, [orphanUploadId]);
    assert.equal(bridge.uploads.has(orphanUploadId), false);
    assert.equal(bridge.objects.get(object.key), object);

    const checkpoint = await readNdjsonArray(join(mediaRoot, "recovery-checkpoint.ndjson"));
    const completed = checkpoint.find(
      (row) =>
        row.kind === "multipart" && row.event === "completed" && row.uploadId === orphanUploadId,
    );
    assert.equal(completed.disposition, "reused");
    assert.equal(completed.orphanUploadDisposition, "aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery and finalization reject empty or truncated plans against normalized media", async (t) => {
  for (const [label, plan] of [
    ["empty", []],
    ["truncated", [planned(LARGE, "public", "image/jpeg")]],
  ]) {
    await t.test(label, async () => {
      const root = await mkdtemp(join(tmpdir(), `moments-recovery-${label}-plan-test-`));
      const mediaRoot = join(root, "media");
      await mkdir(mediaRoot, { recursive: true });
      await writeNormalizedMedia(root, [LARGE, THUMBNAIL]);
      await writeRows(join(mediaRoot, "plan.ndjson"), plan);
      const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
      await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
        captureHeader(planSha256, plan.length),
      ]);
      await writeRows(join(mediaRoot, "recovery-plan.ndjson"), []);
      await writeRows(join(mediaRoot, "recovery-checkpoint.ndjson"), [
        {
          schemaVersion: "poapin-moments-media-recovery-checkpoint-v1",
          version: 1,
          kind: "header",
          snapshotId: SNAPSHOT,
        },
      ]);
      try {
        await assert.rejects(
          recoverMomentsMedia({
            input: root,
            snapshotId: SNAPSHOT,
            publicBucket: "poapin-archive",
            privateBucket: "poapin-moments-backups",
            bridge: new RecoveryBridge(),
          }),
          /must cover normalized moment_media keys exactly once/,
        );
        await assert.rejects(
          finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
          /must cover normalized moment_media keys exactly once/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("recovery rejects empty or truncated recovery plans for public-null missing sources", async (t) => {
  for (const [label, includePrivateRow] of [
    ["empty", false],
    ["missing-public-row", true],
  ]) {
    await t.test(label, async () => {
      const root = await mkdtemp(join(tmpdir(), `moments-recovery-${label}-coverage-test-`));
      const mediaRoot = join(root, "media");
      await mkdir(mediaRoot, { recursive: true });
      const publicMissing = {
        ...planned(LARGE, "public", "image/jpeg"),
        gatewayId: null,
        sourceUrl: null,
        target: null,
      };
      const privateMissing = {
        ...planned(DRIFT, "private", "image/jpeg"),
        gatewayId: null,
        sourceUrl: null,
        target: null,
      };
      const plan = [publicMissing, privateMissing];
      await writeNormalizedMedia(root, plan);
      await writeRows(join(mediaRoot, "plan.ndjson"), plan);
      const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
      await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
        captureHeader(planSha256, plan.length),
        captureFailure(LARGE, "source_missing", "NO_CANONICAL_SOURCE", null),
        captureFailure(DRIFT, "source_missing", "NO_CANONICAL_SOURCE", null),
      ]);
      const privateRow = recoveryRow(
        DRIFT,
        "private",
        [
          {
            kind: "metadata_only",
            fidelity: "none",
            target: "private",
            reason: "no_fixed_recovery_candidate",
          },
        ],
        {
          checkpointStatus: "source_missing",
          errorCode: "NO_CANONICAL_SOURCE",
          httpStatus: null,
        },
      );
      await writeRows(
        join(mediaRoot, "recovery-plan.ndjson"),
        includePrivateRow ? [privateRow] : [],
      );
      await writeRows(join(mediaRoot, "recovery-checkpoint.ndjson"), [
        await recoveryCheckpointHeader(root, {
          mediaPlanRows: plan.length,
          recoveryPlanRows: includePrivateRow ? 1 : 0,
        }),
      ]);
      let bridgeReached = false;
      const bridge = new RecoveryBridge();
      bridge.verifyTargets = async () => {
        bridgeReached = true;
      };
      const options = {
        input: root,
        snapshotId: SNAPSHOT,
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        maximumObjectBytes: PART_BYTES,
        maximumRecoveryObjectBytes: 20_000_000,
        multipartPartBytes: PART_BYTES,
        bridge,
      };
      try {
        await assert.rejects(
          recoverMomentsMedia(options),
          /must exactly cover capture results that require recovery/,
        );
        assert.equal(bridgeReached, false);
        await assert.rejects(
          finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
          /must exactly cover capture results that require recovery/,
        );
        await assert.rejects(
          readFile(join(mediaRoot, "d1-media-manifest.json")),
          (error) => error?.code === "ENOENT",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("recovery binds each planned strategy to capture state and normalized hashes", async (t) => {
  await t.test("stale normalized hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "moments-stale-recovery-hash-test-"));
    const mediaRoot = join(root, "media");
    await mkdir(mediaRoot, { recursive: true });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    const plan = [planned(ALIAS, "private", "image/jpeg")];
    await writeNormalizedMedia(root, plan, { [ALIAS]: firstHash });
    await writeRows(join(mediaRoot, "plan.ndjson"), plan);
    const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
    await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
      captureHeader(planSha256, 1),
      captureFailure(ALIAS, "failed", "SOURCE_HTTP_ERROR", 403),
    ]);
    await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
      recoveryRow(
        ALIAS,
        "private",
        [
          {
            kind: "retry_primary",
            fidelity: "original",
            target: "private",
            gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sourceUrl: `https://cdn.media.poap.tech/${ALIAS}`,
            requireSha256: firstHash,
          },
        ],
        { expectedSha256: firstHash },
      ),
    ]);
    await writeRows(join(mediaRoot, "recovery-checkpoint.ndjson"), [
      await recoveryCheckpointHeader(root, {
        mediaPlanRows: 1,
        recoveryPlanRows: 1,
      }),
    ]);
    await writeNormalizedMedia(root, plan, { [ALIAS]: secondHash });
    let bridgeReached = false;
    const bridge = new RecoveryBridge();
    bridge.verifyTargets = async () => {
      bridgeReached = true;
    };
    try {
      await assert.rejects(
        recoverMomentsMedia({
          input: root,
          snapshotId: SNAPSHOT,
          publicBucket: "poapin-archive",
          privateBucket: "poapin-moments-backups",
          maximumObjectBytes: PART_BYTES,
          maximumRecoveryObjectBytes: 20_000_000,
          multipartPartBytes: PART_BYTES,
          bridge,
        }),
        /does not match the latest capture and normalized media/,
      );
      assert.equal(bridgeReached, false);
      await assert.rejects(
        finalizeMomentsMediaRecovery({ input: root, snapshotId: SNAPSHOT }),
        /does not match the latest capture and normalized media/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("strategy digest mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "moments-recovery-strategy-hash-test-"));
    const mediaRoot = join(root, "media");
    await mkdir(mediaRoot, { recursive: true });
    const expectedSha256 = "a".repeat(64);
    const plan = [planned(ALIAS, "private", "image/jpeg")];
    await writeNormalizedMedia(root, plan, { [ALIAS]: expectedSha256 });
    await writeRows(join(mediaRoot, "plan.ndjson"), plan);
    const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
    await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
      captureHeader(planSha256, 1),
      captureFailure(ALIAS, "failed", "SOURCE_HTTP_ERROR", 403),
    ]);
    await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
      recoveryRow(
        ALIAS,
        "private",
        [
          {
            kind: "retry_primary",
            fidelity: "original",
            target: "private",
            gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sourceUrl: `https://cdn.media.poap.tech/${ALIAS}`,
            requireSha256: "b".repeat(64),
          },
        ],
        { expectedSha256 },
      ),
    ]);
    let bridgeReached = false;
    const bridge = new RecoveryBridge();
    bridge.verifyTargets = async () => {
      bridgeReached = true;
    };
    try {
      await assert.rejects(
        recoverMomentsMedia({
          input: root,
          snapshotId: SNAPSHOT,
          publicBucket: "poapin-archive",
          privateBucket: "poapin-moments-backups",
          maximumObjectBytes: PART_BYTES,
          maximumRecoveryObjectBytes: 20_000_000,
          multipartPartBytes: PART_BYTES,
          bridge,
        }),
        /Moments recovery plan is invalid/,
      );
      assert.equal(bridgeReached, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("bridge 403 cannot become metadata-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "moments-recovery-bridge-403-metadata-test-"));
    const mediaRoot = join(root, "media");
    await mkdir(mediaRoot, { recursive: true });
    const plan = [planned(ALIAS, "private", "image/jpeg")];
    await writeNormalizedMedia(root, plan);
    await writeRows(join(mediaRoot, "plan.ndjson"), plan);
    const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
    await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
      captureHeader(planSha256, 1),
      captureFailure(ALIAS, "failed", "MOMENTS_BRIDGE_REQUEST_FAILED", 403),
    ]);
    await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
      recoveryRow(
        ALIAS,
        "private",
        [
          {
            kind: "metadata_only",
            fidelity: "none",
            target: "private",
            reason: "tampered_terminal_fallback",
          },
        ],
        {
          checkpointStatus: "failed",
          errorCode: "MOMENTS_BRIDGE_REQUEST_FAILED",
          httpStatus: 403,
        },
      ),
    ]);
    let bridgeReached = false;
    const bridge = new RecoveryBridge();
    bridge.verifyTargets = async () => {
      bridgeReached = true;
    };
    try {
      await assert.rejects(
        recoverMomentsMedia({
          input: root,
          snapshotId: SNAPSHOT,
          publicBucket: "poapin-archive",
          privateBucket: "poapin-moments-backups",
          maximumObjectBytes: PART_BYTES,
          maximumRecoveryObjectBytes: 20_000_000,
          multipartPartBytes: PART_BYTES,
          bridge,
        }),
        /Moments recovery plan is invalid/,
      );
      assert.equal(bridgeReached, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a generated pass-one recovery plan cannot mark a public-null missing source ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-public-null-pass-one-gate-test-"));
  const mediaRoot = join(root, "media");
  const normalized = join(root, "normalized");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [
    {
      ...planned(LARGE, "public", "image/jpeg"),
      gatewayId: null,
      sourceUrl: null,
      target: null,
    },
  ];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(normalized, "gateways.ndjson"), []);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(LARGE, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);

  try {
    await buildMomentsMediaRecoveryPlan({ input: root, snapshotId: SNAPSHOT });
    const recoveryPlan = await readNdjsonArray(join(mediaRoot, "recovery-plan.ndjson"));
    assert.equal(recoveryPlan.length, 1);
    assert.equal(recoveryPlan[0].target, "public");
    assert.equal(recoveryPlan[0].publicEligible, true);
    assert.deepEqual(
      recoveryPlan[0].strategies.map((strategy) => strategy.kind),
      ["public_original_required"],
    );

    const report = await recoverMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: PART_BYTES,
      maximumRecoveryObjectBytes: 20_000_000,
      multipartPartBytes: PART_BYTES,
      attempts: 1,
      bridge: new RecoveryBridge(),
      fetchImpl: async () => {
        throw new Error("A public-original-required gate must not fetch.");
      },
    });
    assert.equal(report.complete, false);
    assert.equal(report.publicProjectionReady, false);
    assert.equal(report.recovery.unresolved, 1);
    const proof = JSON.parse(await readFile(join(mediaRoot, "d1-media-manifest.json"), "utf8"));
    assert.equal(proof.complete, false);
    assert.equal(proof.publicProjectionReady, false);
    assert.equal(proof.manifestRows, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing pass-one checkpoint row stays unattempted when its source URL is null", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-missing-pass-one-row-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [
    {
      ...planned(LARGE, "public", "image/jpeg"),
      gatewayId: null,
      sourceUrl: null,
      target: null,
    },
  ];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [captureHeader(planSha256, 1)]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), []);
  await writeRows(join(mediaRoot, "recovery-checkpoint.ndjson"), [
    await recoveryCheckpointHeader(root, {
      mediaPlanRows: 1,
      recoveryPlanRows: 0,
    }),
  ]);

  try {
    const report = await finalizeMomentsMediaRecovery({
      input: root,
      snapshotId: SNAPSHOT,
    });
    assert.equal(report.complete, false);
    assert.equal(report.publicProjectionReady, false);
    assert.equal(report.counts.unattempted, 1);
    const manifest = await readNdjsonArray(join(mediaRoot, "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "unattempted");
    const proof = JSON.parse(await readFile(join(mediaRoot, "d1-media-manifest.json"), "utf8"));
    assert.equal(proof.complete, false);
    assert.equal(proof.publicProjectionReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery rejects an impossible multipart bound before bridge or upload creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-multipart-bound-preflight-test-"));
  let verifiedTargets = 0;
  let createdUploads = 0;
  const bridge = new RecoveryBridge();
  bridge.verifyTargets = async () => {
    verifiedTargets += 1;
  };
  bridge.createMultipartUpload = async () => {
    createdUploads += 1;
    throw new Error("Multipart creation must not be reached.");
  };
  try {
    await assert.rejects(
      recoverMomentsMedia({
        input: root,
        snapshotId: SNAPSHOT,
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        maximumObjectBytes: PART_BYTES,
        maximumRecoveryObjectBytes: PART_BYTES * 10_000 + 1,
        multipartPartBytes: PART_BYTES,
        bridge,
      }),
      /require too many multipart parts/,
    );
    assert.equal(verifiedTargets, 0);
    assert.equal(createdUploads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery rejects capture bucket drift before contacting the bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-bucket-drift-test-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  const plan = [planned(DRIFT, "private", "image/jpeg")];
  await writeNormalizedMedia(root, plan);
  await writeRows(join(mediaRoot, "plan.ndjson"), plan);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
    captureHeader(planSha256, 1),
    captureFailure(DRIFT, "source_missing", "NO_CANONICAL_SOURCE", null),
  ]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), [
    recoveryRow(
      DRIFT,
      "private",
      [
        {
          kind: "metadata_only",
          fidelity: "none",
          target: "private",
          reason: "no_fixed_recovery_candidate",
        },
      ],
      {
        checkpointStatus: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
        httpStatus: null,
      },
    ),
  ]);
  let bridgeReached = false;
  const bridge = new RecoveryBridge();
  bridge.verifyTargets = async () => {
    bridgeReached = true;
  };
  try {
    await assert.rejects(
      recoverMomentsMedia({
        input: root,
        snapshotId: SNAPSHOT,
        publicBucket: "poapin-archive-other",
        privateBucket: "poapin-moments-backups",
        maximumObjectBytes: PART_BYTES,
        maximumRecoveryObjectBytes: 20_000_000,
        multipartPartBytes: PART_BYTES,
        bridge,
      }),
      /Recovery targets do not match the capture checkpoint/,
    );
    assert.equal(bridgeReached, false);
    await assert.rejects(
      readFile(join(mediaRoot, "recovery-checkpoint.ndjson")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery rejects path-like media identities before bridge or temporary-file work", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-recovery-path-test-"));
  const mediaRoot = join(root, "media");
  const sentinelRoot = join(root, "sentinel");
  const sentinelPath = join(sentinelRoot, "keep.txt");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(sentinelRoot, { recursive: true });
  await writeFile(sentinelPath, "keep");
  await writeNormalizedMedia(root, [LARGE]);
  const malicious = {
    ...planned(LARGE, "private", "image/jpeg"),
    planId: "x/../../sentinel",
    mediaKey: "x/../../sentinel",
  };
  await writeRows(join(mediaRoot, "plan.ndjson"), [malicious]);
  const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
  await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [captureHeader(planSha256, 1)]);
  await writeRows(join(mediaRoot, "recovery-plan.ndjson"), []);
  const bridge = new RecoveryBridge();
  bridge.verifyTargets = async () => {
    throw new Error("Bridge must not be reached for an invalid plan.");
  };
  try {
    await assert.rejects(
      recoverMomentsMedia({
        input: root,
        snapshotId: SNAPSHOT,
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        bridge,
      }),
      /Moments media plan is invalid/,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery rejects contradictory public eligibility and targets", async (t) => {
  for (const [label, plan] of [
    [
      "eligible-private",
      {
        ...planned(DRIFT, "private", "image/jpeg"),
        publicEligible: true,
        target: "private",
      },
    ],
    [
      "ineligible-public",
      {
        ...planned(DRIFT, "public", "image/jpeg"),
        publicEligible: false,
        target: "public",
      },
    ],
  ]) {
    await t.test(label, async () => {
      const root = await mkdtemp(join(tmpdir(), `moments-recovery-${label}-test-`));
      const mediaRoot = join(root, "media");
      await mkdir(mediaRoot, { recursive: true });
      await writeNormalizedMedia(root, [plan]);
      await writeRows(join(mediaRoot, "plan.ndjson"), [plan]);
      const planSha256 = (await sha256File(join(mediaRoot, "plan.ndjson"))).sha256;
      await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [captureHeader(planSha256, 1)]);
      await writeRows(join(mediaRoot, "recovery-plan.ndjson"), []);
      try {
        await assert.rejects(
          recoverMomentsMedia({
            input: root,
            snapshotId: SNAPSHOT,
            publicBucket: "poapin-archive",
            privateBucket: "poapin-moments-backups",
            bridge: new RecoveryBridge(),
          }),
          /Moments media plan is invalid/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

class RecoveryBridge {
  constructor({ failSecondPartOnce = false } = {}) {
    this.objects = new Map();
    this.uploads = new Map();
    this.partCalls = [];
    this.abortCalls = [];
    this.nextUpload = 1;
    this.failSecondPartOnce = failSecondPartOnce;
  }

  async verifyTargets() {}

  async head(object) {
    return this.objects.get(object.key) ?? null;
  }

  async uploadFile(object) {
    const stored = { ...object, etag: `etag-${this.objects.size + 1}` };
    this.objects.set(object.key, stored);
    return { disposition: "uploaded", etag: stored.etag };
  }

  async createMultipartUpload(object) {
    const existing = this.objects.get(object.key);
    if (existing) return { disposition: "reused", etag: existing.etag, ...object };
    const uploadId = `upload-${this.nextUpload}`;
    this.nextUpload += 1;
    this.uploads.set(uploadId, { object, parts: new Map() });
    return { disposition: "created", uploadId, ...object };
  }

  async uploadMultipartPart(object, uploadId, partNumber, bytes) {
    this.partCalls.push(partNumber);
    if (partNumber === 2 && this.failSecondPartOnce) {
      this.failSecondPartOnce = false;
      throw Object.assign(new Error("Simulated interruption."), { code: "TEST_STOP" });
    }
    const upload = this.uploads.get(uploadId);
    assert.equal(upload.object.key, object.key);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = {
      partNumber,
      byteLength: bytes.byteLength,
      sha256,
      etag: `part-${uploadId}-${partNumber}`,
    };
    upload.parts.set(partNumber, result);
    return result;
  }

  async completeMultipartUpload(object, uploadId, parts) {
    const upload = this.uploads.get(uploadId);
    assert.ok(upload);
    assert.equal(
      parts.reduce((total, part) => total + part.byteLength, 0),
      object.byteLength,
    );
    const stored = { ...object, etag: `etag-${this.objects.size + 1}` };
    this.objects.set(object.key, stored);
    this.uploads.delete(uploadId);
    return { disposition: "uploaded", etag: stored.etag };
  }

  async abortMultipartUpload(object, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      return { disposition: "already_absent", uploadId, ...object };
    }
    assert.equal(upload.object.key, object.key);
    this.uploads.delete(uploadId);
    this.abortCalls.push(uploadId);
    return { disposition: "aborted", uploadId, ...object };
  }
}

function planned(mediaKey, target, declaredContentType) {
  return {
    planId: mediaKey,
    mediaKey,
    momentId: target === "public" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : null,
    gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceUrl: `https://cdn.media.poap.tech/${mediaKey}`,
    declaredContentType,
    declaredByteLength: null,
    sourceStatus: "PROCESSED",
    publicEligible: target === "public",
    target,
    eligibility: target === "public" ? "public" : "orphan_media",
    dropIds: target === "public" ? ["42"] : [],
    alternateOriginalGateways: 0,
  };
}

function recoveryRow(
  mediaKey,
  target,
  strategies,
  {
    expectedSha256 = null,
    checkpointStatus = target === "public" ? "oversize" : "failed",
    errorCode = target === "public" ? "SOURCE_OVERSIZE" : "SOURCE_HTTP_ERROR",
    httpStatus = target === "public" ? null : 403,
  } = {},
) {
  return {
    schemaVersion: "poapin-moments-media-recovery-row-v1",
    planId: mediaKey,
    mediaKey,
    checkpointStatus,
    errorCode,
    httpStatus,
    target,
    publicEligible: target === "public",
    eligibility: target === "public" ? "public" : "orphan_media",
    expectedSha256,
    strategies,
  };
}

function captureHeader(planSha256, planRows) {
  return {
    schemaVersion: "poapin-moments-media-checkpoint-v1",
    version: 1,
    kind: "header",
    snapshotId: SNAPSHOT,
    planSha256,
    planRows,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: PART_BYTES,
  };
}

function captureFailure(mediaKey, status, errorCode, httpStatus) {
  return {
    kind: "media",
    planId: mediaKey,
    mediaKey,
    gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status,
    errorCode,
    httpStatus,
  };
}

function byteResponse(bytes, contentType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
  });
}

function isoBytes() {
  const bytes = Buffer.alloc(16);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  return bytes;
}

function legacyDnsError({
  code = "ENOTFOUND",
  syscall = "getaddrinfo",
  hostname = "cdn.registry.poap.tech",
} = {}) {
  const cause = Object.assign(new Error(`${syscall} ${code} ${hostname}`), {
    code,
    syscall,
    hostname,
  });
  return new TypeError("fetch failed", { cause });
}

async function writeRows(path, rows) {
  await writeFile(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

async function writeNormalizedMedia(root, rows, hashes = {}) {
  const normalized = join(root, "normalized");
  await mkdir(normalized, { recursive: true });
  await writeRows(
    join(normalized, "moment_media.ndjson"),
    rows.map((row) => {
      const key = typeof row === "string" ? row : row.mediaKey;
      return {
        key,
        ...(hashes[key] ? { hash: hashes[key] } : {}),
      };
    }),
  );
}

async function recoveryCheckpointHeader(
  root,
  {
    mediaPlanRows,
    recoveryPlanRows,
    publicBucket = "poapin-archive",
    privateBucket = "poapin-moments-backups",
    maximumObjectBytes = PART_BYTES,
    maximumRecoveryObjectBytes = 20_000_000,
    multipartPartBytes = PART_BYTES,
  },
) {
  const mediaRoot = join(root, "media");
  const normalizedMedia = await readNdjsonArray(join(root, "normalized", "moment_media.ndjson"));
  const [mediaPlan, normalized, captureCheckpoint, recoveryPlan] = await Promise.all([
    sha256File(join(mediaRoot, "plan.ndjson")),
    sha256File(join(root, "normalized", "moment_media.ndjson")),
    sha256File(join(mediaRoot, "capture-checkpoint.ndjson")),
    sha256File(join(mediaRoot, "recovery-plan.ndjson")),
  ]);
  return {
    schemaVersion: "poapin-moments-media-recovery-checkpoint-v1",
    version: 1,
    kind: "header",
    snapshotId: SNAPSHOT,
    mediaPlanSha256: mediaPlan.sha256,
    mediaPlanRows,
    normalizedMediaSha256: normalized.sha256,
    normalizedMediaRows: normalizedMedia.length,
    captureCheckpointSha256: captureCheckpoint.sha256,
    recoveryPlanSha256: recoveryPlan.sha256,
    recoveryPlanRows,
    publicBucket,
    privateBucket,
    maximumObjectBytes,
    maximumRecoveryObjectBytes,
    multipartPartBytes,
  };
}
