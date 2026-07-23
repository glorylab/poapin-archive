import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureMomentsMedia, momentsMediaObjectKey } from "../lib/capture.mjs";
import { readNdjsonArray } from "../lib/io.mjs";
import { buildMomentsMediaPlan, isCanonicalOriginal } from "../lib/plan.mjs";
import { detectMediaType, isDeclaredTypeCompatible } from "../lib/sniff.mjs";

const SNAPSHOT = "moments-2026-07-23-v1";
const PUBLIC_MOMENT = "11111111-1111-4111-8111-111111111111";
const HIDDEN_MOMENT = "22222222-2222-4222-8222-222222222222";
const NO_DROP_MOMENT = "33333333-3333-4333-8333-333333333333";
const PUBLIC_MEDIA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HIDDEN_MEDIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORPHAN_MEDIA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MISSING_MEDIA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("builds a deterministic fail-closed original-media plan", async () => {
  const root = await fixtureRoot();
  try {
    const result = await buildMomentsMediaPlan({ input: root, snapshotId: SNAPSHOT });
    const rows = await readNdjsonArray(result.planPath);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map(({ mediaKey, target, eligibility, sourceUrl }) => ({
        mediaKey,
        target,
        eligibility,
        hasSource: Boolean(sourceUrl),
      })),
      [
        { mediaKey: PUBLIC_MEDIA, target: "public", eligibility: "public", hasSource: true },
        {
          mediaKey: HIDDEN_MEDIA,
          target: "private",
          eligibility: "hidden_drop",
          hasSource: true,
        },
        {
          mediaKey: ORPHAN_MEDIA,
          target: "private",
          eligibility: "orphan_media",
          hasSource: true,
        },
        {
          mediaKey: MISSING_MEDIA,
          target: null,
          eligibility: "moment_without_drop",
          hasSource: false,
        },
      ],
    );
    assert.equal(result.report.counts.rejectedOrDerivedGatewayRows, 1);
    assert.equal(result.report.counts.public, 1);
    assert.equal(result.report.counts.private, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes only the exact canonical source gateway", () => {
  assert.equal(
    isCanonicalOriginal(`https://cdn.media.poap.tech/${PUBLIC_MEDIA}`, PUBLIC_MEDIA),
    true,
  );
  assert.equal(
    isCanonicalOriginal(
      `https://cdn.media.poap.tech/thumbnails/${PUBLIC_MEDIA}.webp`,
      PUBLIC_MEDIA,
    ),
    false,
  );
  assert.equal(isCanonicalOriginal(`https://example.com/${PUBLIC_MEDIA}`, PUBLIC_MEDIA), false);
});

test("sniffs browser and preservation media types from bytes", () => {
  assert.deepEqual(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), {
    contentType: "image/jpeg",
    extension: "jpg",
  });
  const m4a = Buffer.alloc(32);
  m4a.write("ftyp", 4, "ascii");
  m4a.write("M4A ", 8, "ascii");
  assert.deepEqual(detectMediaType(m4a, "audio/x-m4a"), {
    contentType: "audio/mp4",
    extension: "m4a",
  });
  assert.equal(isDeclaredTypeCompatible("audio/x-m4a", "audio/mp4"), true);
  assert.equal(isDeclaredTypeCompatible("image/png", "image/jpeg"), false);
});

test("captures, hashes, uploads, resumes, and emits a public-only D1 manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-media-capture-test-"));
  await mkdir(join(root, "media"), { recursive: true });
  await mkdir(join(root, "normalized"), { recursive: true });
  await writeRows(join(root, "normalized", "moment_media.ndjson"), [
    { key: PUBLIC_MEDIA, moment_id: PUBLIC_MOMENT },
  ]);
  await writeFile(
    join(root, "media", "plan.ndjson"),
    `${JSON.stringify({
      planId: PUBLIC_MEDIA,
      mediaKey: PUBLIC_MEDIA,
      momentId: PUBLIC_MOMENT,
      gatewayId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sourceUrl: `https://cdn.media.poap.tech/${PUBLIC_MEDIA}`,
      declaredContentType: "image/jpeg",
      declaredByteLength: 7,
      sourceStatus: "PROCESSED",
      publicEligible: true,
      target: "public",
      eligibility: "public",
      dropIds: ["42"],
      alternateOriginalGateways: 0,
    })}\n`,
  );
  const stored = new Map();
  let uploads = 0;
  const bridge = {
    async verifyTargets() {},
    async head(object) {
      return stored.get(object.key) ?? null;
    },
    async uploadFile(object, path) {
      const bytes = await readFile(path);
      assert.equal(bytes.byteLength, object.byteLength);
      uploads += 1;
      const result = { ...object, etag: `etag-${uploads}` };
      stored.set(object.key, result);
      return { disposition: "uploaded", etag: result.etag };
    },
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02]);
  let downloads = 0;
  const fetchImpl = async () => {
    downloads += 1;
    return new Response(jpeg, {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length) },
    });
  };
  try {
    const options = {
      input: root,
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      bridge,
      fetchImpl,
      concurrency: 1,
    };
    const first = await captureMomentsMedia(options);
    assert.equal(first.complete, true);
    assert.equal(first.publicProjectionReady, true);
    assert.equal(uploads, 1);
    assert.equal(downloads, 1);
    const manifest = await readNdjsonArray(join(root, "media", "d1-media-manifest.ndjson"));
    assert.equal(manifest[0].status, "public_stored");
    assert.match(manifest[0].objectKey, new RegExp(`^snapshots/${SNAPSHOT}/moments/original/`));

    const second = await captureMomentsMedia(options);
    assert.equal(second.complete, true);
    assert.equal(uploads, 1);
    assert.equal(downloads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture rejects path-like media identities before bridge or temporary-file work", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-media-path-test-"));
  const mediaRoot = join(root, "media");
  const sentinelRoot = join(root, "sentinel");
  const sentinelPath = join(sentinelRoot, "keep.txt");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(sentinelRoot, { recursive: true });
  await writeFile(sentinelPath, "keep");
  await writeRows(join(mediaRoot, "plan.ndjson"), [
    {
      planId: "x/../../sentinel",
      mediaKey: "x/../../sentinel",
      sourceUrl: null,
      target: null,
    },
  ]);
  let bridgeReached = false;
  try {
    await assert.rejects(
      captureMomentsMedia({
        input: root,
        snapshotId: SNAPSHOT,
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        bridge: {
          async verifyTargets() {
            bridgeReached = true;
          },
        },
      }),
      /Moments media plan is invalid/,
    );
    assert.equal(bridgeReached, false);
    assert.equal(await readFile(sentinelPath, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture rejects a shared public/private bucket before bridge access", async () => {
  let bridgeReached = false;
  await assert.rejects(
    captureMomentsMedia({
      input: "/not-read",
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-shared",
      privateBucket: "poapin-shared",
      bridge: {
        async verifyTargets() {
          bridgeReached = true;
        },
      },
    }),
    /must be different/,
  );
  assert.equal(bridgeReached, false);
});

test("builds separate public and private content-addressed keys", () => {
  const sha = "a".repeat(64);
  assert.equal(
    momentsMediaObjectKey(SNAPSHOT, "public", sha, "jpg"),
    `snapshots/${SNAPSHOT}/moments/original/sha256/aa/${sha}.jpg`,
  );
  assert.equal(
    momentsMediaObjectKey(SNAPSHOT, "private", sha, "jpg"),
    `snapshots/${SNAPSHOT}/moments/private/original/sha256/aa/${sha}.jpg`,
  );
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "moments-media-plan-test-"));
  const normalized = join(root, "normalized");
  await mkdir(normalized, { recursive: true });
  await writeRows(join(normalized, "moments.ndjson"), [
    { id: PUBLIC_MOMENT },
    { id: HIDDEN_MOMENT },
    { id: NO_DROP_MOMENT },
  ]);
  await writeRows(join(normalized, "moment_drops.ndjson"), [
    { moment_id: PUBLIC_MOMENT, drop_id: 42 },
    { moment_id: HIDDEN_MOMENT, drop_id: 43 },
  ]);
  await writeRows(join(normalized, "moment_media.ndjson"), [
    media(PUBLIC_MEDIA, PUBLIC_MOMENT),
    media(HIDDEN_MEDIA, HIDDEN_MOMENT),
    media(ORPHAN_MEDIA, null),
    media(MISSING_MEDIA, NO_DROP_MOMENT),
  ]);
  await writeRows(join(normalized, "gateways.ndjson"), [
    gateway(PUBLIC_MEDIA, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    gateway(HIDDEN_MEDIA, "ffffffff-ffff-4fff-8fff-ffffffffffff"),
    gateway(ORPHAN_MEDIA, "01234567-89ab-4cde-8fab-0123456789ab"),
    {
      ...gateway(PUBLIC_MEDIA, "12345678-1234-4234-8234-123456789abc"),
      url: `https://cdn.media.poap.tech/thumbnails/${PUBLIC_MEDIA}.webp`,
      type: "image/webp",
    },
  ]);
  await writeRows(join(normalized, "moments_hidden_drops.ndjson"), [
    { drop_id: 43, hidden_on: "2026-01-01" },
  ]);
  // This generic Drops row must not be reinterpreted as a Moments visibility
  // rule; only moments_hidden_drops hides a Moment from Explore.
  await writeRows(join(normalized, "drops_hidden_drops.ndjson"), [
    { drop_id: 42, hidden_on: "2026-01-01" },
  ]);
  return root;
}

function media(key, momentId) {
  return {
    key,
    moment_id: momentId,
    mime_type: "image/jpeg",
    status: "PROCESSED",
  };
}

function gateway(mediaKey, id) {
  return {
    id,
    moment_media_id: mediaKey,
    type: "image/jpeg",
    url: `https://cdn.media.poap.tech/${mediaKey}`,
    metadata: { size: 7 },
  };
}

async function writeRows(path, rows) {
  await writeFile(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}
