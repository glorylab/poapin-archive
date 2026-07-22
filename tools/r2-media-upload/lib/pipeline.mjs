import { createHash } from "node:crypto";

import { ARTWORK_PATH_PATTERN } from "./constants.mjs";
import { ZipFormatError, ZipStreamReader, decodeZipEntry, describeArtwork } from "./zip-stream.mjs";

export async function uploadArtworkArchive({
  source,
  manifest,
  uploader = null,
  checkpoint = null,
  options,
  signal,
  onProgress = () => {},
}) {
  const startedAt = new Date();
  const archiveHash = createHash("sha256");
  const reader = new ZipStreamReader(source.stream, {
    onChunk: (chunk) => archiveHash.update(chunk),
  });
  const pool = new TaskPool(options.concurrency);
  const seenKeys = new Set();
  const seenEligibleManifestPaths = new Set();
  const failures = [];
  const counts = {
    zipEntries: 0,
    artworkEntries: 0,
    manifestEligibleEntries: 0,
    manifestSkipped: 0,
    uploaded: 0,
    reused: 0,
    checkpointSkipped: 0,
    dryRunValidated: 0,
    failed: 0,
    ignoredEntries: 0,
  };
  const bytes = {
    sourceRead: 0,
    artworkDecoded: 0,
    uploaded: 0,
  };
  let sourceComplete = false;
  let stopReason = null;
  let fatalFailure = null;
  let scheduled = 0;

  try {
    if (
      options.expectedSourceBytes !== null &&
      source.byteLength !== null &&
      source.byteLength !== options.expectedSourceBytes
    ) {
      throw runError(
        `Archive size is ${source.byteLength} bytes; expected ${options.expectedSourceBytes}.`,
        "SOURCE_SIZE_MISMATCH",
      );
    }

    while (!signal?.aborted) {
      if (failures.length >= options.maxFailures) {
        stopReason = "maximum-failures";
        break;
      }

      const entry = await reader.nextEntry();
      if (entry === null) {
        if (!reader.reachedCentralDirectory) {
          throw runError("ZIP ended without a central directory.", "MISSING_CENTRAL_DIRECTORY");
        }
        await reader.drain();
        sourceComplete = true;
        break;
      }
      counts.zipEntries += 1;

      const match = ARTWORK_PATH_PATTERN.exec(entry.path);
      if (!match) {
        if (entry.path !== "poap.sqlite" && entry.path !== "artwork/") counts.ignoredEntries += 1;
        await reader.skip(entry);
        continue;
      }
      counts.artworkEntries += 1;

      const manifestEntry = manifest.get(entry.path);
      if (!manifestEntry || !manifestEntry.eligibleForPublish) {
        counts.manifestSkipped += 1;
        await reader.skip(entry);
        continue;
      }
      const key = manifestEntry.key;
      if (seenKeys.has(key))
        throw runError(`ZIP contains duplicate artwork key ${key}.`, "DUPLICATE_ARTWORK_KEY");
      seenKeys.add(key);
      seenEligibleManifestPaths.add(entry.path);
      counts.manifestEligibleEntries += 1;

      if (
        manifestEntry.sourceByteLength !== null &&
        manifestEntry.sourceByteLength !== entry.byteLength
      ) {
        throw runError(
          `Manifest size for ${key} does not match the ZIP entry.`,
          "MANIFEST_SOURCE_MISMATCH",
        );
      }
      const entryCrc32 = entry.crc32.toString(16).padStart(8, "0");
      if (manifestEntry.sourceCrc32 !== null && manifestEntry.sourceCrc32 !== entryCrc32) {
        throw runError(
          `Manifest CRC-32 for ${key} does not match the ZIP entry.`,
          "MANIFEST_SOURCE_MISMATCH",
        );
      }

      const unsafeSize = validateEntrySize(entry, options);
      if (unsafeSize) {
        await reader.skip(entry);
        recordFailure(failures, counts, key, unsafeSize);
        reportProgress({ counts, bytes, onProgress, progressEvery: options.progressEvery });
        continue;
      }

      const prior = checkpoint?.get(key);
      if (prior) {
        if (prior.byteLength !== entry.byteLength) {
          throw runError(
            `Checkpoint size for ${key} does not match this archive.`,
            "CHECKPOINT_SOURCE_MISMATCH",
          );
        }
        counts.checkpointSkipped += 1;
        await reader.skip(entry);
        reportProgress({ counts, bytes, onProgress, progressEvery: options.progressEvery });
        continue;
      }

      if (options.limit !== null && scheduled >= options.limit) {
        stopReason = "limit";
        break;
      }

      await pool.waitForSlot();
      if (failures.length >= options.maxFailures) {
        stopReason = "maximum-failures";
        break;
      }
      const compressed = await reader.readCompressed(entry, options.maximumEntryBytes);
      scheduled += 1;
      pool.run(async () => {
        try {
          const decoded = await decodeZipEntry(entry, compressed, {
            maximumEntryBytes: options.maximumEntryBytes,
            maximumCompressionRatio: options.maximumCompressionRatio,
          });
          const artwork = describeArtwork(decoded);
          bytes.artworkDecoded += artwork.byteLength;

          if (options.dryRun) {
            counts.dryRunValidated += 1;
            return;
          }
          const result = await uploader.upload({
            key,
            bytes: decoded,
            sha256: artwork.sha256,
            contentMd5: artwork.contentMd5,
            signal,
          });
          if (result.disposition === "reused") {
            counts.reused += 1;
          } else {
            counts.uploaded += 1;
            bytes.uploaded += artwork.byteLength;
          }
          await checkpoint.record({
            key,
            byteLength: artwork.byteLength,
            sha256: artwork.sha256,
            disposition: result.disposition,
            etag: result.etag,
          });
        } catch (error) {
          recordFailure(failures, counts, key, error);
        } finally {
          reportProgress({ counts, bytes, onProgress, progressEvery: options.progressEvery });
        }
      });
    }
    await pool.drain();

    if (signal?.aborted) stopReason = "aborted";
    if (stopReason) reader.destroy();
  } catch (error) {
    fatalFailure = failureRecord("archive", error);
    reader.destroy();
    await pool.drain();
  } finally {
    bytes.sourceRead = reader.sourceBytesRead;
  }

  const sourceSha256 = sourceComplete ? archiveHash.digest("hex") : null;
  if (
    sourceComplete &&
    seenEligibleManifestPaths.size !== manifest.eligibleCount &&
    !fatalFailure
  ) {
    fatalFailure = failureRecord(
      "manifest",
      runError(
        `ZIP contained ${seenEligibleManifestPaths.size} of ${manifest.eligibleCount} eligible manifest artworks.`,
        "MANIFEST_ENTRIES_MISSING",
      ),
    );
  }
  const validations = {
    sourceComplete,
    sourceByteLength: validationResult(
      sourceComplete && options.expectedSourceBytes !== null,
      reader.sourceBytesRead,
      options.expectedSourceBytes,
    ),
    sourceSha256: validationResult(
      sourceComplete && options.expectedSourceSha256 !== null,
      sourceSha256,
      options.expectedSourceSha256,
    ),
    artworkCount: validationResult(
      sourceComplete && options.expectedArtworkCount !== null,
      counts.artworkEntries,
      options.expectedArtworkCount,
    ),
  };
  const validationFailed = Object.values(validations).some(
    (result) => result.checked && !result.matches,
  );
  if (validationFailed && !fatalFailure) {
    fatalFailure = failureRecord(
      "archive",
      runError(
        "Archive verification failed; see validation results.",
        "ARCHIVE_VERIFICATION_FAILED",
      ),
    );
  }
  if (stopReason === "maximum-failures" && !fatalFailure) {
    fatalFailure = failureRecord(
      "archive",
      runError(`Stopped after ${failures.length} artwork failures.`, "MAX_FAILURES_REACHED"),
    );
  }

  const finishedAt = new Date();
  const intentionalStop = stopReason === null || stopReason === "limit";
  const ok = !fatalFailure && failures.length === 0 && intentionalStop && !validationFailed;
  const complete = ok && sourceComplete && stopReason === null;
  const pinnedChecksPassed = [
    validations.sourceByteLength,
    validations.sourceSha256,
    validations.artworkCount,
  ].every((result) => result.checked && result.matches);
  return {
    version: 1,
    ok,
    complete,
    publishable: complete && !options.dryRun && pinnedChecksPassed,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    mode: options.dryRun ? "dry-run" : "upload",
    snapshotId: options.snapshotId,
    stopReason,
    source: {
      kind: source.kind,
      label: source.label,
      advertisedByteLength: source.byteLength,
      actualByteLength: sourceComplete ? reader.sourceBytesRead : null,
      sha256: sourceSha256,
    },
    manifest: {
      label: manifest.label,
      byteLength: manifest.byteLength,
      sha256: manifest.sha256,
      rows: manifest.rowCount,
      eligible: manifest.eligibleCount,
      ineligible: manifest.ineligibleCount,
    },
    target: options.dryRun
      ? null
      : {
          bucket: options.bucket,
          endpoint: options.endpoint,
          snapshotId: options.snapshotId,
          cacheControl: options.cacheControl,
        },
    counts,
    bytes,
    validations,
    failures,
    fatalFailure,
  };
}

class TaskPool {
  constructor(limit) {
    this.limit = limit;
    this.active = new Set();
  }

  async waitForSlot() {
    if (this.active.size >= this.limit) await Promise.race(this.active);
  }

  run(task) {
    const pending = Promise.resolve().then(task);
    this.active.add(pending);
    pending.finally(() => this.active.delete(pending));
  }

  async drain() {
    await Promise.all(this.active);
  }
}

function validateEntrySize(entry, options) {
  if (entry.byteLength <= 0) return runError(`${entry.path} is empty.`, "EMPTY_ARTWORK");
  if (entry.byteLength > options.maximumEntryBytes) {
    return runError(
      `${entry.path} expands to ${entry.byteLength} bytes; limit is ${options.maximumEntryBytes}.`,
      "ENTRY_TOO_LARGE",
    );
  }
  if (entry.compressedByteLength > options.maximumEntryBytes) {
    return runError(
      `${entry.path} has ${entry.compressedByteLength} compressed bytes; limit is ${options.maximumEntryBytes}.`,
      "ENTRY_TOO_LARGE",
    );
  }
  if (
    entry.compressedByteLength === 0 ||
    entry.byteLength / entry.compressedByteLength > options.maximumCompressionRatio
  ) {
    return runError(
      `${entry.path} has a suspicious decompression ratio.`,
      "SUSPICIOUS_COMPRESSION_RATIO",
    );
  }
  return null;
}

function recordFailure(failures, counts, key, error) {
  failures.push(failureRecord(key, error));
  counts.failed += 1;
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

function reportProgress({ counts, bytes, onProgress, progressEvery }) {
  const settled =
    counts.uploaded +
    counts.reused +
    counts.checkpointSkipped +
    counts.dryRunValidated +
    counts.failed;
  if (settled > 0 && settled % progressEvery === 0) {
    onProgress({ settled, counts: { ...counts }, bytes: { ...bytes } });
  }
}

function validationResult(checked, actual, expected) {
  return {
    checked,
    actual,
    expected,
    matches: checked ? actual === expected : null,
  };
}

function runError(message, code) {
  const error = new ZipFormatError(message, code);
  return error;
}
