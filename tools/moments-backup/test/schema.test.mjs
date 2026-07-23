import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TOOL_SCHEMA = fileURLToPath(new URL("../d1-schema.sql", import.meta.url));
const MIGRATION_SCHEMA = fileURLToPath(
  new URL("../../../migrations/moments/0001_schema.sql", import.meta.url),
);

test("D1 artifact schema stays column-compatible with the deployed migration", async () => {
  const [tool, migration] = await Promise.all([
    readFile(TOOL_SCHEMA, "utf8"),
    readFile(MIGRATION_SCHEMA, "utf8"),
  ]);
  const tables = [
    "moments_meta",
    "moments",
    "moment_visibility",
    "moment_drops",
    "moment_hidden_drops",
    "moment_suppressions",
    "moment_media",
    "moment_links",
    "moment_user_tags",
    "capsules",
    "capsule_visibility",
    "capsule_suppressions",
    "capsule_moments",
    "moment_collections",
  ];
  for (const table of tables) {
    assert.deepEqual(columns(tool, table), columns(migration, table), table);
  }
  for (const view of ["public_moments", "public_capsules"]) {
    assert.match(tool, new RegExp(`CREATE VIEW ${view}\\s+AS`));
    assert.match(migration, new RegExp(`CREATE VIEW ${view}\\s+AS`));
  }
});

function columns(sql, table) {
  const lines = sql.split("\n");
  const start = lines.findIndex((line) => line === `CREATE TABLE ${table} (`);
  assert.notEqual(start, -1, `missing table ${table}`);
  const result = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\)/.test(lines[index])) break;
    const name = lines[index].match(/^  ([a-z][a-z0-9_]*)\b/)?.[1];
    if (name && !["primary", "foreign", "unique", "check"].includes(name)) result.push(name);
  }
  return result;
}
