import assert from "node:assert/strict";
import test from "node:test";

import { ENTITY_BY_NAME, HARD_PAGE_LIMIT } from "../lib/config.mjs";
import { makePageQuery } from "../lib/graphql.mjs";

test("page queries use bounded keysets and the hard nested relation limit", () => {
  const moments = makePageQuery(ENTITY_BY_NAME.get("moments"));
  assert.match(moments, /limit: \$limit/);
  assert.match(moments, /_and:/);
  assert.match(moments, /_gt: \$cursor0/);
  assert.match(moments, /_lte: \$upper0/);
  assert.match(moments, new RegExp(`drops\\(limit: ${HARD_PAGE_LIMIT}`));

  const relations = makePageQuery(ENTITY_BY_NAME.get("capsule_moments"));
  assert.match(relations, /capsule_id: \{ _gt: \$cursor0 \}/);
  assert.match(relations, /capsule_id: \{ _eq: \$cursor0 \}, moment_id: \{ _gt: \$cursor1 \}/);
});
