import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ENTITY_CONFIGS } from "../lib/config.mjs";
import { INTROSPECTION_QUERY } from "../lib/graphql.mjs";
import { verifyCollectionsSnapshot } from "../lib/verify.mjs";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";

test("verifies a complete minimal Collections snapshot", async (t) => {
  const root = await createSnapshot(t);

  const report = await verifyCollectionsSnapshot({ input: root });

  assert.equal(report.verified, true);
  assert.equal(report.issues.errors, 0);
  assert.equal(report.normalized.checked, report.normalized.expected);
  assert.equal(report.relationships.itemSectionCollectionMismatches, 0);
  assert.deepEqual(report.relationships.referencedDrops, {
    union: 1,
    listed: 1,
    captured: 1,
    missing: 0,
  });
  assert.equal(report.media.checked, false);
  assert.match(
    await readFile(resolve(root, "checksums.sha256"), "utf8"),
    /normalized\/collections\.ndjson/,
  );
  assert.equal(
    JSON.parse(await readFile(resolve(root, "validation/report.json"), "utf8")).verified,
    true,
  );
  assert.match(
    await readFile(resolve(root, "validation/report.sha256"), "utf8"),
    /^[0-9a-f]{64}  validation\/report\.json\n$/,
  );
});

test("rejects normalized content whose checksum was changed", async (t) => {
  const root = await createSnapshot(t);
  const path = resolve(root, "normalized/collections.ndjson");
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace('"title":"One"', '"title":"Two"'));

  const error = await rejectionOf(verifyCollectionsSnapshot({ input: root }));

  assert.equal(error.code, "COLLECTIONS_SNAPSHOT_INVALID");
  assert.equal(error.report.verified, false);
  assert.equal(error.report.issues.byCode.ARTIFACT_CHECKSUM_MISMATCH, 1);
  assert.equal(
    JSON.parse(await readFile(resolve(root, "validation/report.json"), "utf8")).verified,
    false,
  );
});

test("rejects an orphaned collection foreign key with otherwise valid artifacts", async (t) => {
  const root = await createSnapshot(t, { urlCollectionId: 999 });

  const error = await rejectionOf(verifyCollectionsSnapshot({ input: root }));

  assert.equal(error.code, "COLLECTIONS_SNAPSHOT_INVALID");
  assert.equal(error.report.verified, false);
  assert.equal(error.report.issues.byCode.FOREIGN_KEY_MISSING, 1);
  assert.equal(error.report.issues.byCode.ARTIFACT_CHECKSUM_MISMATCH, undefined);
  assert.match(
    error.report.issues.items.find((issue) => issue.code === "FOREIGN_KEY_MISSING").message,
    /collection_urls\.collection_id references missing key 999/,
  );
});

test("rejects missing or unexpected manifest entity keys", async (t) => {
  const missingRoot = await createSnapshot(t);
  const missingManifestPath = resolve(missingRoot, "manifest.json");
  const missingManifest = JSON.parse(await readFile(missingManifestPath, "utf8"));
  delete missingManifest.entities.items;
  await writeFile(missingManifestPath, `${JSON.stringify(missingManifest, null, 2)}\n`);
  const missing = await rejectionOf(verifyCollectionsSnapshot({ input: missingRoot }));
  assert.equal(missing.report.issues.byCode.ENTITY_SET_MISMATCH, 1);
  assert.equal(missing.report.issues.byCode.ENTITY_REPORT_MISSING, 1);

  const extraRoot = await createSnapshot(t);
  const extraManifestPath = resolve(extraRoot, "manifest.json");
  const extraManifest = JSON.parse(await readFile(extraManifestPath, "utf8"));
  extraManifest.entities.unexpected = { rows: 0, complete: true };
  await writeFile(extraManifestPath, `${JSON.stringify(extraManifest, null, 2)}\n`);
  const extra = await rejectionOf(verifyCollectionsSnapshot({ input: extraRoot }));
  assert.equal(extra.report.issues.byCode.ENTITY_SET_MISMATCH, 1);
});

async function createSnapshot(t, { urlCollectionId = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "poapin-collections-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "normalized"), { recursive: true });
  await mkdir(resolve(root, "schema"), { recursive: true });

  const rows = {
    collections: [
      {
        banner_image_url: null,
        created_by: "fixture",
        created_on: "2026-07-22T00:00:00.000Z",
        description: null,
        external_url: null,
        id: 1,
        logo_image_url: null,
        owner_address: null,
        slug: "one",
        title: "One",
        type: "user",
        type_rank: 1,
        updated_on: "2026-07-22T00:00:00.000Z",
        year: 2026,
      },
    ],
    collection_ui_settings: [],
    artists: [],
    artist_drops: [],
    organizations: [],
    verified_collections: [],
    featured_collections: [],
    items: [{ collection_id: 1, created_on: null, drop_id: 10, id: 1 }],
    sections: [{ collection_id: 1, id: SECTION_ID, name: "All", position: 0 }],
    item_sections: [{ item_id: 1, position: 0, section_id: SECTION_ID }],
    suggested_drops: [],
    collection_drop_ids: [{ collection_id: 1, drop_ids: [10] }],
    collection_urls: [
      { collection_id: urlCollectionId, id: 1, url: "https://example.test/collection" },
    ],
    referenced_drops: [{ id: 10, hidden_drop: null, drop_image: null }],
  };

  const artifacts = [];
  for (const [name, tableRows] of Object.entries(rows)) {
    const path = `normalized/${name}.ndjson`;
    const bytes = Buffer.from(
      tableRows.length === 0 ? "" : `${tableRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    await writeFile(resolve(root, path), bytes);
    artifacts.push(artifact(path, bytes, tableRows.length));
  }

  const referencedDropIds = Buffer.from("10\n");
  const referencedDropIdsPath = "normalized/referenced_drop_ids.txt";
  await writeFile(resolve(root, referencedDropIdsPath), referencedDropIds);
  artifacts.push(artifact(referencedDropIdsPath, referencedDropIds, 1));

  const schema = Buffer.from(`${JSON.stringify({ data: { __schema: { types: [] } } }, null, 2)}\n`);
  await writeFile(resolve(root, "schema/introspection.json"), schema);

  const endpoint = "https://example.test/graphql";
  await writeFile(
    resolve(root, "source.json"),
    `${JSON.stringify({ version: 1, dataset: "poap-compass-collections", endpoint }, null, 2)}\n`,
  );

  const entities = Object.fromEntries(
    ENTITY_CONFIGS.map((config) => [
      config.name,
      {
        name: config.name,
        root: config.root,
        rows: rows[config.name].length,
        pages: rows[config.name].length === 0 ? 0 : 1,
        expectedCount: config.aggregateRoot ? rows[config.name].length : null,
        upper: null,
        querySha256: "0".repeat(64),
        startedAt: "2026-07-22T00:00:00.000Z",
        finishedAt: "2026-07-22T00:00:01.000Z",
        complete: true,
      },
    ]),
  );
  const manifest = {
    version: 1,
    dataset: "poap-compass-collections",
    endpoint,
    startedAt: "2026-07-22T00:00:00.000Z",
    finishedAt: "2026-07-22T00:00:01.000Z",
    schema: {
      sha256: digest(schema),
      bytes: schema.byteLength,
      querySha256: digest(INTROSPECTION_QUERY),
    },
    pagination: {
      method: "bounded-keyset",
      pageSize: 100,
      referencedDropsPageSize: 100,
    },
    entities,
    referencedDrops: {
      requested: 1,
      captured: 1,
      missing: [],
      pages: 1,
      querySha256: "0".repeat(64),
      idsSha256: digest(referencedDropIds),
      complete: true,
    },
    normalized: {
      artifacts,
      referencedDropIds: 1,
      referencedDropIdsSha256: digest(referencedDropIds),
    },
    knownGaps: [],
    media: { captured: false },
  };
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function artifact(path, bytes, rows) {
  return { path, sha256: digest(bytes), byteLength: bytes.byteLength, rows };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected promise to reject.");
}
