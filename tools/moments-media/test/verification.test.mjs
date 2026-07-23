import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateMomentsMediaCapture, verifyMomentsMedia } from "../lib/capture.mjs";
import { sha256File } from "../lib/io.mjs";
import {
  buildMomentsStoredObjectSet,
  canonicalMomentsBridgeOrigin,
  validateMomentsBucketPair,
} from "../lib/verification.mjs";

const SNAPSHOT = "moments-verification-v1";
const PUBLIC_MEDIA = "11111111-1111-4111-8111-111111111111";
const PRIVATE_MEDIA = "22222222-2222-4222-8222-222222222222";
const PUBLIC_SHA = "a".repeat(64);
const PRIVATE_SHA = "b".repeat(64);
const PUBLIC_BUCKET = "poapin-archive";
const PRIVATE_BUCKET = "poapin-moments-backups";

test("bridge origins canonicalize only an HTTPS origin", () => {
  assert.equal(
    canonicalMomentsBridgeOrigin("https://BRIDGE.Example:443/"),
    "https://bridge.example",
  );
  assert.equal(
    canonicalMomentsBridgeOrigin("https://bridge.example:8443"),
    "https://bridge.example:8443",
  );
  for (const value of [
    "http://bridge.example",
    "https://user@bridge.example",
    "https://bridge.example/path",
    "https://bridge.example?query=1",
    "https://bridge.example/#fragment",
  ]) {
    assert.throws(() => canonicalMomentsBridgeOrigin(value), /canonical HTTPS origin/);
  }
  assert.throws(() => validateMomentsBucketPair(PUBLIC_BUCKET, PUBLIC_BUCKET), /must be different/);
});

test("remote verification binds two immutable journals to a deterministic object set", async () => {
  const fixture = await verificationFixture();
  const seen = [];
  const bridge = {
    async verifyTargets() {},
    async head(object) {
      seen.push(object);
      return { ...object, etag: `etag-${seen.length}` };
    },
  };
  try {
    const firstPath = join(fixture.root, "media", "verify-report-pass1.json");
    const first = await verifyMomentsMedia({
      ...fixture.options,
      bridge,
      reportPath: firstPath,
      now: () => Date.parse("2026-07-23T04:00:00.000Z"),
    });
    const secondPath = join(fixture.root, "media", "verify-report-pass2.json");
    const second = await verifyMomentsMedia({
      ...fixture.options,
      bridge,
      reportPath: secondPath,
      previousVerificationReportPath: firstPath,
      now: () => Date.parse("2026-07-23T04:01:00.000Z"),
    });

    assert.equal(first.complete, true);
    assert.equal(first.schemaVersion, "poapin-moments-media-remote-verification-v3");
    assert.equal(first.pass, 1);
    assert.equal(first.previousReportSha256, null);
    assert.match(first.runId, /^[0-9a-f]{32}$/);
    assert.equal(first.runIdAlgorithm, "os-csprng-128-bit-hex-v1");
    assert.equal(first.algorithm, "poapin-r2-head-all-v1");
    assert.deepEqual(first.counts, { stored: 2, verified: 2, failed: 0 });
    assert.equal(first.binding.checkpointMode, "recovery-finalized");
    assert.equal(first.binding.bridgeOrigin, "https://bridge.example");
    assert.equal(first.binding.publicBucket, PUBLIC_BUCKET);
    assert.equal(first.binding.privateBucket, PRIVATE_BUCKET);
    assert.equal(first.binding.captureCheckpointSha256, fixture.captureCheckpointSha256);
    assert.equal(first.binding.recoveryPlanSha256, fixture.recoveryPlanSha256);
    assert.equal(first.binding.recoveryCheckpointSha256, fixture.recoveryCheckpointSha256);
    assert.equal(first.binding.stored, 2);
    assert.equal(
      first.binding.storedObjectSetSha256,
      "cfbec27388bdd2ab992aadd491c8e8b609eedb29f25a411679f6276417ccf2ae",
    );
    assert.deepEqual(second.binding, first.binding);
    assert.equal(second.pass, 2);
    assert.equal(second.previousReportSha256, (await sha256File(firstPath)).sha256);
    assert.notEqual(second.runId, first.runId);
    assert.ok(Date.parse(second.verifiedAt) > Date.parse(first.verifiedAt));
    assert.notEqual((await sha256File(firstPath)).sha256, (await sha256File(secondPath)).sha256);
    assert.equal(seen.length, 4);

    const reversed = buildMomentsStoredObjectSet([...fixture.objects].reverse(), {
      snapshotId: SNAPSHOT,
    });
    assert.equal(reversed.sha256, first.binding.storedObjectSetSha256);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("remote verification refuses to attest inputs changed during HEAD checks", async () => {
  const fixture = await verificationFixture();
  let changed = false;
  const bridge = {
    async verifyTargets() {},
    async head(object) {
      if (!changed) {
        changed = true;
        await writeFile(
          fixture.recoveryCheckpointPath,
          `${await readFile(fixture.recoveryCheckpointPath, "utf8")}\n`,
        );
      }
      return { ...object, etag: "etag" };
    },
  };
  try {
    await assert.rejects(
      verifyMomentsMedia({
        ...fixture.options,
        bridge,
        reportPath: join(fixture.root, "media", "verify-report-tampered.json"),
      }),
      /media evidence changed|not the exact evaluator output/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("remote verification never infers recovery mode from a legacy proof", async () => {
  const fixture = await verificationFixture();
  try {
    const proof = JSON.parse(await readFile(fixture.mediaProofPath, "utf8"));
    delete proof.checkpointMode;
    await writeFile(fixture.mediaProofPath, `${JSON.stringify(proof)}\n`);
    await assert.rejects(
      verifyMomentsMedia({
        ...fixture.options,
        bridge: {
          async verifyTargets() {},
          async head(object) {
            return object;
          },
        },
      }),
      /explicit finalized checkpoint mode/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capture-only eligibility permits only explicit nonpublic source-missing terminals", async () => {
  for (const [publicEligible, expectedComplete] of [
    [false, true],
    [true, false],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "poapin-capture-evaluation-"));
    try {
      const mediaRoot = join(root, "media");
      const normalizedRoot = join(root, "normalized");
      await mkdir(mediaRoot, { recursive: true });
      await mkdir(normalizedRoot, { recursive: true });
      const mediaKey = publicEligible ? PUBLIC_MEDIA : PRIVATE_MEDIA;
      const planPath = join(mediaRoot, "plan.ndjson");
      await writeRows(planPath, [
        {
          planId: mediaKey,
          mediaKey,
          sourceUrl: null,
          target: publicEligible ? "public" : null,
          publicEligible,
          eligibility: publicEligible ? "public" : "moment_without_drop",
        },
      ]);
      await writeRows(join(normalizedRoot, "moment_media.ndjson"), [{ key: mediaKey }]);
      await writeRows(join(mediaRoot, "capture-checkpoint.ndjson"), [
        {
          schemaVersion: "poapin-moments-media-checkpoint-v1",
          version: 1,
          kind: "header",
          snapshotId: SNAPSHOT,
          planSha256: (await sha256File(planPath)).sha256,
          planRows: 1,
          publicBucket: PUBLIC_BUCKET,
          privateBucket: PRIVATE_BUCKET,
          maximumObjectBytes: 100_000_000,
        },
        {
          kind: "media",
          planId: mediaKey,
          mediaKey,
          status: "source_missing",
          errorCode: "NO_CANONICAL_SOURCE",
        },
      ]);
      const evaluation = await evaluateMomentsMediaCapture({
        input: root,
        snapshotId: SNAPSHOT,
        publicBucket: PUBLIC_BUCKET,
        privateBucket: PRIVATE_BUCKET,
      });
      assert.equal(evaluation.complete, expectedComplete);
      assert.equal(evaluation.publicProjectionReady, expectedComplete);
      assert.deepEqual(evaluation.recoveryRequired, expectedComplete ? [] : [mediaKey]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function verificationFixture() {
  const root = await mkdtemp(join(tmpdir(), "poapin-moments-verification-"));
  const mediaRoot = join(root, "media");
  const normalizedRoot = join(root, "normalized");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(normalizedRoot, { recursive: true });

  const planPath = join(mediaRoot, "plan.ndjson");
  await writeRows(planPath, [planRow(PUBLIC_MEDIA, "public"), planRow(PRIVATE_MEDIA, "private")]);
  const mediaPlanSha256 = (await sha256File(planPath)).sha256;
  const normalizedMediaPath = join(normalizedRoot, "moment_media.ndjson");
  await writeRows(normalizedMediaPath, [
    { key: PUBLIC_MEDIA, moment_id: null, hash: PUBLIC_SHA },
    { key: PRIVATE_MEDIA, moment_id: null, hash: PRIVATE_SHA },
  ]);
  const normalizedMediaSha256 = (await sha256File(normalizedMediaPath)).sha256;

  const publicObject = {
    planId: PUBLIC_MEDIA,
    target: "public",
    objectKey: `snapshots/${SNAPSHOT}/moments/original/sha256/aa/${PUBLIC_SHA}.jpg`,
    byteLength: 7,
    sha256: PUBLIC_SHA,
    contentType: "image/jpeg",
  };
  const captureCheckpointPath = join(mediaRoot, "capture-checkpoint.ndjson");
  await writeRows(captureCheckpointPath, [
    {
      schemaVersion: "poapin-moments-media-checkpoint-v1",
      version: 1,
      kind: "header",
      snapshotId: SNAPSHOT,
      planSha256: mediaPlanSha256,
      planRows: 2,
      publicBucket: PUBLIC_BUCKET,
      privateBucket: PRIVATE_BUCKET,
      maximumObjectBytes: 100_000_000,
    },
    {
      kind: "media",
      planId: PUBLIC_MEDIA,
      mediaKey: PUBLIC_MEDIA,
      status: "public_stored",
      ...publicObject,
    },
    {
      kind: "media",
      planId: PRIVATE_MEDIA,
      mediaKey: PRIVATE_MEDIA,
      status: "failed",
    },
  ]);
  const captureCheckpointSha256 = (await sha256File(captureCheckpointPath)).sha256;

  const recoveryPlanPath = join(mediaRoot, "recovery-plan.ndjson");
  await writeRows(recoveryPlanPath, [
    {
      schemaVersion: "poapin-moments-media-recovery-row-v1",
      planId: PRIVATE_MEDIA,
      mediaKey: PRIVATE_MEDIA,
      target: "private",
      publicEligible: false,
      eligibility: "orphan_media",
      checkpointStatus: "failed",
      errorCode: null,
      httpStatus: null,
      expectedSha256: PRIVATE_SHA,
      strategies: [
        {
          kind: "hash_alias_original",
          fidelity: "original",
          target: "private",
          requireSha256: PRIVATE_SHA,
          candidates: [
            {
              mediaKey: PUBLIC_MEDIA,
              sourceUrl: `https://cdn.media.poap.tech/${PUBLIC_MEDIA}`,
            },
          ],
        },
      ],
    },
  ]);
  const recoveryPlanSha256 = (await sha256File(recoveryPlanPath)).sha256;
  const privateObject = {
    planId: PRIVATE_MEDIA,
    target: "private",
    objectKey: `snapshots/${SNAPSHOT}/moments/private/original/sha256/bb/${PRIVATE_SHA}.jpg`,
    byteLength: 9,
    sha256: PRIVATE_SHA,
    contentType: "image/jpeg",
  };
  const recoveryCheckpointPath = join(mediaRoot, "recovery-checkpoint.ndjson");
  await writeRows(recoveryCheckpointPath, [
    {
      schemaVersion: "poapin-moments-media-recovery-checkpoint-v1",
      version: 1,
      kind: "header",
      snapshotId: SNAPSHOT,
      mediaPlanSha256,
      mediaPlanRows: 2,
      normalizedMediaSha256,
      normalizedMediaRows: 2,
      captureCheckpointSha256,
      recoveryPlanSha256,
      recoveryPlanRows: 1,
      publicBucket: PUBLIC_BUCKET,
      privateBucket: PRIVATE_BUCKET,
      maximumObjectBytes: 100_000_000,
      maximumRecoveryObjectBytes: 5_000_000_000,
      multipartPartBytes: 16_777_216,
    },
    {
      kind: "media",
      planId: PRIVATE_MEDIA,
      mediaKey: PRIVATE_MEDIA,
      status: "original_stored",
      fidelity: "original",
      strategy: "hash_alias_original",
      ...privateObject,
    },
  ]);
  const recoveryCheckpointSha256 = (await sha256File(recoveryCheckpointPath)).sha256;
  const mediaManifestPath = join(mediaRoot, "d1-media-manifest.ndjson");
  await writeRows(mediaManifestPath, [
    {
      mediaKey: PUBLIC_MEDIA,
      objectKey: publicObject.objectKey,
      sha256: publicObject.sha256,
      byteLength: publicObject.byteLength,
      contentType: publicObject.contentType,
      status: "public_stored",
    },
    {
      mediaKey: PRIVATE_MEDIA,
      objectKey: null,
      sha256: privateObject.sha256,
      byteLength: privateObject.byteLength,
      contentType: privateObject.contentType,
      status: "private_stored",
    },
  ]);
  const mediaManifestSha256 = (await sha256File(mediaManifestPath)).sha256;
  const mediaProofPath = join(mediaRoot, "d1-media-manifest.json");
  await writeFile(
    mediaProofPath,
    `${JSON.stringify({
      schemaVersion: "poapin-moments-d1-media-proof-v1",
      snapshotId: SNAPSHOT,
      generatedAt: "2026-07-23T03:59:00.000Z",
      planSha256: mediaPlanSha256,
      manifestSha256: mediaManifestSha256,
      manifestRows: 2,
      complete: true,
      publicProjectionReady: true,
      checkpointMode: "recovery-finalized",
      publicBucket: PUBLIC_BUCKET,
      privateBucket: PRIVATE_BUCKET,
      normalizedMediaSha256,
      captureCheckpointSha256,
      recovery: {
        planSha256: recoveryPlanSha256,
        normalizedMediaSha256,
        captureCheckpointSha256,
        checkpointSha256: recoveryCheckpointSha256,
      },
    })}\n`,
  );
  return {
    root,
    captureCheckpointPath,
    recoveryCheckpointPath,
    captureCheckpointSha256,
    recoveryPlanSha256,
    recoveryCheckpointSha256,
    mediaProofPath,
    objects: [publicObject, privateObject],
    options: {
      input: root,
      snapshotId: SNAPSHOT,
      bridgeUrl: "https://BRIDGE.Example:443/",
      publicBucket: PUBLIC_BUCKET,
      privateBucket: PRIVATE_BUCKET,
      captureCheckpointPath,
      recoveryPlanPath,
      recoveryCheckpointPath,
      concurrency: 1,
    },
  };
}

function planRow(mediaKey, target) {
  return {
    planId: mediaKey,
    mediaKey,
    sourceUrl: `https://cdn.media.poap.tech/${mediaKey}`,
    target,
    publicEligible: target === "public",
    eligibility: target === "public" ? "public" : "orphan_media",
  };
}

async function writeRows(path, rows) {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
