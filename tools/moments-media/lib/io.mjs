import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

export async function* readNdjson(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      throw new Error(`${path}:${lineNumber} is not valid NDJSON.`);
    }
  }
}

export async function readNdjsonArray(path) {
  const rows = [];
  for await (const row of readNdjson(path)) rows.push(row);
  return rows;
}

export async function readNdjsonBound(path) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${path} is not a regular NDJSON file.`);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${path} is too large to validate safely.`);
    }
    const hash = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    const rows = [];
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let pending = "";
    let position = 0n;
    let lineNumber = 0;

    const parseLine = (rawLine) => {
      lineNumber += 1;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;
      try {
        rows.push(JSON.parse(line));
      } catch {
        throw new Error(`${path}:${lineNumber} is not valid NDJSON.`);
      }
    };

    while (position < before.size) {
      const length = Number(
        before.size - position > BigInt(chunk.length)
          ? BigInt(chunk.length)
          : before.size - position,
      );
      const { bytesRead } = await handle.read(chunk, 0, length, Number(position));
      if (bytesRead < 1) {
        throw new Error(`${path} changed while its NDJSON bytes were being read.`);
      }
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      pending += decoder.write(bytes);
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        parseLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      position += BigInt(bytesRead);
    }
    pending += decoder.end();
    if (pending.length > 0) parseLine(pending);

    const after = await handle.stat({ bigint: true });
    if (!sameImmutableFileStat(before, after)) {
      throw new Error(`${path} changed while its NDJSON bytes were being read.`);
    }
    return {
      rows,
      sha256: hash.digest("hex"),
      byteLength: Number(before.size),
    };
  } finally {
    await handle.close();
  }
}

export async function writeNdjsonAtomic(path, rows) {
  const text = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeTextAtomic(path, text);
  return digest(Buffer.from(text));
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

export async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    byteLength += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function sameImmutableFileStat(left, right) {
  return Boolean(
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs,
  );
}
