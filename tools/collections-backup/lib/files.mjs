import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createGunzip, gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);

export async function writeJsonAtomic(filePath, value, { mode = 0o600 } = {}) {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, absolute);
}

export async function writeGzipJsonAtomic(filePath, value) {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  const bytes = await gzip(Buffer.from(`${JSON.stringify(value)}\n`), { level: 9 });
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, absolute);
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

export async function readGzipJson(filePath) {
  const chunks = [];
  const stream = createReadStream(filePath).pipe(createGunzip());
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function appendJsonLine(filePath, value) {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  const handle = await open(absolute, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function fileMetadata(root, filePath) {
  const absolute = resolve(filePath);
  const metadata = await sha256File(absolute);
  return {
    path: relative(resolve(root), absolute).replaceAll("\\", "/"),
    ...metadata,
  };
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
