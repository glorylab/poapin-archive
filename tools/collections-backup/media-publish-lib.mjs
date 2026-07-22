import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { createCollectionsBridgeTarget } from "./bridge/client.mjs";

export const COLLECTIONS_MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Workers Free/Pro accept request bodies up to 100 MB (decimal). Keep the
// application limit exact so the largest validated source object still fits
// without relying on an upstream rejection as flow control.
export const COLLECTIONS_MEDIA_MAXIMUM_BYTES = 100_000_000;

const CHECKPOINT_VERSION = 1;
const REPORT_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const CONTENT_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
});

export class CollectionsMediaPublishError extends Error {
  constructor(message, code = "COLLECTIONS_MEDIA_PUBLICATION_INVALID") {
    super(message);
    this.name = "CollectionsMediaPublishError";
    this.code = code;
  }
}

export function collectionMediaObjectKey(snapshotId, sha256, extension) {
  if (!SNAPSHOT_PATTERN.test(snapshotId ?? "")) {
    throw new CollectionsMediaPublishError("Snapshot ID is invalid.", "INVALID_SNAPSHOT_ID");
  }
  if (!SHA256_PATTERN.test(sha256 ?? "") || !(extension in CONTENT_TYPES)) {
    throw new CollectionsMediaPublishError(
      "Collection media object identity is invalid.",
      "INVALID_OBJECT_IDENTITY",
    );
  }
  return `snapshots/${snapshotId}/collections/media/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

export async function loadCollectionMediaPublicationPlan({ input, snapshotId }) {
  if (!input) throw new CollectionsMediaPublishError("--input is required.", "INVALID_INPUT");
  if (!SNAPSHOT_PATTERN.test(snapshotId ?? "")) {
    throw new CollectionsMediaPublishError("--snapshot-id is invalid.", "INVALID_SNAPSHOT_ID");
  }
  const root = resolve(input);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CollectionsMediaPublishError(
      "Snapshot input must be a non-symlink directory.",
      "UNSAFE_SNAPSHOT_ROOT",
    );
  }
  const realRoot = await realpath(root);
  const objectsRoot = await safeDirectory(root, realRoot, "media/objects/sha256");

  const snapshotFile = await readVerifiedJson(root, realRoot, "manifest.json");
  const validationFile = await readVerifiedJson(root, realRoot, "validation/report.json");
  const checksumsFile = await readVerifiedFile(root, realRoot, "checksums.sha256");
  const mediaFile = await readVerifiedJson(root, realRoot, "media/manifest.json");
  const mediaCheckpointFile = await readVerifiedFile(root, realRoot, "media/checkpoint.ndjson");
  const mediaPlanFile = await readVerifiedFile(root, realRoot, "media/plan.ndjson");

  const snapshot = snapshotFile.value;
  const validation = validationFile.value;
  const mediaManifest = mediaFile.value;
  assertSnapshotValidation({
    snapshot,
    validation,
    mediaManifest,
    snapshotFile,
    checksumsFile,
    mediaFile,
  });

  const checksums = parseChecksums(checksumsFile.bytes.toString("utf8"));
  assertChecksumFile(validation, checksumsFile);
  for (const file of [snapshotFile, mediaFile, mediaCheckpointFile, mediaPlanFile]) {
    assertListedChecksum(checksums, file.path, file.sha256);
  }

  const planRows = parseNdjson(mediaPlanFile.bytes.toString("utf8"), mediaPlanFile.path);
  const planById = new Map();
  for (const row of planRows) {
    if (!row || typeof row.id !== "string" || planById.has(row.id)) {
      throw invalid(`Media plan has an invalid or duplicate reference ${JSON.stringify(row?.id)}.`);
    }
    planById.set(row.id, row);
  }
  const referencesSha256 = digest(Buffer.from(canonicalJsonLines(planRows)));
  if (referencesSha256 !== mediaManifest.referencesSha256) {
    throw invalid("Media plan digest differs from media/manifest.json.");
  }

  const checkpoint = parseMediaCaptureCheckpoint(mediaCheckpointFile.bytes.toString("utf8"));
  if (
    checkpoint.header?.kind !== "header" ||
    checkpoint.header.version !== 1 ||
    checkpoint.header.dataset !== "poap-compass-collection-media" ||
    checkpoint.header.endpoint !== snapshot.endpoint ||
    checkpoint.header.referencesSha256 !== referencesSha256
  ) {
    throw invalid("Media capture checkpoint header does not match this snapshot.");
  }
  if (checkpoint.records.size !== planById.size) {
    throw invalid(
      "Media capture checkpoint does not have one latest record per planned reference.",
    );
  }

  const statuses = { stored: 0, missing: 0, quarantined: 0, failed: 0 };
  const eligibleRecords = [];
  for (const [id, planned] of planById) {
    const record = checkpoint.records.get(id);
    if (!record) throw invalid(`Media capture checkpoint is missing ${id}.`);
    for (const field of ["id", "collectionId", "role", "sourceUrl"]) {
      if (record[field] !== planned[field]) {
        throw invalid(`Media capture checkpoint ${id} field ${field} differs from its plan.`);
      }
    }
    if (!(record.status in statuses))
      throw invalid(`Media capture checkpoint ${id} has an invalid status.`);
    statuses[record.status] += 1;
    if (record.status === "stored") {
      if (record.eligibleForPublish !== true) {
        throw invalid(`Stored media reference ${id} is not eligible for publication.`);
      }
      eligibleRecords.push(record);
    } else if (record.eligibleForPublish !== false) {
      throw invalid(`Excluded media reference ${id} is incorrectly marked publishable.`);
    }
  }
  for (const id of checkpoint.records.keys()) {
    if (!planById.has(id))
      throw invalid(`Media capture checkpoint has unexpected reference ${id}.`);
  }
  assertMediaCounts({ snapshot, validation, mediaManifest, statuses, planRows, checkpoint });

  const objectMap = new Map();
  for (const record of eligibleRecords) {
    const object = mediaObjectFromRecord(record, snapshotId, root);
    const prior = objectMap.get(object.key);
    if (prior) {
      if (
        prior.sha256 !== object.sha256 ||
        prior.byteLength !== object.byteLength ||
        prior.contentType !== object.contentType ||
        prior.sourcePath !== object.sourcePath
      ) {
        throw invalid(`References sharing ${object.key} disagree about immutable object metadata.`);
      }
      prior.referenceIds.push(record.id);
    } else {
      objectMap.set(object.key, { ...object, referenceIds: [record.id] });
    }
  }
  const objects = [...objectMap.values()].sort((left, right) => left.key.localeCompare(right.key));
  if (objects.length !== mediaManifest.uniqueObjects) {
    throw invalid("Unique eligible object count differs from media/manifest.json.");
  }

  await runPool(objects, 4, async (object) => {
    const file = await verifyLocalObject({ root, realRoot, objectsRoot, object });
    assertListedChecksum(checksums, object.sourcePath, object.sha256);
    object.absolutePath = file.absolutePath;
  });

  const eligibleManifestSha256 = digest(
    Buffer.from(
      `${objects
        .map((object) =>
          JSON.stringify({
            key: object.key,
            sourcePath: object.sourcePath,
            byteLength: object.byteLength,
            sha256: object.sha256,
            contentType: object.contentType,
          }),
        )
        .join("\n")}\n`,
    ),
  );
  const unified = await loadUnifiedD1Plan({
    root,
    realRoot,
    snapshotId,
    snapshotFile,
    brandingObjects: objects,
    eligibleManifestSha256,
    latestReferences: checkpoint.records.size,
  });

  return {
    root,
    snapshotId,
    objectPrefix: "snapshots/",
    archiveSnapshotId: unified.archiveSnapshotId,
    archiveTargetBucket: unified.archiveTargetBucket,
    objects: unified.objects,
    counts: {
      sourceCheckpointRecords: checkpoint.rawRecordCount,
      latestReferences: checkpoint.records.size,
      eligibleReferences: eligibleRecords.length,
      excludedReferences: checkpoint.records.size - eligibleRecords.length,
      uniqueObjects: unified.objects.length,
      deduplicatedReferences: eligibleRecords.length - objects.length,
      statuses,
      ...unified.counts,
    },
    bytes: unified.objects
      .filter((object) => object.disposition === "upload")
      .reduce((sum, object) => sum + object.byteLength, 0),
    manifests: {
      snapshot: metadata(snapshotFile),
      validationReport: metadata(validationFile),
      validationChecksums: metadata(checksumsFile),
      media: metadata(mediaFile),
      mediaCheckpoint: metadata(mediaCheckpointFile),
      mediaPlan: metadata(mediaPlanFile),
      dropSupplement: unified.dropSupplement,
      d1: unified.d1,
      mediaProof: unified.mediaProof,
      eligibleObjects: { sha256: eligibleManifestSha256, objects: objects.length },
    },
  };
}

export async function publishCollectionMedia({
  input,
  snapshotId,
  bucket,
  bridgeUrl,
  concurrency = 3,
  attempts = 4,
  checkpointPath,
  reportPath,
  signal,
  uploader: injectedUploader = null,
  onProgress = () => {},
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new CollectionsMediaPublishError(
      "concurrency must be an integer from 1 to 8.",
      "INVALID_CONCURRENCY",
    );
  }
  if (!BUCKET_PATTERN.test(bucket ?? "")) {
    throw new CollectionsMediaPublishError("--bucket is invalid.", "INVALID_BUCKET");
  }
  const startedAt = new Date();
  const endpoint = normalizeBridgeOrigin(bridgeUrl);
  const plan = await loadCollectionMediaPublicationPlan({ input, snapshotId });
  if (plan.counts.reuseObjects > 0 && plan.archiveTargetBucket !== bucket) {
    throw invalid("Archive artwork proof was published to a different R2 bucket.");
  }
  throwIfAborted(signal);
  const resolvedCheckpoint = resolve(
    checkpointPath ?? resolve(plan.root, "media/publish-checkpoint.ndjson"),
  );
  const resolvedReport = resolve(reportPath ?? resolve(plan.root, "media/publish-report.json"));
  const context = {
    dataset: "poapin-collections-media-publication",
    snapshotId,
    bucket,
    bridgeOrigin: endpoint,
    objectPrefix: plan.objectPrefix,
    archiveSnapshotId: plan.archiveSnapshotId,
    cacheControl: COLLECTIONS_MEDIA_CACHE_CONTROL,
    snapshotManifestSha256: plan.manifests.snapshot.sha256,
    validationReportSha256: plan.manifests.validationReport.sha256,
    mediaManifestSha256: plan.manifests.media.sha256,
    mediaCheckpointSha256: plan.manifests.mediaCheckpoint.sha256,
    d1ReportSha256: plan.manifests.d1.sha256,
    mediaProofSha256: plan.manifests.mediaProof.sha256,
    mediaProofObjects: plan.manifests.mediaProof.objects,
  };

  let uploader = injectedUploader;
  if (!uploader) {
    uploader = createCollectionsBridgeTarget({
      bridgeUrl: endpoint,
      bucket,
      snapshotId,
      archiveSnapshotId: plan.archiveSnapshotId,
      objectPrefix: plan.objectPrefix,
      cacheControl: COLLECTIONS_MEDIA_CACHE_CONTROL,
      maximumObjectBytes: COLLECTIONS_MEDIA_MAXIMUM_BYTES,
      attempts,
    }).uploader;
  }
  await uploader.verifyTarget({ signal });
  throwIfAborted(signal);

  const checkpoint = await new CollectionsMediaPublishCheckpoint(resolvedCheckpoint).open({
    context,
    objects: plan.objects,
  });
  const counts = {
    ...plan.counts,
    localValidated: plan.counts.uploadObjects,
    uploaded: 0,
    reused: 0,
    proofVerified: 0,
    checkpointVerified: 0,
    failed: 0,
  };
  const bytes = { source: plan.bytes, uploaded: 0 };
  const failures = [];
  let settled = 0;

  try {
    await runPool(
      plan.objects,
      concurrency,
      async (object) => {
        try {
          const prior = checkpoint.get(object.key);
          if (object.disposition === "reuse") {
            const remote = await uploader.head(remoteIdentity(object), { signal });
            if (!remote) {
              throw Object.assign(new Error(`Required archive object is absent: ${object.key}.`), {
                code: "ARCHIVE_OBJECT_MISSING",
              });
            }
            assertRemoteMatchesPlan(remote, object);
            if (prior) {
              assertRemoteMatchesCheckpoint(remote, prior);
              counts.checkpointVerified += 1;
            } else {
              await checkpoint.record({
                ...remote,
                mode: "archive-reuse",
                disposition: "archive-reuse",
              });
            }
            counts.proofVerified += 1;
            return;
          }
          if (prior) {
            const remote = await uploader.head(remoteIdentity(object), { signal });
            if (remote) {
              assertRemoteMatchesCheckpoint(remote, prior);
              counts.checkpointVerified += 1;
              counts.proofVerified += 1;
              return;
            }
          } else {
            // A previous publication can exist without a checkpoint compatible
            // with the current unified proof. Resolve that state with a signed,
            // exact metadata HEAD before sending the object body. This is also
            // the safe recovery path when a prior conditional PUT succeeded but
            // its response/checkpoint write was lost.
            const remote = await uploader.head(remoteIdentity(object), { signal });
            if (remote) {
              assertRemoteMatchesPlan(remote, object);
              await checkpoint.record({
                ...remote,
                mode: "upload",
                disposition: "reused",
              });
              counts.reused += 1;
              return;
            }
          }

          const fileBytes = await readFile(object.absolutePath);
          validateObjectBytes(fileBytes, object);
          const result = await uploader.upload({
            ...remoteIdentity(object),
            bytes: fileBytes,
            signal,
          });
          if (result.disposition === "uploaded") {
            counts.uploaded += 1;
            bytes.uploaded += object.byteLength;
          } else {
            counts.reused += 1;
          }
          await checkpoint.record({
            ...remoteIdentity(object),
            mode: "upload",
            disposition: result.disposition,
            etag: result.etag,
          });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") {
            throw abortReason(signal, error);
          }
          counts.failed += 1;
          failures.push(failureRecord(object.key, error));
        } finally {
          settled += 1;
          onProgress({ settled, total: plan.objects.length, counts: { ...counts } });
        }
      },
      signal,
    );
  } finally {
    await checkpoint.close();
  }

  const finishedAt = new Date();
  const remotelyVerified = counts.uploaded + counts.reused + counts.proofVerified;
  const complete = counts.failed === 0 && remotelyVerified === plan.objects.length;
  const report = {
    version: REPORT_VERSION,
    dataset: "poapin-collections-media-publication",
    ok: complete,
    complete,
    publishable: complete,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    snapshotId,
    manifests: plan.manifests,
    target: {
      transport: "temporary-hmac-worker-bridge",
      protocolVersion: 2,
      bucket,
      bridgeOrigin: endpoint,
      objectPrefix: plan.objectPrefix,
      archiveSnapshotId: plan.archiveSnapshotId,
      cacheControl: COLLECTIONS_MEDIA_CACHE_CONTROL,
      maximumObjectBytes: COLLECTIONS_MEDIA_MAXIMUM_BYTES,
    },
    checkpoint: {
      path: relative(plan.root, resolvedCheckpoint).replaceAll("\\", "/"),
      warning: checkpoint.warning,
    },
    counts,
    bytes,
    failures,
  };
  await writeJsonAtomic(resolvedReport, report);
  return report;
}

export class CollectionsMediaPublishCheckpoint {
  #handle = null;
  #chain = Promise.resolve();
  #pendingSync = 0;

  constructor(path, { syncEvery = 50 } = {}) {
    this.path = resolve(path);
    this.syncEvery = syncEvery;
    this.completed = new Map();
    this.warning = null;
  }

  async open({ context, objects }) {
    await mkdir(dirname(this.path), { recursive: true });
    let contents = null;
    try {
      const fileStat = await lstat(this.path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw invalid("Publication checkpoint must be a regular non-symlink file.");
      }
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const expected = new Map(objects.map((object) => [object.key, object]));
    if (contents) {
      const loaded = parsePublicationCheckpoint(contents);
      for (const [key, value] of Object.entries(context)) {
        if (loaded.header[key] !== value) {
          throw invalid(`Publication checkpoint ${key} does not match this run.`);
        }
      }
      for (const record of loaded.records) {
        const object = expected.get(record.key);
        assertPublicationRecord(record, object);
        this.completed.set(record.key, record);
      }
      if (loaded.repaired !== null) {
        await writeFile(this.path, loaded.repaired, { encoding: "utf8", mode: 0o600 });
        this.warning = "Ignored and removed a truncated final publication checkpoint line.";
      }
    }
    this.#handle = await open(this.path, "a", 0o600);
    if (!contents) {
      await this.#append(
        {
          kind: "header",
          version: CHECKPOINT_VERSION,
          ...context,
          createdAt: new Date().toISOString(),
        },
        true,
      );
    }
    return this;
  }

  get(key) {
    return this.completed.get(key) ?? null;
  }

  async record({ key, byteLength, sha256, contentType, mode, disposition, etag }) {
    const record = {
      kind: "object",
      version: CHECKPOINT_VERSION,
      key,
      byteLength,
      sha256,
      contentType,
      mode,
      disposition,
      etag,
      completedAt: new Date().toISOString(),
    };
    this.completed.set(key, record);
    await this.#append(record, false);
  }

  async close() {
    await this.#chain;
    if (this.#handle) {
      if (this.#pendingSync > 0) await this.#handle.sync();
      await this.#handle.close();
      this.#handle = null;
    }
  }

  async #append(record, forceSync) {
    if (!this.#handle) throw invalid("Publication checkpoint is not open.");
    this.#chain = this.#chain.then(async () => {
      await this.#handle.write(`${JSON.stringify(record)}\n`);
      this.#pendingSync += 1;
      if (forceSync || this.#pendingSync >= this.syncEvery) {
        await this.#handle.sync();
        this.#pendingSync = 0;
      }
    });
    await this.#chain;
  }
}

async function loadUnifiedD1Plan({
  root,
  realRoot,
  snapshotId,
  snapshotFile,
  brandingObjects,
  eligibleManifestSha256,
  latestReferences,
}) {
  const reportFile = await readVerifiedJson(root, realRoot, "d1/report.json");
  const report = reportFile.value;
  if (
    report.version !== 1 ||
    report.snapshotId !== snapshotId ||
    report.sourceManifestSha256 !== snapshotFile.sha256 ||
    report.tables?.collection_media !== latestReferences ||
    report.mediaProof?.version !== 2 ||
    !SHA256_PATTERN.test(report.mediaProof.sha256 ?? "") ||
    !Number.isSafeInteger(report.mediaProof.objects) ||
    report.mediaProof.objects < 0
  ) {
    throw invalid("D1 report is not bound to this snapshot and its final media proof.");
  }

  const proof = report.mediaProof;
  if (
    proof.manifest?.path !== "d1/media/publication-plan.ndjson" ||
    proof.manifest.sha256 !== proof.sha256 ||
    proof.manifest.rows !== proof.objects
  ) {
    throw invalid("D1 media proof manifest metadata is invalid.");
  }
  const proofFile = await readVerifiedFile(root, realRoot, proof.manifest.path);
  if (proofFile.sha256 !== proof.sha256 || proofFile.byteLength !== proof.manifest.byteLength) {
    throw invalid("D1 media proof bytes differ from d1/report.json.");
  }
  const rows = parseNdjson(proofFile.bytes.toString("utf8"), proofFile.path);
  if (
    rows.length !== proof.objects ||
    canonicalJsonLines(rows) !== proofFile.bytes.toString("utf8")
  ) {
    throw invalid("D1 media proof is not canonical NDJSON with the declared row count.");
  }

  const binding = report.sourceInputs?.dropSupplement;
  if (
    binding?.manifest?.path !== "drop-supplement/manifest.json" ||
    !SHA256_PATTERN.test(binding.sha256 ?? "") ||
    proof.provenance?.snapshotId !== snapshotId ||
    proof.provenance?.dropSupplementSha256 !== binding.sha256
  ) {
    throw invalid("D1 media proof is not bound to the final drop supplement.");
  }
  const dropSupplementFile = await readVerifiedJson(root, realRoot, binding.manifest.path);
  if (
    dropSupplementFile.sha256 !== binding.manifest.sha256 ||
    dropSupplementFile.byteLength !== binding.manifest.byteLength ||
    dropSupplementFile.value.version !== 1 ||
    dropSupplementFile.value.dataset !== "poap-compass-referenced-drop-supplement" ||
    dropSupplementFile.value.complete !== true ||
    dropSupplementFile.value.publishable !== true
  ) {
    throw invalid("Drop supplement manifest changed or is not complete and publishable.");
  }
  if (
    proof.provenance.collectionsMediaSha256 !== eligibleManifestSha256 ||
    report.sourceInputs?.media?.eligibleObjectsSha256 !== eligibleManifestSha256
  ) {
    throw invalid("D1 media proof is not bound to the validated Collection media set.");
  }
  if (
    JSON.stringify(proof.provenance.archiveMedia ?? null) !==
      JSON.stringify(binding.provenance?.archiveMedia ?? null) ||
    JSON.stringify(binding.provenance?.archiveMedia ?? null) !==
      JSON.stringify(dropSupplementFile.value.archiveMedia ?? null)
  ) {
    throw invalid("D1 media proof archive reuse provenance differs from its source binding.");
  }
  const supplementArtwork = dropSupplementFile.value.artwork;
  const boundArtwork = binding.artwork;
  if (
    boundArtwork?.reusedReferences !== supplementArtwork?.counts?.reused ||
    boundArtwork?.downloadedReferences !== supplementArtwork?.counts?.downloaded ||
    boundArtwork?.missingReferences !== supplementArtwork?.counts?.missing ||
    boundArtwork?.quarantinedReferences !== supplementArtwork?.counts?.quarantined ||
    boundArtwork?.downloadedObjects !== supplementArtwork?.uniqueDownloadedObjects ||
    proof.counts?.archiveDropArtwork !== boundArtwork?.reusedObjects ||
    proof.counts?.collectionDropArtwork !== boundArtwork?.downloadedObjects
  ) {
    throw invalid("D1 media proof drop artwork counts differ from the final supplement.");
  }

  const expectedBranding = new Map(
    brandingObjects.map((object) => [
      object.key,
      {
        kind: "collection-media",
        disposition: "upload",
        key: object.key,
        sourcePath: object.sourcePath,
        byteLength: object.byteLength,
        sha256: object.sha256,
        contentType: object.contentType,
      },
    ]),
  );
  const seen = new Set();
  const objects = [];
  let previousKey = null;
  for (const row of rows) {
    if (
      !row ||
      typeof row.key !== "string" ||
      seen.has(row.key) ||
      (previousKey !== null && previousKey.localeCompare(row.key, "en") >= 0)
    ) {
      throw invalid("D1 media proof keys are duplicated or not in canonical order.");
    }
    seen.add(row.key);
    previousKey = row.key;
    if (row.kind === "archive-drop-artwork" && row.disposition === "reuse") {
      objects.push(validateArchiveReuseDescriptor(row));
    } else {
      objects.push(await validatePublicationUploadDescriptor({ root, realRoot, snapshotId, row }));
    }
  }

  const actualBranding = new Map(
    rows.filter((row) => row.kind === "collection-media").map((row) => [row.key, row]),
  );
  if (
    actualBranding.size !== expectedBranding.size ||
    [...expectedBranding].some(
      ([key, expected]) => JSON.stringify(actualBranding.get(key)) !== JSON.stringify(expected),
    )
  ) {
    throw invalid("D1 media proof does not contain the exact validated Collection media set.");
  }

  const counts = {
    collectionMedia: rows.filter((row) => row.kind === "collection-media").length,
    archiveDropArtwork: rows.filter((row) => row.kind === "archive-drop-artwork").length,
    collectionDropArtwork: rows.filter((row) => row.kind === "collection-drop-artwork").length,
    uploadObjects: rows.filter((row) => row.disposition === "upload").length,
    reuseObjects: rows.filter((row) => row.disposition === "reuse").length,
  };
  const expectedCounts = proof.counts ?? {};
  if (
    expectedCounts.collectionMedia !== counts.collectionMedia ||
    expectedCounts.archiveDropArtwork !== counts.archiveDropArtwork ||
    expectedCounts.collectionDropArtwork !== counts.collectionDropArtwork ||
    expectedCounts.upload !== counts.uploadObjects ||
    expectedCounts.reuse !== counts.reuseObjects
  ) {
    throw invalid("D1 media proof counts do not describe its exact object plan.");
  }

  const reuseRows = objects.filter((object) => object.disposition === "reuse");
  const archiveEvidence = proof.provenance.archiveMedia;
  const archiveSnapshotId = archiveEvidence?.snapshotId ?? snapshotId;
  if (
    reuseRows.length > 0 &&
    (archiveEvidence?.used !== true ||
      archiveEvidence.publishable !== true ||
      !SNAPSHOT_PATTERN.test(archiveSnapshotId) ||
      !BUCKET_PATTERN.test(archiveEvidence.targetBucket ?? "") ||
      archiveEvidence.verifiedPublishedObjects < reuseRows.length ||
      reuseRows.some((object) => object.archiveSnapshotId !== archiveSnapshotId))
  ) {
    throw invalid("Archive artwork reuse lacks complete trusted upload provenance.");
  }
  if (reuseRows.length > 0) {
    await verifyArchiveReuseProvenance({
      root,
      realRoot,
      archiveEvidence,
      reuseRows,
    });
  }
  return {
    objects,
    counts,
    archiveSnapshotId,
    archiveTargetBucket: archiveEvidence?.targetBucket ?? null,
    dropSupplement: metadata(dropSupplementFile),
    d1: metadata(reportFile),
    mediaProof: {
      sha256: proof.sha256,
      objects: proof.objects,
      manifest: { ...metadata(proofFile), rows: proof.objects },
    },
  };
}

async function verifyArchiveReuseProvenance({ root, realRoot, archiveEvidence, reuseRows }) {
  const definitions = [
    ["manifest", "provenance/archive/artwork-manifest.ndjson"],
    ["uploadReport", "provenance/archive/upload-report.json"],
    ["uploadCheckpoint", "provenance/archive/upload-checkpoint.jsonl"],
  ];
  if (!Array.isArray(archiveEvidence.artifacts) || archiveEvidence.artifacts.length !== 3) {
    throw invalid("Archive artwork provenance artifact set is incomplete.");
  }
  const artifacts = new Map(
    archiveEvidence.artifacts.map((artifact) => [artifact?.path, artifact]),
  );
  const verified = new Map();
  for (const [name, path] of definitions) {
    const expected = archiveEvidence[name];
    const planned = artifacts.get(path);
    if (
      expected?.path !== path ||
      planned?.path !== path ||
      expected.sha256 !== planned.sha256 ||
      expected.byteLength !== planned.byteLength ||
      expected.rows !== planned.rows
    ) {
      throw invalid(`Archive artwork ${name} provenance metadata is inconsistent.`);
    }
    const actual = await readVerifiedFile(root, realRoot, `drop-supplement/${path}`);
    if (
      actual.sha256 !== expected.sha256 ||
      actual.byteLength !== expected.byteLength ||
      !Number.isSafeInteger(expected.rows) ||
      expected.rows < 1
    ) {
      throw invalid(`Archive artwork ${name} provenance bytes changed.`);
    }
    verified.set(name, actual);
  }

  let uploadReport;
  try {
    uploadReport = JSON.parse(verified.get("uploadReport").bytes.toString("utf8"));
  } catch (error) {
    throw invalid(`Archive upload report is invalid JSON: ${error.message}`);
  }
  const accounted =
    Number(uploadReport.counts?.uploaded ?? 0) +
    Number(uploadReport.counts?.reused ?? 0) +
    Number(uploadReport.counts?.checkpointSkipped ?? 0);
  if (
    uploadReport.version !== 1 ||
    uploadReport.ok !== true ||
    uploadReport.complete !== true ||
    uploadReport.publishable !== true ||
    uploadReport.snapshotId !== archiveEvidence.snapshotId ||
    uploadReport.target?.snapshotId !== archiveEvidence.snapshotId ||
    uploadReport.target?.bucket !== archiveEvidence.targetBucket ||
    uploadReport.target?.cacheControl !== COLLECTIONS_MEDIA_CACHE_CONTROL ||
    uploadReport.stopReason !== null ||
    uploadReport.fatalFailure !== null ||
    (uploadReport.failures?.length ?? 0) !== 0 ||
    Number(uploadReport.counts?.failed) !== 0 ||
    uploadReport.source?.kind !== "local" ||
    (uploadReport.source.label ?? null) !== (archiveEvidence.sourceArchive?.label ?? null) ||
    uploadReport.source.actualByteLength !== archiveEvidence.sourceArchive?.byteLength ||
    uploadReport.source.sha256 !== archiveEvidence.sourceArchive?.sha256 ||
    uploadReport.validations?.sourceComplete !== true ||
    uploadReport.validations?.sourceByteLength?.checked !== true ||
    uploadReport.validations.sourceByteLength.matches !== true ||
    uploadReport.validations.sourceByteLength.actual !== uploadReport.source.actualByteLength ||
    uploadReport.validations.sourceByteLength.expected !==
      uploadReport.source.advertisedByteLength ||
    uploadReport.validations?.sourceSha256?.checked !== true ||
    uploadReport.validations.sourceSha256.matches !== true ||
    uploadReport.validations.sourceSha256.actual !== uploadReport.source.sha256 ||
    uploadReport.validations.sourceSha256.expected !== uploadReport.source.sha256 ||
    uploadReport.validations?.artworkCount?.checked !== true ||
    uploadReport.validations.artworkCount.matches !== true ||
    uploadReport.validations.artworkCount.actual !== uploadReport.manifest?.rows ||
    uploadReport.validations.artworkCount.expected !== uploadReport.manifest?.rows ||
    uploadReport.manifest?.sha256 !== archiveEvidence.manifest.sha256 ||
    uploadReport.manifest?.byteLength !== archiveEvidence.manifest.byteLength ||
    uploadReport.manifest?.rows !== archiveEvidence.manifest.rows ||
    uploadReport.manifest.eligible !== archiveEvidence.manifest.rows ||
    uploadReport.manifest.ineligible !== 0 ||
    accounted !== archiveEvidence.manifest.rows
  ) {
    throw invalid("Archive upload report is not a complete release bound to its preserved proof.");
  }

  const manifestRows = parseNdjson(
    verified.get("manifest").bytes.toString("utf8"),
    "drop-supplement/provenance/archive/artwork-manifest.ndjson",
  );
  const manifestKeys = new Set();
  for (const [index, row] of manifestRows.entries()) {
    const dropId = Number(row?.dropId);
    const key = `snapshots/${archiveEvidence.snapshotId}/artwork/${dropId}.webp`;
    if (
      row?.snapshotId !== archiveEvidence.snapshotId ||
      !Number.isSafeInteger(dropId) ||
      dropId <= 0 ||
      row.eligibleForPublish !== true ||
      row.object?.key !== key ||
      row.object?.contentType !== "image/webp" ||
      row.object?.cacheControl !== COLLECTIONS_MEDIA_CACHE_CONTROL ||
      manifestKeys.has(key)
    ) {
      throw invalid(`Archive artwork manifest row ${index + 1} is invalid or duplicated.`);
    }
    manifestKeys.add(key);
  }
  if (
    manifestRows.length !== archiveEvidence.manifest.rows ||
    manifestKeys.size !== archiveEvidence.verifiedPublishedObjects
  ) {
    throw invalid("Archive artwork manifest object count is incomplete.");
  }

  const checkpointRows = parseNdjson(
    verified.get("uploadCheckpoint").bytes.toString("utf8"),
    "drop-supplement/provenance/archive/upload-checkpoint.jsonl",
  );
  const header = checkpointRows.shift();
  if (
    header?.kind !== "header" ||
    header.version !== 1 ||
    header.snapshotId !== archiveEvidence.snapshotId ||
    header.archiveSha256 !== archiveEvidence.sourceArchive?.sha256 ||
    header.manifestSha256 !== archiveEvidence.manifest.sha256 ||
    header.endpoint !== uploadReport.target.endpoint ||
    header.bucket !== archiveEvidence.targetBucket ||
    header.cacheControl !== COLLECTIONS_MEDIA_CACHE_CONTROL ||
    header.objectPrefix !== `snapshots/${archiveEvidence.snapshotId}/artwork/` ||
    checkpointRows.length + 1 !== archiveEvidence.uploadCheckpoint.rows
  ) {
    throw invalid("Archive upload checkpoint header is not bound to the trusted release.");
  }
  const proofByKey = new Map();
  for (const row of checkpointRows) {
    if (
      row?.kind !== "object" ||
      row.version !== 1 ||
      typeof row.key !== "string" ||
      !row.key.startsWith(header.objectPrefix) ||
      !Number.isSafeInteger(row.byteLength) ||
      row.byteLength <= 0 ||
      !SHA256_PATTERN.test(row.sha256 ?? "") ||
      !["uploaded", "reused"].includes(row.disposition) ||
      proofByKey.has(row.key)
    ) {
      throw invalid(`Archive upload checkpoint contains an invalid proof row: ${row?.key}.`);
    }
    proofByKey.set(row.key, row);
  }
  if (
    proofByKey.size !== archiveEvidence.uploadCheckpoint.objects ||
    proofByKey.size !== archiveEvidence.verifiedPublishedObjects ||
    proofByKey.size !== manifestKeys.size ||
    [...proofByKey.keys()].some((key) => !manifestKeys.has(key))
  ) {
    throw invalid("Archive upload checkpoint object count is incomplete.");
  }
  for (const object of reuseRows) {
    const proof = proofByKey.get(object.key);
    if (
      !proof ||
      proof.byteLength !== object.byteLength ||
      proof.sha256 !== object.sha256 ||
      proof.disposition !== object.archiveDisposition ||
      (proof.etag ?? null) !== object.etag
    ) {
      throw invalid(`Archive object differs from its preserved upload proof: ${object.key}.`);
    }
  }
}

async function validatePublicationUploadDescriptor({ root, realRoot, snapshotId, row }) {
  const expectedFields = [
    "byteLength",
    "contentType",
    "disposition",
    "key",
    "kind",
    "sha256",
    "sourcePath",
  ].sort();
  if (
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedFields) ||
    row.disposition !== "upload" ||
    !["collection-media", "collection-drop-artwork"].includes(row.kind) ||
    !SHA256_PATTERN.test(row.sha256 ?? "") ||
    !Number.isSafeInteger(row.byteLength) ||
    row.byteLength <= 0 ||
    row.byteLength > COLLECTIONS_MEDIA_MAXIMUM_BYTES ||
    typeof row.contentType !== "string" ||
    typeof row.sourcePath !== "string"
  ) {
    throw invalid(`D1 media proof has an invalid upload descriptor for ${row?.key}.`);
  }
  const extension = Object.entries(CONTENT_TYPES).find(([, type]) => type === row.contentType)?.[0];
  if (!extension) throw invalid(`D1 media proof has an unsupported media type for ${row.key}.`);
  const suffix = `${row.sha256.slice(0, 2)}/${row.sha256}.${extension}`;
  const expected =
    row.kind === "collection-media"
      ? {
          sourcePath: `media/objects/sha256/${suffix}`,
          key: `snapshots/${snapshotId}/collections/media/sha256/${suffix}`,
        }
      : {
          sourcePath: `drop-supplement/artwork/objects/sha256/${suffix}`,
          key: `snapshots/${snapshotId}/collections/drop-artwork/sha256/${suffix}`,
        };
  if (row.sourcePath !== expected.sourcePath || row.key !== expected.key) {
    throw invalid(`D1 media proof has a non-canonical upload path/key for ${row.key}.`);
  }
  const file = await readVerifiedFile(root, realRoot, row.sourcePath, {
    maximumBytes: COLLECTIONS_MEDIA_MAXIMUM_BYTES,
  });
  if (file.sha256 !== row.sha256 || file.byteLength !== row.byteLength) {
    throw invalid(`Publication object differs from the D1 media proof: ${row.sourcePath}.`);
  }
  const object = { ...row, extension, absolutePath: file.absolutePath };
  validateObjectMagic(file.prefix, object);
  return object;
}

function validateArchiveReuseDescriptor(row) {
  const expectedFields = [
    "archiveDisposition",
    "archiveSnapshotId",
    "byteLength",
    "cacheControl",
    "contentType",
    "disposition",
    "dropId",
    "etag",
    "key",
    "kind",
    "sha256",
  ].sort();
  const expectedKey = `snapshots/${row.archiveSnapshotId}/artwork/${row.dropId}.webp`;
  if (
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedFields) ||
    !SNAPSHOT_PATTERN.test(row.archiveSnapshotId ?? "") ||
    !Number.isSafeInteger(row.dropId) ||
    row.dropId <= 0 ||
    !Number.isSafeInteger(row.byteLength) ||
    row.byteLength <= 0 ||
    !SHA256_PATTERN.test(row.sha256 ?? "") ||
    row.key !== expectedKey ||
    row.contentType !== "image/webp" ||
    row.cacheControl !== COLLECTIONS_MEDIA_CACHE_CONTROL ||
    !["uploaded", "reused"].includes(row.archiveDisposition) ||
    !(
      row.etag === null ||
      (typeof row.etag === "string" && row.etag.length > 0 && row.etag.length <= 256)
    )
  ) {
    throw invalid(`D1 media proof has an invalid archive reuse descriptor for ${row?.key}.`);
  }
  return { ...row, mode: "archive-reuse" };
}

async function verifyLocalObject({ root, realRoot, objectsRoot, object }) {
  if (object.byteLength > COLLECTIONS_MEDIA_MAXIMUM_BYTES) {
    throw invalid(`Collection media object ${object.sourcePath} exceeds the bridge size limit.`);
  }
  const file = await readVerifiedFile(root, realRoot, object.sourcePath, {
    maximumBytes: COLLECTIONS_MEDIA_MAXIMUM_BYTES,
  });
  const expectedPrefix = `${objectsRoot.real}${sep}`;
  if (!file.realPath.startsWith(expectedPrefix)) {
    throw invalid(`Collection media object escapes media/objects/sha256: ${object.sourcePath}.`);
  }
  if (file.byteLength !== object.byteLength || file.sha256 !== object.sha256) {
    throw invalid(
      `Collection media object metadata differs from checkpoint: ${object.sourcePath}.`,
    );
  }
  validateObjectMagic(file.prefix, object);
  return { absolutePath: file.absolutePath };
}

function validateObjectBytes(bytes, object) {
  if (bytes.byteLength !== object.byteLength || digest(bytes) !== object.sha256) {
    throw new CollectionsMediaPublishError(
      `Collection media object changed after validation: ${object.sourcePath}.`,
      "LOCAL_OBJECT_CHANGED",
    );
  }
  validateObjectMagic(bytes.subarray(0, 512), object);
}

function validateObjectMagic(prefix, object) {
  const detected = detectImage(prefix);
  if (
    !detected ||
    detected.extension !== object.extension ||
    detected.contentType !== object.contentType
  ) {
    throw invalid(`Collection media magic/type mismatch: ${object.sourcePath}.`);
  }
}

function mediaObjectFromRecord(record, snapshotId, root) {
  if (
    !SHA256_PATTERN.test(record.sha256 ?? "") ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength <= 0 ||
    !(record.extension in CONTENT_TYPES) ||
    CONTENT_TYPES[record.extension] !== record.contentType ||
    typeof record.objectPath !== "string"
  ) {
    throw invalid(`Stored media reference ${record.id} has invalid object metadata.`);
  }
  const expectedPath = `media/objects/sha256/${record.sha256.slice(0, 2)}/${record.sha256}.${record.extension}`;
  if (record.objectPath !== expectedPath) {
    throw invalid(`Stored media reference ${record.id} has a non-canonical object path.`);
  }
  return {
    key: collectionMediaObjectKey(snapshotId, record.sha256, record.extension),
    sourcePath: expectedPath,
    absolutePath: resolve(root, expectedPath),
    byteLength: record.byteLength,
    sha256: record.sha256,
    extension: record.extension,
    contentType: record.contentType,
  };
}

function assertSnapshotValidation({
  snapshot,
  validation,
  mediaManifest,
  snapshotFile,
  checksumsFile,
  mediaFile,
}) {
  if (snapshot.version !== 1 || snapshot.dataset !== "poap-compass-collections") {
    throw invalid("Snapshot manifest is not a Collections v1 dataset.");
  }
  if (
    snapshot.media?.captured !== true ||
    snapshot.media.complete !== true ||
    snapshot.media.publishable !== true ||
    snapshot.media.manifest !== "media/manifest.json"
  ) {
    throw invalid("Snapshot manifest does not mark Collections media publishable.");
  }
  if (
    validation.version !== 1 ||
    validation.dataset !== snapshot.dataset ||
    validation.verified !== true ||
    validation.media?.checked !== true ||
    validation.media.complete !== true ||
    validation.manifest?.sha256 !== snapshotFile.sha256 ||
    validation.manifest.byteLength !== snapshotFile.byteLength
  ) {
    throw invalid("validation/report.json does not verify the current Collections snapshot.");
  }
  if (
    mediaManifest.version !== 1 ||
    mediaManifest.dataset !== "poap-compass-collection-media" ||
    mediaManifest.attemptedAll !== true ||
    mediaManifest.complete !== true ||
    mediaManifest.publishable !== true ||
    mediaManifest.quarantinedReferencesAreExcluded !== true ||
    mediaManifest.checkpoint !== "media/checkpoint.ndjson" ||
    snapshot.media.referencesSha256 !== mediaManifest.referencesSha256 ||
    snapshot.media.uniqueObjects !== mediaManifest.uniqueObjects ||
    snapshot.media.references !== mediaManifest.references
  ) {
    throw invalid("media/manifest.json is incomplete or differs from the root manifest.");
  }
  if (!checksumsFile.byteLength || !mediaFile.byteLength)
    throw invalid("Snapshot validation files are empty.");
}

function assertMediaCounts({
  snapshot,
  validation,
  mediaManifest,
  statuses,
  planRows,
  checkpoint,
}) {
  if (
    mediaManifest.references !== planRows.length ||
    validation.media.references !== planRows.length ||
    validation.media.checkpointRecords !== checkpoint.records.size ||
    validation.media.objectsChecked !== mediaManifest.uniqueObjects ||
    validation.media.uniqueObjects !== mediaManifest.uniqueObjects
  ) {
    throw invalid("Media reference counts differ across validated manifests.");
  }
  for (const [status, count] of Object.entries(statuses)) {
    if (
      mediaManifest.counts?.[status] !== count ||
      snapshot.media.counts?.[status] !== count ||
      validation.media.statuses?.[status] !== count
    ) {
      throw invalid(`Media ${status} count differs across validated manifests.`);
    }
  }
  if (statuses.failed !== 0 || statuses.missing !== 0) {
    throw invalid("Missing or failed collection media prevents publication.");
  }
}

function assertChecksumFile(validation, checksumsFile) {
  const entries = parseChecksums(checksumsFile.bytes.toString("utf8"));
  if (
    validation.checksums?.path !== "checksums.sha256" ||
    validation.checksums.entries !== entries.size ||
    validation.checksums.sha256 !== checksumsFile.sha256 ||
    validation.checksums.byteLength !== checksumsFile.byteLength
  ) {
    throw invalid("checksums.sha256 differs from validation/report.json.");
  }
}

function assertListedChecksum(checksums, path, expectedSha256) {
  if (checksums.get(path) !== expectedSha256) {
    throw invalid(`Validated checksum entry differs for ${path}.`);
  }
}

async function safeDirectory(root, realRoot, path) {
  const absolutePath = safePath(root, path);
  const fileStat = await lstat(absolutePath);
  if (!fileStat.isDirectory() || fileStat.isSymbolicLink()) {
    throw invalid(`Expected a non-symlink directory: ${path}.`);
  }
  const real = await realpath(absolutePath);
  assertRealContainment(realRoot, real, path);
  return { absolutePath, real };
}

async function readVerifiedJson(root, realRoot, path) {
  const file = await readVerifiedFile(root, realRoot, path);
  let value;
  try {
    value = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    throw invalid(`Invalid JSON in ${path}: ${error.message}`);
  }
  return { ...file, value };
}

async function readVerifiedFile(root, realRoot, path, { maximumBytes = 64 * 1024 * 1024 } = {}) {
  const absolutePath = safePath(root, path);
  const fileStat = await lstat(absolutePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw invalid(`Expected a regular non-symlink file: ${path}.`);
  }
  if (fileStat.size > maximumBytes) throw invalid(`File exceeds safe read limit: ${path}.`);
  const realPath = await realpath(absolutePath);
  assertRealContainment(realRoot, realPath, path);
  const bytes = await readFile(absolutePath);
  const prefix = bytes.subarray(0, 512);
  return {
    path,
    absolutePath,
    realPath,
    bytes,
    prefix,
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
  };
}

function safePath(root, path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    throw invalid(`Unsafe snapshot path: ${JSON.stringify(path)}.`);
  }
  const absolute = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) throw invalid(`Snapshot path escapes root: ${path}.`);
  return absolute;
}

function assertRealContainment(realRoot, realTarget, display) {
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!realTarget.startsWith(prefix))
    throw invalid(`Snapshot path escapes root through a link: ${display}.`);
}

function parseChecksums(text) {
  const entries = new Map();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  ([^\r\n]+)$/.exec(line);
    if (!match || entries.has(match[2]) || match[2].includes("\\") || match[2].startsWith("/")) {
      throw invalid(`Invalid checksum entry on line ${index + 1}.`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function parseMediaCaptureCheckpoint(text) {
  const rows = parseNdjson(text, "media/checkpoint.ndjson");
  const header = rows.shift() ?? null;
  const records = new Map();
  let rawRecordCount = 0;
  for (const record of rows) {
    if (record?.kind !== "reference" || record.version !== 1 || typeof record.id !== "string") {
      throw invalid("Media capture checkpoint has an invalid reference record.");
    }
    records.set(record.id, record);
    rawRecordCount += 1;
  }
  return { header, records, rawRecordCount };
}

function parsePublicationCheckpoint(text) {
  const lines = text.split("\n");
  const rows = [];
  let repaired = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      rows.push(JSON.parse(lines[index]));
    } catch {
      const last = lines.slice(index + 1).every((line) => !line.trim());
      if (!last) throw invalid(`Publication checkpoint has invalid JSON on line ${index + 1}.`);
      repaired = `${lines.slice(0, index).join("\n")}\n`;
    }
  }
  const header = rows.shift();
  if (header?.kind !== "header" || header.version !== CHECKPOINT_VERSION) {
    throw invalid("Publication checkpoint header is invalid.");
  }
  return { header, records: rows, repaired };
}

function assertPublicationRecord(record, object) {
  const commonInvalid =
    !object ||
    record?.kind !== "object" ||
    record.version !== CHECKPOINT_VERSION ||
    record.key !== object.key ||
    record.contentType !== object.contentType ||
    typeof record.etag !== "string" ||
    !record.etag;
  const uploadInvalid =
    object?.disposition === "upload" &&
    (record.mode !== "upload" ||
      record.byteLength !== object.byteLength ||
      record.sha256 !== object.sha256 ||
      !["uploaded", "reused"].includes(record.disposition));
  const reuseInvalid =
    object?.disposition === "reuse" &&
    (record.mode !== "archive-reuse" ||
      record.disposition !== "archive-reuse" ||
      record.byteLength !== object.byteLength ||
      record.sha256 !== object.sha256);
  if (commonInvalid || uploadInvalid || reuseInvalid) {
    throw invalid("Publication checkpoint contains an invalid or stale object record.");
  }
}

function parseNdjson(text, path) {
  const rows = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw invalid(`Invalid NDJSON in ${path} on line ${index + 1}: ${error.message}`);
    }
  }
  return rows;
}

function canonicalJsonLines(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function detectImage(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return { contentType: "image/gif", extension: "gif" };
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = bytes.subarray(8, Math.min(bytes.length, 64)).toString("ascii");
    if (brands.includes("avif") || brands.includes("avis")) {
      return { contentType: "image/avif", extension: "avif" };
    }
  }
  return null;
}

async function runPool(values, concurrency, task, signal) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      await task(values[index]);
    }
  });
  const results = await Promise.allSettled(workers);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  throwIfAborted(signal);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal, error) {
  if (error?.name === "AbortError") return error;
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Collections media publication was aborted."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function normalizeBridgeOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new CollectionsMediaPublishError(
      "--bridge-url must be an exact HTTPS origin.",
      "INVALID_BRIDGE_URL",
    );
  }
}

function metadata(file) {
  return { path: file.path, byteLength: file.byteLength, sha256: file.sha256 };
}

function remoteIdentity(object) {
  if (object.disposition === "reuse") {
    return {
      mode: "archive-reuse",
      key: object.key,
      byteLength: object.byteLength,
      sha256: object.sha256,
      contentType: object.contentType,
      archiveSnapshotId: object.archiveSnapshotId,
      dropId: object.dropId,
    };
  }
  return {
    mode: "upload",
    key: object.key,
    byteLength: object.byteLength,
    sha256: object.sha256,
    contentType: object.contentType,
  };
}

function assertRemoteMatchesCheckpoint(remote, checkpoint) {
  if (
    remote.key !== checkpoint.key ||
    remote.byteLength !== checkpoint.byteLength ||
    remote.sha256 !== checkpoint.sha256 ||
    remote.contentType !== checkpoint.contentType ||
    remote.etag !== checkpoint.etag
  ) {
    throw Object.assign(new Error(`Remote immutable object changed: ${checkpoint.key}.`), {
      code: "REMOTE_OBJECT_CHANGED",
    });
  }
}

function assertRemoteMatchesPlan(remote, object) {
  if (
    remote.key !== object.key ||
    remote.byteLength !== object.byteLength ||
    remote.sha256 !== object.sha256 ||
    remote.contentType !== object.contentType ||
    (typeof object.etag === "string" && remote.etag !== object.etag)
  ) {
    throw Object.assign(new Error(`Remote object differs from its trusted proof: ${object.key}.`), {
      code: "REMOTE_PROOF_MISMATCH",
    });
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failureRecord(scope, error) {
  return {
    scope,
    code: String(error?.code ?? error?.name ?? "UNKNOWN_ERROR").slice(0, 80),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
    ...(Number.isSafeInteger(error?.attempts) ? { attempts: error.attempts } : {}),
    ...(Number.isSafeInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  };
}

function invalid(message) {
  return new CollectionsMediaPublishError(message);
}

export const collectionMediaPublishInternals = {
  detectImage,
  parseMediaCaptureCheckpoint,
  parsePublicationCheckpoint,
};
