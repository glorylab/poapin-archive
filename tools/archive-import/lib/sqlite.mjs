import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { invariant } from "./util.mjs";

const SQLITE_BINARY = process.env.POAP_SQLITE3 || "sqlite3";

export async function assertSqliteAvailable() {
  const child = spawn(SQLITE_BINARY, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const closePromise = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await closePromise;
  invariant(code === 0, `sqlite3 is required (${stderr.trim() || `exit ${code}`}).`);
  return stdout.trim().split(/\s+/)[0];
}

/**
 * Streams one JSON object per SQLite result row. The SELECT expression must
 * return a single json_object(...) column; embedded newlines remain escaped.
 */
export async function* streamJsonRows(databasePath, selectSql) {
  const child = spawn(SQLITE_BINARY, ["-batch", "-readonly", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closePromise = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });

  child.stdin.end(
    [
      ".bail on",
      ".mode list",
      "PRAGMA query_only = ON;",
      "PRAGMA temp_store = FILE;",
      selectSql.trim().replace(/;?$/, ";"),
      "",
    ].join("\n"),
  );

  child.stdout.setEncoding("utf8");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let completed = false;
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`sqlite3 emitted invalid JSON: ${line.slice(0, 240)}`, { cause: error });
      }
      yield parsed;
    }
    const [code] = await closePromise;
    completed = true;
    invariant(code === 0, `sqlite3 query failed: ${stderr.trim() || `exit ${code}`}`);
  } finally {
    lines.close();
    if (!completed && child.exitCode === null) child.kill("SIGTERM");
  }
}

export async function queryJsonRows(databasePath, selectSql, { maximumRows = 10_000 } = {}) {
  const rows = [];
  for await (const row of streamJsonRows(databasePath, selectSql)) {
    rows.push(row);
    invariant(rows.length <= maximumRows, `Query returned more than ${maximumRows} rows.`);
  }
  return rows;
}

export async function querySmallJsonDocument(databasePath, sql, { maxBytes = 1024 * 1024 } = {}) {
  const child = spawn(
    SQLITE_BINARY,
    ["-batch", "-readonly", "-cmd", ".explain off", "-json", databasePath, sql],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closePromise = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > maxBytes && child.exitCode === null) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await closePromise;
  invariant(code === 0, `sqlite3 query failed: ${stderr.trim() || `exit ${code}`}`);
  invariant(
    Buffer.byteLength(stdout) <= maxBytes,
    `sqlite3 JSON output exceeded ${maxBytes} bytes.`,
  );
  return stdout.trim() ? JSON.parse(stdout) : [];
}

export function jsonObjectSelect(table, columns, { where = null, orderBy = null } = {}) {
  const pairs = columns.flatMap((column) => [`'${column}'`, quoteIdentifier(column)]).join(", ");
  return [
    `SELECT json_object(${pairs})`,
    `FROM ${quoteIdentifier(table)}`,
    where ? `WHERE ${where}` : null,
    orderBy ? `ORDER BY ${orderBy}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
