import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

test("Collections migrations and fixture preserve duplicate slugs and foreign keys", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    for (const path of [
      "../../../migrations/collections/0001_schema.sql",
      "../../../migrations/collections/0002_import_shards.sql",
      "../../../migrations/collections/0003_drop_supplement.sql",
      "../../../fixtures/collections.sql",
    ]) {
      database.exec(await readFile(new URL(path, import.meta.url), "utf8"));
    }

    assert.equal(database.prepare("PRAGMA integrity_check;").get().integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check;").all(), []);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM collections WHERE slug = 'shared-history'")
        .get().count,
      2,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM collections_fts").get().count, 4);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM collection_drop_cards WHERE private_value='false' AND is_private=0",
        )
        .get().count,
      3,
    );
    assert.throws(() =>
      database.exec("UPDATE collection_drop_cards SET is_private=0 WHERE drop_id=1002;"),
    );
    database.exec("UPDATE collection_drop_cards SET private_value='false' WHERE drop_id=1002;");
    assert.equal(
      database.prepare("SELECT is_private FROM collection_drop_cards WHERE drop_id=1002").get()
        .is_private,
      0,
    );
    database.exec(`
      INSERT INTO collection_drop_stats_by_chain(
        drop_id, chain_key, chain, created_on, poap_count, transfer_count
      ) VALUES
        (1001, 'n:', NULL, NULL, 1, 2),
        (1001, 's:fixture', 'fixture', NULL, 3, 4);
    `);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM collection_drop_stats_by_chain WHERE drop_id=1001")
        .get().count,
      4,
    );
    assert.throws(() =>
      database.exec(
        "INSERT INTO collection_drop_stats_by_chain VALUES(1002, 's:wrong', 'ethereum', NULL, 0, 0);",
      ),
    );
    assert.match(
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT suggestion_id FROM suggested_drops WHERE collection_id=101 AND curation_status='approved' ORDER BY created_on DESC, suggestion_id DESC LIMIT 48;",
        )
        .all()
        .map((row) => row.detail)
        .join("\n"),
      /idx_suggested_drops_approved/,
    );
  } finally {
    database.close();
  }
});
