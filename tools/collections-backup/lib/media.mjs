import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  DEAD_COLLECTIONS_MEDIA_HOST,
  RECOVERED_COLLECTIONS_MEDIA_HOST,
  TRUSTED_MEDIA_HOSTS,
} from "./config.mjs";
import { appendJsonLine, exists, readJson, writeJsonAtomic } from "./files.mjs";

const MEDIA_FORMAT_VERSION = 1;
const MAX_REDIRECTS = 5;
const USER_AGENT = "POAPin-Archive-Collections-Media/0.1 (+https://poap.in)";

export async function captureCollectionMedia({
  input,
  concurrency = 3,
  maximumBytes = 50 * 1024 * 1024,
  retryFailures = false,
  onProgress = () => {},
}) {
  const root = resolve(input);
  const source = await readJson(resolve(root, "source.json"));
  const manifestPath = resolve(root, "manifest.json");
  const snapshotManifest = await readJson(manifestPath);
  const references = await buildReferences(root);
  const referencesSha256 = createHash("sha256")
    .update(`${references.map((reference) => JSON.stringify(reference)).join("\n")}\n`)
    .digest("hex");
  await writePlan(root, references);

  const checkpointPath = resolve(root, "media/checkpoint.ndjson");
  const completed = await readCheckpoint(checkpointPath, {
    endpoint: source.endpoint,
    referencesSha256,
  });
  const pending = references.filter((reference) => {
    const prior = completed.records.get(reference.id);
    if (!prior) return true;
    return retryFailures && ["failed", "missing"].includes(prior.status);
  });

  let handled = references.length - pending.length;
  const checkpoint = new SerializedCheckpoint(checkpointPath, {
    initialize: !completed.header,
    header: {
      kind: "header",
      version: MEDIA_FORMAT_VERSION,
      dataset: "poap-compass-collection-media",
      endpoint: source.endpoint,
      referencesSha256,
      createdAt: new Date().toISOString(),
    },
  });

  await runPool(pending, concurrency, async (reference) => {
    let record;
    try {
      record = await downloadReference({ root, reference, maximumBytes });
    } catch (error) {
      const quarantined = [
        "CONTENT_TYPE_MISMATCH",
        "INVALID_SOURCE_URL",
        "PRIVATE_NETWORK_TARGET",
        "SOURCE_HOST_NOT_ALLOWED",
        "UNSUPPORTED_MEDIA",
      ].includes(error.code);
      record = {
        ...reference,
        status: quarantined ? "quarantined" : "failed",
        eligibleForPublish: false,
        failureCode: error.code || "MEDIA_DOWNLOAD_FAILED",
        failureReason: error.message,
        completedAt: new Date().toISOString(),
      };
    }
    await checkpoint.record(record);
    completed.records.set(reference.id, record);
    handled += 1;
    onProgress({ entity: "collection_media", rows: handled, pages: references.length });
  });
  await checkpoint.close();

  const records = references
    .map((reference) => completed.records.get(reference.id))
    .filter(Boolean);
  const counts = countStatuses(records);
  const mediaManifest = {
    version: MEDIA_FORMAT_VERSION,
    dataset: "poap-compass-collection-media",
    referencesSha256,
    generatedAt: new Date().toISOString(),
    references: references.length,
    uniqueObjects: new Set(records.filter((row) => row.sha256).map((row) => row.sha256)).size,
    counts,
    attemptedAll: records.length === references.length,
    complete: records.length === references.length && counts.failed === 0 && counts.missing === 0,
    publishable:
      records.length === references.length && counts.failed === 0 && counts.missing === 0,
    quarantinedReferencesAreExcluded: true,
    checkpoint: relative(root, checkpointPath),
  };
  await writeJsonAtomic(resolve(root, "media/manifest.json"), mediaManifest);
  snapshotManifest.media = {
    captured: true,
    manifest: "media/manifest.json",
    ...mediaManifest,
  };
  await writeJsonAtomic(manifestPath, snapshotManifest);
  return mediaManifest;
}

async function buildReferences(root) {
  const collectionsPath = resolve(root, "normalized/collections.ndjson");
  const references = [];
  for await (const collection of readNdjson(collectionsPath)) {
    for (const [role, sourceUrl] of [
      ["logo", collection.logo_image_url],
      ["banner", collection.banner_image_url],
    ]) {
      if (!sourceUrl) continue;
      references.push({
        id: `${collection.id}:${role}`,
        collectionId: Number(collection.id),
        role,
        sourceUrl,
      });
    }
  }
  references.sort(
    (left, right) => left.collectionId - right.collectionId || left.role.localeCompare(right.role),
  );
  return references;
}

async function writePlan(root, references) {
  const path = resolve(root, "media/plan.ndjson");
  if (await exists(path)) return;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    for (const reference of references) await handle.write(`${JSON.stringify(reference)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function downloadReference({ root, reference, maximumBytes }) {
  const resolved = resolveSourceUrl(reference.sourceUrl);
  if (!resolved.ok) throw mediaError(resolved.reason, resolved.code);
  const redirectChain = [];
  let current = resolved.url;
  let response;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await validateNetworkTarget(current);
    response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "image/*", "user-agent": USER_AGENT },
    });
    redirectChain.push({ url: current.toString(), status: response.status });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location)
      throw mediaError("Redirect response did not include Location.", "INVALID_REDIRECT");
    current = new URL(location, current);
    if (redirect === MAX_REDIRECTS) {
      throw mediaError("Media exceeded the redirect limit.", "TOO_MANY_REDIRECTS");
    }
  }

  if (response.status === 404 || response.status === 410) {
    return {
      ...reference,
      resolvedSourceUrl: current.toString(),
      redirectChain,
      status: "missing",
      eligibleForPublish: false,
      httpStatus: response.status,
      completedAt: new Date().toISOString(),
    };
  }
  if (!response.ok || !response.body) {
    throw mediaError(`Media returned HTTP ${response.status}.`, "HTTP_ERROR");
  }
  const advertisedLength = parseContentLength(response.headers.get("content-length"));
  if (advertisedLength !== null && advertisedLength > maximumBytes) {
    throw mediaError(
      `Media advertises ${advertisedLength} bytes, above the ${maximumBytes} byte limit.`,
      "MEDIA_TOO_LARGE",
    );
  }

  const temporary = resolve(root, `media/tmp/${safeFileName(reference.id)}-${process.pid}.part`);
  await mkdir(dirname(temporary), { recursive: true });
  const handle = await open(temporary, "w", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        throw mediaError(`Media exceeded the ${maximumBytes} byte limit.`, "MEDIA_TOO_LARGE");
      }
      if (prefix.byteLength < 512) {
        prefix = Buffer.concat([prefix, Buffer.from(chunk)]).subarray(0, 512);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  if (byteLength === 0) {
    await rm(temporary, { force: true });
    throw mediaError("Media response was empty.", "EMPTY_MEDIA");
  }

  const detected = detectImage(prefix);
  if (!detected) {
    await rm(temporary, { force: true });
    throw mediaError("Media bytes were not a supported image format.", "UNSUPPORTED_MEDIA");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (
    contentType &&
    contentType !== "application/octet-stream" &&
    !contentType.startsWith("image/")
  ) {
    await rm(temporary, { force: true });
    throw mediaError(`Media Content-Type was ${contentType}.`, "CONTENT_TYPE_MISMATCH");
  }

  const digest = hash.digest("hex");
  const objectPath = resolve(
    root,
    `media/objects/sha256/${digest.slice(0, 2)}/${digest}.${detected.extension}`,
  );
  await mkdir(dirname(objectPath), { recursive: true });
  if (await exists(objectPath)) {
    await rm(temporary, { force: true });
  } else {
    await rename(temporary, objectPath);
  }
  return {
    ...reference,
    resolvedSourceUrl: current.toString(),
    recoveryRuleApplied: resolved.rewritten,
    redirectChain,
    status: "stored",
    eligibleForPublish: true,
    httpStatus: response.status,
    contentType: detected.contentType,
    advertisedContentType: contentType || null,
    advertisedByteLength: advertisedLength,
    byteLength,
    sha256: digest,
    extension: detected.extension,
    objectPath: relative(root, objectPath).replaceAll("\\", "/"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    completedAt: new Date().toISOString(),
  };
}

function resolveSourceUrl(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return { ok: false, code: "INVALID_SOURCE_URL", reason: "Media URL could not be parsed." };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return {
      ok: false,
      code: "INVALID_SOURCE_URL",
      reason: "Media URL must use credential-free HTTPS on the default port.",
    };
  }
  url.hash = "";
  if (url.hostname === DEAD_COLLECTIONS_MEDIA_HOST) {
    url.hostname = RECOVERED_COLLECTIONS_MEDIA_HOST;
    return { ok: true, url, rewritten: "collections-assets-to-production-s3-v1" };
  }
  if (!TRUSTED_MEDIA_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      code: "SOURCE_HOST_NOT_ALLOWED",
      reason: `Media host ${url.hostname} is not allowlisted.`,
    };
  }
  return { ok: true, url, rewritten: null };
}

async function validateNetworkTarget(url) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !TRUSTED_MEDIA_HOSTS.has(url.hostname)
  ) {
    throw mediaError(
      "Redirect target is not an allowlisted HTTPS host.",
      "SOURCE_HOST_NOT_ALLOWED",
    );
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw mediaError(
      "Media host resolved to a private or invalid address.",
      "PRIVATE_NETWORK_TARGET",
    );
  }
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

function detectImage(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return { contentType: "image/gif", extension: "gif" };
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  if (bytes.subarray(4, 12).toString("ascii").includes("ftypavif")) {
    return { contentType: "image/avif", extension: "avif" };
  }
  return null;
}

async function readCheckpoint(path, context) {
  if (!(await exists(path))) return { header: null, records: new Map() };
  const contents = await readFile(path, "utf8");
  const records = new Map();
  let header = null;
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Media checkpoint has invalid JSON on line ${index + 1}.`);
    }
    if (!header) {
      header = record;
      if (header.kind !== "header" || header.version !== MEDIA_FORMAT_VERSION) {
        throw new Error("Media checkpoint header is invalid.");
      }
      for (const [key, value] of Object.entries(context)) {
        if (header[key] !== value) throw new Error(`Media checkpoint ${key} does not match.`);
      }
    } else {
      if (record.kind !== "reference" || typeof record.id !== "string") {
        throw new Error(`Media checkpoint record on line ${index + 1} is invalid.`);
      }
      records.set(record.id, record);
    }
  }
  return { header, records };
}

class SerializedCheckpoint {
  constructor(path, { initialize, header }) {
    this.path = path;
    this.chain = initialize ? appendJsonLine(path, header) : Promise.resolve();
  }

  async record(record) {
    this.chain = this.chain.then(() =>
      appendJsonLine(this.path, { kind: "reference", version: MEDIA_FORMAT_VERSION, ...record }),
    );
    await this.chain;
  }

  async close() {
    await this.chain;
  }
}

async function runPool(values, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

async function* readNdjson(path) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}

function countStatuses(records) {
  const counts = { stored: 0, missing: 0, quarantined: 0, failed: 0 };
  for (const record of records) {
    if (record.status in counts) counts[record.status] += 1;
  }
  return counts;
}

function parseContentLength(value) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeFileName(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function mediaError(message, code) {
  return Object.assign(new Error(message), { code });
}

export const mediaInternals = {
  detectImage,
  isPrivateAddress,
  resolveSourceUrl,
};
