import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readNdjsonBound, sha256File } from "../lib/io.mjs";

test("bound NDJSON parsing hashes the exact parsed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-bound-ndjson-test-"));
  const path = join(root, "rows.ndjson");
  const rows = [
    { id: 1, value: "one" },
    { id: 2, value: "二" },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  try {
    const bound = await readNdjsonBound(path);
    assert.deepEqual(bound.rows, rows);
    assert.deepEqual(
      { sha256: bound.sha256, byteLength: bound.byteLength },
      await sha256File(path),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bound NDJSON parsing refuses a file appended during its read", async () => {
  const root = await mkdtemp(join(tmpdir(), "moments-bound-ndjson-race-test-"));
  const path = join(root, "rows.ndjson");
  const payload = "x".repeat(512);
  const rows = Array.from({ length: 20_000 }, (_, sequence) =>
    JSON.stringify({ sequence, payload }),
  );
  await writeFile(path, `${rows.join("\n")}\n`);
  let sequence = rows.length;
  let appendError = null;
  const pendingWrites = new Set();
  const timer = setInterval(() => {
    const write = appendFile(path, `${JSON.stringify({ sequence, payload })}\n`).catch((error) => {
      appendError = error;
    });
    sequence += 1;
    pendingWrites.add(write);
    void write.then(() => pendingWrites.delete(write));
  }, 1);
  try {
    await assert.rejects(readNdjsonBound(path), /changed while its NDJSON bytes were being read/);
  } finally {
    clearInterval(timer);
    await Promise.all(pendingWrites);
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(appendError, null);
});
