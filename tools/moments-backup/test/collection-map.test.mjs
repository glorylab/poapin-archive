import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { buildMomentsCollectionMap } from "../lib/collection-map.mjs";
import { compareMomentsSnapshots } from "../lib/compare.mjs";
import { buildMomentsD1 } from "../lib/d1.mjs";
import { sha256File, writeJsonAtomic } from "../lib/files.mjs";
import { captureMomentsSnapshot } from "../lib/snapshot.mjs";
import { MockGraphqlClient, UUID } from "./helpers.mjs";

const ENDPOINT = "https://example.invalid/graphql";
const T = "2026-07-23T00:00:00.000Z";

test("collection map verifies both snapshots and emits a stable, D1-compatible bridge", async () => {
  const moments = await momentsFixture("collection-map");
  const collections = await collectionsFixture("collection-map");

  const result = await buildMomentsCollectionMap({
    input: moments,
    collectionsInput: collections,
  });
  assert.equal(result.output, resolve(moments, "derived/moment_collections.ndjson"));
  assert.equal(result.reportPath, resolve(moments, "derived/moment_collections.report.json"));
  assert.equal(
    await readFile(result.output, "utf8"),
    `${JSON.stringify({ momentId: UUID(1), collectionId: 5 })}\n${JSON.stringify({ momentId: UUID(1), collectionId: 7 })}\n`,
  );
  assert.deepEqual(result.counts, {
    collections: 3,
    collectionsWithDropIds: 2,
    collectionDropReferences: 4,
    uniqueCollectionDrops: 3,
    momentDropRelations: 1,
    momentsWithDropRelations: 1,
    matchedMomentDropRelations: 1,
    unmatchedMomentDropRelations: 0,
    mappedMoments: 1,
    mappedCollections: 2,
    momentCollectionPairs: 2,
  });
  assert.match(result.sources.moments.manifest.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.sources.collections.manifest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.sources.collections.collections.rows, 3);
  assert.equal(result.sources.collections.collectionDropIds.rows, 2);

  const firstReport = await readFile(result.reportPath, "utf8");
  await buildMomentsCollectionMap({ input: moments, collectionsInput: collections });
  assert.equal(await readFile(result.reportPath, "utf8"), firstReport);

  const d1 = await buildMomentsD1({
    input: moments,
    output: resolve(moments, "d1-with-collection-map"),
    snapshotId: "synthetic-collection-map-v1",
    collectionMap: result.output,
  });
  assert.equal(d1.tables.moment_collections, 2);

  const proof = JSON.parse(await readFile(result.reportPath, "utf8"));
  proof.sources.moments.manifest.sha256 = "f".repeat(64);
  await writeFile(result.reportPath, `${JSON.stringify(proof)}\n`);
  await assert.rejects(
    buildMomentsD1({
      input: moments,
      output: resolve(moments, "d1-rejected-collection-map"),
      snapshotId: "synthetic-collection-map-v1",
      collectionMap: result.output,
    }),
    /Collection map proof is not bound/,
  );
});

test("collection map rejects a Collections artifact whose bytes no longer match its manifest", async () => {
  const moments = await momentsFixture("collection-tamper");
  const collections = await collectionsFixture("collection-tamper");
  const path = resolve(collections, "normalized/collection_drop_ids.ndjson");
  await writeFile(path, `${await readFile(path, "utf8")} `);

  await assert.rejects(
    buildMomentsCollectionMap({ input: moments, collectionsInput: collections }),
    /checksum or byte length does not match/,
  );
});

test("compare can atomically persist manifest bindings and normalized results", async () => {
  const moments = await momentsFixture("stability");
  const output = resolve(await temporary("stability-report"), "stability.json");
  const comparison = await compareMomentsSnapshots({
    primary: moments,
    secondary: moments,
    output,
  });
  assert.equal(comparison.stable, true);
  assert.equal(comparison.output, output);
  assert.equal(comparison.normalized.stable, true);
  assert.ok(comparison.normalized.artifacts.length > 0);

  const report = JSON.parse(await readFile(output, "utf8"));
  const manifestMetadata = await sha256File(resolve(moments, "manifest.json"));
  assert.equal(report.primary.manifestSha256, manifestMetadata.sha256);
  assert.equal(report.secondary.manifestSha256, manifestMetadata.sha256);
  assert.equal(report.primary.startedAt, report.secondary.startedAt);
  assert.equal(report.primary.finishedAt, report.secondary.finishedAt);
  assert.equal(report.normalized.stable, true);
  assert.equal("primaryPath" in report, false);
});

async function momentsFixture(name) {
  const root = await temporary(name);
  await captureMomentsSnapshot({
    output: root,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  const secondary = await temporary(`${name}-secondary`);
  await captureMomentsSnapshot({
    output: secondary,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  await compareMomentsSnapshots({
    primary: root,
    secondary,
    output: resolve(root, "validation/stability.json"),
  });
  return root;
}

async function collectionsFixture(name) {
  const root = await temporary(name);
  const normalized = resolve(root, "normalized");
  await mkdir(normalized, { recursive: true });
  const collectionsPath = resolve(normalized, "collections.ndjson");
  const collectionDropIdsPath = resolve(normalized, "collection_drop_ids.ndjson");
  const collectionsRows = [{ id: 5 }, { id: 7 }, { id: 9 }];
  const collectionDropRows = [
    { collection_id: 5, drop_ids: [101, 999] },
    { collection_id: 7, drop_ids: [101, 202] },
  ];
  await writeFile(
    collectionsPath,
    `${collectionsRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeFile(
    collectionDropIdsPath,
    `${collectionDropRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const [collectionsMetadata, collectionDropIdsMetadata] = await Promise.all([
    sha256File(collectionsPath),
    sha256File(collectionDropIdsPath),
  ]);
  await writeJsonAtomic(resolve(root, "manifest.json"), {
    version: 1,
    dataset: "poap-compass-collections",
    startedAt: T,
    finishedAt: T,
    normalized: {
      artifacts: [
        {
          path: "normalized/collections.ndjson",
          rows: collectionsRows.length,
          ...collectionsMetadata,
        },
        {
          path: "normalized/collection_drop_ids.ndjson",
          rows: collectionDropRows.length,
          ...collectionDropIdsMetadata,
        },
      ],
    },
  });
  return root;
}

async function temporary(name) {
  return mkdtemp(resolve(tmpdir(), `poapin-moments-${name}-`));
}
