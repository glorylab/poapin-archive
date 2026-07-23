import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteLength };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
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

export async function writeGzipJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const input = Buffer.from(`${JSON.stringify(value)}\n`);
  await pipeline(
    async function* () {
      yield input;
    },
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(temporary, { mode: 0o600 }),
  );
  await rename(temporary, path);
  return sha256File(path);
}

export async function readGzipJson(path) {
  const chunks = [];
  const output = createGunzip();
  output.on("data", (chunk) => chunks.push(chunk));
  await pipeline(createReadStream(path), output);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function fileMetadata(path) {
  const metadata = await sha256File(path);
  const details = await stat(path);
  return { ...metadata, modifiedAt: details.mtime.toISOString() };
}
