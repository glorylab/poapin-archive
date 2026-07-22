import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  COLLECTIONS_BRIDGE_AUTH_SCHEME,
  COLLECTIONS_BRIDGE_OBJECT_PATH,
  COLLECTIONS_BRIDGE_PROTOCOL_VERSION,
  COLLECTIONS_BRIDGE_STATUS_PATH,
  createCollectionsBridgeSignaturePayload,
} from "./protocol.mjs";

const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_ALLOWED_OBJECT_BYTES = 100_000_000;

export class CollectionsBridgeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CollectionsBridgeConfigurationError";
    this.code = "INVALID_COLLECTIONS_BRIDGE_CONFIGURATION";
  }
}

export class ExistingCollectionObjectConflictError extends Error {
  constructor(key) {
    super(`R2 already contains conflicting immutable object ${key}.`);
    this.name = "ExistingCollectionObjectConflictError";
    this.code = "EXISTING_OBJECT_CONFLICT";
    this.httpStatus = 409;
  }
}

class CollectionsBridgeResponseError extends Error {
  constructor(status, code = "bridge_request_failed") {
    super(`Collections upload bridge returned HTTP ${status} (${code}).`);
    this.name = "CollectionsBridgeResponseError";
    this.code = String(code).slice(0, 80);
    this.httpStatus = status;
  }
}

export function createCollectionsBridgeTarget({
  bridgeUrl,
  bucket,
  snapshotId,
  archiveSnapshotId,
  objectPrefix = "snapshots/",
  cacheControl,
  maximumObjectBytes,
  secret = process.env.COLLECTIONS_R2_BRIDGE_SECRET,
  attempts = 4,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!bucket || !BUCKET_PATTERN.test(bucket)) {
    throw new CollectionsBridgeConfigurationError(
      "--bucket must be a valid lowercase R2 bucket name.",
    );
  }
  if (!snapshotId || !SNAPSHOT_PATTERN.test(snapshotId)) {
    throw new CollectionsBridgeConfigurationError(
      "--snapshot-id must be a valid lowercase snapshot slug.",
    );
  }
  if (!archiveSnapshotId || !SNAPSHOT_PATTERN.test(archiveSnapshotId)) {
    throw new CollectionsBridgeConfigurationError(
      "archiveSnapshotId must be a valid lowercase snapshot slug.",
    );
  }
  const expectedPrefix = "snapshots/";
  if (objectPrefix !== expectedPrefix) {
    throw new CollectionsBridgeConfigurationError(
      "The Collections object prefix is not canonical.",
    );
  }
  if (!cacheControl || typeof cacheControl !== "string" || cacheControl.length > 256) {
    throw new CollectionsBridgeConfigurationError("cacheControl must be a non-empty value.");
  }
  if (
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > MAXIMUM_ALLOWED_OBJECT_BYTES
  ) {
    throw new CollectionsBridgeConfigurationError(
      "maximumObjectBytes must be an integer from 1 to 100000000.",
    );
  }
  if (
    !secret ||
    !SECRET_PATTERN.test(secret) ||
    Buffer.from(secret, "base64url").byteLength !== 32
  ) {
    throw new CollectionsBridgeConfigurationError(
      "COLLECTIONS_R2_BRIDGE_SECRET must be an unpadded base64url-encoded 32-byte secret.",
    );
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new CollectionsBridgeConfigurationError("attempts must be an integer from 1 to 10.");
  }

  let endpoint;
  try {
    endpoint = new URL(bridgeUrl);
  } catch {
    throw new CollectionsBridgeConfigurationError("--bridge-url must be a valid HTTPS origin.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new CollectionsBridgeConfigurationError(
      "--bridge-url must be an HTTPS origin without credentials, path, query, or fragment.",
    );
  }

  return {
    bucket,
    endpoint: endpoint.origin,
    objectPrefix,
    archiveSnapshotId,
    protocolVersion: COLLECTIONS_BRIDGE_PROTOCOL_VERSION,
    uploader: new ImmutableCollectionsBridgeUploader({
      endpoint: endpoint.origin,
      bucket,
      snapshotId,
      archiveSnapshotId,
      objectPrefix,
      cacheControl,
      maximumObjectBytes,
      secret,
      attempts,
      fetchImpl,
      now,
    }),
  };
}

export class ImmutableCollectionsBridgeUploader {
  constructor({
    endpoint,
    bucket,
    snapshotId,
    archiveSnapshotId,
    objectPrefix,
    cacheControl,
    maximumObjectBytes,
    secret,
    attempts = 4,
    fetchImpl = fetch,
    sleep = delay,
    random = Math.random,
    now = Date.now,
  }) {
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.snapshotId = snapshotId;
    this.archiveSnapshotId = archiveSnapshotId;
    this.objectPrefix = objectPrefix;
    this.cacheControl = cacheControl;
    this.maximumObjectBytes = maximumObjectBytes;
    this.secret = Buffer.from(secret, "base64url");
    this.attempts = attempts;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.random = random;
    this.now = now;
  }

  async verifyTarget({ signal } = {}) {
    const payload = await this.#withRetries(
      () =>
        this.#request({
          method: "GET",
          path: COLLECTIONS_BRIDGE_STATUS_PATH,
          key: "-",
          byteLength: 0,
          sha256: "-",
          contentType: "-",
          signal,
        }),
      signal,
    );
    if (
      payload?.protocolVersion !== COLLECTIONS_BRIDGE_PROTOCOL_VERSION ||
      payload.bucket !== this.bucket ||
      payload.snapshotId !== this.snapshotId ||
      payload.archiveSnapshotId !== this.archiveSnapshotId ||
      payload.objectPrefix !== this.objectPrefix ||
      payload.cacheControl !== this.cacheControl ||
      payload.maximumObjectBytes !== this.maximumObjectBytes ||
      !Array.isArray(payload.capabilities) ||
      payload.capabilities.join(",") !== "head,put-if-absent,archive-reuse-head"
    ) {
      throw protocolError(
        "Collections upload bridge target metadata does not match this publication.",
        "COLLECTIONS_BRIDGE_TARGET_MISMATCH",
      );
    }
  }

  async head(expected, { signal } = {}) {
    const mode = expected.mode === "archive-reuse" ? "archive-reuse" : "upload";
    return this.#withRetries(
      () =>
        this.#request({
          method: "HEAD",
          path: COLLECTIONS_BRIDGE_OBJECT_PATH,
          key: expected.key,
          byteLength: expected.byteLength,
          sha256: expected.sha256,
          contentType: expected.contentType,
          mode,
          signal,
        }),
      signal,
    );
  }

  async upload({ key, bytes, byteLength, sha256, contentType, signal }) {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== byteLength) {
      throw protocolError(
        "Upload bytes do not match the declared object length.",
        "LOCAL_OBJECT_SIZE_MISMATCH",
      );
    }
    const payload = await this.#withRetries(
      () =>
        this.#request({
          method: "PUT",
          path: COLLECTIONS_BRIDGE_OBJECT_PATH,
          key,
          byteLength,
          sha256,
          contentType,
          mode: "upload",
          bytes,
          signal,
        }),
      signal,
    );
    if (
      !payload ||
      !["uploaded", "reused"].includes(payload.disposition) ||
      payload.key !== key ||
      payload.byteLength !== byteLength ||
      payload.sha256 !== sha256 ||
      payload.contentType !== contentType ||
      typeof payload.etag !== "string" ||
      payload.etag.length === 0 ||
      payload.etag.length > 256
    ) {
      throw protocolError("Collections upload bridge returned an invalid success response.");
    }
    return { disposition: payload.disposition, etag: payload.etag };
  }

  async #request({
    method,
    path,
    key,
    byteLength,
    sha256,
    contentType,
    mode = "status",
    bytes,
    signal,
  }) {
    const timestamp = Math.floor(this.now() / 1000);
    const signaturePayload = createCollectionsBridgeSignaturePayload({
      method,
      path,
      bucket: this.bucket,
      snapshotId: this.snapshotId,
      objectPrefix: this.objectPrefix,
      mode,
      key,
      byteLength,
      sha256,
      contentType,
      timestamp,
    });
    const signature = createHmac("sha256", this.secret)
      .update(signaturePayload)
      .digest("base64url");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `${COLLECTIONS_BRIDGE_AUTH_SCHEME} ${signature}`,
      "X-POAPin-Bucket": this.bucket,
      "X-POAPin-Snapshot": this.snapshotId,
      "X-POAPin-Object-Prefix": this.objectPrefix,
      "X-POAPin-Object-Mode": mode,
      "X-POAPin-Timestamp": String(timestamp),
    });
    if (method === "PUT" || method === "HEAD") {
      headers.set("X-POAPin-Object-Key", key);
      headers.set("X-POAPin-Object-Byte-Length", String(byteLength));
      headers.set("X-POAPin-SHA256", sha256);
      headers.set("X-POAPin-Content-Type", contentType);
    }
    if (method === "PUT") {
      headers.set("Content-Length", String(byteLength));
      headers.set("Content-Type", contentType);
    }

    const response = await this.fetchImpl(new URL(path, this.endpoint), {
      method,
      headers,
      ...(bytes ? { body: bytes } : {}),
      redirect: "error",
      signal,
    });
    if (method === "HEAD")
      return readHeadResponse(response, { key, byteLength, sha256, contentType });

    let payload;
    try {
      payload = await readJsonResponse(response);
    } catch (error) {
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 409) throw new ExistingCollectionObjectConflictError(key);
      throw new CollectionsBridgeResponseError(response.status, payload?.code);
    }
    return payload;
  }

  async #withRetries(task, signal) {
    let latestError;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        return await task();
      } catch (error) {
        latestError = error;
        if (signal?.aborted || !isRetryable(error) || attempt === this.attempts) break;
        const waitMs = Math.round(250 * 2 ** (attempt - 1) * (0.75 + this.random() * 0.5));
        try {
          await this.sleep(waitMs, undefined, { signal });
        } catch (sleepError) {
          latestError = sleepError;
          break;
        }
      }
    }
    const wrapped = new Error(safeErrorMessage(latestError));
    wrapped.name = latestError?.name ?? "CollectionsBridgeUploadError";
    wrapped.code = latestError?.code ?? latestError?.name ?? "COLLECTIONS_BRIDGE_UPLOAD_FAILED";
    wrapped.attempts = attemptsMade;
    wrapped.httpStatus = latestError?.httpStatus ?? null;
    throw wrapped;
  }
}

function readHeadResponse(response, expected) {
  if (
    response.status === 404 &&
    response.headers.get("x-poapin-error-code") === "object_not_found"
  ) {
    return null;
  }
  if (response.status === 409) throw new ExistingCollectionObjectConflictError(expected.key);
  if (!response.ok) {
    throw new CollectionsBridgeResponseError(
      response.status,
      response.headers.get("x-poapin-error-code") ?? "bridge_head_failed",
    );
  }
  const actual = {
    key: response.headers.get("x-poapin-object-key"),
    byteLength: Number(response.headers.get("x-poapin-object-byte-length")),
    sha256: response.headers.get("x-poapin-sha256"),
    contentType: response.headers.get("x-poapin-content-type"),
    etag: response.headers.get("etag"),
  };
  if (
    actual.key !== expected.key ||
    actual.byteLength !== expected.byteLength ||
    actual.sha256 !== expected.sha256 ||
    actual.contentType !== expected.contentType ||
    !actual.etag ||
    actual.etag.length > 256
  ) {
    throw protocolError("Collections upload bridge returned invalid HEAD metadata.");
  }
  return actual;
}

function isRetryable(error) {
  if (error instanceof ExistingCollectionObjectConflictError) return false;
  const status = error?.httpStatus;
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  if (typeof status === "number") return false;
  return error?.name !== "AbortError" && !String(error?.code).includes("MISMATCH");
}

async function readJsonResponse(response) {
  const maximumBytes = 32_768;
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    await response.body?.cancel();
    throw protocolError("Collections upload bridge returned an oversized response.");
  }
  if (!response.body) throw protocolError("Collections upload bridge returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw protocolError("Collections upload bridge returned an oversized response.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw protocolError("Collections upload bridge returned malformed JSON.");
  }
}

function protocolError(message, code = "INVALID_COLLECTIONS_BRIDGE_RESPONSE") {
  return Object.assign(new Error(message), {
    name: "CollectionsBridgeProtocolError",
    code,
  });
}

function safeErrorMessage(error) {
  return (error instanceof Error ? error.message : String(error ?? "Unknown bridge failure")).slice(
    0,
    600,
  );
}
