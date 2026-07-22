import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { captureReferencedDropSupplement, DROP_SUPPLEMENT_QUERY } from "../lib/drop-supplement.mjs";

const SNAPSHOT_ID = "2026-07-02-v1";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("enrich-drops reuses verified archive artwork, downloads the remainder, and resumes", async (t) => {
  const fixture = await createFixture([
    drop(1, "https://assets.poap.xyz/1.png"),
    drop(2, "https://assets.poap.xyz/2.png"),
  ]);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const archive = await createArchiveMedia(fixture.base, [1]);
  let graphqlRequests = 0;
  let mediaRequests = 0;
  const dependencies = {
    client: relationClient(() => {
      graphqlRequests += 1;
    }),
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    fetch: async () => {
      mediaRequests += 1;
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    },
  };

  const first = await captureReferencedDropSupplement({
    input: fixture.root,
    pageSize: 1,
    maximumBytes: 1024,
    archiveMediaManifest: archive.manifestPath,
    archiveUploadReport: archive.reportPath,
    archiveUploadCheckpoint: archive.checkpointPath,
    archiveSnapshotId: SNAPSHOT_ID,
    dependencies,
  });

  assert.equal(graphqlRequests, 2);
  assert.equal(mediaRequests, 1);
  assert.equal(first.graphql.pages, 2);
  assert.deepEqual(first.artwork.counts, {
    reused: 1,
    downloaded: 1,
    quarantined: 0,
    failed: 0,
    missing: 0,
    pending: 0,
  });
  assert.equal(first.complete, true);
  assert.equal(first.publishable, true);
  const storedQuery = await readFile(
    resolve(fixture.root, "drop-supplement/queries/referenced-drop-supplement.graphql"),
  );
  assert.equal(first.graphql.querySha256, digest(DROP_SUPPLEMENT_QUERY));
  assert.equal(first.graphql.queryFileSha256, digest(storedQuery));
  assert.notEqual(first.graphql.querySha256, first.graphql.queryFileSha256);
  assert.equal(first.archiveMedia.uploadCheckpoint.rows, 2);
  assert.equal(first.archiveMedia.uploadCheckpoint.objects, 1);
  assert.match(first.archiveMedia.uploadCheckpoint.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    first.archiveMedia.artifacts.map((artifact) => artifact.path),
    [
      "provenance/archive/artwork-manifest.ndjson",
      "provenance/archive/upload-report.json",
      "provenance/archive/upload-checkpoint.jsonl",
    ],
  );
  assert.equal(
    await readFile(
      resolve(fixture.root, "drop-supplement", first.archiveMedia.manifest.path),
      "hex",
    ),
    await readFile(archive.manifestPath, "hex"),
  );

  const references = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  assert.equal(references[0].objectKey, `snapshots/${SNAPSHOT_ID}/artwork/1.webp`);
  assert.equal(references[0].sha256, digest("artwork-1"));
  assert.equal(references[0].byteLength, 1001);
  assert.equal(references[0].contentType, "image/webp");
  assert.equal(references[0].cacheControl, "public, max-age=31536000, immutable");
  assert.equal(references[1].status, "stored");
  assert.match(
    references[1].objectPath,
    /^artwork\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/,
  );

  const weakReferences = references.map((row) => {
    if (row.status !== "reused") return row;
    const legacy = { ...row };
    for (const key of [
      "sha256",
      "byteLength",
      "contentType",
      "cacheControl",
      "disposition",
      "etag",
    ]) {
      delete legacy[key];
    }
    return legacy;
  });
  await writeFile(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
    `${weakReferences.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const legacyManifestPath = resolve(fixture.root, "drop-supplement/manifest.json");
  const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8"));
  delete legacyManifest.archiveMedia.uploadCheckpoint;
  delete legacyManifest.archiveMedia.artifacts;
  await writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);

  const resumed = await captureReferencedDropSupplement({
    input: fixture.root,
    pageSize: 1,
    maximumBytes: 1024,
    archiveMediaManifest: archive.manifestPath,
    archiveUploadReport: archive.reportPath,
    archiveUploadCheckpoint: archive.checkpointPath,
    archiveSnapshotId: SNAPSHOT_ID,
    dependencies: {
      client: { request: async () => assert.fail("resume made a GraphQL request") },
      lookup: async () => assert.fail("resume resolved a media host"),
      fetch: async () => assert.fail("resume downloaded artwork"),
    },
  });
  assert.equal(resumed.complete, true);
  const [upgradedReuse] = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  assert.equal(upgradedReuse.sha256, digest("artwork-1"));
  assert.equal(upgradedReuse.byteLength, 1001);
  assert.equal(resumed.archiveMedia.uploadCheckpoint.objects, 1);
  await writeFile(
    resolve(fixture.root, "drop-supplement/provenance/archive/upload-report.json"),
    "tampered",
  );
  await assert.rejects(
    captureReferencedDropSupplement({
      input: fixture.root,
      pageSize: 1,
      maximumBytes: 1024,
      archiveMediaManifest: archive.manifestPath,
      archiveUploadReport: archive.reportPath,
      archiveUploadCheckpoint: archive.checkpointPath,
      archiveSnapshotId: SNAPSHOT_ID,
      dependencies: {
        client: { request: async () => assert.fail("resume made a GraphQL request") },
      },
    }),
    /provenance uploadReport differs from the previously preserved file/,
  );
});

test("enrich-drops rejects tampered raw pages and stored objects on resume", async (t) => {
  const fixture = await createFixture([drop(7, "https://assets.poap.xyz/7.png")]);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const options = {
    input: fixture.root,
    maximumBytes: 1024,
    dependencies: {
      client: relationClient(),
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetch: async () =>
        new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    },
  };
  await captureReferencedDropSupplement(options);

  const rawPath = resolve(fixture.root, "drop-supplement/raw/000001.json.gz");
  const raw = await readFile(rawPath);
  await writeFile(rawPath, Buffer.concat([raw, Buffer.from("tamper")]));
  await assert.rejects(captureReferencedDropSupplement(options), /raw page checksum mismatch/);
  await writeFile(rawPath, raw);

  const [reference] = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  await writeFile(resolve(fixture.root, "drop-supplement", reference.objectPath), "tamper");
  await assert.rejects(captureReferencedDropSupplement(options), /artwork checksum mismatch/);
});

test("enrich-drops quarantines unknown image hosts and refuses forged archive reuse", async (t) => {
  const fixture = await createFixture([drop(9, "https://unknown.example/9.png")]);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  let fetches = 0;
  const result = await captureReferencedDropSupplement({
    input: fixture.root,
    maximumBytes: 1024,
    dependencies: {
      client: relationClient(),
      fetch: async () => {
        fetches += 1;
        return new Response(PNG);
      },
      lookup: async () => assert.fail("unknown host reached DNS"),
    },
  });
  assert.equal(fetches, 0);
  assert.equal(result.artwork.counts.quarantined, 1);
  assert.equal(result.complete, true);
  assert.equal(result.publishable, true);
  assert.equal(result.artwork.quarantinedReferencesAreExcluded, true);
  await captureReferencedDropSupplement({
    input: fixture.root,
    maximumBytes: 1024,
    retryFailures: true,
    dependencies: {
      client: { request: async () => assert.fail("resume made a GraphQL request") },
      fetch: async () => assert.fail("unknown-host quarantine was retried"),
      lookup: async () => assert.fail("unknown-host quarantine reached DNS on resume"),
    },
  });

  const second = await createFixture([drop(10, "https://assets.poap.xyz/10.png")]);
  t.after(() => rm(second.base, { recursive: true, force: true }));
  const archive = await createArchiveMedia(second.base, [10]);
  await writeFile(archive.manifestPath, `${await readFile(archive.manifestPath, "utf8")} `);
  await assert.rejects(
    captureReferencedDropSupplement({
      input: second.root,
      maximumBytes: 1024,
      archiveMediaManifest: archive.manifestPath,
      archiveUploadReport: archive.reportPath,
      archiveUploadCheckpoint: archive.checkpointPath,
      archiveSnapshotId: SNAPSHOT_ID,
      dependencies: { client: relationClient() },
    }),
    /not bound to the supplied media manifest/,
  );

  const third = await createFixture([drop(13, "https://assets.poap.xyz/13.png")]);
  t.after(() => rm(third.base, { recursive: true, force: true }));
  const forged = await createArchiveMedia(third.base, [13]);
  const forgedRows = await readFile(forged.checkpointPath, "utf8");
  await writeFile(forged.checkpointPath, `${forgedRows}${forgedRows.trim().split("\n").at(-1)}\n`);
  await assert.rejects(
    captureReferencedDropSupplement({
      input: third.root,
      maximumBytes: 1024,
      archiveMediaManifest: forged.manifestPath,
      archiveUploadReport: forged.reportPath,
      archiveUploadCheckpoint: forged.checkpointPath,
      archiveSnapshotId: SNAPSHOT_ID,
      dependencies: { client: relationClient() },
    }),
    /checkpoint object row .* invalid or duplicated/,
  );
});

test("enrich-drops preserves non-image bytes in quarantine and verifies them on resume", async (t) => {
  const fixture = await createFixture([drop(11, "https://assets.poap.xyz/11.png")]);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const mp4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypmp42", "ascii"),
    Buffer.from("private-backup-evidence", "ascii"),
  ]);
  const options = {
    input: fixture.root,
    maximumBytes: 100_000_000,
    dependencies: {
      client: relationClient(),
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetch: async () =>
        new Response(mp4, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            etag: '"mp4-etag"',
            "last-modified": "Wed, 22 Jul 2026 00:00:00 GMT",
          },
        }),
    },
  };

  const result = await captureReferencedDropSupplement(options);
  const [reference] = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  assert.equal(result.complete, true);
  assert.equal(result.publishable, true);
  assert.equal(result.artwork.counts.quarantined, 1);
  assert.equal(result.artwork.uniqueQuarantinedObjects, 1);
  assert.equal(reference.failureCode, "UNSUPPORTED_MEDIA");
  assert.equal(reference.eligibleForPublish, false);
  assert.equal(reference.advertisedContentType, "video/mp4");
  assert.equal(reference.detectedContentType, null);
  assert.equal(reference.byteLength, mp4.byteLength);
  assert.equal(
    await readFile(resolve(fixture.root, "drop-supplement", reference.quarantinePath), "hex"),
    mp4.toString("hex"),
  );

  await captureReferencedDropSupplement({
    ...options,
    retryFailures: true,
    dependencies: {
      client: { request: async () => assert.fail("resume made a GraphQL request") },
      lookup: async () => assert.fail("terminal quarantine reached DNS"),
      fetch: async () => assert.fail("terminal quarantine was retried"),
    },
  });
  await writeFile(resolve(fixture.root, "drop-supplement", reference.quarantinePath), "tampered");
  await assert.rejects(
    captureReferencedDropSupplement(options),
    /Quarantined drop artwork checksum mismatch/,
  );
});

test("enrich-drops records empty HTTP responses as terminal excluded evidence", async (t) => {
  const fixture = await createFixture([drop(12, "https://assets.poap.xyz/12.png")]);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const result = await captureReferencedDropSupplement({
    input: fixture.root,
    maximumBytes: 1024,
    dependencies: {
      client: relationClient(),
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetch: async () =>
        new Response(Buffer.alloc(0), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "0",
            etag: '"empty-etag"',
            "last-modified": "Wed, 22 Jul 2026 00:00:00 GMT",
          },
        }),
    },
  });
  const [reference] = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  assert.equal(result.complete, true);
  assert.equal(result.publishable, true);
  assert.equal(reference.status, "quarantined");
  assert.equal(reference.failureCode, "EMPTY_MEDIA");
  assert.equal(reference.httpStatus, 200);
  assert.equal(reference.etag, '"empty-etag"');
  assert.equal(reference.lastModified, "Wed, 22 Jul 2026 00:00:00 GMT");
  assert.equal(reference.byteLength, 0);
  assert.equal(reference.sha256, digest(Buffer.alloc(0)));
  assert.equal(reference.quarantinePath, null);
  assert.equal(reference.eligibleForPublish, false);
});

test("enrich-drops migrates only legacy trusted-host quarantine without byte proof", async (t) => {
  const fixture = await createFixture([drop(14, "https://assets.poap.xyz/14.png")]);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const bytes = Buffer.from("not-an-image-but-private-evidence", "utf8");
  const first = await captureReferencedDropSupplement({
    input: fixture.root,
    maximumBytes: 1024,
    dependencies: {
      client: relationClient(),
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetch: async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    },
  });
  assert.equal(first.artwork.counts.quarantined, 1);
  const [current] = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  await rm(resolve(fixture.root, "drop-supplement", current.quarantinePath));
  const checkpointPath = resolve(fixture.root, "drop-supplement/artwork/checkpoint.ndjson");
  await writeFile(
    checkpointPath,
    `${await readFile(checkpointPath, "utf8")}${JSON.stringify({
      kind: "reference",
      version: 1,
      id: "14",
      dropId: 14,
      status: "quarantined",
      eligibleForPublish: false,
      failureCode: "UNSUPPORTED_MEDIA",
      failureReason: "Legacy exporter deleted these bytes.",
      completedAt: "2026-07-22T00:00:00.000Z",
    })}\n`,
  );
  let downloads = 0;
  const migrated = await captureReferencedDropSupplement({
    input: fixture.root,
    maximumBytes: 1024,
    dependencies: {
      client: { request: async () => assert.fail("resume made a GraphQL request") },
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetch: async () => {
        downloads += 1;
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      },
    },
  });
  const [proof] = await readNdjson(
    resolve(fixture.root, "drop-supplement/artwork/references.ndjson"),
  );
  assert.equal(downloads, 1);
  assert.equal(migrated.complete, true);
  assert.equal(proof.failureCode, "UNSUPPORTED_MEDIA");
  assert.equal(proof.sha256, digest(bytes));
  assert.equal(proof.byteLength, bytes.byteLength);
  assert.equal(
    await readFile(resolve(fixture.root, "drop-supplement", proof.quarantinePath), "hex"),
    bytes.toString("hex"),
  );
});

async function createFixture(drops) {
  const base = await mkdtemp(resolve(tmpdir(), "poapin-drop-supplement-"));
  const root = resolve(base, "snapshot");
  await mkdir(resolve(root, "normalized"), { recursive: true });
  await mkdir(resolve(root, "schema"), { recursive: true });
  const ids = drops.map((row) => Number(row.id)).sort((left, right) => left - right);
  const idsBytes = Buffer.from(`${ids.join("\n")}\n`);
  const dropsBytes = Buffer.from(
    `${drops
      .toSorted((left, right) => Number(left.id) - Number(right.id))
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  const schemaBytes = Buffer.from(`${JSON.stringify(schemaDocument(), null, 2)}\n`);
  await Promise.all([
    writeFile(resolve(root, "normalized/referenced_drop_ids.txt"), idsBytes),
    writeFile(resolve(root, "normalized/referenced_drops.ndjson"), dropsBytes),
    writeFile(resolve(root, "schema/introspection.json"), schemaBytes),
  ]);
  const manifest = {
    version: 1,
    dataset: "poap-compass-collections",
    endpoint: "https://public.compass.poap.tech/v1/graphql",
    schema: { sha256: digest(schemaBytes), bytes: schemaBytes.byteLength },
    normalized: {
      artifacts: [
        artifact("normalized/referenced_drop_ids.txt", idsBytes, ids.length),
        artifact("normalized/referenced_drops.ndjson", dropsBytes, drops.length),
      ],
      referencedDropIds: ids.length,
      referencedDropIdsSha256: digest(idsBytes),
    },
    referencedDrops: { captured: drops.length, missing: [], complete: true },
  };
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { base, root };
}

function drop(id, imageUrl) {
  return {
    id,
    image_url: imageUrl,
    drop_image: {
      gateways: [{ id, type: "ORIGINAL", url: imageUrl }],
    },
  };
}

function relationClient(onRequest = () => {}) {
  return {
    async request({ query, variables, operationName }) {
      onRequest();
      assert.equal(query, DROP_SUPPLEMENT_QUERY);
      assert.equal(operationName, "ReferencedDropSupplement");
      assert.equal((query.match(/^\s*drops\(/gm) ?? []).length, 1);
      assert.equal(query.includes("drops_stats_by_chain("), false);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          data: {
            drops: variables.dropIds.map((id) => ({
              id,
              stats_by_chain: [
                {
                  chain: "ethereum",
                  created_on: "2022-01-01T00:00:00Z",
                  drop_id: id,
                  poap_count: id,
                  transfer_count: id + 1,
                },
              ],
              email_claims_stats: { drop_id: id, minted: id, reserved: 0, total: id },
              featured_drop: id % 2 ? null : { drop_id: id, featured_on: "2022-01-02" },
              moments_stats: { drop_id: id, moments_uploaded: 0 },
            })),
          },
        },
      };
    },
  };
}

async function createArchiveMedia(base, dropIds) {
  const manifestPath = resolve(base, "artwork-manifest.ndjson");
  const reportPath = resolve(base, "r2-media-upload-report.json");
  const checkpointPath = resolve(base, "r2-media-bridge.checkpoint.jsonl");
  const cacheControl = "public, max-age=31536000, immutable";
  const rows = dropIds.map((dropId) => ({
    snapshotId: SNAPSHOT_ID,
    dropId,
    object: {
      key: `snapshots/${SNAPSHOT_ID}/artwork/${dropId}.webp`,
      contentType: "image/webp",
      cacheControl,
    },
    eligibleForPublish: true,
  }));
  const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(manifestPath, bytes);
  const report = {
    version: 1,
    ok: true,
    complete: true,
    publishable: true,
    snapshotId: SNAPSHOT_ID,
    stopReason: null,
    fatalFailure: null,
    failures: [],
    source: {
      kind: "local",
      advertisedByteLength: 123,
      actualByteLength: 123,
      sha256: "a".repeat(64),
    },
    manifest: {
      sha256: digest(bytes),
      byteLength: bytes.byteLength,
      rows: rows.length,
      eligible: rows.length,
      ineligible: 0,
    },
    target: {
      snapshotId: SNAPSHOT_ID,
      bucket: "poapin-archive",
      endpoint: "https://upload.example.test",
      cacheControl,
    },
    counts: { uploaded: rows.length, reused: 0, checkpointSkipped: 0, failed: 0 },
    validations: {
      sourceComplete: true,
      sourceByteLength: { checked: true, actual: 123, expected: 123, matches: true },
      sourceSha256: {
        checked: true,
        actual: "a".repeat(64),
        expected: "a".repeat(64),
        matches: true,
      },
      artworkCount: { checked: true, actual: rows.length, expected: rows.length, matches: true },
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const checkpointRows = [
    {
      kind: "header",
      version: 1,
      snapshotId: SNAPSHOT_ID,
      archiveSha256: report.source.sha256,
      manifestSha256: report.manifest.sha256,
      endpoint: report.target.endpoint,
      bucket: report.target.bucket,
      cacheControl,
      objectPrefix: `snapshots/${SNAPSHOT_ID}/artwork/`,
    },
    ...dropIds.map((dropId) => ({
      kind: "object",
      version: 1,
      key: `snapshots/${SNAPSHOT_ID}/artwork/${dropId}.webp`,
      byteLength: 1000 + dropId,
      sha256: digest(`artwork-${dropId}`),
      disposition: "uploaded",
      etag: `etag-${dropId}`,
      completedAt: "2026-07-22T00:00:00.000Z",
    })),
  ];
  await writeFile(
    checkpointPath,
    `${checkpointRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return { manifestPath, reportPath, checkpointPath };
}

function schemaDocument() {
  const object = (name, fields) => ({
    kind: "OBJECT",
    name,
    fields: fields.map((field) => ({ field, name: field, type: { kind: "SCALAR", name: "Int" } })),
  });
  return {
    data: {
      __schema: {
        queryType: { name: "query_root" },
        types: [
          object("query_root", ["drops"]),
          object("drops_stats_by_chain", [
            "chain",
            "created_on",
            "drop_id",
            "poap_count",
            "transfer_count",
          ]),
          object("email_claims_stats", ["drop_id", "minted", "reserved", "total"]),
          object("drops_featured_drops", ["drop_id", "featured_on"]),
          object("drops_stats_moments", ["drop_id", "moments_uploaded"]),
        ],
      },
    },
  };
}

async function readNdjson(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function artifact(path, bytes, rows) {
  return { path, sha256: digest(bytes), byteLength: bytes.byteLength, rows };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
