import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  BUSINESS_TABLES,
  REQUIRED_SCHEMA_TABLES,
  enforceConfiguredTargetGate,
  activate,
  load,
  loadContext,
  preflight,
  verify,
} from "../d1-loader.mjs";
import { bindCollectionsSnapshotInputs, makeFinalizer } from "../lib/d1.mjs";
import { ENTITY_CONFIGS } from "../lib/config.mjs";
import { DROP_SUPPLEMENT_QUERY } from "../lib/drop-supplement.mjs";
import { packageCollectionsSnapshot } from "../lib/package.mjs";

const SNAPSHOT_ID = "collections-2026-07-22-v1";
const SOURCE_SHA256 = "a".repeat(64);
const SCHEMA_SHA256 = "b".repeat(64);
const DATABASE_ID = "371091e1-1eff-4afe-9ff9-c833a4aeda2d";

test("configured Collections target requires both first-launch attestations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-gate-"));
  try {
    const configPath = resolve(root, "wrangler.jsonc");
    await writeFile(configPath, `{ "database_id": "${DATABASE_ID}" }\n`);
    const context = {
      projectConfig: configPath,
      target: { name: "collections", id: DATABASE_ID },
    };
    await assert.rejects(
      enforceConfiguredTargetGate(context, {
        allowConfiguredEmptyTarget: true,
        confirmWorkerNotActivated: false,
      }),
      /both --allow-configured-empty-target and --confirm-worker-not-activated/,
    );
    await enforceConfiguredTargetGate(context, {
      allowConfiguredEmptyTarget: true,
      confirmWorkerNotActivated: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight requires migrated but completely empty staging tables", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-preflight-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    await preflight(context, client);

    client.counts.collections = 1;
    await assert.rejects(preflight(context, client), /not an empty staging database/);
    client.counts.collections = 0;
    client.meta.set("ready", "0");
    await assert.rejects(preflight(context, client), /must remain unactivated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load stops at a failed shard, resumes from verified markers, and never finalizes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-resume-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    const [first, second] = context.dataArtifacts;
    client.failOnce = second.path;

    await assert.rejects(load(context, client), /fixture import failure/);
    assert.equal(client.markers.has(first.path), true);
    assert.equal(client.markers.has(second.path), false);

    await load(context, client);
    await verify(context, client);
    assert.equal(
      client.imports.filter((path) => path === first.path).length,
      1,
      "a committed shard must be skipped during resume",
    );
    assert.equal(
      client.imports.some((path) => path.includes("/prepare/") || path.includes("/finalize/")),
      false,
      "prepare and finalize SQL must never be imported",
    );

    const marker = client.markers.get(first.path);
    client.markers.set(first.path, { ...marker, payload_sha256: "f".repeat(64) });
    await assert.rejects(verify(context, client), /journal marker mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load rejects any remote marker outside the signed artifact plan", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-unknown-marker-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    client.markers.set("d1/load/999999_unknown.sql", {
      snapshot_id: SNAPSHOT_ID,
      source_database_sha256: SOURCE_SHA256,
      shard_path: "d1/load/999999_unknown.sql",
      payload_sha256: "c".repeat(64),
      table_name: "collections",
      row_count: 1,
      statement_count: 1,
    });
    await assert.rejects(load(context, client), /unexpected import marker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify rejects a remote table count that differs from its journal/report", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-count-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    await load(context, client);
    client.counts.collections += 1;
    await assert.rejects(verify(context, client), /count mismatch for collections/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight rejects a missing index, trigger, or changed schema definition", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-schema-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    client.schema.delete("idx_collections_recent");
    await assert.rejects(
      preflight(context, client),
      /schema object mismatch: idx_collections_recent/,
    );

    client.schema = new Map(context.expectedSchemaObjects.map((row) => [row.name, schemaRow(row)]));
    client.schema.delete("collections_fts_after_update");
    await assert.rejects(preflight(context, client), /collections_fts_after_update/);

    client.schema = new Map(context.expectedSchemaObjects.map((row) => [row.name, schemaRow(row)]));
    const fts = client.schema.get("collections_fts");
    client.schema.set("collections_fts", { ...fts, sql: "CREATE TABLE collections_fts(id)" });
    await assert.rejects(preflight(context, client), /collections_fts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify requires FTS synchronization and representative index query plans", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-search-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    await load(context, client);
    client.ftsSearchCount = 1;
    await assert.rejects(verify(context, client), /FTS content row count/);
    client.ftsSearchCount = null;
    client.badRecentPlan = true;
    await assert.rejects(verify(context, client), /idx_collections_recent/);
    client.badRecentPlan = false;
    client.badApprovedPlan = true;
    await assert.rejects(verify(context, client), /idx_suggested_drops_approved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activate accepts only a fully bound second-pass R2 report and reads back metadata", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-activate-"));
  try {
    const context = await fixtureContext(root);
    const client = fakeClient(context);
    await load(context, client);
    const mediaReportPath = resolve(root, "media/publish-verify-report.json");
    await writeFile(mediaReportPath, `${JSON.stringify(mediaReport(context), null, 2)}\n`);
    await activate(context, client, mediaReportPath);
    assert.equal(client.meta.get("ready"), "1");

    const next = await fixtureContext(
      await mkdtemp(resolve(tmpdir(), "poapin-collections-d1-activate-bad-")),
    );
    const badClient = fakeClient(next);
    await load(next, badClient);
    const badPath = resolve(next.root, "media/publish-verify-report.json");
    const bad = mediaReport(next);
    bad.counts.checkpointVerified = bad.counts.uniqueObjects - 1;
    await writeFile(badPath, `${JSON.stringify(bad, null, 2)}\n`);
    await assert.rejects(
      activate(next, badClient, badPath),
      /second-pass remote object verification/,
    );
    assert.equal(badClient.meta.size, 0);
    await rm(next.root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalizer atomically rejects every incomplete or mismatched shard plan", async () => {
  const artifact = {
    path: "d1/load/000001_collections.sql",
    payloadSha256: "c".repeat(64),
    table: "collections",
    rowCount: 1,
    statementCount: 1,
  };
  const rows = Object.fromEntries(
    [
      "collections",
      "referenced_drops",
      "drop_stats_by_chain",
      "items",
      "sections",
      "item_sections",
      "collection_urls",
      "collection_ui_settings",
      "collection_media",
      "artists",
      "artist_drops",
      "organizations",
      "verified_collections",
      "featured_collections",
      "suggested_drops",
    ].map((name) => [name, name === "collections" ? [{}] : []]),
  );
  const finalizer = makeFinalizer({
    snapshotId: SNAPSHOT_ID,
    manifest: {
      finishedAt: "2026-07-22T00:00:01.000Z",
      schema: { sha256: SCHEMA_SHA256 },
    },
    sourceDigest: SOURCE_SHA256,
    rows,
    dataArtifacts: [artifact],
    sourceInputs: { sha256: "d".repeat(64) },
    mediaProof: { version: 2, sha256: "e".repeat(64), objects: 0 },
  });
  const validMarker = {
    snapshot_id: SNAPSHOT_ID,
    source_database_sha256: SOURCE_SHA256,
    shard_path: artifact.path,
    payload_sha256: artifact.payloadSha256,
    table_name: artifact.table,
    row_count: artifact.rowCount,
    statement_count: artifact.statementCount,
  };
  const cases = [
    { label: "valid", marker: validMarker, expected: 1 },
    { label: "missing", marker: null, expected: 0 },
    { label: "snapshot", marker: { ...validMarker, snapshot_id: "other" }, expected: 0 },
    {
      label: "source",
      marker: { ...validMarker, source_database_sha256: "e".repeat(64) },
      expected: 0,
    },
    { label: "path", marker: { ...validMarker, shard_path: "d1/load/other.sql" }, expected: 0 },
    {
      label: "payload",
      marker: { ...validMarker, payload_sha256: "f".repeat(64) },
      expected: 0,
    },
    { label: "table", marker: { ...validMarker, table_name: "collection_items" }, expected: 0 },
    { label: "rows", marker: { ...validMarker, row_count: 2 }, expected: 0 },
    { label: "statements", marker: { ...validMarker, statement_count: 2 }, expected: 0 },
    { label: "extra", marker: validMarker, extra: true, expected: 0 },
    { label: "table-count", marker: validMarker, omitCollection: true, expected: 0 },
  ];
  const schema = await readFile(
    new URL("../../../migrations/collections/0001_schema.sql", import.meta.url),
    "utf8",
  );
  const journalSchema = await readFile(
    new URL("../../../migrations/collections/0002_import_shards.sql", import.meta.url),
    "utf8",
  );
  const supplementSchema = await readFile(
    new URL("../../../migrations/collections/0003_drop_supplement.sql", import.meta.url),
    "utf8",
  );
  for (const scenario of cases) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(schema);
      database.exec(journalSchema);
      database.exec(supplementSchema);
      if (!scenario.omitCollection) {
        database.exec(
          "INSERT INTO collections(collection_id, slug, title, created_on, updated_on) VALUES(1, 'one', 'One', '2026-07-22', '2026-07-22');",
        );
      }
      if (scenario.marker) insertMarker(database, scenario.marker);
      if (scenario.extra) {
        insertMarker(database, { ...validMarker, shard_path: "d1/load/unexpected.sql" });
      }
      database.exec(finalizer);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM collections_meta").get().count,
        scenario.expected ? 18 : 0,
        scenario.label,
      );
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM collections_meta WHERE key='ready' AND value='1'")
          .get().count,
        scenario.expected,
        scenario.label,
      );
    } finally {
      database.close();
    }
  }
});

test("source rebinding rejects post-verify normalized, media, supplement, and validation tampering", async () => {
  for (const target of ["normalized", "media", "supplement", "validation"]) {
    const root = await mkdtemp(resolve(tmpdir(), `poapin-collections-d1-toctou-${target}-`));
    try {
      const context = await fixtureContext(root);
      if (target === "normalized") {
        await writeFile(resolve(root, "normalized/collections.ndjson"), '{"id":999}\n');
      } else if (target === "media") {
        await writeFile(resolve(root, "media/plan.ndjson"), "\n");
      } else if (target === "supplement") {
        await writeFile(
          resolve(root, "drop-supplement/normalized/drop_stats_by_chain.ndjson"),
          '{"drop_id":999}\n',
        );
      } else {
        const reportPath = resolve(root, "validation/report.json");
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        report.finishedAt = "tampered";
        await writeFile(reportPath, `${JSON.stringify(report)}\n`);
      }
      await assert.rejects(
        bindCollectionsSnapshotInputs({ root, snapshotId: context.snapshotId }),
        /changed after verification|stale|checksum\/size differs/,
        target,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("drop supplement binds reviewed request and canonical file query hashes separately", async () => {
  for (const target of ["request", "file"]) {
    const root = await mkdtemp(resolve(tmpdir(), `poapin-collections-query-${target}-`));
    try {
      await fixtureContext(root);
      const manifestPath = resolve(root, "drop-supplement/manifest.json");
      const supplement = JSON.parse(await readFile(manifestPath, "utf8"));
      if (target === "request") {
        supplement.graphql.querySha256 = "f".repeat(64);
      } else {
        const forged = "query Forged { drops { id } }\n";
        await writeFile(
          resolve(root, "drop-supplement/queries/referenced-drop-supplement.graphql"),
          forged,
        );
        supplement.graphql.queryFileSha256 = digest(forged);
      }
      await writeFile(manifestPath, `${JSON.stringify(supplement, null, 2)}\n`);
      await assert.rejects(
        bindCollectionsSnapshotInputs({ root, snapshotId: SNAPSHOT_ID }),
        target === "request"
          ? /request query checksum differs from the reviewed exporter/
          : /stored query checksum\/size differs|stored query bytes differ/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("loader rejects a media proof plan changed after the D1 report", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-proof-toctou-"));
  try {
    await fixtureContext(root);
    await writeFile(
      resolve(root, "d1/media/publication-plan.ndjson"),
      `${JSON.stringify({ key: "tampered", disposition: "reuse" })}\n`,
    );
    await assert.rejects(
      loadContext({
        inputDirectory: root,
        target: { name: "poapin-archive-collections", id: DATABASE_ID },
        projectConfig: resolve(root, "not-configured.jsonc"),
      }),
      /media proof manifest checksum\/size differs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package refuses a validation report changed after the D1 build", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-package-toctou-"));
  try {
    await fixtureContext(root);
    const reportPath = resolve(root, "validation/report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.finishedAt = "tampered";
    await writeFile(reportPath, `${JSON.stringify(report)}\n`);
    await assert.rejects(
      packageCollectionsSnapshot({
        input: root,
        output: resolve(root, "..", `${root.split("/").at(-1)}.tar.gz`),
      }),
      /checksum sidecar is stale/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package rejects a media proof publication plan changed after build", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-collections-package-proof-"));
  try {
    await fixtureContext(root);
    await writeFile(resolve(root, "d1/media/publication-plan.ndjson"), '{"key":"tampered"}\n');
    await assert.rejects(
      packageCollectionsSnapshot({
        input: root,
        output: resolve(root, "..", `${root.split("/").at(-1)}.tar.gz`),
      }),
      /media proof publication plan changed after build/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureContext(root) {
  const artifacts = [];
  const addArtifact = async (path, contents, metadata) => {
    const absolutePath = resolve(root, path);
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents);
    artifacts.push({
      path,
      byteLength: Buffer.byteLength(contents),
      sha256: digest(contents),
      kind: "d1-sql",
      database: "collections",
      ...metadata,
    });
  };

  await addArtifact(
    "d1/prepare/000001_schema.sql",
    await readFile(
      new URL("../../../migrations/collections/0001_schema.sql", import.meta.url),
      "utf8",
    ),
    { phase: "prepare" },
  );
  await addArtifact(
    "d1/prepare/000002_import_shards.sql",
    await readFile(
      new URL("../../../migrations/collections/0002_import_shards.sql", import.meta.url),
      "utf8",
    ),
    { phase: "prepare" },
  );
  await addArtifact(
    "d1/prepare/000003_drop_supplement.sql",
    await readFile(
      new URL("../../../migrations/collections/0003_drop_supplement.sql", import.meta.url),
      "utf8",
    ),
    { phase: "prepare" },
  );
  await addDataArtifact({
    addArtifact,
    path: "d1/load/000001_collections.sql",
    table: "collections",
    rowCount: 2,
  });
  await addDataArtifact({
    addArtifact,
    path: "d1/load/002001_collection_items.sql",
    table: "collection_items",
    rowCount: 1,
  });
  await addArtifact(
    "d1/finalize/999999_finalize.sql",
    "INSERT INTO collections_meta VALUES ('ready', '1');\n",
    { phase: "finalize" },
  );

  const manifest = {
    version: 1,
    dataset: "poap-compass-collections",
    endpoint: "https://public.compass.poap.tech/v1/graphql",
    startedAt: "2026-07-22T00:00:00.000Z",
    finishedAt: "2026-07-22T00:00:01.000Z",
    schema: { sha256: SCHEMA_SHA256 },
    entities: Object.fromEntries(
      ENTITY_CONFIGS.map((config) => [
        config.name,
        {
          rows: config.name === "collections" ? 2 : config.name === "items" ? 1 : 0,
          expectedCount: config.name === "collections" ? 2 : config.name === "items" ? 1 : 0,
          complete: true,
        },
      ]),
    ),
    media: {
      captured: true,
      complete: true,
      publishable: true,
      manifest: "media/manifest.json",
      referencesSha256: digest("\n"),
      references: 0,
      uniqueObjects: 0,
      counts: { stored: 0, missing: 0, quarantined: 0, failed: 0 },
    },
    consistency: {
      status: "stable-two-pass",
      comparedAt: "2026-07-22T00:00:02.000Z",
      report: "validation/stability.json",
    },
  };
  const normalizedRows = Object.fromEntries(
    [
      ...ENTITY_CONFIGS.map((config) => config.name),
      "collection_urls",
      "referenced_drops",
      "referenced_drop_ids",
    ].map((name) => [name, name === "collections" ? 2 : name === "items" ? 1 : 0]),
  );
  const normalizedArtifacts = [];
  await mkdir(resolve(root, "normalized"), { recursive: true });
  for (const [name, rows] of Object.entries(normalizedRows)) {
    const path = `normalized/${name}.${name === "referenced_drop_ids" ? "txt" : "ndjson"}`;
    const contents =
      rows === 0
        ? ""
        : `${Array.from({ length: rows }, (_, index) => JSON.stringify({ id: index + 1 })).join("\n")}\n`;
    await writeFile(resolve(root, path), contents);
    normalizedArtifacts.push({
      path,
      sha256: digest(contents),
      byteLength: Buffer.byteLength(contents),
      rows,
    });
  }
  manifest.normalized = { artifacts: normalizedArtifacts };
  await mkdir(resolve(root, "media"), { recursive: true });
  await writeFile(resolve(root, "media/plan.ndjson"), "");
  await writeFile(
    resolve(root, "media/checkpoint.ndjson"),
    `${JSON.stringify({ kind: "header", version: 1, referencesSha256: digest("\n") })}\n`,
  );
  await writeFile(
    resolve(root, "media/manifest.json"),
    `${JSON.stringify({
      version: 1,
      dataset: "poap-compass-collection-media",
      complete: true,
      publishable: true,
      attemptedAll: true,
      quarantinedReferencesAreExcluded: true,
      checkpoint: "media/checkpoint.ndjson",
      referencesSha256: digest("\n"),
      references: 0,
      uniqueObjects: 0,
      counts: { stored: 0, missing: 0, quarantined: 0, failed: 0 },
    })}\n`,
  );
  await mkdir(resolve(root, "validation"), { recursive: true });
  await writeFile(
    resolve(root, "validation/stability.json"),
    `${JSON.stringify({
      version: 1,
      stable: true,
      consistency: "stable-two-pass",
      comparedAt: manifest.consistency.comparedAt,
      primary: {
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt,
        schemaSha256: SCHEMA_SHA256,
      },
      artifactsCompared: normalizedArtifacts.length,
      mismatches: [],
    })}\n`,
  );
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolve(root, "manifest.json"), manifestSource);
  const manifestSha256 = digest(manifestSource);
  const checksumPaths = [
    "manifest.json",
    "validation/stability.json",
    ...normalizedArtifacts.map((artifact) => artifact.path),
    "media/manifest.json",
    "media/plan.ndjson",
    "media/checkpoint.ndjson",
  ].sort();
  const checksumsSource = `${(
    await Promise.all(
      checksumPaths.map(async (path) => `${digest(await readFile(resolve(root, path)))}  ${path}`),
    )
  ).join("\n")}\n`;
  await writeFile(resolve(root, "checksums.sha256"), checksumsSource);
  const validation = {
    version: 1,
    dataset: manifest.dataset,
    verified: true,
    manifest: { sha256: manifestSha256, byteLength: Buffer.byteLength(manifestSource) },
    schema: { checked: true, sha256: SCHEMA_SHA256 },
    normalized: { checked: 1, expected: 1 },
    relationships: { checked: true },
    media: {
      checked: true,
      complete: true,
      references: 0,
      checkpointRecords: 0,
      objectsChecked: 0,
      uniqueObjects: 0,
      statuses: { stored: 0, missing: 0, quarantined: 0, failed: 0 },
    },
    checksums: {
      path: "checksums.sha256",
      entries: checksumPaths.length,
      sha256: digest(checksumsSource),
      byteLength: Buffer.byteLength(checksumsSource),
    },
  };
  const validationSource = `${JSON.stringify(validation)}\n`;
  await writeFile(resolve(root, "validation/report.json"), validationSource);
  await writeFile(
    resolve(root, "validation/report.sha256"),
    `${digest(validationSource)}  validation/report.json\n`,
  );

  await writeEmptyDropSupplement({ root, manifestSource, normalizedArtifacts });

  const sourceInputs = await bindCollectionsSnapshotInputs({
    root,
    manifest,
    validation,
    snapshotId: SNAPSHOT_ID,
  });

  const tables = Object.fromEntries(BUSINESS_TABLES.map((table) => [table, 0]));
  tables.collections = 2;
  tables.collection_items = 1;
  const mediaProofSource = "\n";
  await mkdir(resolve(root, "d1/media"), { recursive: true });
  await writeFile(resolve(root, "d1/media/publication-plan.ndjson"), mediaProofSource);
  const mediaProofManifest = {
    path: "d1/media/publication-plan.ndjson",
    byteLength: Buffer.byteLength(mediaProofSource),
    sha256: digest(mediaProofSource),
    rows: 0,
  };
  const report = {
    version: 1,
    snapshotId: SNAPSHOT_ID,
    sourceManifestSha256: manifestSha256,
    sourceValidationSha256: sourceInputs.validation.sha256,
    sourceInputsSha256: sourceInputs.sha256,
    sourceInputs,
    mediaProof: {
      version: 2,
      sha256: mediaProofManifest.sha256,
      objects: 0,
      manifest: mediaProofManifest,
      counts: {
        collectionMedia: 0,
        archiveDropArtwork: 0,
        collectionDropArtwork: 0,
        upload: 0,
        reuse: 0,
      },
      provenance: {
        snapshotId: SNAPSHOT_ID,
        collectionsMediaSha256: sourceInputs.media.eligibleObjectsSha256,
        dropSupplementSha256: sourceInputs.dropSupplement.sha256,
        archiveMedia: sourceInputs.dropSupplement.provenance.archiveMedia,
      },
    },
    sourceDatabaseSha256: SOURCE_SHA256,
    schemaSha256: SCHEMA_SHA256,
    tables,
    artifacts,
  };
  await writeFile(resolve(root, "d1/report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const context = await loadContext({
    inputDirectory: root,
    target: { name: "poapin-archive-collections", id: DATABASE_ID },
    projectConfig: resolve(root, "not-configured.jsonc"),
  });
  context.root = root;
  return context;
}

async function writeEmptyDropSupplement({ root, manifestSource, normalizedArtifacts }) {
  const supplementRoot = resolve(root, "drop-supplement");
  const write = async (path, contents) => {
    const absolute = resolve(supplementRoot, path);
    await mkdir(resolve(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
    return { path, sha256: digest(contents), byteLength: Buffer.byteLength(contents) };
  };
  const schemaSource = "{}\n";
  await mkdir(resolve(root, "schema"), { recursive: true });
  await writeFile(resolve(root, "schema/introspection.json"), schemaSource);
  const referencedDropIds = normalizedArtifacts.find(
    (artifact) => artifact.path === "normalized/referenced_drop_ids.txt",
  );
  const referencedDrops = normalizedArtifacts.find(
    (artifact) => artifact.path === "normalized/referenced_drops.ndjson",
  );
  const source = {
    endpoint: "https://public.compass.poap.tech/v1/graphql",
    manifest: {
      path: "manifest.json",
      sha256: digest(manifestSource),
      byteLength: Buffer.byteLength(manifestSource),
    },
    schema: {
      path: "schema/introspection.json",
      sha256: digest(schemaSource),
      byteLength: Buffer.byteLength(schemaSource),
    },
    referencedDropIds: {
      path: referencedDropIds.path,
      sha256: referencedDropIds.sha256,
      byteLength: referencedDropIds.byteLength,
    },
    referencedDrops: {
      path: referencedDrops.path,
      sha256: referencedDrops.sha256,
      byteLength: referencedDrops.byteLength,
    },
    referencedDropCount: 0,
  };
  const query = await write(
    "queries/referenced-drop-supplement.graphql",
    `${DROP_SUPPLEMENT_QUERY.trim()}\n`,
  );
  const relations = [];
  for (const path of [
    "normalized/drop_stats_by_chain.ndjson",
    "normalized/email_claims_stats.ndjson",
    "normalized/featured_drops.ndjson",
    "normalized/moments_stats.ndjson",
  ]) {
    relations.push({ ...(await write(path, "")), rows: 0 });
  }
  const plan = await write("artwork/plan.ndjson", "\n");
  const checkpointHeader = {
    kind: "header",
    version: 1,
    dataset: "poap-compass-referenced-drop-artwork",
    bindingSha256: digest(JSON.stringify(source)),
    planSha256: plan.sha256,
    archiveCatalogSha256: null,
    archiveMediaManifestSha256: null,
    archiveUploadReportSha256: null,
    archiveSnapshotId: null,
  };
  const checkpoint = await write(
    "artwork/checkpoint.ndjson",
    `${JSON.stringify(checkpointHeader)}\n`,
  );
  const references = { ...(await write("artwork/references.ndjson", "")), rows: 0 };
  const archiveCatalog = { ...(await write("normalized/archive_catalog.ndjson", "")), rows: 0 };
  const supplement = {
    version: 1,
    dataset: "poap-compass-referenced-drop-supplement",
    source,
    graphql: {
      query: query.path,
      querySha256: digest(DROP_SUPPLEMENT_QUERY),
      queryFileSha256: query.sha256,
      pageSize: 100,
      referencedDrops: 0,
      pages: 0,
      counts: { statsByChain: 0, emailClaimsStats: 0, featuredDrops: 0, momentsStats: 0 },
      artifacts: relations,
      rawArtifacts: [],
      complete: true,
    },
    archiveCatalog: { used: false, matchedDrops: 0, catalogArtworkFlags: 0 },
    archiveMedia: { used: false, verifiedPublishedObjects: 0 },
    artwork: {
      references: 0,
      plan: { path: plan.path, sha256: plan.sha256 },
      checkpoint: checkpoint.path,
      artifacts: [archiveCatalog, references],
      counts: { reused: 0, downloaded: 0, quarantined: 0, failed: 0, missing: 0, pending: 0 },
      uniqueDownloadedObjects: 0,
      uniqueQuarantinedObjects: 0,
      attemptedAll: true,
      complete: true,
      publishable: true,
      quarantinedReferencesAreExcluded: true,
    },
    complete: true,
    publishable: true,
    quarantinedReferencesAreExcluded: true,
  };
  await writeFile(
    resolve(supplementRoot, "manifest.json"),
    `${JSON.stringify(supplement, null, 2)}\n`,
  );
}

async function addDataArtifact({ addArtifact, path, table, rowCount }) {
  const payload = `INSERT INTO ${table} DEFAULT VALUES;\n`;
  await addArtifact(path, `${payload}-- import marker\n`, {
    phase: "load",
    table,
    rowCount,
    statementCount: 1,
    payloadSha256: digest(payload),
  });
}

function fakeClient(context) {
  const counts = Object.fromEntries(BUSINESS_TABLES.map((table) => [table, 0]));
  return {
    imports: [],
    markers: new Map(),
    meta: new Map(),
    counts,
    schema: new Map(context.expectedSchemaObjects.map((row) => [row.name, schemaRow(row)])),
    failOnce: null,
    ftsSearchCount: null,
    badRecentPlan: false,
    badApprovedPlan: false,
    async query(sql) {
      if (sql.includes("FROM sqlite_schema")) {
        return [...this.schema.values()];
      }
      if (sql.includes('AS "count_0"')) {
        const values = [
          this.meta.size,
          this.markers.size,
          ...BUSINESS_TABLES.map((t) => counts[t]),
        ];
        return [Object.fromEntries(values.map((value, index) => [`count_${index}`, value]))];
      }
      if (sql.includes("FROM import_shards ORDER BY")) return [...this.markers.values()];
      if (sql.includes("FROM import_shards WHERE")) {
        const match = sql.match(/shard_path = '([^']+)'/);
        const marker = match ? this.markers.get(match[1]) : null;
        return marker ? [marker] : [];
      }
      if (sql.startsWith("SELECT COUNT(*) AS row_count")) {
        const match = sql.match(/FROM "([^"]+)"/);
        return [{ row_count: counts[match[1]] }];
      }
      if (sql === "PRAGMA foreign_key_check;") return [];
      if (sql.includes("AS source_count") && sql.includes("AS search_count")) {
        return [
          {
            source_count: counts.collections,
            search_count: this.ftsSearchCount ?? counts.collections,
          },
        ];
      }
      if (sql.startsWith("INSERT INTO collections_fts(collections_fts, rank)")) return [];
      if (sql.startsWith("SELECT rowid FROM collections_fts WHERE")) return [];
      if (sql.startsWith("EXPLAIN QUERY PLAN SELECT collection_id FROM collections")) {
        return [
          {
            detail: this.badRecentPlan
              ? "SCAN collections"
              : "SCAN collections USING COVERING INDEX idx_collections_recent",
          },
        ];
      }
      if (sql.startsWith("EXPLAIN QUERY PLAN SELECT rowid FROM collections_fts")) {
        return [{ detail: "SCAN collections_fts VIRTUAL TABLE INDEX 0:M3" }];
      }
      if (sql.startsWith("EXPLAIN QUERY PLAN SELECT suggestion_id FROM suggested_drops")) {
        return [
          {
            detail: this.badApprovedPlan
              ? "SCAN suggested_drops"
              : "SEARCH suggested_drops USING INDEX idx_suggested_drops_approved",
          },
        ];
      }
      if (sql === "SELECT key, value FROM collections_meta ORDER BY key;") {
        return [...this.meta].map(([key, value]) => ({ key, value }));
      }
      throw new Error(`Unexpected fake query: ${sql}`);
    },
    async importFile(filePath) {
      const artifact = [...context.artifacts.values()].find(
        (candidate) => candidate.absolutePath === filePath,
      );
      this.imports.push(artifact.path);
      if (this.failOnce === artifact.path) {
        this.failOnce = null;
        throw new Error("fixture import failure");
      }
      if (artifact.phase === "finalize") {
        this.meta = expectedFixtureMetadata(context);
        return;
      }
      if (artifact.phase !== "load") throw new Error("fixture imported a non-load artifact");
      counts[artifact.table] += artifact.rowCount;
      this.markers.set(artifact.path, {
        snapshot_id: SNAPSHOT_ID,
        source_database_sha256: SOURCE_SHA256,
        shard_path: artifact.path,
        payload_sha256: artifact.payloadSha256,
        table_name: artifact.table,
        row_count: artifact.rowCount,
        statement_count: artifact.statementCount,
      });
    },
  };
}

function schemaRow(row) {
  return { type: row.type, name: row.name, tbl_name: row.table, sql: row.sql };
}

function insertMarker(database, marker) {
  database
    .prepare(
      `INSERT INTO import_shards(
        snapshot_id, source_database_sha256, shard_path, payload_sha256,
        table_name, row_count, statement_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    )
    .run(
      marker.snapshot_id,
      marker.source_database_sha256,
      marker.shard_path,
      marker.payload_sha256,
      marker.table_name,
      marker.row_count,
      marker.statement_count,
    );
}

function expectedFixtureMetadata(context) {
  return new Map(
    Object.entries({
      snapshot_id: context.snapshotId,
      snapshot_at: context.manifest.finishedAt,
      schema_version: "3",
      importer_version: "collections-backup-v2",
      source_schema_sha256: context.manifest.schema.sha256,
      source_database_sha256: context.sourceDatabaseSha256,
      source_inputs_sha256: context.sourceInputs.sha256,
      media_proof_sha256: context.report.mediaProof.sha256,
      media_objects_count: String(context.report.mediaProof.objects),
      consistency: "stable-two-pass",
      collections_count: String(context.report.tables.collections),
      items_count: String(context.report.tables.collection_items),
      sections_count: String(context.report.tables.collection_sections),
      item_sections_count: String(context.report.tables.collection_item_sections),
      drop_cards_count: String(context.report.tables.collection_drop_cards),
      drop_stats_by_chain_count: String(context.report.tables.collection_drop_stats_by_chain),
      media_count: String(context.report.tables.collection_media),
      ready: "1",
    }),
  );
}

function mediaReport(context) {
  const inputs = context.sourceInputs;
  return {
    version: 1,
    dataset: "poapin-collections-media-publication",
    ok: true,
    complete: true,
    publishable: true,
    snapshotId: context.snapshotId,
    manifests: {
      snapshot: inputs.manifest,
      validationReport: inputs.validation,
      dropSupplement: inputs.dropSupplement.manifest,
      d1: { sha256: context.reportSha256 },
      mediaProof: {
        sha256: context.report.mediaProof.sha256,
        objects: context.report.mediaProof.objects,
        manifest: context.report.mediaProof.manifest,
      },
    },
    target: {
      bucket: "poapin-archive",
      objectPrefix: `snapshots/${context.snapshotId}/collections/media/sha256/`,
    },
    counts: {
      uniqueObjects: context.report.mediaProof.objects,
      checkpointVerified: context.report.mediaProof.objects,
      uploaded: 0,
      reused: 0,
      failed: 0,
    },
    failures: [],
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
