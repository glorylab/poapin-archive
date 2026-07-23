import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { activate, auditD1Sql, load, loadContext, preflight, verify } from "../d1-loader.mjs";
import { compareMomentsSnapshots } from "../lib/compare.mjs";
import { buildMomentsD1 } from "../lib/d1.mjs";
import { captureMomentsSnapshot } from "../lib/snapshot.mjs";
import { MockGraphqlClient } from "./helpers.mjs";

const DATABASE_ID = "34c5add5-3057-463d-9863-de9cd565ae64";

test("Moments loader stages, verifies, and explicitly activates a metadata-only build", async () => {
  const fixture = await buildFixture("metadata-only");
  const database = new DatabaseSync(":memory:");
  const client = sqliteClient(database);
  try {
    const context = await loadContext(contextOptions(fixture.d1.output));
    await preflight(context, client);
    await load(context, client);
    await load(context, client);

    const verification = await verify(context, client);
    assert.equal(verification.media.mode, "metadata-only");
    assert.equal(verification.media.ready, false);
    assert.equal(verification.media.statuses.pending, verification.media.rows);
    assert.match(verification.media.note, /not part of this release/);
    assert.equal(verification.publicProjection.invalidPublicMoments, 0);
    assert.equal(verification.integrity.foreignKeyViolations, 0);
    assert.equal(
      database.prepare("SELECT value FROM moments_meta WHERE key='ready';").get().value,
      "0",
    );
    assert.throws(
      () => database.exec("UPDATE moment_visibility SET is_public = 1 - is_public;"),
      /source table moment_visibility is immutable/,
    );
    assert.throws(
      () => database.exec("UPDATE moments SET description = 'changed';"),
      /source table moments is immutable/,
    );
    assert.throws(
      () => database.exec("DELETE FROM import_shards WHERE table_name = 'moments';"),
      /import journal is immutable/,
    );
    assert.throws(
      () =>
        database.exec(
          "INSERT INTO moment_suppressions (moment_id, reason_code, suppressed_on, active) SELECT moment_id, 'test', '2026-07-23T00:00:00.000Z', 1 FROM moments LIMIT 1;",
        ),
      /require an activated snapshot/,
    );

    await assert.rejects(
      activate(context, client, verification.reportPath),
      /requires --allow-metadata-only/,
    );
    const activation = await activate(context, client, verification.reportPath, {
      allowMetadataOnly: true,
    });
    assert.equal(activation.activated, true);
    assert.equal(
      database.prepare("SELECT value FROM moments_meta WHERE key='ready';").get().value,
      "1",
    );
    const reportSha = database
      .prepare("SELECT value FROM moments_meta WHERE key='activation_report_sha256';")
      .get().value;
    assert.match(reportSha, /^[0-9a-f]{64}$/);

    const retry = await activate(context, client, verification.reportPath, {
      allowMetadataOnly: true,
    });
    assert.equal(retry.alreadyActivated, true);
    database.exec(
      "INSERT INTO moment_suppressions (moment_id, reason_code, suppressed_on, active) SELECT moment_id, 'test', '2026-07-23T00:00:00.000Z', 1 FROM public_moments LIMIT 1;",
    );
    assert.throws(
      () => database.exec("DELETE FROM moment_suppressions;"),
      /suppressions are monotonic/,
    );
  } finally {
    database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Moments loader rejects non-pristine targets, unjournaled rows, and changed artifacts", async () => {
  const fixture = await buildFixture("guards");
  const context = await loadContext(contextOptions(fixture.d1.output));

  const nonEmpty = new DatabaseSync(":memory:");
  try {
    nonEmpty.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
    await assert.rejects(
      preflight(context, sqliteClient(nonEmpty)),
      /partial, changed, or contains unexpected objects/,
    );
  } finally {
    nonEmpty.close();
  }

  const changed = new DatabaseSync(":memory:");
  try {
    const client = sqliteClient(changed);
    await load(context, client);
    changed.exec(
      `INSERT INTO import_shards (snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count)
       VALUES ('moments-test-v1', '${"0".repeat(64)}', 'load/999999_unknown.sql', '${"1".repeat(64)}', 'moments', 1, 1);`,
    );
    await assert.rejects(verify(context, client), /unexpected import marker/);
  } finally {
    changed.close();
  }

  const artifact = context.dataArtifacts[0];
  await writeFile(
    artifact.absolutePath,
    `${await readFile(artifact.absolutePath, "utf8")}-- changed\n`,
  );
  await assert.rejects(
    loadContext(contextOptions(fixture.d1.output)),
    /artifact checksum\/size mismatch/,
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test("Moments loader imports only a freshly validated private artifact copy", async () => {
  const fixture = await buildFixture("artifact-copy");
  const context = await loadContext(contextOptions(fixture.d1.output));
  const artifact = context.dataArtifacts.find((entry) => entry.table === "moments");
  const source = await readFile(artifact.absolutePath, "utf8");
  assert.match(source, /First moment/);
  await writeFile(artifact.absolutePath, source.replace("First moment", "Other moment"));

  const database = new DatabaseSync(":memory:");
  try {
    await assert.rejects(load(context, sqliteClient(database)), /artifact changed before import/);
    assert.equal(
      database.prepare("SELECT value FROM moments_meta WHERE key='ready';").get()?.value,
      undefined,
    );
  } finally {
    database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Moments activation gate rejects a state change in the final activation window", async () => {
  const fixture = await buildFixture("activation-gate");
  const database = new DatabaseSync(":memory:");
  const client = sqliteClient(database);
  try {
    const context = await loadContext(contextOptions(fixture.d1.output));
    await load(context, client);
    const verification = await verify(context, client);
    let injected = false;
    const racingClient = sqliteClient(database, {
      beforeQuery(sql) {
        if (injected || !sql.startsWith("UPDATE moments_meta SET value = '1'")) return;
        injected = true;
        database.exec(
          `INSERT INTO import_shards (snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count)
           VALUES ('moments-test-v1', '${"0".repeat(64)}', 'load/999999_race.sql', '${"1".repeat(64)}', 'moments', 1, 1);`,
        );
      },
    });
    await assert.rejects(
      activate(context, racingClient, verification.reportPath, { allowMetadataOnly: true }),
      /atomic activation gate rejected/,
    );
    assert.equal(injected, true);
    assert.equal(
      database.prepare("SELECT value FROM moments_meta WHERE key='ready';").get().value,
      "0",
    );
  } finally {
    database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("D1 SQL audit measures UTF-8 statements and rejects explicit transactions", () => {
  const transaction = auditD1Sql(
    "-- staged\nBEGIN TRANSACTION;\nINSERT INTO t VALUES ('COMMIT;');\nCOMMIT;\n",
  );
  assert.deepEqual(transaction.explicitTransactions, ["begin", "commit"]);
  assert.equal(transaction.statements, 3);

  const oversized = auditD1Sql(`INSERT INTO t VALUES ('${"界".repeat(34_000)}');`);
  assert.ok(oversized.maxStatementBytes > 100_000);
});

async function buildFixture(label) {
  const root = await mkdtemp(resolve(tmpdir(), `poapin-moments-loader-${label}-`));
  await captureMomentsSnapshot({
    output: root,
    endpoint: "https://example.invalid/graphql",
    pageSize: 1,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  const secondary = resolve(root, ".stability-secondary");
  await captureMomentsSnapshot({
    output: secondary,
    endpoint: "https://example.invalid/graphql",
    pageSize: 1,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  await compareMomentsSnapshots({
    primary: root,
    secondary,
    output: resolve(root, "validation/stability.json"),
  });
  const d1 = await buildMomentsD1({
    input: root,
    output: resolve(root, "d1-build"),
    snapshotId: "moments-test-v1",
  });
  return { root, d1 };
}

function contextOptions(inputDirectory) {
  return {
    inputDirectory,
    target: { name: "poapin-moments-test", id: DATABASE_ID },
    projectConfig: resolve(inputDirectory, "missing-wrangler.jsonc"),
  };
}

function sqliteClient(database, { beforeQuery = null } = {}) {
  return {
    async query(sql) {
      await beforeQuery?.(sql);
      const prefix = sql
        .trimStart()
        .match(/^([a-z]+)/i)?.[1]
        ?.toLowerCase();
      if (["select", "pragma", "explain"].includes(prefix)) {
        return database.prepare(sql).all();
      }
      database.exec(sql);
      return [];
    },
    async importFile(path) {
      database.exec(await readFile(path, "utf8"));
    },
    async close() {},
  };
}
