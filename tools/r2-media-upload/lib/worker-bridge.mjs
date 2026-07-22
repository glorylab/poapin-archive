import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  BRIDGE_AUTH_SCHEME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_STATUS_PATH,
  BRIDGE_UPLOAD_PATH,
  createBridgeSignaturePayload,
} from "./bridge-protocol.mjs";
import { ExistingObjectConflictError, redactErrorMessage } from "./r2.mjs";

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class WorkerBridgeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerBridgeConfigurationError";
    this.code = "INVALID_WORKER_BRIDGE_CONFIGURATION";
  }
}

class WorkerBridgeResponseError extends Error {
  constructor(status, code = "bridge_request_failed") {
    super(`Upload bridge returned HTTP ${status} (${code}).`);
    this.name = "WorkerBridgeResponseError";
    this.code = String(code).slice(0, 80);
    this.httpStatus = status;
  }
}

export function createWorkerBridgeTarget({
  bridgeUrl,
  bucket = process.env.R2_BUCKET,
  secret = process.env.R2_UPLOAD_BRIDGE_SECRET,
  snapshotId,
  cacheControl,
  maximumEntryBytes,
  attempts = 4,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!bucket || !BUCKET_PATTERN.test(bucket)) {
    throw new WorkerBridgeConfigurationError(
      "R2_BUCKET/--bucket must be a valid lowercase R2 bucket name.",
    );
  }
  if (
    !secret ||
    !SECRET_PATTERN.test(secret) ||
    Buffer.from(secret, "base64url").byteLength !== 32
  ) {
    throw new WorkerBridgeConfigurationError(
      "R2_UPLOAD_BRIDGE_SECRET must be an unpadded base64url-encoded 32-byte secret.",
    );
  }

  let endpoint;
  try {
    endpoint = new URL(bridgeUrl);
  } catch {
    throw new WorkerBridgeConfigurationError("--bridge-url must be a valid HTTPS origin.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new WorkerBridgeConfigurationError(
      "--bridge-url must be an HTTPS origin without credentials, a path, query, or fragment.",
    );
  }

  return {
    bucket,
    endpoint: endpoint.origin,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    secrets: [secret],
    uploader: new ImmutableWorkerBridgeUploader({
      endpoint: endpoint.origin,
      bucket,
      snapshotId,
      cacheControl,
      maximumEntryBytes,
      secret,
      attempts,
      fetchImpl,
      now,
    }),
  };
}

export class ImmutableWorkerBridgeUploader {
  constructor({
    endpoint,
    bucket,
    snapshotId,
    cacheControl,
    maximumEntryBytes,
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
    this.cacheControl = cacheControl;
    this.maximumEntryBytes = maximumEntryBytes;
    this.secret = Buffer.from(secret, "base64url");
    this.redactionSecrets = [secret];
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
          path: BRIDGE_STATUS_PATH,
          key: "-",
          byteLength: 0,
          sha256: "-",
          signal,
        }),
      signal,
    );
    const expectedPrefix = `snapshots/${this.snapshotId}/artwork/`;
    if (
      payload?.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      payload.bucket !== this.bucket ||
      payload.snapshotId !== this.snapshotId ||
      payload.objectPrefix !== expectedPrefix ||
      payload.cacheControl !== this.cacheControl ||
      payload.maximumObjectBytes !== this.maximumEntryBytes
    ) {
      const error = new Error("Upload bridge target metadata does not match this import.");
      error.name = "WorkerBridgeProtocolError";
      error.code = "WORKER_BRIDGE_TARGET_MISMATCH";
      throw error;
    }
  }

  async upload({ key, bytes, sha256, signal }) {
    const payload = await this.#withRetries(
      () =>
        this.#request({
          method: "PUT",
          path: BRIDGE_UPLOAD_PATH,
          key,
          byteLength: bytes.byteLength,
          sha256,
          bytes,
          signal,
        }),
      signal,
    );
    if (
      !payload ||
      !["uploaded", "reused"].includes(payload.disposition) ||
      payload.key !== key ||
      payload.byteLength !== bytes.byteLength ||
      payload.sha256 !== sha256 ||
      typeof payload.etag !== "string" ||
      payload.etag.length === 0 ||
      payload.etag.length > 256
    ) {
      const error = new Error("Upload bridge returned an invalid success response.");
      error.name = "WorkerBridgeProtocolError";
      error.code = "INVALID_WORKER_BRIDGE_RESPONSE";
      throw error;
    }
    return { disposition: payload.disposition, etag: payload.etag };
  }

  async #request({ method, path, key, byteLength, sha256, bytes, signal }) {
    const timestamp = Math.floor(this.now() / 1000);
    const signaturePayload = createBridgeSignaturePayload({
      method,
      path,
      bucket: this.bucket,
      snapshotId: this.snapshotId,
      key,
      byteLength,
      sha256,
      timestamp,
    });
    const signature = createHmac("sha256", this.secret)
      .update(signaturePayload)
      .digest("base64url");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `${BRIDGE_AUTH_SCHEME} ${signature}`,
      "X-POAPin-Bucket": this.bucket,
      "X-POAPin-Snapshot": this.snapshotId,
      "X-POAPin-Timestamp": String(timestamp),
    });
    if (method === "PUT") {
      headers.set("Content-Length", String(byteLength));
      headers.set("Content-Type", "image/webp");
      headers.set("X-POAPin-Object-Key", key);
      headers.set("X-POAPin-SHA256", sha256);
    }

    const response = await this.fetchImpl(new URL(path, this.endpoint), {
      method,
      headers,
      ...(bytes ? { body: bytes } : {}),
      redirect: "error",
      signal,
    });
    let payload;
    try {
      payload = await readJsonResponse(response);
    } catch (error) {
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 409) {
        const conflict = new ExistingObjectConflictError(key);
        conflict.httpStatus = 409;
        throw conflict;
      }
      throw new WorkerBridgeResponseError(response.status, payload?.code);
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
        if (signal?.aborted || !isBridgeRetryable(error) || attempt === this.attempts) break;
        const waitMs = Math.round(250 * 2 ** (attempt - 1) * (0.75 + this.random() * 0.5));
        try {
          await this.sleep(waitMs, undefined, { signal });
        } catch (sleepError) {
          latestError = sleepError;
          break;
        }
      }
    }

    const wrapped = new Error(redactErrorMessage(latestError, this.redactionSecrets));
    wrapped.name = latestError?.name ?? "WorkerBridgeUploadError";
    wrapped.code = latestError?.code ?? latestError?.name ?? "WORKER_BRIDGE_UPLOAD_FAILED";
    wrapped.attempts = attemptsMade;
    wrapped.httpStatus = latestError?.httpStatus ?? null;
    throw wrapped;
  }
}

function isBridgeRetryable(error) {
  if (error instanceof ExistingObjectConflictError) return false;
  const status = error?.httpStatus;
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  if (typeof status === "number") return false;
  if (error?.code === "INVALID_WORKER_BRIDGE_RESPONSE") return false;
  return error?.name !== "AbortError" && error?.code !== "WORKER_BRIDGE_TARGET_MISMATCH";
}

async function readJsonResponse(response) {
  const maximumBytes = 32_768;
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    await response.body?.cancel();
    throw protocolResponseError();
  }
  if (!response.body) throw protocolResponseError();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw protocolResponseError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks, totalBytes).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw protocolResponseError();
  }
}

function protocolResponseError() {
  const error = new Error("Upload bridge returned a malformed response.");
  error.name = "WorkerBridgeProtocolError";
  error.code = "INVALID_WORKER_BRIDGE_RESPONSE";
  return error;
}
