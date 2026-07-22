import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { locateCentralDirectoryFromTail, parseZipCentralDirectory } from "./artwork.mjs";
import { invariant, sha256Bytes, sortNumbers } from "./util.mjs";

const INVENTORY_FORMAT_VERSION = 1;
const INVENTORY_KIND = "poapin-remote-artwork-inventory";
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 128 * 1024;
const DEFAULT_RANGE_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CRC32_PATTERN = /^[0-9a-f]{8}$/;

export const OFFICIAL_ARCHIVE_POLICY = Object.freeze({
  id: "poaparchive-2026-07-02-v1",
  snapshotId: "2026-07-02-v1",
  archiveUrl: "https://downloads.poaparchive.com/archive.zip",
  byteLength: 15_839_405_768,
  expectedArchiveSha256: "046850de3bd4b3c6aa75c33c4a1a589b4ab176aacdd5986c1a824df803c07633",
  expectedEtag: '"ad5592b151e29e144d63ead19515f22c-152"',
  centralDirectory: Object.freeze({
    zip64: true,
    offset: 15_832_217_678,
    byteLength: 7_187_992,
    entryCount: 73_797,
    sha256: "812151165d901386a5da0a82a65fc773241bd660e5acc8a89189b5510100b2cc",
  }),
  artworkCount: 73_795,
  unexpectedEntryCount: 2,
  // Pinned to the canonical NDJSON-like serialization produced by
  // artworkEntriesSha256(). It protects importer consumption from a modified
  // inventory even though the whole 15.8 GB body is not read by this workflow.
  artworkEntriesSha256: "eb347f8c1980d5d1de1564dbcdf69d9e5ca8dafeb2f3ba610d4789ea796c065f",
});

export async function inventoryRemoteArchive({
  fetchImpl = globalThis.fetch,
  policy = OFFICIAL_ARCHIVE_POLICY,
  tailByteLength = DEFAULT_TAIL_BYTES,
  rangeByteLength = DEFAULT_RANGE_BYTES,
  signal,
} = {}) {
  validatePolicy(policy);
  invariant(typeof fetchImpl === "function", "A Fetch-compatible implementation is required.");
  invariant(
    Number.isSafeInteger(tailByteLength) && tailByteLength >= 128,
    "tailByteLength must be at least 128 bytes.",
  );
  invariant(
    Number.isSafeInteger(rangeByteLength) && rangeByteLength > 0,
    "rangeByteLength must be positive.",
  );
  const requestSignal = signal ?? AbortSignal.timeout(120_000);

  const tailLength = Math.min(policy.byteLength, tailByteLength);
  const tailStart = policy.byteLength - tailLength;
  const tailResponse = await fetchStrictRange({
    fetchImpl,
    url: policy.archiveUrl,
    start: tailStart,
    end: policy.byteLength - 1,
    expectedTotal: policy.byteLength,
    expectedEtag: policy.expectedEtag,
    signal: requestSignal,
  });
  const directory = locateCentralDirectoryFromTail(tailResponse.bytes, {
    fileSize: policy.byteLength,
    tailOffset: tailStart,
  });
  invariant(directory.zip64 === policy.centralDirectory.zip64, "Unexpected ZIP64 mode.");
  invariant(
    directory.offset === policy.centralDirectory.offset,
    `Central directory offset changed: ${directory.offset}.`,
  );
  invariant(
    directory.size === policy.centralDirectory.byteLength,
    `Central directory byte length changed: ${directory.size}.`,
  );
  invariant(
    directory.entryCount === policy.centralDirectory.entryCount,
    `Central directory entry count changed: ${directory.entryCount}.`,
  );
  invariant(
    directory.size <= MAX_CENTRAL_DIRECTORY_BYTES,
    `Central directory exceeds ${MAX_CENTRAL_DIRECTORY_BYTES} bytes.`,
  );

  const centralChunks = [];
  let centralBytesRead = 0;
  let requestCount = 1;
  let responseEtag = tailResponse.etag;
  let lastModified = tailResponse.lastModified;
  for (let start = directory.offset; start < directory.offset + directory.size;) {
    const end = Math.min(start + rangeByteLength - 1, directory.offset + directory.size - 1);
    const response = await fetchStrictRange({
      fetchImpl,
      url: policy.archiveUrl,
      start,
      end,
      expectedTotal: policy.byteLength,
      expectedEtag: policy.expectedEtag,
      signal: requestSignal,
    });
    invariant(
      !responseEtag || !response.etag || responseEtag === response.etag,
      "Archive ETag changed between Range responses.",
    );
    invariant(
      !lastModified || !response.lastModified || lastModified === response.lastModified,
      "Archive Last-Modified changed between Range responses.",
    );
    responseEtag ??= response.etag;
    lastModified ??= response.lastModified;
    centralChunks.push(response.bytes);
    centralBytesRead += response.bytes.length;
    requestCount += 1;
    start = end + 1;
  }
  invariant(centralBytesRead === directory.size, "Central directory Range reads are incomplete.");
  const centralDirectory = Buffer.concat(centralChunks, directory.size);
  const centralSha256 = sha256Bytes(centralDirectory);
  invariant(
    centralSha256 === policy.centralDirectory.sha256,
    `Central directory SHA-256 mismatch: ${centralSha256}.`,
  );

  const parsed = parseZipCentralDirectory(centralDirectory, {
    entryCount: directory.entryCount,
  });
  validateCentralQuality(parsed.quality, policy);
  invariant(
    parsed.entries.size === policy.artworkCount,
    `Artwork count changed: ${parsed.entries.size}.`,
  );
  const entries = toInventoryEntries(parsed.entries);
  const entriesSha256 = artworkEntriesSha256(entries);
  invariant(
    entriesSha256 === policy.artworkEntriesSha256,
    `Artwork inventory SHA-256 mismatch: ${entriesSha256}.`,
  );

  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    kind: INVENTORY_KIND,
    policyId: policy.id,
    snapshotId: policy.snapshotId,
    source: {
      url: policy.archiveUrl,
      byteLength: policy.byteLength,
      etag: responseEtag,
      lastModified,
    },
    verification: {
      acquisition: {
        method: "http-range",
        requestCount,
        byteLength: tailResponse.bytes.length + centralBytesRead,
      },
      centralDirectory: {
        status: "verified",
        zip64: directory.zip64,
        offset: directory.offset,
        byteLength: directory.size,
        entryCount: directory.entryCount,
        expectedSha256: policy.centralDirectory.sha256,
        measuredSha256: centralSha256,
        matchesExpected: true,
      },
      wholeArchiveSha256: {
        status: "not-measured",
        expectedSha256: policy.expectedArchiveSha256,
        measuredSha256: null,
        matchesExpected: null,
        reason: "HTTP Range inventory does not read every archive byte.",
      },
    },
    artwork: {
      count: entries.length,
      entriesSha256,
      entries,
    },
    quality: parsed.quality,
  };
}

export async function loadArtworkInventory(filePath, { policy = OFFICIAL_ARCHIVE_POLICY } = {}) {
  validatePolicy(policy);
  const absolutePath = resolve(filePath);
  const fileStat = await stat(absolutePath);
  invariant(fileStat.isFile(), `Expected an artwork inventory file: ${filePath}`);
  invariant(
    fileStat.size > 0 && fileStat.size <= MAX_INVENTORY_BYTES,
    `Artwork inventory must be between 1 and ${MAX_INVENTORY_BYTES} bytes.`,
  );
  const bytes = await readFile(absolutePath);
  let inventory;
  try {
    inventory = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Artwork inventory is not valid JSON.", { cause: error });
  }
  validateInventoryDocument(inventory);

  validateInventoryAgainstPolicy(inventory, policy);
  const entries = new Map();
  let previousDropId = 0;
  for (const rawEntry of inventory.artwork.entries) {
    const entry = normalizeInventoryEntry(rawEntry);
    invariant(entry.dropId > previousDropId, "Artwork inventory entries must be uniquely sorted.");
    previousDropId = entry.dropId;
    entries.set(entry.dropId, {
      dropId: entry.dropId,
      source: {
        kind: "zip",
        path: entry.path,
        byteLength: entry.byteLength,
        compressedByteLength: entry.compressedByteLength,
        compressionMethod: entry.compressionMethod,
        crc32: entry.crc32,
      },
    });
  }
  const measuredEntriesSha256 = artworkEntriesSha256(inventory.artwork.entries);
  invariant(
    measuredEntriesSha256 === inventory.artwork.entriesSha256,
    "Artwork entries digest does not match the inventory.",
  );

  return {
    source: {
      kind: "inventory",
      name: basename(absolutePath),
      snapshotId: inventory.snapshotId,
      inventorySha256: sha256Bytes(bytes),
      archiveUrl: inventory.source.url,
      byteLength: inventory.source.byteLength,
      expectedSha256: inventory.verification.wholeArchiveSha256.expectedSha256,
      measuredSha256: inventory.verification.wholeArchiveSha256.measuredSha256,
      wholeArchiveSha256Status: inventory.verification.wholeArchiveSha256.status,
      centralDirectory: inventory.verification.centralDirectory,
    },
    entries,
    quality: inventory.quality,
  };
}

export function artworkEntriesSha256(entries) {
  const hash = createHash("sha256");
  const normalizedEntries = entries instanceof Map ? toInventoryEntries(entries) : entries;
  for (const rawEntry of normalizedEntries) {
    const entry = normalizeInventoryEntry(rawEntry);
    hash.update(`${JSON.stringify(entry)}\n`);
  }
  return hash.digest("hex");
}

function toInventoryEntries(entries) {
  return sortNumbers(entries.keys()).map((dropId) => {
    const source = entries.get(dropId).source;
    return normalizeInventoryEntry({
      dropId,
      path: source.path,
      byteLength: source.byteLength,
      compressedByteLength: source.compressedByteLength,
      compressionMethod: source.compressionMethod,
      crc32: source.crc32,
    });
  });
}

function normalizeInventoryEntry(entry) {
  invariant(entry && typeof entry === "object" && !Array.isArray(entry), "Invalid artwork entry.");
  invariant(Number.isSafeInteger(entry.dropId) && entry.dropId > 0, "Invalid artwork drop id.");
  invariant(entry.path === `artwork/${entry.dropId}.webp`, "Artwork path does not match drop id.");
  invariant(
    Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0,
    `Artwork ${entry.dropId} has an invalid byte length.`,
  );
  invariant(
    Number.isSafeInteger(entry.compressedByteLength) && entry.compressedByteLength > 0,
    `Artwork ${entry.dropId} has an invalid compressed byte length.`,
  );
  invariant(
    entry.compressionMethod === 0 || entry.compressionMethod === 8,
    `Artwork ${entry.dropId} uses unsupported ZIP compression.`,
  );
  invariant(CRC32_PATTERN.test(entry.crc32), `Artwork ${entry.dropId} has an invalid CRC-32.`);
  return {
    dropId: entry.dropId,
    path: entry.path,
    byteLength: entry.byteLength,
    compressedByteLength: entry.compressedByteLength,
    compressionMethod: entry.compressionMethod,
    crc32: entry.crc32,
  };
}

async function fetchStrictRange({
  fetchImpl,
  url,
  start,
  end,
  expectedTotal,
  expectedEtag,
  signal,
}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/zip",
      "Accept-Encoding": "identity",
      Range: `bytes=${start}-${end}`,
    },
    redirect: "error",
    signal,
  });
  invariant(response.status === 206, `Archive Range request returned HTTP ${response.status}.`);
  const contentEncoding = response.headers.get("content-encoding");
  invariant(
    !contentEncoding || contentEncoding.toLowerCase() === "identity",
    `Archive Range response used Content-Encoding ${contentEncoding}.`,
  );
  const contentRange = response.headers.get("content-range");
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(contentRange ?? "");
  invariant(match, "Archive Range response has an invalid Content-Range header.");
  invariant(
    Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === expectedTotal,
    `Archive Content-Range did not match bytes=${start}-${end}/${expectedTotal}.`,
  );
  const expectedLength = end - start + 1;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    invariant(Number(contentLength) === expectedLength, "Archive Content-Length is incorrect.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(bytes.length === expectedLength, "Archive Range body length is incorrect.");
  const etag = response.headers.get("etag");
  if (expectedEtag)
    invariant(etag === expectedEtag, `Archive ETag changed: ${etag ?? "<missing>"}.`);
  return {
    bytes,
    etag,
    lastModified: response.headers.get("last-modified"),
  };
}

function validateInventoryDocument(inventory) {
  invariant(
    inventory?.formatVersion === INVENTORY_FORMAT_VERSION,
    "Unsupported artwork inventory format.",
  );
  invariant(inventory.kind === INVENTORY_KIND, "Unexpected artwork inventory kind.");
  invariant(
    typeof inventory.policyId === "string" && inventory.policyId.length > 0,
    "Inventory policy id is missing.",
  );
  invariant(
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(inventory.snapshotId),
    "Inventory snapshot id is invalid.",
  );
  invariant(typeof inventory.source?.url === "string", "Inventory source URL is missing.");
  const sourceUrl = new URL(inventory.source.url);
  invariant(
    sourceUrl.protocol === "https:" || sourceUrl.hostname === "127.0.0.1",
    "Inventory source URL must use HTTPS.",
  );
  invariant(
    Number.isSafeInteger(inventory.source.byteLength) && inventory.source.byteLength > 0,
    "Inventory source byte length is invalid.",
  );
  const acquisition = inventory.verification?.acquisition;
  invariant(acquisition?.method === "http-range", "Inventory acquisition method is invalid.");
  invariant(
    Number.isSafeInteger(acquisition.requestCount) && acquisition.requestCount > 0,
    "Inventory Range request count is invalid.",
  );
  invariant(
    Number.isSafeInteger(acquisition.byteLength) &&
      acquisition.byteLength > 0 &&
      acquisition.byteLength < inventory.source.byteLength,
    "Inventory Range byte count must be smaller than the whole archive.",
  );
  const central = inventory.verification?.centralDirectory;
  invariant(
    central?.status === "verified" && central.matchesExpected === true,
    "Central directory is not verified.",
  );
  invariant(
    SHA256_PATTERN.test(central.expectedSha256),
    "Central directory expected digest is invalid.",
  );
  invariant(
    central.measuredSha256 === central.expectedSha256,
    "Central directory digest mismatch.",
  );
  invariant(typeof central.zip64 === "boolean", "Central directory ZIP64 flag is invalid.");
  invariant(
    Number.isSafeInteger(central.offset) && central.offset >= 0,
    "Central directory offset is invalid.",
  );
  invariant(
    Number.isSafeInteger(central.byteLength) && central.byteLength > 0,
    "Central directory byte length is invalid.",
  );
  invariant(
    Number.isSafeInteger(central.entryCount) && central.entryCount > 0,
    "Central directory entry count is invalid.",
  );
  invariant(
    central.offset + central.byteLength <= inventory.source.byteLength,
    "Central directory lies outside the archive.",
  );
  const whole = inventory.verification?.wholeArchiveSha256;
  invariant(
    SHA256_PATTERN.test(whole?.expectedSha256),
    "Expected whole-archive digest is invalid.",
  );
  if (whole.status === "not-measured") {
    invariant(
      whole.measuredSha256 === null && whole.matchesExpected === null,
      "Unmeasured archive claims verification.",
    );
  } else if (whole.status === "verified") {
    invariant(
      whole.measuredSha256 === whole.expectedSha256 && whole.matchesExpected === true,
      "Whole-archive verification is inconsistent.",
    );
  } else {
    throw new Error(`Unsupported whole-archive verification status: ${whole.status}.`);
  }
  invariant(Array.isArray(inventory.artwork?.entries), "Artwork inventory entries are missing.");
  invariant(
    inventory.artwork.count === inventory.artwork.entries.length,
    "Artwork inventory count is inconsistent.",
  );
  invariant(
    Number.isSafeInteger(inventory.artwork.count) &&
      inventory.artwork.count > 0 &&
      inventory.artwork.count <= central.entryCount,
    "Artwork inventory count is invalid.",
  );
  invariant(
    SHA256_PATTERN.test(inventory.artwork.entriesSha256),
    "Artwork entries digest is invalid.",
  );
  validateCentralQuality(inventory.quality, {
    unexpectedEntryCount: inventory.quality?.unexpectedEntries,
  });
}

function validateInventoryAgainstPolicy(inventory, policy) {
  invariant(inventory.policyId === policy.id, "Archive inventory policy id changed.");
  invariant(inventory.snapshotId === policy.snapshotId, "Archive inventory snapshot id changed.");
  invariant(inventory.source.url === policy.archiveUrl, "Archive inventory source URL changed.");
  invariant(
    inventory.source.byteLength === policy.byteLength,
    "Archive inventory byte length changed.",
  );
  if (policy.expectedEtag) {
    invariant(inventory.source.etag === policy.expectedEtag, "Archive inventory ETag changed.");
  }
  invariant(
    inventory.verification.centralDirectory.zip64 === policy.centralDirectory.zip64 &&
      inventory.verification.centralDirectory.offset === policy.centralDirectory.offset &&
      inventory.verification.centralDirectory.byteLength === policy.centralDirectory.byteLength &&
      inventory.verification.centralDirectory.entryCount === policy.centralDirectory.entryCount &&
      inventory.verification.centralDirectory.measuredSha256 === policy.centralDirectory.sha256,
    "Archive inventory central directory does not match the pinned policy.",
  );
  invariant(
    inventory.verification.wholeArchiveSha256.expectedSha256 === policy.expectedArchiveSha256,
    "Whole-archive expected digest changed.",
  );
  invariant(inventory.artwork.count === policy.artworkCount, "Archive artwork count changed.");
  invariant(
    inventory.artwork.entriesSha256 === policy.artworkEntriesSha256,
    "Archive artwork entries digest changed.",
  );
  validateCentralQuality(inventory.quality, policy);
}

function validateCentralQuality(quality, policy) {
  invariant(quality && typeof quality === "object", "ZIP quality report is missing.");
  invariant(
    Array.isArray(quality.duplicateDropIds) && quality.duplicateDropIds.length === 0,
    "Duplicate artwork ids found.",
  );
  invariant(quality.encryptedEntries === 0, "Encrypted ZIP entries found.");
  invariant(quality.symlinkEntries === 0, "ZIP symlink entries found.");
  invariant(
    Array.isArray(quality.unsafePaths) && quality.unsafePaths.length === 0,
    "Unsafe ZIP paths found.",
  );
  invariant(
    Number.isSafeInteger(quality.unexpectedEntries) && quality.unexpectedEntries >= 0,
    "Unexpected ZIP entry count is invalid.",
  );
  invariant(
    quality.unexpectedEntries === policy.unexpectedEntryCount,
    `Unexpected ZIP entry count changed: ${quality.unexpectedEntries}.`,
  );
  invariant(
    Array.isArray(quality.invalidWebpSignatures) && quality.invalidWebpSignatures.length === 0,
    "Invalid WebP signatures are recorded.",
  );
}

function validatePolicy(policy) {
  invariant(
    typeof policy?.id === "string" && policy.id.length > 0,
    "Archive policy id is missing.",
  );
  invariant(typeof policy.snapshotId === "string", "Archive policy snapshot id is missing.");
  const url = new URL(policy.archiveUrl);
  invariant(
    url.protocol === "https:" || url.hostname === "127.0.0.1",
    "Archive policy URL must use HTTPS.",
  );
  invariant(
    Number.isSafeInteger(policy.byteLength) && policy.byteLength > 0,
    "Archive policy byte length is invalid.",
  );
  invariant(SHA256_PATTERN.test(policy.expectedArchiveSha256), "Archive policy digest is invalid.");
  invariant(
    policy.centralDirectory && SHA256_PATTERN.test(policy.centralDirectory.sha256),
    "Central directory policy is invalid.",
  );
  invariant(
    typeof policy.centralDirectory.zip64 === "boolean" &&
      Number.isSafeInteger(policy.centralDirectory.offset) &&
      policy.centralDirectory.offset >= 0 &&
      Number.isSafeInteger(policy.centralDirectory.byteLength) &&
      policy.centralDirectory.byteLength > 0 &&
      Number.isSafeInteger(policy.centralDirectory.entryCount) &&
      policy.centralDirectory.entryCount > 0 &&
      policy.centralDirectory.offset + policy.centralDirectory.byteLength <= policy.byteLength,
    "Central directory policy bounds are invalid.",
  );
  invariant(
    Number.isSafeInteger(policy.artworkCount) &&
      policy.artworkCount > 0 &&
      policy.artworkCount <= policy.centralDirectory.entryCount,
    "Archive policy artwork count is invalid.",
  );
  invariant(
    Number.isSafeInteger(policy.unexpectedEntryCount) && policy.unexpectedEntryCount >= 0,
    "Archive policy unexpected entry count is invalid.",
  );
  if (policy.expectedEtag !== null && policy.expectedEtag !== undefined) {
    invariant(
      typeof policy.expectedEtag === "string" && policy.expectedEtag.length > 0,
      "Archive policy ETag is invalid.",
    );
  }
  invariant(
    SHA256_PATTERN.test(policy.artworkEntriesSha256),
    "Artwork entries policy digest is invalid.",
  );
}
