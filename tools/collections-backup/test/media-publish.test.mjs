import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectionMediaObjectKey,
  loadCollectionMediaPublicationPlan,
  publishCollectionMedia,
} from "../media-publish-lib.mjs";

const SNAPSHOT_ID = "collections-2026-07-22-v1";
const ARCHIVE_SNAPSHOT_ID = "2026-07-02-v1";
const BUCKET = "poapin-archive";
const BRIDGE_URL = "https://collections-upload.example.workers.dev";
const CACHE_CONTROL = "public, max-age=31536000, immutable";

test("final D1 proof keeps reference counts separate from deduplicated media objects", async () => {
  const fixture = await createSnapshotFixture();
  const plan = await loadCollectionMediaPublicationPlan({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
  });

  assert.equal(plan.counts.sourceCheckpointRecords, 3);
  assert.equal(plan.counts.latestReferences, 2);
  assert.equal(plan.counts.eligibleReferences, 2);
  assert.equal(plan.counts.uniqueObjects, 3);
  assert.equal(plan.counts.deduplicatedReferences, 1);
  assert.equal(plan.counts.collectionMedia, 1);
  assert.equal(plan.counts.collectionDropArtwork, 1);
  assert.equal(plan.counts.archiveDropArtwork, 1);
  assert.equal(plan.counts.uploadObjects, 2);
  assert.equal(plan.counts.reuseObjects, 1);
  assert.deepEqual(
    plan.objects.map((object) => [object.kind, object.disposition]),
    [
      ["archive-drop-artwork", "reuse"],
      ["collection-drop-artwork", "upload"],
      ["collection-media", "upload"],
    ],
  );
  assert.equal(plan.manifests.mediaProof.sha256, fixture.mediaProofSha256);
});

test("publication resumes by strict remote HEAD and binds checkpoint context", async () => {
  const fixture = await createSnapshotFixture();
  const checkpointPath = resolve(fixture.root, "media/publish-checkpoint.ndjson");
  const firstUploader = new FakeUploader();
  const first = await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(fixture.root, "first-report.json"),
    uploader: firstUploader,
  });
  assert.equal(first.publishable, true);
  assert.equal(first.counts.uploaded, 2);
  assert.equal(first.counts.proofVerified, 1);
  assert.equal(first.counts.checkpointVerified, 0);
  assert.equal(firstUploader.uploadCalls, 2);
  assert.equal(firstUploader.headCalls, 3);

  const resumeUploader = new FakeUploader({
    remote: firstUploader.remote,
    failOnUpload: true,
  });
  const resumed = await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(fixture.root, "resume-report.json"),
    uploader: resumeUploader,
  });
  assert.equal(resumed.publishable, true);
  assert.equal(resumed.counts.proofVerified, 3);
  assert.equal(resumed.counts.checkpointVerified, 3);
  assert.equal(resumed.counts.uploaded, 0);
  assert.equal(resumed.counts.reused, 0);
  assert.equal(resumeUploader.headCalls, 3);
  assert.equal(resumeUploader.uploadCalls, 0);

  await assert.rejects(
    publishCollectionMedia({
      input: fixture.root,
      snapshotId: SNAPSHOT_ID,
      bucket: "different-bucket",
      bridgeUrl: BRIDGE_URL,
      checkpointPath,
      reportPath: resolve(fixture.root, "wrong-target-report.json"),
      uploader: resumeUploader,
    }),
    /different R2 bucket/,
  );
});

test("publication abort stops dequeuing, records no false failures, and resumes", async () => {
  const fixture = await createSnapshotFixture();
  const checkpointPath = resolve(fixture.root, "media/abort-checkpoint.ndjson");
  const reportPath = resolve(fixture.root, "media/abort-report.json");
  const controller = new AbortController();
  const uploader = new AbortBarrierUploader(controller, 2);
  const progress = [];

  await assert.rejects(
    publishCollectionMedia({
      input: fixture.root,
      snapshotId: SNAPSHOT_ID,
      bucket: BUCKET,
      bridgeUrl: BRIDGE_URL,
      concurrency: 2,
      checkpointPath,
      reportPath,
      signal: controller.signal,
      uploader,
      onProgress(state) {
        progress.push(state);
      },
    }),
    { name: "AbortError" },
  );

  assert.equal(uploader.started, 2);
  assert.ok(uploader.started <= 2);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((state) => state.counts.failed === 0));
  await assert.rejects(readFile(reportPath), { code: "ENOENT" });

  const resumed = await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    concurrency: 2,
    checkpointPath,
    reportPath: resolve(fixture.root, "media/abort-resume-report.json"),
    uploader: new FakeUploader(),
  });
  assert.equal(resumed.publishable, true);
  assert.equal(resumed.counts.failed, 0);
  assert.equal(resumed.counts.uploaded, 2);
  assert.equal(resumed.counts.proofVerified, 1);
});

test("an exact pre-existing upload object is HEAD-reused before any conditional PUT", async () => {
  const fixture = await createSnapshotFixture();
  const plan = await loadCollectionMediaPublicationPlan({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
  });
  const uploadObjects = plan.objects.filter((object) => object.disposition === "upload");
  const remote = new Map(
    uploadObjects.map((object) => [
      object.key,
      {
        key: object.key,
        byteLength: object.byteLength,
        sha256: object.sha256,
        contentType: object.contentType,
        etag: `existing-${object.sha256.slice(0, 12)}`,
      },
    ]),
  );
  const uploader = new FakeUploader({ remote, failOnUpload: true });
  const report = await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath: resolve(fixture.root, "media/pre-existing-checkpoint.ndjson"),
    reportPath: resolve(fixture.root, "media/pre-existing-report.json"),
    uploader,
  });

  assert.equal(report.publishable, true);
  assert.equal(report.counts.reused, 2);
  assert.equal(report.counts.uploaded, 0);
  assert.equal(report.counts.failed, 0);
  assert.equal(uploader.headCalls, 3);
  assert.equal(uploader.uploadCalls, 0);
});

test("resume reports a strict remote conflict instead of overwriting", async () => {
  const fixture = await createSnapshotFixture();
  const checkpointPath = resolve(fixture.root, "media/publish-checkpoint.ndjson");
  await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(fixture.root, "first-report.json"),
    uploader: new FakeUploader(),
  });
  const conflict = new FakeUploader({ remote: new Map(), conflictOnHead: true });
  const report = await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(fixture.root, "conflict-report.json"),
    uploader: conflict,
  });
  assert.equal(report.publishable, false);
  assert.equal(report.counts.failed, 3);
  assert.equal(report.failures[0].code, "EXISTING_OBJECT_CONFLICT");
  assert.equal(conflict.uploadCalls, 0);
});

test("local magic is checked even when size, SHA, manifests, and D1 agree", async () => {
  const fixture = await createSnapshotFixture({ objectBytes: Buffer.from("not an image") });
  await assert.rejects(
    loadCollectionMediaPublicationPlan({ input: fixture.root, snapshotId: SNAPSHOT_ID }),
    /magic\/type mismatch/,
  );
});

test("D1 proof bytes, counts, and self-contained archive provenance are tamper-evident", async () => {
  const proofFixture = await createSnapshotFixture();
  const proofPath = resolve(proofFixture.root, "d1/media/publication-plan.ndjson");
  await writeFile(proofPath, `${await readFile(proofPath, "utf8")}{"tampered":true}\n`);
  await assert.rejects(
    loadCollectionMediaPublicationPlan({ input: proofFixture.root, snapshotId: SNAPSHOT_ID }),
    /media proof bytes differ/,
  );

  const countsFixture = await createSnapshotFixture();
  const reportPath = resolve(countsFixture.root, "d1/report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.mediaProof.counts.reuse += 1;
  await writeJson(reportPath, report);
  await assert.rejects(
    loadCollectionMediaPublicationPlan({ input: countsFixture.root, snapshotId: SNAPSHOT_ID }),
    /media proof counts/,
  );

  const provenanceFixture = await createSnapshotFixture();
  const provenancePath = resolve(
    provenanceFixture.root,
    "drop-supplement/provenance/archive/upload-checkpoint.jsonl",
  );
  await writeFile(provenancePath, `${await readFile(provenancePath, "utf8")}\n`);
  await assert.rejects(
    loadCollectionMediaPublicationPlan({ input: provenanceFixture.root, snapshotId: SNAPSHOT_ID }),
    /provenance bytes changed/,
  );
});

test("publisher detects local TOCTOU and remote mutation without overwriting", async () => {
  const localFixture = await createSnapshotFixture();
  const mutatingUploader = new FakeUploader({
    onVerify: () =>
      writeFile(resolve(localFixture.root, localFixture.newDropObjectPath), png("changed later")),
  });
  const localReport = await publishCollectionMedia({
    input: localFixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath: resolve(localFixture.root, "media/local-change-checkpoint.ndjson"),
    reportPath: resolve(localFixture.root, "media/local-change-report.json"),
    uploader: mutatingUploader,
  });
  assert.equal(localReport.publishable, false);
  assert.equal(localReport.counts.failed, 1);
  assert.equal(localReport.failures[0].scope, localFixture.newDropKey);
  assert.equal(localReport.failures[0].code, "LOCAL_OBJECT_CHANGED");

  const remoteFixture = await createSnapshotFixture();
  const checkpointPath = resolve(remoteFixture.root, "media/remote-change-checkpoint.ndjson");
  const firstUploader = new FakeUploader();
  await publishCollectionMedia({
    input: remoteFixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(remoteFixture.root, "media/remote-first-report.json"),
    uploader: firstUploader,
  });
  firstUploader.remote.set(remoteFixture.newDropKey, {
    ...firstUploader.remote.get(remoteFixture.newDropKey),
    sha256: "f".repeat(64),
  });
  const secondUploader = new FakeUploader({ remote: firstUploader.remote, failOnUpload: true });
  const remoteReport = await publishCollectionMedia({
    input: remoteFixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(remoteFixture.root, "media/remote-second-report.json"),
    uploader: secondUploader,
  });
  assert.equal(remoteReport.publishable, false);
  assert.equal(remoteReport.counts.failed, 1);
  assert.equal(remoteReport.failures[0].scope, remoteFixture.newDropKey);
  assert.equal(remoteReport.failures[0].code, "REMOTE_OBJECT_CHANGED");
  assert.equal(secondUploader.uploadCalls, 0);
});

test("publication checkpoint records cannot be altered", async () => {
  const fixture = await createSnapshotFixture();
  const checkpointPath = resolve(fixture.root, "media/tampered-checkpoint.ndjson");
  const uploader = new FakeUploader();
  await publishCollectionMedia({
    input: fixture.root,
    snapshotId: SNAPSHOT_ID,
    bucket: BUCKET,
    bridgeUrl: BRIDGE_URL,
    checkpointPath,
    reportPath: resolve(fixture.root, "media/checkpoint-first-report.json"),
    uploader,
  });
  const rows = (await readFile(checkpointPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  rows[1].byteLength += 1;
  await writeFile(checkpointPath, jsonLines(rows));
  await assert.rejects(
    publishCollectionMedia({
      input: fixture.root,
      snapshotId: SNAPSHOT_ID,
      bucket: BUCKET,
      bridgeUrl: BRIDGE_URL,
      checkpointPath,
      reportPath: resolve(fixture.root, "media/checkpoint-second-report.json"),
      uploader: new FakeUploader({ remote: uploader.remote, failOnUpload: true }),
    }),
    /invalid or stale object record/,
  );
});

class FakeUploader {
  constructor({
    remote = new Map(),
    failOnUpload = false,
    conflictOnHead = false,
    onVerify = null,
  } = {}) {
    this.remote = remote;
    this.failOnUpload = failOnUpload;
    this.conflictOnHead = conflictOnHead;
    this.onVerify = onVerify;
    this.headCalls = 0;
    this.uploadCalls = 0;
  }

  async verifyTarget() {
    await this.onVerify?.();
  }

  async head(expected) {
    this.headCalls += 1;
    if (this.conflictOnHead) {
      throw Object.assign(new Error("immutable conflict"), {
        code: "EXISTING_OBJECT_CONFLICT",
        httpStatus: 409,
        attempts: 1,
      });
    }
    if (expected.mode === "archive-reuse") {
      return { ...expected, etag: "archive-etag" };
    }
    return this.remote.get(expected.key) ?? null;
  }

  async upload(input) {
    this.uploadCalls += 1;
    if (this.failOnUpload) throw new Error("upload must not run");
    assert.equal(digest(input.bytes), input.sha256);
    const remote = {
      key: input.key,
      byteLength: input.byteLength,
      sha256: input.sha256,
      contentType: input.contentType,
      etag: `etag-${input.sha256.slice(0, 12)}`,
    };
    this.remote.set(input.key, remote);
    return { disposition: "uploaded", etag: remote.etag };
  }
}

class AbortBarrierUploader {
  constructor(controller, abortAfterStarts) {
    this.controller = controller;
    this.abortAfterStarts = abortAfterStarts;
    this.started = 0;
  }

  async verifyTarget() {}

  async head(_expected, { signal } = {}) {
    this.started += 1;
    if (this.started === this.abortAfterStarts) this.controller.abort();
    await new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  async upload() {
    throw new Error("upload must not start before the abort barrier");
  }
}

async function createSnapshotFixture({ objectBytes = png("shared") } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-media-publish-"));
  const sha256 = digest(objectBytes);
  const extension = "png";
  const contentType = "image/png";
  const objectPath = `media/objects/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
  const key = collectionMediaObjectKey(SNAPSHOT_ID, sha256, extension);
  await mkdir(resolve(root, `media/objects/sha256/${sha256.slice(0, 2)}`), { recursive: true });
  await mkdir(resolve(root, "validation"), { recursive: true });
  await mkdir(resolve(root, "d1/media"), { recursive: true });
  await mkdir(resolve(root, "drop-supplement/provenance/archive"), { recursive: true });
  await writeFile(resolve(root, objectPath), objectBytes);

  const plan = [
    { id: "1:logo", collectionId: 1, role: "logo", sourceUrl: "https://example.com/shared.png" },
    {
      id: "2:banner",
      collectionId: 2,
      role: "banner",
      sourceUrl: "https://example.com/shared.png",
    },
  ];
  const referencesSha256 = digest(Buffer.from(jsonLines(plan)));
  const stored = (reference) => ({
    kind: "reference",
    version: 1,
    ...reference,
    status: "stored",
    eligibleForPublish: true,
    contentType,
    byteLength: objectBytes.byteLength,
    sha256,
    extension,
    objectPath,
  });
  const captureRows = [
    {
      kind: "header",
      version: 1,
      dataset: "poap-compass-collection-media",
      endpoint: "https://public.compass.poap.tech/v1/graphql",
      referencesSha256,
    },
    { kind: "reference", version: 1, ...plan[0], status: "failed", eligibleForPublish: false },
    stored(plan[0]),
    stored(plan[1]),
  ];
  const statuses = { stored: 2, missing: 0, quarantined: 0, failed: 0 };
  const mediaManifest = {
    version: 1,
    dataset: "poap-compass-collection-media",
    referencesSha256,
    references: 2,
    uniqueObjects: 1,
    counts: statuses,
    attemptedAll: true,
    complete: true,
    publishable: true,
    quarantinedReferencesAreExcluded: true,
    checkpoint: "media/checkpoint.ndjson",
  };
  const snapshot = {
    version: 1,
    dataset: "poap-compass-collections",
    endpoint: "https://public.compass.poap.tech/v1/graphql",
    media: {
      captured: true,
      manifest: "media/manifest.json",
      ...mediaManifest,
    },
  };
  await writeFile(resolve(root, "media/plan.ndjson"), jsonLines(plan));
  await writeFile(resolve(root, "media/checkpoint.ndjson"), jsonLines(captureRows));
  await writeJson(resolve(root, "media/manifest.json"), mediaManifest);
  await writeJson(resolve(root, "manifest.json"), snapshot);

  const checksumPaths = [
    "manifest.json",
    "media/checkpoint.ndjson",
    "media/manifest.json",
    "media/plan.ndjson",
    objectPath,
  ];
  const checksumText = `${(
    await Promise.all(
      checksumPaths.map(async (path) => `${digest(await readFile(resolve(root, path)))}  ${path}`),
    )
  ).join("\n")}\n`;
  await writeFile(resolve(root, "checksums.sha256"), checksumText);
  const manifestBytes = await readFile(resolve(root, "manifest.json"));
  const checksumsBytes = Buffer.from(checksumText);
  await writeJson(resolve(root, "validation/report.json"), {
    version: 1,
    dataset: "poap-compass-collections",
    verified: true,
    manifest: { sha256: digest(manifestBytes), byteLength: manifestBytes.byteLength },
    media: {
      checked: true,
      complete: true,
      references: 2,
      checkpointRecords: 2,
      objectsChecked: 1,
      uniqueObjects: 1,
      statuses,
    },
    checksums: {
      path: "checksums.sha256",
      entries: checksumPaths.length,
      sha256: digest(checksumsBytes),
      byteLength: checksumsBytes.byteLength,
    },
  });

  const newDropBytes = png("new drop artwork");
  const newDropSha256 = digest(newDropBytes);
  const newDropObjectPath =
    `drop-supplement/artwork/objects/sha256/${newDropSha256.slice(0, 2)}/` + `${newDropSha256}.png`;
  const newDropKey =
    `snapshots/${SNAPSHOT_ID}/collections/drop-artwork/sha256/` +
    `${newDropSha256.slice(0, 2)}/${newDropSha256}.png`;
  await mkdir(
    resolve(root, `drop-supplement/artwork/objects/sha256/${newDropSha256.slice(0, 2)}`),
    {
      recursive: true,
    },
  );
  await writeFile(resolve(root, newDropObjectPath), newDropBytes);

  const archiveSha256 = "a".repeat(64);
  const archiveKey = `snapshots/${ARCHIVE_SNAPSHOT_ID}/artwork/42.webp`;
  const archiveManifestSource = `${JSON.stringify({
    snapshotId: ARCHIVE_SNAPSHOT_ID,
    dropId: 42,
    eligibleForPublish: true,
    object: {
      key: archiveKey,
      contentType: "image/webp",
      cacheControl: CACHE_CONTROL,
    },
  })}\n`;
  const archiveManifestPath = "drop-supplement/provenance/archive/artwork-manifest.ndjson";
  await writeFile(resolve(root, archiveManifestPath), archiveManifestSource);
  const archiveManifest = fileDescriptor(
    "provenance/archive/artwork-manifest.ndjson",
    Buffer.from(archiveManifestSource),
    { rows: 1 },
  );
  const sourceArchive = {
    label: "poap-archive-2026-07-02.zip",
    byteLength: 2_000_000,
    sha256: "b".repeat(64),
  };
  const archiveReportSource = `${JSON.stringify(
    {
      version: 1,
      ok: true,
      complete: true,
      publishable: true,
      snapshotId: ARCHIVE_SNAPSHOT_ID,
      stopReason: null,
      fatalFailure: null,
      failures: [],
      source: {
        kind: "local",
        label: sourceArchive.label,
        advertisedByteLength: sourceArchive.byteLength,
        actualByteLength: sourceArchive.byteLength,
        sha256: sourceArchive.sha256,
      },
      target: {
        bucket: BUCKET,
        snapshotId: ARCHIVE_SNAPSHOT_ID,
        endpoint: "https://media.poap.in",
        cacheControl: CACHE_CONTROL,
      },
      manifest: {
        sha256: archiveManifest.sha256,
        byteLength: archiveManifest.byteLength,
        rows: 1,
        eligible: 1,
        ineligible: 0,
      },
      counts: { uploaded: 1, reused: 0, checkpointSkipped: 0, failed: 0 },
      validations: {
        sourceComplete: true,
        sourceByteLength: {
          checked: true,
          matches: true,
          actual: sourceArchive.byteLength,
          expected: sourceArchive.byteLength,
        },
        sourceSha256: {
          checked: true,
          matches: true,
          actual: sourceArchive.sha256,
          expected: sourceArchive.sha256,
        },
        artworkCount: { checked: true, matches: true, actual: 1, expected: 1 },
      },
    },
    null,
    2,
  )}\n`;
  const archiveReportPath = "drop-supplement/provenance/archive/upload-report.json";
  await writeFile(resolve(root, archiveReportPath), archiveReportSource);
  const archiveReport = fileDescriptor(
    "provenance/archive/upload-report.json",
    Buffer.from(archiveReportSource),
    { rows: 1 },
  );
  const archiveCheckpointRows = [
    {
      kind: "header",
      version: 1,
      snapshotId: ARCHIVE_SNAPSHOT_ID,
      archiveSha256: sourceArchive.sha256,
      manifestSha256: archiveManifest.sha256,
      endpoint: "https://media.poap.in",
      bucket: BUCKET,
      cacheControl: CACHE_CONTROL,
      objectPrefix: `snapshots/${ARCHIVE_SNAPSHOT_ID}/artwork/`,
    },
    {
      kind: "object",
      version: 1,
      key: archiveKey,
      byteLength: 1_234,
      sha256: archiveSha256,
      disposition: "uploaded",
      etag: "archive-etag",
    },
  ];
  const archiveCheckpointSource = jsonLines(archiveCheckpointRows);
  const archiveCheckpointPath = "drop-supplement/provenance/archive/upload-checkpoint.jsonl";
  await writeFile(resolve(root, archiveCheckpointPath), archiveCheckpointSource);
  const archiveCheckpoint = fileDescriptor(
    "provenance/archive/upload-checkpoint.jsonl",
    Buffer.from(archiveCheckpointSource),
    { rows: 2, objects: 1 },
  );
  const archiveMedia = {
    used: true,
    snapshotId: ARCHIVE_SNAPSHOT_ID,
    manifest: archiveManifest,
    uploadReport: archiveReport,
    uploadCheckpoint: archiveCheckpoint,
    artifacts: [archiveManifest, archiveReport, archiveCheckpoint],
    sourceArchive,
    targetBucket: BUCKET,
    verifiedPublishedObjects: 1,
    publishable: true,
  };
  const dropSupplement = {
    version: 1,
    dataset: "poap-compass-referenced-drop-supplement",
    generatedAt: "2026-07-22T00:00:00.000Z",
    archiveMedia,
    artwork: {
      counts: {
        reused: 1,
        downloaded: 2,
        quarantined: 0,
        failed: 0,
        missing: 0,
        pending: 0,
      },
      uniqueDownloadedObjects: 1,
    },
    complete: true,
    publishable: true,
    quarantinedReferencesAreExcluded: true,
  };
  const dropManifestPath = resolve(root, "drop-supplement/manifest.json");
  await writeJson(dropManifestPath, dropSupplement);
  const dropManifestBytes = await readFile(dropManifestPath);
  const dropBindingSha256 = digest(Buffer.from("fixture drop supplement binding"));
  const eligibleObjectsSha256 = digest(
    Buffer.from(
      jsonLines([
        { key, sourcePath: objectPath, byteLength: objectBytes.byteLength, sha256, contentType },
      ]),
    ),
  );
  const publicationRows = [
    {
      kind: "collection-media",
      disposition: "upload",
      key,
      sourcePath: objectPath,
      byteLength: objectBytes.byteLength,
      sha256,
      contentType,
    },
    {
      kind: "archive-drop-artwork",
      disposition: "reuse",
      key: archiveKey,
      byteLength: 1_234,
      sha256: archiveSha256,
      contentType: "image/webp",
      cacheControl: CACHE_CONTROL,
      etag: "archive-etag",
      archiveDisposition: "uploaded",
      archiveSnapshotId: ARCHIVE_SNAPSHOT_ID,
      dropId: 42,
    },
    {
      kind: "collection-drop-artwork",
      disposition: "upload",
      key: newDropKey,
      sourcePath: newDropObjectPath,
      byteLength: newDropBytes.byteLength,
      sha256: newDropSha256,
      contentType: "image/png",
    },
  ].sort((left, right) => left.key.localeCompare(right.key, "en"));
  const publicationSource = jsonLines(publicationRows);
  const publicationPath = "d1/media/publication-plan.ndjson";
  await writeFile(resolve(root, publicationPath), publicationSource);
  const publicationManifest = fileDescriptor(publicationPath, Buffer.from(publicationSource), {
    rows: publicationRows.length,
  });
  const mediaProof = {
    version: 2,
    sha256: publicationManifest.sha256,
    objects: publicationRows.length,
    manifest: publicationManifest,
    counts: {
      collectionMedia: 1,
      archiveDropArtwork: 1,
      collectionDropArtwork: 1,
      upload: 2,
      reuse: 1,
    },
    provenance: {
      snapshotId: SNAPSHOT_ID,
      collectionsMediaSha256: eligibleObjectsSha256,
      dropSupplementSha256: dropBindingSha256,
      archiveMedia,
    },
  };
  await writeJson(resolve(root, "d1/report.json"), {
    version: 1,
    snapshotId: SNAPSHOT_ID,
    sourceManifestSha256: digest(manifestBytes),
    tables: { collection_media: 2 },
    sourceInputs: {
      media: { eligibleObjectsSha256 },
      dropSupplement: {
        manifest: fileDescriptor("drop-supplement/manifest.json", dropManifestBytes),
        sha256: dropBindingSha256,
        artwork: {
          reusedReferences: 1,
          downloadedReferences: 2,
          missingReferences: 0,
          quarantinedReferences: 0,
          reusedObjects: 1,
          downloadedObjects: 1,
        },
        provenance: { archiveMedia },
      },
    },
    mediaProof,
  });
  return {
    root,
    sha256,
    objectPath,
    key,
    newDropObjectPath,
    newDropKey,
    archiveKey,
    mediaProofSha256: mediaProof.sha256,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonLines(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function fileDescriptor(path, bytes, extra = {}) {
  return { path, byteLength: bytes.byteLength, sha256: digest(bytes), ...extra };
}

function png(text) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(text),
  ]);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
