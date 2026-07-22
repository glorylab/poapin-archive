import assert from "node:assert/strict";
import test from "node:test";

import { ENTITY_CONFIGS } from "../lib/config.mjs";
import { makePageQuery } from "../lib/graphql.mjs";

test("single-column pages use a frozen keyset range", () => {
  const config = ENTITY_CONFIGS.find((entry) => entry.name === "collections");
  const query = compact(makePageQuery(config));

  assert.match(query, /\$cursor0: bigint!/);
  assert.match(query, /\$upper0: bigint!/);
  assert.match(query, /id: \{ _gt: \$cursor0 \}/);
  assert.match(query, /id: \{ _lte: \$upper0 \}/);
  assert.match(query, /urls\(limit: 100, order_by: \{ id: asc \}\)/);
});

test("composite pages use lexicographic lower and upper bounds", () => {
  const config = ENTITY_CONFIGS.find((entry) => entry.name === "item_sections");
  const query = compact(makePageQuery(config));

  assert.match(query, /order_by: \[\{ item_id: asc \}, \{ section_id: asc \}\]/);
  assert.match(query, /item_id: \{ _gt: \$cursor0 \}/);
  assert.match(query, /item_id: \{ _eq: \$cursor0 \}, section_id: \{ _gt: \$cursor1 \}/);
  assert.match(query, /item_id: \{ _lt: \$upper0 \}/);
  assert.match(query, /item_id: \{ _eq: \$upper0 \}, section_id: \{ _lte: \$upper1 \}/);
});

function compact(value) {
  return value.replaceAll(/\s+/g, " ").trim();
}
