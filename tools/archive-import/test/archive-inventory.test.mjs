import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  artworkEntriesSha256,
  inventoryRemoteArchive,
  loadArtworkInventory,
} from "../lib/archive-inventory.mjs";
import { parseZipCentralDirectory } from "../lib/artwork.mjs";
import { sha256Bytes } from "../lib/util.mjs";

test("inventories a ZIP64 central directory through strict HTTP Range requests", async () => {
  const fixture = makeZip64Fixture([
    { path: "poap.sqlite", byteLength: 128, compressedByteLength: 64, crc32: 0x11111111 },
    { path: "artwork/1.webp", byteLength: 12, compressedByteLength: 10, crc32: 0x22222222 },
    { path: "artwork/2.webp", byteLength: 24, compressedByteLength: 18, crc32: 0x33333333 },
  ]);
  const parsed = parseZipCentralDirectory(fixture.centralDirectory, { entryCount: 3 });
  const ranges = [];
  const server = createServer((request, response) => {
    const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(request.headers.range ?? "");
    if (!match) {
      response.writeHead(416).end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    ranges.push({ start, end });
    const body = fixture.archive.subarray(start, end + 1);
    response.writeHead(206, {
      "Accept-Ranges": "bytes",
      "Content-Length": body.length,
      "Content-Range": `bytes ${start}-${end}/${fixture.archive.length}`,
      ETag: '"fixture-etag"',
      "Last-Modified": "Thu, 02 Jul 2026 15:28:18 GMT",
    });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const archiveUrl = `http://127.0.0.1:${address.port}/archive.zip`;
  const policy = {
    id: "fixture-v1",
    snapshotId: "2026-07-02-v1",
    archiveUrl,
    byteLength: fixture.archive.length,
    expectedArchiveSha256: sha256Bytes(fixture.archive),
    expectedEtag: '"fixture-etag"',
    centralDirectory: {
      zip64: true,
      offset: fixture.centralOffset,
      byteLength: fixture.centralDirectory.length,
      entryCount: 3,
      sha256: sha256Bytes(fixture.centralDirectory),
    },
    artworkCount: 2,
    unexpectedEntryCount: 1,
    artworkEntriesSha256: artworkEntriesSha256(parsed.entries),
  };
  await assert.rejects(
    inventoryRemoteArchive({
      policy,
      fetchImpl: async () => new Response(Buffer.alloc(1), { status: 200 }),
      tailByteLength: 256,
    }),
    /HTTP 200/,
    "A server that ignores Range must be rejected.",
  );
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "poapin-range-inventory-"));
  try {
    const inventory = await inventoryRemoteArchive({
      policy,
      tailByteLength: 256,
      rangeByteLength: 96,
    });
    assert.equal(inventory.verification.centralDirectory.status, "verified");
    assert.equal(inventory.verification.wholeArchiveSha256.status, "not-measured");
    assert.equal(inventory.verification.wholeArchiveSha256.measuredSha256, null);
    assert.equal(inventory.artwork.count, 2);
    assert.ok(ranges.length >= 2);
    assert.ok(ranges.every(({ start, end }) => start >= 0 && end < fixture.archive.length));
    assert.ok(
      inventory.verification.acquisition.byteLength < fixture.archive.length,
      "The inventory path must not read the complete archive.",
    );

    const inventoryPath = resolve(temporaryRoot, "inventory.json");
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
    await assert.rejects(
      loadArtworkInventory(inventoryPath),
      /policy id changed/i,
      "Importer consumption defaults to the fixed official archive policy.",
    );
    const loaded = await loadArtworkInventory(inventoryPath, { policy });
    assert.deepEqual([...loaded.entries.keys()], [1, 2]);
    assert.equal(loaded.source.wholeArchiveSha256Status, "not-measured");

    const tampered = structuredClone(inventory);
    tampered.artwork.entries[0].byteLength += 1;
    const tamperedPath = resolve(temporaryRoot, "tampered.json");
    await writeFile(tamperedPath, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(loadArtworkInventory(tamperedPath, { policy }), /digest/i);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function makeZip64Fixture(entries) {
  const prefix = Buffer.alloc(256 * 1024, 0x5a);
  const centralDirectory = Buffer.concat(entries.map(makeCentralEntry));
  const centralOffset = prefix.length;
  const zip64Offset = centralOffset + centralDirectory.length;

  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 24);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
  zip64End.writeBigUInt64LE(BigInt(centralDirectory.length), 40);
  zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64Offset), 8);
  locator.writeUInt32LE(1, 16);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return {
    archive: Buffer.concat([prefix, centralDirectory, zip64End, locator, end]),
    centralDirectory,
    centralOffset,
  };
}

function makeCentralEntry(entry) {
  const name = Buffer.from(entry.path, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x031e, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.compressedByteLength, 20);
  header.writeUInt32LE(entry.byteLength, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  return Buffer.concat([header, name]);
}
