import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importArchive } from "../lib/importer.mjs";
import { sqlLiteral } from "../lib/sql-shards.mjs";
import { normalizeAddress } from "../lib/util.mjs";
import { verifyImportOutput } from "../lib/verifier.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MIGRATIONS_ROOT = resolve(PROJECT_ROOT, "migrations");

test("normalizes addresses and safely emits SQL literals", () => {
  assert.equal(
    normalizeAddress("0xAbCdEf0000000000000000000000000000000000"),
    "0xabcdef0000000000000000000000000000000000",
  );
  assert.equal(normalizeAddress("0x1234"), null);
  assert.equal(sqlLiteral("Kira's\nPOAP"), "'Kira''s\nPOAP'");
  assert.match(sqlLiteral("a\u0000b"), /^CAST\(X'[0-9a-f]+' AS TEXT\)$/);
});

test("generates deterministic D1 shards, quality report, and R2 manifest", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "poapin-import-test-"));
  try {
    const sourceDatabase = resolve(temporaryRoot, "poap.sqlite");
    const artworkDirectory = resolve(temporaryRoot, "artwork");
    const outputOne = resolve(temporaryRoot, "output-one");
    const outputTwo = resolve(temporaryRoot, "output-two");
    await mkdir(artworkDirectory);
    execFileSync("sqlite3", [sourceDatabase], { input: SOURCE_FIXTURE_SQL });
    const minimalWebp = Buffer.from("524946460400000057454250", "hex");
    await Promise.all([
      writeFile(resolve(artworkDirectory, "1.webp"), minimalWebp),
      writeFile(resolve(artworkDirectory, "2.webp"), minimalWebp),
    ]);

    const commonOptions = {
      databasePath: sourceDatabase,
      artworkDirectory,
      sourceUrl: "https://poap.in",
      retrievedAt: "2026-07-22T00:00:00.000Z",
      maxShardBytes: 2_048,
      maxStatementBytes: 1_024,
      rowsPerStatement: 2,
    };
    const first = await importArchive({ ...commonOptions, outputDirectory: outputOne });
    const second = await importArchive({ ...commonOptions, outputDirectory: outputTwo });

    assert.deepEqual(first.report, second.report);
    assert.equal(first.report.snapshot.id, "2026-07-02-v1");
    assert.deepEqual(first.report.counts.accepted, {
      drops: 2,
      tokens: 3,
      owners: 2,
      emailReservationStats: 1,
      artworks: 2,
    });
    assert.deepEqual(first.report.quality.blockingIssues, []);
    assert.equal(first.report.quality.tokens.normalizedAddressesChanged, 2);
    assert.equal(first.report.quality.tokens.duplicatePoapIds, 1);
    assert.equal(first.report.quality.tokens.duplicatePoapExtraRows, 1);

    const manifestLines = (await readFile(resolve(outputOne, "r2/artwork-manifest.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      manifestLines.map((row) => row.object.key),
      ["snapshots/2026-07-02-v1/artwork/1.webp", "snapshots/2026-07-02-v1/artwork/2.webp"],
    );
    assert.ok(manifestLines.every((row) => row.eligibleForPublish));
    assert.ok(manifestLines.every((row) => row.snapshotId === "2026-07-02-v1"));
    assert.ok(
      manifestLines.every((row) => row.object.publicUrl.startsWith("https://media.poap.in/")),
    );

    const holdingSqlFiles = (await readdir(resolve(outputOne, "holdings"))).filter((name) =>
      name.includes("_tokens.sql"),
    );
    const holdingSql = (
      await Promise.all(
        holdingSqlFiles.map((name) => readFile(resolve(outputOne, "holdings", name), "utf8")),
      )
    ).join("\n");
    assert.match(holdingSql, /"owner_address_norm"/);
    assert.doesNotMatch(holdingSql, /"owner_address",/);

    const verification = await verifyImportOutput({
      inputDirectory: outputOne,
      migrationsRoot: MIGRATIONS_ROOT,
    });
    assert.equal(verification.verified, true);
    assert.equal(verification.catalog.drops, 2);
    assert.equal(verification.holdings.tokens, 3);
    assert.match(verification.ownerLookupPlan.join("\n"), /PRIMARY KEY/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

const SOURCE_FIXTURE_SQL = `
CREATE TABLE drops (
  drop_id INTEGER PRIMARY KEY,
  fancy_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  city TEXT,
  country TEXT,
  event_url TEXT,
  year INTEGER NOT NULL,
  is_virtual INTEGER,
  is_private INTEGER NOT NULL,
  channel TEXT,
  platform TEXT,
  location_type TEXT,
  timezone TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tokens (
  source_uid TEXT PRIMARY KEY,
  poap_id INTEGER NOT NULL,
  drop_id INTEGER,
  minted_on INTEGER,
  owner_address TEXT NOT NULL,
  network TEXT NOT NULL,
  transfer_count INTEGER NOT NULL
);
CREATE TABLE email_reservation_stats (
  drop_id INTEGER PRIMARY KEY,
  email_reservations_total INTEGER NOT NULL,
  email_reservations_minted INTEGER NOT NULL,
  email_reservations_unminted INTEGER NOT NULL
);
CREATE TABLE snapshot_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

INSERT INTO drops VALUES
  (1, 'first', 'First', 'Kira''s first POAP', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'Tokyo', 'Japan', 'https://poap.in', 2026, 0, 0, NULL, NULL, NULL, 'Asia/Tokyo', '2026-07-01T00:00:00.000Z'),
  (2, 'second', 'Second', 'Line one\nLine two', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', NULL, NULL, NULL, 2025, 1, 0, 'community', 'online', 'virtual', 'UTC', '2025-01-01T00:00:00.000Z');
INSERT INTO tokens VALUES
  ('00000000000000000000000000000001', 100, 1, 1751328000, '0xAbCdEf0000000000000000000000000000000000', 'xdai', 1),
  ('00000000000000000000000000000002', 100, 2, 1735689600, '0xABCDEF0000000000000000000000000000000000', 'xdai', 0),
  ('00000000000000000000000000000003', 101, 2, 1735689700, '0x1111111111111111111111111111111111111111', 'mainnet', 2);
INSERT INTO email_reservation_stats VALUES (1, 3, 2, 1);
INSERT INTO snapshot_metadata VALUES
  ('schema_version', '1'),
  ('snapshot_at', '2026-07-02T14:28:17.259Z'),
  ('generated_at', '2026-07-02T14:49:32.049Z'),
  ('drops_count', '2'),
  ('tokens_count', '3'),
  ('email_reservation_stats_count', '1');
`;
