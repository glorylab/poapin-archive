import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { d1Internals } from "../lib/d1.mjs";

const SNAPSHOT_ID = "collections-2026-07-22-v1";
const ARCHIVE_SNAPSHOT_ID = "2026-07-02-v1";

test("drop supplement projection aggregates per-chain statistics and remains fail-closed", () => {
  const projection = d1Internals.projectDropSupplementRelations({
    ids: [10, 11],
    idSet: new Set([10, 11]),
    relationRows: {
      statsByChain: [
        {
          drop_id: 10,
          chain: null,
          created_on: null,
          poap_count: 2,
          transfer_count: 3,
        },
        {
          drop_id: 11,
          chain: "ethereum",
          created_on: 1_753_142_400,
          poap_count: 5,
          transfer_count: 8,
        },
      ],
      emailClaimsStats: [{ drop_id: 10, minted: 1, reserved: 2, total: 3 }],
      featuredDrops: [{ drop_id: 11, featured_on: "2026-07-20T00:00:00Z" }],
      momentsStats: [{ drop_id: 10, moments_uploaded: 4 }],
    },
  });

  assert.deepEqual(projection.statsRows[0], {
    dropId: 10,
    chainKey: "n:",
    chain: null,
    createdOn: null,
    poapCount: 2,
    transferCount: 3,
  });
  assert.deepEqual(projection.dropCards.get(10), {
    tokenCount: 2,
    transferCount: 3,
    emailClaimsMinted: 1,
    emailClaimsReserved: 2,
    emailClaimsTotal: 3,
    featuredOn: null,
    momentsUploaded: 4,
    imageObjectKey: null,
  });
  assert.equal(projection.dropCards.get(11).tokenCount, 5);
  assert.deepEqual(d1Internals.normalizePrivateValue("false", 10), {
    privateValue: "false",
    isPrivate: 0,
  });
  assert.deepEqual(d1Internals.normalizePrivateValue(null, 10), {
    privateValue: null,
    isPrivate: 1,
  });
  assert.throws(() => d1Internals.normalizePrivateValue("unknown", 10), /reviewed boolean/);
  assert.throws(
    () =>
      d1Internals.projectDropSupplementRelations({
        ids: [10],
        idSet: new Set([10]),
        relationRows: {
          statsByChain: [
            {
              drop_id: 99,
              chain: "ethereum",
              created_on: null,
              poap_count: 1,
              transfer_count: 1,
            },
          ],
          emailClaimsStats: [],
          featuredDrops: [],
          momentsStats: [],
        },
      }),
    /unknown drop 99/,
  );
});

test("artwork projection emits immutable keys, preserves terminal exclusions, and builds one proof", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-d1-enrichment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sha256 = digest(bytes);
  const objectPath = `artwork/objects/sha256/${sha256.slice(0, 2)}/${sha256}.png`;
  await mkdir(resolve(root, "drop-supplement", objectPath, ".."), { recursive: true });
  await writeFile(resolve(root, "drop-supplement", objectPath), bytes);
  const stored = {
    id: "11",
    dropId: 11,
    status: "stored",
    eligibleForPublish: true,
    objectPath,
    sha256,
    byteLength: bytes.byteLength,
    extension: "png",
    contentType: "image/png",
  };
  const missing = {
    id: "12",
    dropId: 12,
    status: "missing",
    eligibleForPublish: false,
    failureCode: "EMPTY_MEDIA",
    failureReason: "Upstream media was empty.",
  };
  const plan = [
    {
      id: "10",
      dropId: 10,
      reuseObjectKey: `snapshots/${ARCHIVE_SNAPSHOT_ID}/artwork/10.webp`,
    },
    { id: "11", dropId: 11, reuseObjectKey: null },
    { id: "12", dropId: 12, reuseObjectKey: null },
  ];
  const references = [
    {
      id: "10",
      dropId: 10,
      status: "reused",
      eligibleForPublish: true,
      objectKey: `snapshots/${ARCHIVE_SNAPSHOT_ID}/artwork/10.webp`,
      sha256,
      byteLength: bytes.byteLength,
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
      disposition: "uploaded",
      etag: "fixture-etag",
      archiveSnapshotId: ARCHIVE_SNAPSHOT_ID,
    },
    stored,
    missing,
  ];
  const checkpointLatest = new Map([
    ["11", stored],
    ["12", missing],
  ]);
  const artwork = await d1Internals.projectDropArtwork({
    root,
    rootRealPath: await realpath(root),
    snapshotId: SNAPSHOT_ID,
    ids: [10, 11, 12],
    plan,
    references,
    checkpointLatest,
    supplement: { archiveMedia: { snapshotId: ARCHIVE_SNAPSHOT_ID } },
    archiveProof: {
      header: { cacheControl: "public, max-age=31536000, immutable" },
      objects: new Map([
        [
          `snapshots/${ARCHIVE_SNAPSHOT_ID}/artwork/10.webp`,
          {
            sha256,
            byteLength: bytes.byteLength,
            disposition: "uploaded",
            etag: "fixture-etag",
          },
        ],
      ]),
    },
  });

  assert.deepEqual(artwork.counts, { reused: 1, downloaded: 1, missing: 1, quarantined: 0 });
  assert.equal(
    artwork.byDrop.get(11).imageObjectKey,
    `snapshots/${SNAPSHOT_ID}/collections/drop-artwork/sha256/${sha256.slice(0, 2)}/${sha256}.png`,
  );
  assert.equal(artwork.byDrop.get(12).imageObjectKey, null);

  const sourceInputs = {
    media: {
      objects: [
        {
          key: `snapshots/${SNAPSHOT_ID}/collections/media/sha256/${sha256.slice(0, 2)}/${sha256}.png`,
          sourcePath: `drop-supplement/${objectPath}`,
          byteLength: bytes.byteLength,
          sha256,
          contentType: "image/png",
        },
      ],
      eligibleObjectsSha256: "a".repeat(64),
    },
    dropSupplement: {
      sha256: "b".repeat(64),
      provenance: { archiveMedia: { snapshotId: ARCHIVE_SNAPSHOT_ID, publishable: true } },
    },
  };
  const proof = await d1Internals.writeMediaProof({
    root,
    snapshotId: SNAPSHOT_ID,
    sourceInputs,
    dropSupplement: {
      reusedObjects: artwork.reusedObjects,
      storedObjects: artwork.storedObjects,
    },
  });
  const rows = (await readFile(resolve(root, proof.manifest.path), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(proof.version, 2);
  assert.equal(proof.objects, 3);
  assert.deepEqual(proof.counts, {
    collectionMedia: 1,
    archiveDropArtwork: 1,
    collectionDropArtwork: 1,
    upload: 2,
    reuse: 1,
  });
  assert.equal(
    rows.some((row) => row.dropId === 12),
    false,
  );
  assert.equal(
    rows.every((row, index) => index === 0 || row.key > rows[index - 1].key),
    true,
  );

  await writeFile(resolve(root, "drop-supplement", objectPath), "tampered");
  await assert.rejects(
    d1Internals.projectDropArtwork({
      root,
      rootRealPath: await realpath(root),
      snapshotId: SNAPSHOT_ID,
      ids: [11],
      plan: [plan[1]],
      references: [stored],
      checkpointLatest,
      supplement: { archiveMedia: { snapshotId: ARCHIVE_SNAPSHOT_ID } },
      archiveProof: { header: {}, objects: new Map() },
    }),
    /changed after capture/,
  );
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
