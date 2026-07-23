import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMomentsBridge } from "../bridge/client.mjs";
import { handleMomentsBridgeRequest } from "../bridge/worker.mjs";
import { momentsMediaObjectKey, verifyMomentsMedia } from "../lib/capture.mjs";
import { sha256File } from "../lib/io.mjs";

const SNAPSHOT = "moments-2026-07-23-v1";
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const NOW = 1_750_000_000_000;

test("bridge client and worker reject a shared public/private bucket", async () => {
  assert.throws(
    () =>
      createMomentsBridge({
        bridgeUrl: "https://bridge.example",
        snapshotId: SNAPSHOT,
        publicBucket: "poapin-shared",
        privateBucket: "poapin-shared",
        secret: SECRET,
      }),
    /must be different/,
  );
  const env = bridgeEnvironment(new MemoryBucket(), new MemoryBucket());
  env.PRIVATE_BUCKET_NAME = env.PUBLIC_BUCKET_NAME;
  const response = await handleMomentsBridgeRequest(
    new Request("https://bridge.example/v1/status"),
    env,
    () => NOW,
  );
  assert.equal(response.status, 503);
});

test("bridge authentication follows the request environment when a secret rotates", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const firstSecret = Buffer.alloc(32, 11).toString("base64url");
  const secondSecret = Buffer.alloc(32, 13).toString("base64url");
  const firstEnvironment = bridgeEnvironment(publicBucket, privateBucket);
  const secondEnvironment = bridgeEnvironment(publicBucket, privateBucket);
  firstEnvironment.MOMENTS_R2_BRIDGE_SECRET = firstSecret;
  secondEnvironment.MOMENTS_R2_BRIDGE_SECRET = secondSecret;

  const client = (secret, environment) =>
    createMomentsBridge({
      bridgeUrl: "https://bridge.example",
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      secret,
      attempts: 1,
      now: () => NOW,
      fetchImpl: (url, init) =>
        handleMomentsBridgeRequest(new Request(url, init), environment, () => NOW),
    });

  await client(firstSecret, firstEnvironment).verifyTargets();
  await client(secondSecret, secondEnvironment).verifyTargets();
  await Promise.all([
    client(firstSecret, firstEnvironment).verifyTargets(),
    client(secondSecret, secondEnvironment).verifyTargets(),
  ]);
  await assert.rejects(
    client(firstSecret, secondEnvironment).verifyTargets(),
    (error) => error.code === "authorization_failed" && error.httpStatus === 401,
  );
});

test("bridge retries an isolated HEAD miss but preserves a persistent missing result", async () => {
  const sha256 = "a".repeat(64);
  const object = {
    target: "public",
    key: momentsMediaObjectKey(SNAPSHOT, "public", sha256, "jpg"),
    byteLength: 10,
    sha256,
    contentType: "image/jpeg",
  };
  const headResponse = () =>
    new Response(null, {
      status: 200,
      headers: {
        "X-POAPin-Target": object.target,
        "X-POAPin-Object-Key": object.key,
        "X-POAPin-Object-Byte-Length": String(object.byteLength),
        "X-POAPin-SHA256": object.sha256,
        "X-POAPin-Content-Type": object.contentType,
        ETag: "etag",
      },
    });
  let transientCalls = 0;
  const transientClient = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    attempts: 2,
    now: () => NOW,
    fetchImpl: async () => {
      transientCalls += 1;
      return transientCalls === 1 ? new Response(null, { status: 404 }) : headResponse();
    },
  });
  assert.equal((await transientClient.head(object)).etag, "etag");
  assert.equal(transientCalls, 2);

  let persistentCalls = 0;
  const persistentClient = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    attempts: 3,
    now: () => NOW,
    fetchImpl: async () => {
      persistentCalls += 1;
      return new Response(null, { status: 404 });
    },
  });
  assert.equal(await persistentClient.head(object), null);
  assert.equal(persistentCalls, 3);
});

test("bridge writes immutable public objects without exposing a body-read route", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = {
    PUBLIC_BUCKET: publicBucket,
    PRIVATE_BUCKET: privateBucket,
    PUBLIC_BUCKET_NAME: "poapin-archive",
    PRIVATE_BUCKET_NAME: "poapin-moments-backups",
    SNAPSHOT_ID: SNAPSHOT,
    PUBLIC_CACHE_CONTROL: "public, max-age=31536000, immutable",
    PRIVATE_CACHE_CONTROL: "private, no-store",
    MAX_OBJECT_BYTES: "100000000",
    MAX_MULTIPART_OBJECT_BYTES: "5000000000",
    MAX_MULTIPART_PART_BYTES: "16777216",
    MOMENTS_R2_BRIDGE_SECRET: SECRET,
  };
  const fetchImpl = (url, init) =>
    handleMomentsBridgeRequest(new Request(url, init), env, () => NOW);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    fetchImpl,
    now: () => NOW,
  });
  await client.verifyTargets();

  const root = await mkdtemp(join(tmpdir(), "moments-bridge-test-"));
  const path = join(root, "image.jpg");
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  const object = {
    target: "public",
    key: momentsMediaObjectKey(SNAPSHOT, "public", sha256, "jpg"),
    byteLength: bytes.length,
    sha256,
    contentType: "image/jpeg",
  };
  try {
    const uploaded = await client.uploadFile(object, path);
    assert.equal(uploaded.disposition, "uploaded");
    assert.equal((await client.head(object)).key, object.key);
    assert.equal(publicBucket.objects.size, 1);
    assert.equal(privateBucket.objects.size, 0);

    const get = await handleMomentsBridgeRequest(
      new Request("https://bridge.example/v1/object", { method: "GET" }),
      env,
      () => NOW,
    );
    assert.equal(get.status, 405);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge target scope rejects a public key signed for the private bucket", async () => {
  const env = {
    PUBLIC_BUCKET: new MemoryBucket(),
    PRIVATE_BUCKET: new MemoryBucket(),
    PUBLIC_BUCKET_NAME: "poapin-archive",
    PRIVATE_BUCKET_NAME: "poapin-moments-backups",
    SNAPSHOT_ID: SNAPSHOT,
    PUBLIC_CACHE_CONTROL: "public, max-age=31536000, immutable",
    PRIVATE_CACHE_CONTROL: "private, no-store",
    MAX_OBJECT_BYTES: "100000000",
    MAX_MULTIPART_OBJECT_BYTES: "5000000000",
    MAX_MULTIPART_PART_BYTES: "16777216",
    MOMENTS_R2_BRIDGE_SECRET: SECRET,
  };
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: (url, init) => handleMomentsBridgeRequest(new Request(url, init), env, () => NOW),
  });
  const sha256 = "a".repeat(64);
  await assert.rejects(
    client.head({
      target: "private",
      key: momentsMediaObjectKey(SNAPSHOT, "public", sha256, "jpg"),
      byteLength: 10,
      sha256,
      contentType: "image/jpeg",
    }),
    (error) => error.code === "MOMENTS_BRIDGE_PROTOCOL_ERROR",
  );
});

test("bridge permits only explicitly labeled private derivative prefixes", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: (url, init) => handleMomentsBridgeRequest(new Request(url, init), env, () => NOW),
  });
  const root = await mkdtemp(join(tmpdir(), "moments-derivative-bridge-test-"));
  const path = join(root, "thumbnail.webp");
  const bytes = Buffer.from("524946460000000057454250", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object = {
    target: "private",
    key:
      `snapshots/${SNAPSHOT}/moments/private/derivative/thumbnail/` +
      `sha256/${sha256.slice(0, 2)}/${sha256}.webp`,
    byteLength: bytes.length,
    sha256,
    contentType: "image/webp",
  };
  await writeFile(path, bytes);
  try {
    assert.equal((await client.uploadFile(object, path)).disposition, "uploaded");
    assert.equal(publicBucket.objects.size, 0);
    assert.equal(privateBucket.objects.size, 1);
    await assert.rejects(
      client.head({
        ...object,
        key: object.key.replace("/thumbnail/", "/unknown/"),
      }),
      (error) => error.code === "MOMENTS_BRIDGE_PROTOCOL_ERROR",
    );
    await assert.rejects(
      client.head({ ...object, target: "public" }),
      (error) => error.code === "MOMENTS_BRIDGE_PROTOCOL_ERROR",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge resumes bounded multipart parts and completes one immutable object", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  const fetchImpl = (url, init) =>
    handleMomentsBridgeRequest(new Request(url, init), env, () => NOW);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumMultipartObjectBytes: 200_000_000,
    multipartPartBytes: 5_242_880,
    secret: SECRET,
    fetchImpl,
    now: () => NOW,
  });
  await client.verifyTargets();

  const firstBytes = Buffer.alloc(5_242_880, 0x31);
  const finalBytes = Buffer.from("final multipart bytes");
  const bytes = Buffer.concat([firstBytes, finalBytes]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object = {
    target: "private",
    key: momentsMediaObjectKey(SNAPSHOT, "private", sha256, "mp4"),
    byteLength: bytes.length,
    sha256,
    contentType: "video/mp4",
  };
  const created = await client.createMultipartUpload(object);
  const part1 = await client.uploadMultipartPart(object, created.uploadId, 1, firstBytes);

  // A later process can resume from its append-only upload ID and recorded ETag.
  const resumedClient = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumMultipartObjectBytes: 200_000_000,
    multipartPartBytes: 5_242_880,
    secret: SECRET,
    fetchImpl,
    now: () => NOW,
  });
  const part2 = await resumedClient.uploadMultipartPart(object, created.uploadId, 2, finalBytes);
  const completed = await resumedClient.completeMultipartUpload(object, created.uploadId, [
    {
      partNumber: 1,
      etag: part1.etag,
      byteLength: part1.byteLength,
      sha256: part1.sha256,
    },
    {
      partNumber: 2,
      etag: part2.etag,
      byteLength: part2.byteLength,
      sha256: part2.sha256,
    },
  ]);
  assert.equal(completed.disposition, "uploaded");
  assert.deepEqual(privateBucket.bytes.get(object.key), bytes);
  assert.equal((await resumedClient.createMultipartUpload(object)).disposition, "reused");

  const read = await handleMomentsBridgeRequest(
    new Request("https://bridge.example/v1/multipart/part", { method: "GET" }),
    env,
    () => NOW,
  );
  const remove = await handleMomentsBridgeRequest(
    new Request("https://bridge.example/v1/object", { method: "DELETE" }),
    env,
    () => NOW,
  );
  assert.equal(read.status, 405);
  assert.equal(remove.status, 405);
});

test("bridge aborts an orphan upload without deleting a completed immutable object", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: (url, init) => handleMomentsBridgeRequest(new Request(url, init), env, () => NOW),
  });
  const bytes = Buffer.from("one immutable object, two multipart sessions");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object = {
    target: "private",
    key: momentsMediaObjectKey(SNAPSHOT, "private", sha256, "mp4"),
    byteLength: bytes.byteLength,
    sha256,
    contentType: "video/mp4",
  };

  const orphan = await client.createMultipartUpload(object);
  await client.uploadMultipartPart(object, orphan.uploadId, 1, bytes);
  const winner = await client.createMultipartUpload(object);
  const winningPart = await client.uploadMultipartPart(object, winner.uploadId, 1, bytes);
  await client.completeMultipartUpload(object, winner.uploadId, [multipartPart(winningPart)]);

  assert.equal(privateBucket.uploads.has(orphan.uploadId), true);
  assert.deepEqual(privateBucket.bytes.get(object.key), bytes);
  assert.equal((await client.abortMultipartUpload(object, orphan.uploadId)).disposition, "aborted");
  assert.equal(privateBucket.uploads.has(orphan.uploadId), false);
  assert.deepEqual(privateBucket.bytes.get(object.key), bytes);
  assert.equal((await client.head(object)).key, object.key);
});

test("bridge accepts Cloudflare-style zero-length POST streams and rejects nonzero or chunked bodies", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  let streamedEmptyRequests = 0;
  const cloudflareFetch = (url, init) => {
    const pathname = new URL(url).pathname;
    if (["/v1/multipart/create", "/v1/multipart/abort"].includes(pathname)) {
      assert.equal(init.headers.get("content-length"), "0");
      const request = new Request(url, {
        ...init,
        body: emptyReadableStream(),
        duplex: "half",
      });
      assert.notEqual(request.body, null);
      streamedEmptyRequests += 1;
      return handleMomentsBridgeRequest(request, env, () => NOW);
    }
    return handleMomentsBridgeRequest(new Request(url, init), env, () => NOW);
  };
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: cloudflareFetch,
  });
  const sha256 = "9".repeat(64);
  const object = {
    target: "private",
    key: momentsMediaObjectKey(SNAPSHOT, "private", sha256, "mp4"),
    byteLength: 42,
    sha256,
    contentType: "video/mp4",
  };
  const created = await client.createMultipartUpload(object);
  assert.equal(
    (await client.abortMultipartUpload(object, created.uploadId)).disposition,
    "aborted",
  );
  assert.equal(streamedEmptyRequests, 2);

  const invalidBodyClient = (mode) =>
    createMomentsBridge({
      bridgeUrl: "https://bridge.example",
      snapshotId: SNAPSHOT,
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      secret: SECRET,
      now: () => NOW,
      attempts: 1,
      fetchImpl: (url, init) => {
        const headers = new Headers(init.headers);
        if (mode === "nonzero") {
          headers.set("Content-Length", "1");
          return handleMomentsBridgeRequest(
            new Request(url, { ...init, headers, body: Buffer.from([0]) }),
            env,
            () => NOW,
          );
        }
        headers.set("Transfer-Encoding", "chunked");
        return handleMomentsBridgeRequest(
          {
            url: String(url),
            method: init.method,
            headers,
            body: emptyReadableStream(),
          },
          env,
          () => NOW,
        );
      },
    });
  await assert.rejects(
    invalidBodyClient("nonzero").createMultipartUpload(object),
    (error) => error.code === "body_not_allowed" && error.httpStatus === 400,
  );
  await assert.rejects(
    invalidBodyClient("chunked").createMultipartUpload(object),
    (error) => error.code === "body_not_allowed" && error.httpStatus === 400,
  );
});

test("bridge reuses v1 originals but never applies legacy metadata compatibility to derivatives", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: (url, init) => handleMomentsBridgeRequest(new Request(url, init), env, () => NOW),
  });

  const originalBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const originalSha256 = createHash("sha256").update(originalBytes).digest("hex");
  const original = {
    target: "private",
    key: momentsMediaObjectKey(SNAPSHOT, "private", originalSha256, "jpg"),
    byteLength: originalBytes.byteLength,
    sha256: originalSha256,
    contentType: "image/jpeg",
  };
  privateBucket.objects.set(
    original.key,
    legacyStoredObject(original, "private, no-store", "legacy-original-etag"),
  );
  privateBucket.bytes.set(original.key, originalBytes);
  assert.equal((await client.head(original)).key, original.key);
  assert.equal((await client.createMultipartUpload(original)).disposition, "reused");

  const explicitFalse = legacyStoredObject(original, "private, no-store", "explicit-false-etag");
  explicitFalse.customMetadata.fidelity = "original";
  explicitFalse.customMetadata.derivativeKind = "";
  explicitFalse.customMetadata.immutable = "false";
  privateBucket.objects.set(original.key, explicitFalse);
  await assert.rejects(client.head(original), (error) => {
    assert.deepEqual(error.conflictFields, ["customMetadata.immutable"]);
    return error.code === "existing_object_conflict" && error.httpStatus === 409;
  });

  const derivativeBytes = Buffer.from("524946460000000057454250", "hex");
  const derivativeSha256 = createHash("sha256").update(derivativeBytes).digest("hex");
  const derivative = {
    target: "private",
    key:
      `snapshots/${SNAPSHOT}/moments/private/derivative/thumbnail/` +
      `sha256/${derivativeSha256.slice(0, 2)}/${derivativeSha256}.webp`,
    byteLength: derivativeBytes.byteLength,
    sha256: derivativeSha256,
    contentType: "image/webp",
  };
  privateBucket.objects.set(
    derivative.key,
    legacyStoredObject(derivative, "private, no-store", "legacy-derivative-etag"),
  );
  privateBucket.bytes.set(derivative.key, derivativeBytes);
  await assert.rejects(client.head(derivative), (error) => {
    assert.deepEqual(error.conflictFields, [
      "customMetadata.fidelity",
      "customMetadata.derivativeKind",
      "customMetadata.immutable",
    ]);
    return error.code === "existing_object_conflict" && error.httpStatus === 409;
  });
});

test("authenticated HEAD conflicts expose exact field names without metadata values", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  let conflictHeader = null;
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: async (url, init) => {
      const response = await handleMomentsBridgeRequest(new Request(url, init), env, () => NOW);
      if (response.status === 409) {
        conflictHeader = response.headers.get("x-poapin-conflict-fields");
      }
      return response;
    },
  });
  const bytes = Buffer.from("524946460000000057454250", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object = {
    target: "private",
    key:
      `snapshots/${SNAPSHOT}/moments/private/derivative/thumbnail/` +
      `sha256/${sha256.slice(0, 2)}/${sha256}.webp`,
    byteLength: bytes.byteLength,
    sha256,
    contentType: "image/webp",
  };
  const sensitiveValues = [
    "SENSITIVE_CHECKSUM_VALUE",
    "SENSITIVE_CONTENT_TYPE_VALUE",
    "SENSITIVE_CACHE_CONTROL_VALUE",
    "SENSITIVE_CUSTOM_SHA_VALUE",
    "SENSITIVE_SNAPSHOT_VALUE",
    "SENSITIVE_SOURCE_VALUE",
    "SENSITIVE_TARGET_VALUE",
    "SENSITIVE_FIDELITY_VALUE",
    "SENSITIVE_DERIVATIVE_VALUE",
    "SENSITIVE_IMMUTABLE_VALUE",
  ];
  privateBucket.objects.set(object.key, {
    key: object.key,
    size: object.byteLength + 1,
    etag: "diagnostic-etag",
    checksums: { toJSON: () => ({ sha256: sensitiveValues[0] }) },
    httpMetadata: {
      contentType: sensitiveValues[1],
      cacheControl: sensitiveValues[2],
    },
    customMetadata: {
      sha256: sensitiveValues[3],
      snapshotId: sensitiveValues[4],
      source: sensitiveValues[5],
      target: sensitiveValues[6],
      fidelity: sensitiveValues[7],
      derivativeKind: sensitiveValues[8],
      immutable: sensitiveValues[9],
    },
  });
  const expectedFields = [
    "size",
    "checksum",
    "contentType",
    "cacheControl",
    "customMetadata.sha256",
    "customMetadata.snapshotId",
    "customMetadata.source",
    "customMetadata.target",
    "customMetadata.fidelity",
    "customMetadata.derivativeKind",
    "customMetadata.immutable",
  ];
  let conflictError = null;
  await assert.rejects(client.head(object), (error) => {
    conflictError = error;
    return error.code === "existing_object_conflict" && error.httpStatus === 409;
  });
  assert.deepEqual(conflictError.conflictFields, expectedFields);
  assert.equal(conflictHeader, expectedFields.join(","));
  assert.match(conflictError.message, /Conflict fields: size, checksum, contentType/);
  const exposed = `${conflictHeader}\n${conflictError.message}`;
  for (const value of [
    ...sensitiveValues,
    object.key,
    object.sha256,
    object.contentType,
    SNAPSHOT,
  ]) {
    assert.equal(exposed.includes(value), false);
  }
});

test("large-object HEAD and recovery verification use the multipart limit while PUT stays bounded", async () => {
  const singleRequestBytes = 5_242_880;
  const maximumMultipartBytes = singleRequestBytes * 2;
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket, {
    maximumObjectBytes: singleRequestBytes,
    maximumMultipartObjectBytes: maximumMultipartBytes,
    maximumMultipartPartBytes: singleRequestBytes,
  });
  const fetchImpl = (url, init) =>
    handleMomentsBridgeRequest(new Request(url, init), env, () => NOW);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumObjectBytes: singleRequestBytes,
    maximumMultipartObjectBytes: maximumMultipartBytes,
    multipartPartBytes: singleRequestBytes,
    attempts: 1,
    secret: SECRET,
    fetchImpl,
    now: () => NOW,
  });
  await client.verifyTargets();

  const firstBytes = Buffer.alloc(singleRequestBytes, 0x51);
  const finalBytes = Buffer.from("larger than the one-request bridge boundary");
  const bytes = Buffer.concat([firstBytes, finalBytes]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object = {
    target: "public",
    key: momentsMediaObjectKey(SNAPSHOT, "public", sha256, "mp4"),
    byteLength: bytes.byteLength,
    sha256,
    contentType: "video/mp4",
  };
  assert.equal(await client.head(object), null);

  const root = await mkdtemp(join(tmpdir(), "moments-large-head-test-"));
  const localPath = join(root, "large.mp4");
  await writeFile(localPath, bytes);
  try {
    await assert.rejects(
      client.uploadFile(object, localPath),
      (error) => error.code === "MOMENTS_BRIDGE_PROTOCOL_ERROR",
    );
    const directPut = await handleMomentsBridgeRequest(
      new Request("https://bridge.example/v1/object", {
        method: "PUT",
        headers: {
          "X-POAPin-Target": object.target,
          "X-POAPin-Bucket": "poapin-archive",
          "X-POAPin-Snapshot": SNAPSHOT,
          "X-POAPin-Object-Key": object.key,
          "X-POAPin-Object-Byte-Length": String(object.byteLength),
          "X-POAPin-SHA256": object.sha256,
          "X-POAPin-Content-Type": object.contentType,
        },
        body: Buffer.from([0]),
      }),
      env,
      () => NOW,
    );
    assert.equal(directPut.status, 413);

    const created = await client.createMultipartUpload(object);
    const part1 = await client.uploadMultipartPart(object, created.uploadId, 1, firstBytes);
    const part2 = await client.uploadMultipartPart(object, created.uploadId, 2, finalBytes);
    await client.completeMultipartUpload(object, created.uploadId, [
      multipartPart(part1),
      multipartPart(part2),
    ]);
    assert.equal((await client.head(object)).key, object.key);

    const mediaRoot = join(root, "media");
    await mkdir(mediaRoot, { recursive: true });
    const normalizedRoot = join(root, "normalized");
    await mkdir(normalizedRoot, { recursive: true });
    const planPath = join(mediaRoot, "plan.ndjson");
    const mediaKey = "77777777-7777-4777-8777-777777777777";
    await writeRows(planPath, [
      {
        planId: mediaKey,
        mediaKey,
        sourceUrl: null,
        target: "public",
        publicEligible: true,
        eligibility: "public",
      },
    ]);
    const planSha256 = (await sha256File(planPath)).sha256;
    const normalizedMediaPath = join(normalizedRoot, "moment_media.ndjson");
    await writeRows(normalizedMediaPath, [{ key: mediaKey }]);
    const normalizedMediaSha256 = (await sha256File(normalizedMediaPath)).sha256;
    const captureCheckpointPath = join(mediaRoot, "capture-checkpoint.ndjson");
    await writeRows(captureCheckpointPath, [
      {
        schemaVersion: "poapin-moments-media-checkpoint-v1",
        version: 1,
        kind: "header",
        snapshotId: SNAPSHOT,
        planSha256,
        planRows: 1,
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        maximumObjectBytes: singleRequestBytes,
      },
      {
        kind: "media",
        planId: mediaKey,
        mediaKey,
        status: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
      },
    ]);
    const captureCheckpointSha256 = (await sha256File(captureCheckpointPath)).sha256;
    const recoveryPlanPath = join(mediaRoot, "recovery-plan.ndjson");
    await writeRows(recoveryPlanPath, [
      {
        schemaVersion: "poapin-moments-media-recovery-row-v1",
        planId: mediaKey,
        mediaKey,
        target: "public",
        publicEligible: true,
        eligibility: "public",
        checkpointStatus: "source_missing",
        errorCode: "NO_CANONICAL_SOURCE",
        httpStatus: null,
        expectedSha256: null,
        strategies: [
          {
            kind: "multipart_original",
            fidelity: "original",
            target: "public",
            sourceUrl: `https://cdn.media.poap.tech/${mediaKey}`,
            requireSha256: null,
          },
        ],
      },
    ]);
    const recoveryPlanSha256 = (await sha256File(recoveryPlanPath)).sha256;
    const recoveryCheckpointPath = join(mediaRoot, "recovery-checkpoint.ndjson");
    await writeRows(recoveryCheckpointPath, [
      {
        schemaVersion: "poapin-moments-media-recovery-checkpoint-v1",
        version: 1,
        kind: "header",
        snapshotId: SNAPSHOT,
        mediaPlanSha256: planSha256,
        mediaPlanRows: 1,
        normalizedMediaSha256,
        normalizedMediaRows: 1,
        captureCheckpointSha256,
        recoveryPlanSha256,
        recoveryPlanRows: 1,
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        maximumObjectBytes: singleRequestBytes,
        maximumRecoveryObjectBytes: maximumMultipartBytes,
        multipartPartBytes: singleRequestBytes,
      },
      {
        kind: "media",
        planId: mediaKey,
        mediaKey,
        status: "original_stored",
        strategy: "multipart_original",
        target: object.target,
        objectKey: object.key,
        byteLength: object.byteLength,
        sha256: object.sha256,
        contentType: object.contentType,
      },
    ]);
    const recoveryCheckpointSha256 = (await sha256File(recoveryCheckpointPath)).sha256;
    const mediaManifestPath = join(mediaRoot, "d1-media-manifest.ndjson");
    await writeRows(mediaManifestPath, [
      {
        mediaKey,
        objectKey: object.key,
        sha256: object.sha256,
        byteLength: object.byteLength,
        contentType: object.contentType,
        status: "public_stored",
      },
    ]);
    const mediaManifestSha256 = (await sha256File(mediaManifestPath)).sha256;
    await writeFile(
      join(mediaRoot, "d1-media-manifest.json"),
      `${JSON.stringify({
        schemaVersion: "poapin-moments-d1-media-proof-v1",
        snapshotId: SNAPSHOT,
        generatedAt: "2026-07-23T00:00:00.000Z",
        planSha256,
        manifestSha256: mediaManifestSha256,
        manifestRows: 1,
        complete: true,
        publicProjectionReady: true,
        checkpointMode: "recovery-finalized",
        publicBucket: "poapin-archive",
        privateBucket: "poapin-moments-backups",
        normalizedMediaSha256,
        captureCheckpointSha256,
        recovery: {
          planSha256: recoveryPlanSha256,
          normalizedMediaSha256,
          captureCheckpointSha256,
          checkpointSha256: recoveryCheckpointSha256,
        },
      })}\n`,
    );
    const verification = await verifyMomentsMedia({
      input: root,
      snapshotId: SNAPSHOT,
      bridgeUrl: "https://bridge.example",
      publicBucket: "poapin-archive",
      privateBucket: "poapin-moments-backups",
      maximumObjectBytes: singleRequestBytes,
      concurrency: 1,
      attempts: 1,
      bridge: client,
    });
    assert.deepEqual(verification.counts, { stored: 1, verified: 1, failed: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge authenticates multipart part bytes and exposes idempotent abort only", async () => {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const env = bridgeEnvironment(publicBucket, privateBucket);
  const honestFetch = (url, init) =>
    handleMomentsBridgeRequest(new Request(url, init), env, () => NOW);
  const client = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumMultipartObjectBytes: 200_000_000,
    multipartPartBytes: 5_242_880,
    secret: SECRET,
    fetchImpl: honestFetch,
    now: () => NOW,
    attempts: 1,
  });
  const bytes = Buffer.alloc(5_242_880, 0x41);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object = {
    target: "private",
    key: momentsMediaObjectKey(SNAPSHOT, "private", sha256, "mp4"),
    byteLength: bytes.length,
    sha256,
    contentType: "video/mp4",
  };
  const created = await client.createMultipartUpload(object);
  const tamperingClient = createMomentsBridge({
    bridgeUrl: "https://bridge.example",
    snapshotId: SNAPSHOT,
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    maximumMultipartObjectBytes: 200_000_000,
    multipartPartBytes: 5_242_880,
    secret: SECRET,
    now: () => NOW,
    attempts: 1,
    fetchImpl: (url, init) => {
      if (new URL(url).pathname !== "/v1/multipart/part") return honestFetch(url, init);
      const changed = Buffer.from(init.body);
      changed[0] ^= 0xff;
      return handleMomentsBridgeRequest(
        new Request(url, { ...init, body: changed }),
        env,
        () => NOW,
      );
    },
  });
  await assert.rejects(
    tamperingClient.uploadMultipartPart(object, created.uploadId, 1, bytes),
    (error) => error.code === "checksum_mismatch" && error.httpStatus === 422,
  );
  assert.equal(
    (await client.abortMultipartUpload(object, created.uploadId)).disposition,
    "aborted",
  );
  assert.equal(
    (await client.abortMultipartUpload(object, created.uploadId)).disposition,
    "already_absent",
  );
  assert.equal(privateBucket.objects.size, 0);
});

function bridgeEnvironment(
  publicBucket,
  privateBucket,
  {
    maximumObjectBytes = 100_000_000,
    maximumMultipartObjectBytes = 5_000_000_000,
    maximumMultipartPartBytes = 16_777_216,
  } = {},
) {
  return {
    PUBLIC_BUCKET: publicBucket,
    PRIVATE_BUCKET: privateBucket,
    PUBLIC_BUCKET_NAME: "poapin-archive",
    PRIVATE_BUCKET_NAME: "poapin-moments-backups",
    SNAPSHOT_ID: SNAPSHOT,
    PUBLIC_CACHE_CONTROL: "public, max-age=31536000, immutable",
    PRIVATE_CACHE_CONTROL: "private, no-store",
    MAX_OBJECT_BYTES: String(maximumObjectBytes),
    MAX_MULTIPART_OBJECT_BYTES: String(maximumMultipartObjectBytes),
    MAX_MULTIPART_PART_BYTES: String(maximumMultipartPartBytes),
    MOMENTS_R2_BRIDGE_SECRET: SECRET,
  };
}

function multipartPart(part) {
  return {
    partNumber: part.partNumber,
    etag: part.etag,
    byteLength: part.byteLength,
    sha256: part.sha256,
  };
}

async function writeRows(path, rows) {
  await writeFile(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function emptyReadableStream() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function legacyStoredObject(object, cacheControl, etag) {
  return {
    key: object.key,
    size: object.byteLength,
    etag,
    checksums: { toJSON: () => ({ sha256: object.sha256 }) },
    httpMetadata: {
      contentType: object.contentType,
      cacheControl,
    },
    customMetadata: {
      sha256: object.sha256,
      snapshotId: SNAPSHOT,
      source: "poapin-moments-backup",
      target: object.target,
    },
  };
}

class MemoryBucket {
  constructor() {
    this.objects = new Map();
    this.bytes = new Map();
    this.uploads = new Map();
    this.nextUpload = 1;
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async put(key, body, options) {
    if (this.objects.has(key)) return null;
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    const object = {
      key,
      size: bytes.length,
      etag: `etag-${this.objects.size + 1}`,
      checksums: { toJSON: () => ({ sha256: options.sha256 }) },
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, object);
    this.bytes.set(key, bytes);
    return object;
  }

  async createMultipartUpload(key, options) {
    const uploadId = `upload-${this.nextUpload}`;
    this.nextUpload += 1;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return { key, uploadId };
  }

  resumeMultipartUpload(key, uploadId) {
    const bucket = this;
    const find = () => {
      const upload = bucket.uploads.get(uploadId);
      if (!upload || upload.key !== key) {
        throw Object.assign(new Error("No such upload."), { code: 10024 });
      }
      return upload;
    };
    return {
      async uploadPart(partNumber, body) {
        const upload = find();
        const bytes = Buffer.from(await new Response(body).arrayBuffer());
        const part = { partNumber, etag: `part-${uploadId}-${partNumber}`, bytes };
        upload.parts.set(partNumber, part);
        return part;
      },
      async complete(parts) {
        const upload = find();
        const bytes = Buffer.concat(
          parts.map(({ partNumber, etag }) => {
            const part = upload.parts.get(partNumber);
            if (!part || part.etag !== etag) throw new Error("Multipart ETag mismatch.");
            return part.bytes;
          }),
        );
        const object = {
          key,
          size: bytes.length,
          etag: `etag-${bucket.objects.size + 1}`,
          checksums: {
            toJSON: () => ({ sha256: upload.options.customMetadata.sha256 }),
          },
          httpMetadata: upload.options.httpMetadata,
          customMetadata: upload.options.customMetadata,
        };
        bucket.objects.set(key, object);
        bucket.bytes.set(key, bytes);
        bucket.uploads.delete(uploadId);
        return object;
      },
      async abort() {
        find();
        bucket.uploads.delete(uploadId);
      },
    };
  }
}
