import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflateRawAsync = promisify(inflateRaw);

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class ZipFormatError extends Error {
  constructor(message, code = "INVALID_ZIP") {
    super(message);
    this.name = "ZipFormatError";
    this.code = code;
  }
}

/**
 * A bounded reader over a Node Readable. It deliberately understands only the
 * forward-only operations needed for ZIP local records, so a 15.8 GB archive
 * never needs to be materialized on disk or retained in memory.
 */
export class ZipStreamReader {
  #reader;
  #onChunk;
  #buffer = Buffer.alloc(0);
  #bufferOffset = 0;
  #ended = false;

  constructor(readable, { onChunk = null } = {}) {
    this.readable = readable;
    this.#reader = readable[Symbol.asyncIterator]();
    this.#onChunk = onChunk;
    this.sourceBytesRead = 0;
    this.entriesRead = 0;
    this.reachedCentralDirectory = false;
  }

  async nextEntry() {
    const signature = await this.#readExactly(4, { allowCleanEof: this.entriesRead > 0 });
    if (signature === null) return null;

    const signatureValue = signature.readUInt32LE(0);
    if (
      signatureValue === CENTRAL_FILE_SIGNATURE ||
      signatureValue === END_OF_CENTRAL_DIRECTORY_SIGNATURE ||
      signatureValue === ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      this.reachedCentralDirectory = true;
      return null;
    }
    if (signatureValue !== LOCAL_FILE_SIGNATURE) {
      throw new ZipFormatError(
        `Unexpected ZIP record signature 0x${signatureValue.toString(16).padStart(8, "0")}.`,
        "UNEXPECTED_ZIP_RECORD",
      );
    }

    const fixed = await this.#readExactly(26);
    const flags = fixed.readUInt16LE(2);
    const compressionMethod = fixed.readUInt16LE(4);
    const crc32 = fixed.readUInt32LE(10);
    const compressed32 = fixed.readUInt32LE(14);
    const uncompressed32 = fixed.readUInt32LE(18);
    const fileNameLength = fixed.readUInt16LE(22);
    const extraLength = fixed.readUInt16LE(24);

    if ((flags & 0x1) !== 0) {
      throw new ZipFormatError("Encrypted ZIP entries are not supported.", "ENCRYPTED_ENTRY");
    }
    if ((flags & 0x8) !== 0) {
      throw new ZipFormatError(
        "ZIP entries that use trailing data descriptors are not supported by the streaming uploader.",
        "DATA_DESCRIPTOR_UNSUPPORTED",
      );
    }

    const fileNameBuffer = await this.#readExactly(fileNameLength);
    const extra = await this.#readExactly(extraLength);
    const fileName = decodeFileName(fileNameBuffer, flags);
    assertSafeArchivePath(fileName);

    const zip64 = parseZip64Sizes(extra, {
      uncompressed: uncompressed32 === 0xffffffff,
      compressed: compressed32 === 0xffffffff,
    });
    const compressedByteLength =
      compressed32 === 0xffffffff
        ? toSafeNumber(zip64.compressed, `${fileName} compressed size`)
        : compressed32;
    const byteLength =
      uncompressed32 === 0xffffffff
        ? toSafeNumber(zip64.uncompressed, `${fileName} uncompressed size`)
        : uncompressed32;

    this.entriesRead += 1;
    return Object.freeze({
      path: fileName,
      flags,
      compressionMethod,
      crc32,
      compressedByteLength,
      byteLength,
    });
  }

  async readCompressed(entry, maximumBytes) {
    if (entry.compressedByteLength > maximumBytes) {
      throw new ZipFormatError(
        `${entry.path} is ${entry.compressedByteLength} compressed bytes; limit is ${maximumBytes}.`,
        "ENTRY_TOO_LARGE",
      );
    }
    return this.#readExactly(entry.compressedByteLength);
  }

  async skip(entry) {
    await this.#skipExactly(entry.compressedByteLength);
  }

  async drain() {
    this.#bufferOffset = this.#buffer.length;
    while (!this.#ended) {
      const next = await this.#reader.next();
      if (next.done) {
        this.#ended = true;
        break;
      }
      this.#recordChunk(next.value);
    }
  }

  destroy(reason) {
    if (typeof this.readable.destroy === "function" && !this.readable.destroyed) {
      this.readable.destroy(reason);
    }
  }

  async #readExactly(byteLength, { allowCleanEof = false } = {}) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new ZipFormatError(`Unsafe ZIP read length: ${byteLength}.`);
    }
    if (byteLength === 0) return Buffer.alloc(0);

    const parts = [];
    let remaining = byteLength;
    while (remaining > 0) {
      const available = this.#buffer.length - this.#bufferOffset;
      if (available === 0) {
        const didRead = await this.#pull();
        if (!didRead) {
          if (allowCleanEof && remaining === byteLength) return null;
          throw new ZipFormatError(
            `ZIP ended ${remaining} bytes before the current record was complete.`,
            "TRUNCATED_ZIP",
          );
        }
        continue;
      }
      const take = Math.min(available, remaining);
      parts.push(this.#buffer.subarray(this.#bufferOffset, this.#bufferOffset + take));
      this.#bufferOffset += take;
      remaining -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, byteLength);
  }

  async #skipExactly(byteLength) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new ZipFormatError(`Unsafe ZIP skip length: ${byteLength}.`);
    }
    let remaining = byteLength;
    while (remaining > 0) {
      const available = this.#buffer.length - this.#bufferOffset;
      if (available === 0) {
        if (!(await this.#pull())) {
          throw new ZipFormatError(
            `ZIP ended ${remaining} bytes before ${byteLength} bytes could be skipped.`,
            "TRUNCATED_ZIP",
          );
        }
        continue;
      }
      const take = Math.min(available, remaining);
      this.#bufferOffset += take;
      remaining -= take;
    }
  }

  async #pull() {
    if (this.#ended) return false;
    const next = await this.#reader.next();
    if (next.done) {
      this.#ended = true;
      this.#buffer = Buffer.alloc(0);
      this.#bufferOffset = 0;
      return false;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.#recordChunk(chunk);
    this.#buffer = chunk;
    this.#bufferOffset = 0;
    return true;
  }

  #recordChunk(chunk) {
    this.sourceBytesRead += chunk.byteLength;
    this.#onChunk?.(chunk);
  }
}

export async function decodeZipEntry(
  entry,
  compressed,
  { maximumEntryBytes, maximumCompressionRatio } = {},
) {
  if (entry.byteLength > maximumEntryBytes) {
    throw new ZipFormatError(
      `${entry.path} expands to ${entry.byteLength} bytes; limit is ${maximumEntryBytes}.`,
      "ENTRY_TOO_LARGE",
    );
  }
  if (entry.byteLength > 0 && entry.compressedByteLength === 0) {
    throw new ZipFormatError(
      `${entry.path} has an invalid zero-byte compressed body.`,
      "INVALID_ENTRY_SIZE",
    );
  }
  if (
    entry.compressedByteLength > 0 &&
    entry.byteLength / entry.compressedByteLength > maximumCompressionRatio
  ) {
    throw new ZipFormatError(
      `${entry.path} exceeds the ${maximumCompressionRatio}:1 decompression-ratio limit.`,
      "SUSPICIOUS_COMPRESSION_RATIO",
    );
  }

  let decoded;
  if (entry.compressionMethod === 0) {
    decoded = compressed;
  } else if (entry.compressionMethod === 8) {
    try {
      decoded = await inflateRawAsync(compressed, { maxOutputLength: maximumEntryBytes });
    } catch (error) {
      throw new ZipFormatError(
        `Could not inflate ${entry.path}: ${safeCause(error)}.`,
        "DECOMPRESSION_FAILED",
      );
    }
  } else {
    throw new ZipFormatError(
      `${entry.path} uses unsupported ZIP compression method ${entry.compressionMethod}.`,
      "UNSUPPORTED_COMPRESSION",
    );
  }

  if (decoded.byteLength !== entry.byteLength) {
    throw new ZipFormatError(
      `${entry.path} decoded to ${decoded.byteLength} bytes; ZIP metadata says ${entry.byteLength}.`,
      "SIZE_MISMATCH",
    );
  }
  const actualCrc32 = crc32(decoded);
  if (actualCrc32 !== entry.crc32) {
    throw new ZipFormatError(`${entry.path} failed its ZIP CRC-32 check.`, "CRC32_MISMATCH");
  }
  return decoded;
}

export function describeArtwork(bytes) {
  if (!isWebp(bytes)) {
    throw new ZipFormatError(
      "Artwork content does not have a RIFF/WEBP signature.",
      "INVALID_WEBP",
    );
  }
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentMd5: createHash("md5").update(bytes).digest("base64"),
  };
}

export function isWebp(bytes) {
  return (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

let crcTable;

export function crc32(bytes) {
  crcTable ??= makeCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
}

function decodeFileName(buffer, flags) {
  const encoding = (flags & 0x800) !== 0 ? "utf8" : "latin1";
  const value = buffer.toString(encoding);
  if (Buffer.from(value, encoding).compare(buffer) !== 0) {
    throw new ZipFormatError(
      "ZIP entry name is not valid in its declared encoding.",
      "INVALID_FILE_NAME",
    );
  }
  return value;
}

function assertSafeArchivePath(value) {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.split("/").includes("..")
  ) {
    throw new ZipFormatError(`Unsafe ZIP entry path: ${JSON.stringify(value)}.`, "UNSAFE_PATH");
  }
}

function parseZip64Sizes(extra, required) {
  if (!required.uncompressed && !required.compressed) return {};
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldLength > extra.length) {
      throw new ZipFormatError("Truncated ZIP extra field.", "INVALID_ZIP64_EXTRA");
    }
    if (fieldId === ZIP64_EXTRA_ID) {
      const field = extra.subarray(offset, offset + fieldLength);
      let cursor = 0;
      const result = {};
      if (required.uncompressed) {
        if (cursor + 8 > field.length)
          throw new ZipFormatError("ZIP64 uncompressed size is missing.", "INVALID_ZIP64_EXTRA");
        result.uncompressed = field.readBigUInt64LE(cursor);
        cursor += 8;
      }
      if (required.compressed) {
        if (cursor + 8 > field.length)
          throw new ZipFormatError("ZIP64 compressed size is missing.", "INVALID_ZIP64_EXTRA");
        result.compressed = field.readBigUInt64LE(cursor);
      }
      return result;
    }
    offset += fieldLength;
  }
  throw new ZipFormatError("A ZIP64 entry is missing its ZIP64 size field.", "INVALID_ZIP64_EXTRA");
}

function toSafeNumber(value, label) {
  if (typeof value !== "bigint" || value > MAX_SAFE_BIGINT) {
    throw new ZipFormatError(`${label} is too large for this importer.`, "UNSAFE_ENTRY_SIZE");
  }
  return Number(value);
}

function safeCause(error) {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown decompression error";
}
