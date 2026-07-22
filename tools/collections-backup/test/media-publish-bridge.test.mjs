import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  createCollectionsBridgeTarget,
  ImmutableCollectionsBridgeUploader,
} from "../bridge/client.mjs";
import {
  COLLECTIONS_BRIDGE_AUTH_SCHEME,
  COLLECTIONS_BRIDGE_OBJECT_PATH,
  createCollectionsBridgeSignaturePayload,
} from "../bridge/protocol.mjs";
import { handleCollectionsBridgeRequest } from "../bridge/worker.mjs";

const SNAPSHOT_ID = "collections-2026-07-22-v1";
const ARCHIVE_SNAPSHOT_ID = "2026-07-02-v1";
const BUCKET = "poapin-archive";
const OBJECT_PREFIX = "snapshots/";
const UPLOAD_PREFIX = `${OBJECT_PREFIX}${SNAPSHOT_ID}/collections/media/sha256/`;
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAXIMUM_OBJECT_BYTES = 100_000_000;
const ENDPOINT = "https://collections-upload.example.workers.dev";
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

test("signature covers key, checksum, type, prefix, bucket, and snapshot", () => {
  const base = {
    method: "PUT",
    path: COLLECTIONS_BRIDGE_OBJECT_PATH,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    objectPrefix: OBJECT_PREFIX,
    mode: "upload",
    key: `${UPLOAD_PREFIX}${"a".repeat(2)}/${"a".repeat(64)}.png`,
    byteLength: 123,
    sha256: "a".repeat(64),
    contentType: "image/png",
    timestamp: Math.floor(NOW / 1000),
  };
  const first = createCollectionsBridgeSignaturePayload(base);
  const second = createCollectionsBridgeSignaturePayload({ ...base, contentType: "image/jpeg" });
  const third = createCollectionsBridgeSignaturePayload({ ...base, mode: "archive-reuse" });
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  assert.notEqual(
    createHmac("sha256", Buffer.from(SECRET, "base64url")).update(first).digest("base64url"),
    createHmac("sha256", Buffer.from(SECRET, "base64url")).update(second).digest("base64url"),
  );
});

test("bridge performs only immutable PUT and strict HEAD reuse", async () => {
  const bucket = new MemoryR2Bucket();
  const uploader = bridgeUploader(bucket);
  await uploader.verifyTarget();

  const bytes = png("immutable");
  const sha256 = digest(bytes);
  const expected = {
    key: `${UPLOAD_PREFIX}${sha256.slice(0, 2)}/${sha256}.png`,
    bytes,
    byteLength: bytes.byteLength,
    sha256,
    contentType: "image/png",
  };
  const first = await uploader.upload(expected);
  const head = await uploader.head(expected);
  const second = await uploader.upload(expected);

  assert.equal(first.disposition, "uploaded");
  assert.equal(second.disposition, "reused");
  assert.equal(head.sha256, sha256);
  assert.equal(bucket.putCalls, 2);
  assert.equal(bucket.headCalls, 2);
  assert.deepEqual(bucket.lastPutOptions.onlyIf, { etagDoesNotMatch: "*" });
  assert.equal(bucket.lastPutOptions.sha256, sha256);
  assert.equal(bucket.lastPutOptions.httpMetadata.contentType, "image/png");
  assert.equal(bucket.lastPutOptions.httpMetadata.cacheControl, CACHE_CONTROL);
  assert.deepEqual(bucket.operations, ["put", "head", "put", "head"]);
});

test("archive reuse is exact HEAD-only proof and can never invoke R2 PUT", async () => {
  const bucket = new MemoryR2Bucket();
  const uploader = bridgeUploader(bucket);
  const key = `${OBJECT_PREFIX}${ARCHIVE_SNAPSHOT_ID}/artwork/42.webp`;
  const sha256 = "c".repeat(64);
  bucket.stored.set(key, {
    key,
    size: 99_330_474,
    etag: "archive-etag",
    checksums: { toJSON: () => ({ sha256 }) },
    httpMetadata: { contentType: "image/webp", cacheControl: CACHE_CONTROL },
    customMetadata: { sha256, source: "poap-archive" },
  });

  const proof = await uploader.head({
    mode: "archive-reuse",
    key,
    byteLength: 99_330_474,
    sha256,
    contentType: "image/webp",
  });
  assert.equal(proof.etag, "archive-etag");

  const response = await signedRequest(bucket, {
    method: "PUT",
    mode: "archive-reuse",
    key,
    bytes: png("must not upload"),
    byteLength: 99_330_474,
    sha256,
    contentType: "image/webp",
  });
  assert.equal(response.status, 405);
  assert.equal(bucket.putCalls, 0);
  assert.equal(bucket.headCalls, 1);
});

test("bridge accepts the exact 100 MB boundary and rejects one byte more", async () => {
  const bucket = new MemoryR2Bucket();
  for (const input of [
    { byteLength: 99_330_474, sha256: "e".repeat(64), extension: "gif", contentType: "image/gif" },
    { byteLength: 79_319_228, sha256: "f".repeat(64), extension: "png", contentType: "image/png" },
  ]) {
    const response = await signedRequest(bucket, {
      method: "HEAD",
      key: `${UPLOAD_PREFIX}${input.sha256.slice(0, 2)}/${input.sha256}.${input.extension}`,
      byteLength: input.byteLength,
      sha256: input.sha256,
      contentType: input.contentType,
    });
    assert.equal(response.status, 404);
  }
  const sha256 = "d".repeat(64);
  const key = `${UPLOAD_PREFIX}${sha256.slice(0, 2)}/${sha256}.gif`;
  const accepted = await signedRequest(bucket, {
    method: "HEAD",
    key,
    byteLength: 100_000_000,
    sha256,
    contentType: "image/gif",
  });
  assert.equal(accepted.status, 404);

  const rejected = await signedRequest(bucket, {
    method: "HEAD",
    key,
    byteLength: 100_000_001,
    sha256,
    contentType: "image/gif",
  });
  assert.equal(rejected.status, 413);
  assert.equal(bucket.putCalls, 0);
  assert.equal(bucket.headCalls, 3);
});

test("conflicting immutable metadata is never overwritten", async () => {
  const bucket = new MemoryR2Bucket();
  const uploader = bridgeUploader(bucket);
  const bytes = png("conflict");
  const sha256 = digest(bytes);
  const expected = {
    key: `${UPLOAD_PREFIX}${sha256.slice(0, 2)}/${sha256}.png`,
    bytes,
    byteLength: bytes.byteLength,
    sha256,
    contentType: "image/png",
  };
  await uploader.upload(expected);
  bucket.stored.get(expected.key).customMetadata.source = "foreign-writer";

  await assert.rejects(
    uploader.upload(expected),
    (error) => error.code === "EXISTING_OBJECT_CONFLICT" && error.attempts === 1,
  );
  assert.equal(bucket.putCalls, 2);
  assert.equal(bucket.stored.get(expected.key).customMetadata.source, "foreign-writer");
});

test("a lost success response retries as an exact immutable reuse", async () => {
  const bucket = new MemoryR2Bucket();
  let uploadResponses = 0;
  const uploader = new ImmutableCollectionsBridgeUploader({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    archiveSnapshotId: ARCHIVE_SNAPSHOT_ID,
    objectPrefix: OBJECT_PREFIX,
    cacheControl: CACHE_CONTROL,
    maximumObjectBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 2,
    now: () => NOW,
    sleep: async () => {},
    async fetchImpl(url, init) {
      const request = new Request(url, init);
      const response = await handleCollectionsBridgeRequest(request, bridgeEnv(bucket), () => NOW);
      if (request.method === "PUT" && uploadResponses++ === 0) {
        return Response.json({ code: "temporary_failure" }, { status: 503 });
      }
      return response;
    },
  });
  const bytes = png("lost response");
  const sha256 = digest(bytes);
  const result = await uploader.upload({
    key: `${UPLOAD_PREFIX}${sha256.slice(0, 2)}/${sha256}.png`,
    bytes,
    byteLength: bytes.byteLength,
    sha256,
    contentType: "image/png",
  });
  assert.equal(result.disposition, "reused");
  assert.equal(bucket.putCalls, 2);
  assert.equal(bucket.headCalls, 1);
});

test("bridge rejects an invalid content-addressed key or media type before R2", async () => {
  const bucket = new MemoryR2Bucket();
  const bytes = png("wrong type");
  const sha256 = digest(bytes);
  const key = `${UPLOAD_PREFIX}${sha256.slice(0, 2)}/${sha256}.png`;
  const wrongType = await signedRequest(bucket, {
    method: "PUT",
    key,
    bytes,
    byteLength: bytes.byteLength,
    sha256,
    contentType: "image/jpeg",
  });
  assert.equal(wrongType.status, 400);

  const wrongKey = await signedRequest(bucket, {
    method: "PUT",
    key: `${UPLOAD_PREFIX}00/${sha256}.png`,
    bytes,
    byteLength: bytes.byteLength,
    sha256,
    contentType: "image/png",
  });
  assert.equal(wrongKey.status, 400);
  assert.equal(bucket.putCalls, 0);
  assert.equal(bucket.headCalls, 0);
});

test("tampering with a signed object header fails authorization", async () => {
  const bucket = new MemoryR2Bucket();
  const bytes = png("signed");
  const sha256 = digest(bytes);
  const key = `${UPLOAD_PREFIX}${sha256.slice(0, 2)}/${sha256}.png`;
  const response = await signedRequest(
    bucket,
    { method: "PUT", key, bytes, byteLength: bytes.byteLength, sha256, contentType: "image/png" },
    (headers) => headers.set("X-POAPin-Object-Byte-Length", String(bytes.byteLength + 1)),
  );
  assert.equal(response.status, 401);
  assert.equal(bucket.putCalls, 0);
});

function bridgeUploader(bucket) {
  return createCollectionsBridgeTarget({
    bridgeUrl: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    archiveSnapshotId: ARCHIVE_SNAPSHOT_ID,
    objectPrefix: OBJECT_PREFIX,
    cacheControl: CACHE_CONTROL,
    maximumObjectBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 1,
    now: () => NOW,
    fetchImpl(url, init) {
      return handleCollectionsBridgeRequest(new Request(url, init), bridgeEnv(bucket), () => NOW);
    },
  }).uploader;
}

async function signedRequest(bucket, input, mutate = () => {}) {
  const mode = input.mode ?? "upload";
  const timestamp = Math.floor(NOW / 1000);
  const payload = createCollectionsBridgeSignaturePayload({
    method: input.method,
    path: COLLECTIONS_BRIDGE_OBJECT_PATH,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    objectPrefix: OBJECT_PREFIX,
    mode,
    key: input.key,
    byteLength: input.byteLength,
    sha256: input.sha256,
    contentType: input.contentType,
    timestamp,
  });
  const signature = createHmac("sha256", Buffer.from(SECRET, "base64url"))
    .update(payload)
    .digest("base64url");
  const headers = new Headers({
    Authorization: `${COLLECTIONS_BRIDGE_AUTH_SCHEME} ${signature}`,
    "X-POAPin-Bucket": BUCKET,
    "X-POAPin-Snapshot": SNAPSHOT_ID,
    "X-POAPin-Object-Prefix": OBJECT_PREFIX,
    "X-POAPin-Object-Mode": mode,
    "X-POAPin-Timestamp": String(timestamp),
    "X-POAPin-Object-Key": input.key,
    "X-POAPin-Object-Byte-Length": String(input.byteLength),
    "X-POAPin-SHA256": input.sha256,
    "X-POAPin-Content-Type": input.contentType,
  });
  if (input.method === "PUT") {
    headers.set("Content-Length", String(input.byteLength));
    headers.set("Content-Type", input.contentType);
  }
  mutate(headers);
  return handleCollectionsBridgeRequest(
    new Request(new URL(COLLECTIONS_BRIDGE_OBJECT_PATH, ENDPOINT), {
      method: input.method,
      headers,
      ...(input.method === "PUT" ? { body: input.bytes } : {}),
    }),
    bridgeEnv(bucket),
    () => NOW,
  );
}

function bridgeEnv(bucket) {
  return {
    COLLECTIONS_BUCKET: bucket,
    COLLECTIONS_R2_BRIDGE_SECRET: SECRET,
    BUCKET_NAME: BUCKET,
    SNAPSHOT_ID,
    ARCHIVE_SNAPSHOT_ID,
    OBJECT_PREFIX,
    CACHE_CONTROL,
    MAX_OBJECT_BYTES: String(MAXIMUM_OBJECT_BYTES),
  };
}

class MemoryR2Bucket {
  constructor() {
    this.stored = new Map();
    this.putCalls = 0;
    this.headCalls = 0;
    this.operations = [];
    this.lastPutOptions = null;
  }

  async put(key, value, options) {
    this.putCalls += 1;
    this.operations.push("put");
    this.lastPutOptions = options;
    if (this.stored.has(key) && options.onlyIf?.etagDoesNotMatch === "*") return null;
    const bytes = Buffer.from(await new Response(value).arrayBuffer());
    const sha256 = digest(bytes);
    if (sha256 !== options.sha256) {
      const error = new Error("bad digest");
      error.code = 10037;
      throw error;
    }
    const object = {
      key,
      size: bytes.byteLength,
      etag: sha256.slice(0, 32),
      checksums: { toJSON: () => ({ sha256 }) },
      httpMetadata: { ...options.httpMetadata },
      customMetadata: { ...options.customMetadata },
      bytes,
    };
    this.stored.set(key, object);
    return object;
  }

  async head(key) {
    this.headCalls += 1;
    this.operations.push("head");
    return this.stored.get(key) ?? null;
  }
}

function png(text) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(text),
  ]);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
