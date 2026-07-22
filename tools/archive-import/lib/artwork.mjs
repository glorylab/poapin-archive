import { opendir, open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  describeFile,
  invariant,
  isUnsafeArchivePath,
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

export async function inventoryArtwork({ archivePath, artworkDirectory, hashArtworkFiles = true }) {
  invariant(
    !(archivePath && artworkDirectory),
    "Use either --archive or --artwork-directory, not both.",
  );
  if (archivePath) return inventoryZipArtwork(archivePath);
  if (artworkDirectory) return inventoryDirectoryArtwork(artworkDirectory, { hashArtworkFiles });
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
  const entries = new Map();
  const quality = emptyQuality();
  let archive;

  try {
    const directory = await locateCentralDirectory(handle, archiveStat.size);
    const reader = new SequentialReader(handle, directory.offset, directory.size);
    let parsedEntries = 0;
    while (reader.remaining > 0 && parsedEntries < directory.entryCount) {
      const fixed = await reader.read(46);
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
      const nameBuffer = await reader.read(nameLength);
      const extra = await reader.read(extraLength);
      await reader.skip(commentLength);
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
      parsedEntries === directory.entryCount,
      `Expected ${directory.entryCount} ZIP entries, parsed ${parsedEntries}.`,
    );
    invariant(
      reader.remaining === 0,
      `ZIP central directory has ${reader.remaining} unread bytes.`,
    );
    archive = {
      kind: "zip",
      name: basename(archivePath),
      byteLength: archiveStat.size,
      ...(includeArchiveHash ? { sha256: await sha256File(archivePath) } : {}),
      centralDirectoryEntries: directory.entryCount,
    };
  } finally {
    await handle.close();
  }

  quality.duplicateDropIds = sortNumbers(new Set(quality.duplicateDropIds));
  quality.unsafePaths.sort((left, right) => left.localeCompare(right, "en"));
  return { source: archive, entries, quality };
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
  const tailLength = Math.min(fileSize, 22 + 65_535 + 20);
  const tailOffset = fileSize - tailLength;
  const tail = await readExactly(handle, tailOffset, tailLength);
  let relativeEocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      relativeEocd = offset;
      break;
    }
  }
  invariant(relativeEocd >= 0, "ZIP end-of-central-directory record was not found.");
  const eocdOffset = tailOffset + relativeEocd;
  const eocd = tail.subarray(relativeEocd);
  const entryCount16 = eocd.readUInt16LE(10);
  const directorySize32 = eocd.readUInt32LE(12);
  const directoryOffset32 = eocd.readUInt32LE(16);

  if (
    entryCount16 !== 0xffff &&
    directorySize32 !== 0xffffffff &&
    directoryOffset32 !== 0xffffffff
  ) {
    return { entryCount: entryCount16, size: directorySize32, offset: directoryOffset32 };
  }

  invariant(eocdOffset >= 20, "ZIP64 locator is missing.");
  const locator = await readExactly(handle, eocdOffset - 20, 20);
  invariant(
    locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE,
    "ZIP64 locator signature is invalid.",
  );
  const zip64Offset = safeZipNumber(locator.readBigUInt64LE(8), "ZIP64 end record offset");
  const zip64 = await readExactly(handle, zip64Offset, 56);
  invariant(
    zip64.readUInt32LE(0) === ZIP64_EOCD_SIGNATURE,
    "ZIP64 end record signature is invalid.",
  );
  return {
    entryCount: safeZipNumber(zip64.readBigUInt64LE(32), "ZIP64 entry count"),
    size: safeZipNumber(zip64.readBigUInt64LE(40), "ZIP64 central directory size"),
    offset: safeZipNumber(zip64.readBigUInt64LE(48), "ZIP64 central directory offset"),
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

class SequentialReader {
  constructor(handle, start, length) {
    this.handle = handle;
    this.position = start;
    this.remaining = length;
  }

  async read(length) {
    invariant(length <= this.remaining, "ZIP central directory is truncated.");
    const value = await readExactly(this.handle, this.position, length);
    this.position += length;
    this.remaining -= length;
    return value;
  }

  async skip(length) {
    invariant(length <= this.remaining, "ZIP central directory is truncated.");
    this.position += length;
    this.remaining -= length;
  }
}
