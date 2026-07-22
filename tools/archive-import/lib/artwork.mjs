import { opendir, open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  describeFile,
  invariant,
  isUnsafeArchivePath,
  sha256Bytes,
  sha256File,
  sortNumbers,
  toPosixPath,
} from "./util.mjs";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP64_EXTRA_ID = 0x0001;
const ARTWORK_PATH_PATTERN = /^artwork\/([1-9][0-9]*)\.webp$/;
const ARTWORK_FILE_PATTERN = /^([1-9][0-9]*)\.webp$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export async function inventoryArtwork({
  archivePath,
  artworkDirectory,
  artworkInventoryPath,
  artworkInventoryPolicy,
  hashArtworkFiles = true,
}) {
  invariant(
    [archivePath, artworkDirectory, artworkInventoryPath].filter(Boolean).length <= 1,
    "Use only one artwork input.",
  );
  if (archivePath) return inventoryZipArtwork(archivePath);
  if (artworkDirectory) return inventoryDirectoryArtwork(artworkDirectory, { hashArtworkFiles });
  if (artworkInventoryPath) {
    const { loadArtworkInventory } = await import("./archive-inventory.mjs");
    return loadArtworkInventory(artworkInventoryPath, {
      ...(artworkInventoryPolicy ? { policy: artworkInventoryPolicy } : {}),
    });
  }
  return {
    source: { kind: "none" },
    entries: new Map(),
    quality: {
      duplicateDropIds: [],
      encryptedEntries: 0,
      symlinkEntries: 0,
      unsafePaths: [],
      unexpectedEntries: 0,
      invalidWebpSignatures: [],
    },
  };
}

export async function inventoryDirectoryArtwork(directoryPath, { hashArtworkFiles = true } = {}) {
  const directoryStat = await stat(directoryPath);
  invariant(directoryStat.isDirectory(), `Expected an artwork directory: ${directoryPath}`);
  const candidates = [];
  const quality = emptyQuality();
  const directory = await opendir(directoryPath);

  for await (const entry of directory) {
    if (entry.isSymbolicLink()) {
      quality.symlinkEntries += 1;
      continue;
    }
    if (!entry.isFile()) {
      quality.unexpectedEntries += 1;
      continue;
    }
    const match = ARTWORK_FILE_PATTERN.exec(entry.name);
    if (!match) {
      quality.unexpectedEntries += 1;
      continue;
    }
    const dropId = Number(match[1]);
    if (!Number.isSafeInteger(dropId)) {
      quality.unexpectedEntries += 1;
      continue;
    }
    candidates.push({ dropId, name: entry.name, filePath: resolve(directoryPath, entry.name) });
  }

  candidates.sort(
    (left, right) => left.dropId - right.dropId || left.name.localeCompare(right.name, "en"),
  );
  const entries = new Map();
  for (const candidate of candidates) {
    if (entries.has(candidate.dropId)) {
      quality.duplicateDropIds.push(candidate.dropId);
      continue;
    }
    const artworkHandle = await open(candidate.filePath, "r");
    const header = Buffer.alloc(12);
    const { bytesRead } = await artworkHandle.read(header, 0, header.length, 0);
    await artworkHandle.close();
    const isWebp =
      bytesRead >= 12 &&
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP";
    if (!isWebp) quality.invalidWebpSignatures.push(candidate.dropId);
    const description = await describeFile(candidate.filePath, { includeHash: hashArtworkFiles });
    entries.set(candidate.dropId, {
      dropId: candidate.dropId,
      source: {
        kind: "directory",
        path: candidate.name,
        byteLength: description.byteLength,
        ...(description.sha256 ? { sha256: description.sha256 } : {}),
      },
    });
  }

  quality.duplicateDropIds = sortNumbers(new Set(quality.duplicateDropIds));
  quality.invalidWebpSignatures = sortNumbers(new Set(quality.invalidWebpSignatures));
  return {
    source: {
      kind: "directory",
      name: basename(resolve(directoryPath)),
      contentDigestsIncluded: hashArtworkFiles,
    },
    entries,
    quality,
  };
}

export async function inventoryZipArtwork(archivePath, { includeArchiveHash = true } = {}) {
  const archiveStat = await stat(archivePath);
  invariant(archiveStat.isFile(), `Expected an archive file: ${archivePath}`);
  const handle = await open(archivePath, "r");
  let parsed;
  let archive;

  try {
    const directory = await locateCentralDirectory(handle, archiveStat.size);
    const centralDirectory = await readExactly(handle, directory.offset, directory.size);
    parsed = parseZipCentralDirectory(centralDirectory, { entryCount: directory.entryCount });
    archive = {
      kind: "zip",
      name: basename(archivePath),
      byteLength: archiveStat.size,
      ...(includeArchiveHash ? { sha256: await sha256File(archivePath) } : {}),
      centralDirectoryEntries: directory.entryCount,
      centralDirectory: {
        offset: directory.offset,
        byteLength: directory.size,
        sha256: sha256Bytes(centralDirectory),
        zip64: directory.zip64,
      },
    };
  } finally {
    await handle.close();
  }
  return { source: archive, entries: parsed.entries, quality: parsed.quality };
}

export function parseZipCentralDirectory(buffer, { entryCount }) {
  invariant(Buffer.isBuffer(buffer), "ZIP central directory must be a Buffer.");
  invariant(Number.isSafeInteger(entryCount) && entryCount >= 0, "Invalid ZIP entry count.");
  const entries = new Map();
  const quality = emptyQuality();
  const reader = new BufferReader(buffer);
  let parsedEntries = 0;
  while (reader.remaining > 0 && parsedEntries < entryCount) {
    const fixed = reader.read(46);
    invariant(
      fixed.readUInt32LE(0) === CENTRAL_FILE_SIGNATURE,
      `Invalid ZIP central directory entry ${parsedEntries}.`,
    );
    const flags = fixed.readUInt16LE(8);
    const compressionMethod = fixed.readUInt16LE(10);
    const crc32 = fixed.readUInt32LE(16);
    const compressed32 = fixed.readUInt32LE(20);
    const uncompressed32 = fixed.readUInt32LE(24);
    const nameLength = fixed.readUInt16LE(28);
    const extraLength = fixed.readUInt16LE(30);
    const commentLength = fixed.readUInt16LE(32);
    const diskStart32 = fixed.readUInt16LE(34);
    const externalAttributes = fixed.readUInt32LE(38);
    const localOffset32 = fixed.readUInt32LE(42);
    const nameBuffer = reader.read(nameLength);
    const extra = reader.read(extraLength);
    reader.skip(commentLength);
    parsedEntries += 1;

    const name = decodeZipName(nameBuffer, flags);
    if (isUnsafeArchivePath(name)) quality.unsafePaths.push(name);
    if ((flags & 0x1) !== 0) quality.encryptedEntries += 1;
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) quality.symlinkEntries += 1;

    const zip64 = parseZip64Extra(extra, {
      uncompressed: uncompressed32 === 0xffffffff,
      compressed: compressed32 === 0xffffffff,
      localOffset: localOffset32 === 0xffffffff,
      diskStart: diskStart32 === 0xffff,
    });
    const diskStart =
      diskStart32 === 0xffff ? safeZipNumber(zip64.diskStart, `${name} disk start`) : diskStart32;
    invariant(diskStart === 0, `ZIP entry ${name} starts on another disk.`);
    if (localOffset32 === 0xffffffff) {
      safeZipNumber(zip64.localOffset, `${name} local header offset`);
    }
    const compressedByteLength =
      compressed32 === 0xffffffff
        ? safeZipNumber(zip64.compressed, `${name} compressed size`)
        : compressed32;
    const byteLength =
      uncompressed32 === 0xffffffff
        ? safeZipNumber(zip64.uncompressed, `${name} uncompressed size`)
        : uncompressed32;

    const normalizedName = toPosixPath(name);
    const match = ARTWORK_PATH_PATTERN.exec(normalizedName);
    if (!match) {
      quality.unexpectedEntries += 1;
      continue;
    }
    const dropId = Number(match[1]);
    invariant(Number.isSafeInteger(dropId), `Unsafe artwork drop id: ${match[1]}`);
    if (entries.has(dropId)) {
      quality.duplicateDropIds.push(dropId);
      continue;
    }
    entries.set(dropId, {
      dropId,
      source: {
        kind: "zip",
        path: normalizedName,
        byteLength,
        compressedByteLength,
        compressionMethod,
        crc32: crc32.toString(16).padStart(8, "0"),
      },
    });
  }
  invariant(
    parsedEntries === entryCount,
    `Expected ${entryCount} ZIP entries, parsed ${parsedEntries}.`,
  );
  invariant(reader.remaining === 0, `ZIP central directory has ${reader.remaining} unread bytes.`);
  quality.duplicateDropIds = sortNumbers(new Set(quality.duplicateDropIds));
  quality.unsafePaths.sort((left, right) => left.localeCompare(right, "en"));
  return { entries, quality };
}

function emptyQuality() {
  return {
    duplicateDropIds: [],
    encryptedEntries: 0,
    symlinkEntries: 0,
    unsafePaths: [],
    unexpectedEntries: 0,
    invalidWebpSignatures: [],
  };
}

async function locateCentralDirectory(handle, fileSize) {
  invariant(fileSize >= 22, "ZIP file is too small.");
  const tailLength = Math.min(fileSize, 22 + 65_535 + 20 + 56);
  const tailOffset = fileSize - tailLength;
  const tail = await readExactly(handle, tailOffset, tailLength);
  return locateCentralDirectoryFromTail(tail, { fileSize, tailOffset });
}

export function locateCentralDirectoryFromTail(tail, { fileSize, tailOffset }) {
  invariant(Buffer.isBuffer(tail), "ZIP tail must be a Buffer.");
  invariant(Number.isSafeInteger(fileSize) && fileSize >= 22, "ZIP file size is invalid.");
  invariant(
    Number.isSafeInteger(tailOffset) && tailOffset >= 0 && tailOffset + tail.length === fileSize,
    "ZIP tail range does not end at the declared file size.",
  );
  let relativeEocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === EOCD_SIGNATURE &&
      offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
    ) {
      relativeEocd = offset;
      break;
    }
  }
  invariant(relativeEocd >= 0, "ZIP end-of-central-directory record was not found.");
  const eocdOffset = tailOffset + relativeEocd;
  const eocd = tail.subarray(relativeEocd);
  const diskNumber = eocd.readUInt16LE(4);
  const directoryDisk = eocd.readUInt16LE(6);
  const entriesOnDisk16 = eocd.readUInt16LE(8);
  const entryCount16 = eocd.readUInt16LE(10);
  const directorySize32 = eocd.readUInt32LE(12);
  const directoryOffset32 = eocd.readUInt32LE(16);

  invariant(diskNumber === 0 && directoryDisk === 0, "Multi-disk ZIP archives are unsupported.");
  if (
    entryCount16 !== 0xffff &&
    directorySize32 !== 0xffffffff &&
    directoryOffset32 !== 0xffffffff
  ) {
    invariant(entriesOnDisk16 === entryCount16, "ZIP entry counts differ across disks.");
    return {
      entryCount: entryCount16,
      size: directorySize32,
      offset: directoryOffset32,
      zip64: false,
    };
  }

  invariant(eocdOffset >= 20, "ZIP64 locator is missing.");
  const relativeLocator = relativeEocd - 20;
  invariant(relativeLocator >= 0, "ZIP64 locator is outside the fetched tail.");
  const locator = tail.subarray(relativeLocator, relativeLocator + 20);
  invariant(
    locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE,
    "ZIP64 locator signature is invalid.",
  );
  invariant(locator.readUInt32LE(4) === 0, "ZIP64 central directory is on another disk.");
  invariant(locator.readUInt32LE(16) === 1, "Multi-disk ZIP64 archives are unsupported.");
  const zip64Offset = safeZipNumber(locator.readBigUInt64LE(8), "ZIP64 end record offset");
  const relativeZip64 = zip64Offset - tailOffset;
  invariant(relativeZip64 >= 0, "ZIP64 end record is outside the fetched tail.");
  const zip64 = tail.subarray(relativeZip64, relativeZip64 + 56);
  invariant(zip64.length === 56, "ZIP64 end record is truncated.");
  invariant(
    zip64.readUInt32LE(0) === ZIP64_EOCD_SIGNATURE,
    "ZIP64 end record signature is invalid.",
  );
  invariant(zip64.readBigUInt64LE(4) >= 44n, "ZIP64 end record is too short.");
  invariant(
    zip64.readUInt32LE(16) === 0 && zip64.readUInt32LE(20) === 0,
    "Multi-disk ZIP64 archives are unsupported.",
  );
  const entriesOnDisk = safeZipNumber(zip64.readBigUInt64LE(24), "ZIP64 disk entry count");
  const entryCount = safeZipNumber(zip64.readBigUInt64LE(32), "ZIP64 entry count");
  invariant(entriesOnDisk === entryCount, "ZIP64 entry counts differ across disks.");
  return {
    entryCount,
    size: safeZipNumber(zip64.readBigUInt64LE(40), "ZIP64 central directory size"),
    offset: safeZipNumber(zip64.readBigUInt64LE(48), "ZIP64 central directory offset"),
    zip64: true,
  };
}

function parseZip64Extra(buffer, required) {
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const id = buffer.readUInt16LE(offset);
    const size = buffer.readUInt16LE(offset + 2);
    const data = buffer.subarray(offset + 4, offset + 4 + size);
    invariant(data.length === size, "Truncated ZIP extra field.");
    if (id === ZIP64_EXTRA_ID) {
      let cursor = 0;
      const result = {};
      for (const [key, needed, byteLength] of [
        ["uncompressed", required.uncompressed, 8],
        ["compressed", required.compressed, 8],
        ["localOffset", required.localOffset, 8],
        ["diskStart", required.diskStart, 4],
      ]) {
        if (!needed) continue;
        invariant(cursor + byteLength <= data.length, "Truncated ZIP64 extra field.");
        result[key] =
          byteLength === 8 ? data.readBigUInt64LE(cursor) : BigInt(data.readUInt32LE(cursor));
        cursor += byteLength;
      }
      return result;
    }
    offset += 4 + size;
  }
  invariant(!Object.values(required).some(Boolean), "Required ZIP64 extra field is missing.");
  return {};
}

function safeZipNumber(value, label) {
  invariant(
    typeof value === "bigint" && value <= MAX_SAFE_BIGINT,
    `${label} is too large for Node.js.`,
  );
  return Number(value);
}

function decodeZipName(buffer, flags) {
  return (flags & 0x800) !== 0 ? buffer.toString("utf8") : buffer.toString("latin1");
}

async function readExactly(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    invariant(bytesRead > 0, `Unexpected end of file at byte ${position + filled}.`);
    filled += bytesRead;
  }
  return buffer;
}

class BufferReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.position = 0;
  }

  get remaining() {
    return this.buffer.length - this.position;
  }

  read(length) {
    invariant(length <= this.remaining, "ZIP central directory is truncated.");
    const value = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }

  skip(length) {
    invariant(length <= this.remaining, "ZIP central directory is truncated.");
    this.position += length;
  }
}
