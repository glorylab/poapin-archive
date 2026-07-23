import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  MOMENTS_BRIDGE_AUTH_SCHEME,
  MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS,
  MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES,
  MOMENTS_BRIDGE_MULTIPART_ABORT_PATH,
  MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH,
  MOMENTS_BRIDGE_MULTIPART_CREATE_PATH,
  MOMENTS_BRIDGE_MULTIPART_PART_PATH,
  MOMENTS_BRIDGE_OBJECT_PATH,
  MOMENTS_BRIDGE_PROTOCOL_VERSION,
  MOMENTS_BRIDGE_STATUS_PATH,
  classifyMomentsMediaObject,
  createMomentsBridgeSignaturePayload,
  validateMomentsBucketPair,
} from "./protocol.mjs";

const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const ETAG_PATTERN = /^[\x20-\x7e]{1,256}$/;
const MAXIMUM_R2_OBJECT_BYTES = 5_000_000_000_000;
const CONFLICT_FIELDS = new Set([
  "object",
  "key",
  "size",
  "etag",
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
]);
const EXPECTED_CAPABILITIES = Object.freeze([
  "head",
  "put-if-absent",
  "multipart-create-if-absent",
  "multipart-upload-part",
  "multipart-complete-if-absent",
  "multipart-abort",
]);

export class MomentsBridgeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MomentsBridgeConfigurationError";
    this.code = "INVALID_MOMENTS_BRIDGE_CONFIGURATION";
  }
}

export function createMomentsBridge({
  bridgeUrl,
  snapshotId,
  publicBucket,
  privateBucket,
  maximumObjectBytes = 100_000_000,
  maximumMultipartObjectBytes = 5_000_000_000,
  multipartPartBytes = 16_777_216,
  attempts = 4,
  secret = process.env.MOMENTS_R2_BRIDGE_SECRET,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const endpoint = parseOrigin(bridgeUrl);
  if (!SNAPSHOT_PATTERN.test(snapshotId ?? "")) {
    throw configurationError("--snapshot-id must be a valid lowercase snapshot slug.");
  }
  try {
    validateMomentsBucketPair(publicBucket, privateBucket);
  } catch (error) {
    throw configurationError(error.message);
  }
  if (
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > 100_000_000
  ) {
    throw configurationError("maximumObjectBytes must be from 1 to 100000000.");
  }
  if (
    !Number.isSafeInteger(maximumMultipartObjectBytes) ||
    maximumMultipartObjectBytes < maximumObjectBytes ||
    maximumMultipartObjectBytes > MAXIMUM_R2_OBJECT_BYTES
  ) {
    throw configurationError(
      "maximumMultipartObjectBytes must cover the single-request limit and stay within R2 limits.",
    );
  }
  if (
    !Number.isSafeInteger(multipartPartBytes) ||
    multipartPartBytes < MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES ||
    multipartPartBytes > maximumObjectBytes
  ) {
    throw configurationError(
      `multipartPartBytes must be from ${MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES} to maximumObjectBytes.`,
    );
  }
  if (!SECRET_PATTERN.test(secret ?? "") || Buffer.from(secret, "base64url").length !== 32) {
    throw configurationError(
      "MOMENTS_R2_BRIDGE_SECRET must be an unpadded base64url-encoded 32-byte secret.",
    );
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw configurationError("attempts must be an integer from 1 to 10.");
  }
  return new MomentsBridgeClient({
    endpoint,
    snapshotId,
    buckets: { public: publicBucket, private: privateBucket },
    maximumObjectBytes,
    maximumMultipartObjectBytes,
    multipartPartBytes,
    attempts,
    secret: Buffer.from(secret, "base64url"),
    fetchImpl,
    now,
  });
}

export class MomentsBridgeClient {
  constructor({
    endpoint,
    snapshotId,
    buckets,
    maximumObjectBytes,
    maximumMultipartObjectBytes,
    multipartPartBytes,
    attempts,
    secret,
    fetchImpl,
    now,
    sleep = delay,
    random = Math.random,
  }) {
    this.endpoint = endpoint;
    this.snapshotId = snapshotId;
    this.buckets = buckets;
    this.maximumObjectBytes = maximumObjectBytes;
    this.maximumMultipartObjectBytes = maximumMultipartObjectBytes;
    this.multipartPartBytes = multipartPartBytes;
    this.attempts = attempts;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
  }

  async verifyTargets({ signal } = {}) {
    for (const target of ["public", "private"]) {
      const payload = await this.#withRetries(
        () =>
          this.#request({
            method: "GET",
            path: MOMENTS_BRIDGE_STATUS_PATH,
            target,
            key: "-",
            byteLength: 0,
            sha256: "-",
            contentType: "-",
            signal,
          }),
        signal,
      );
      if (
        payload?.protocolVersion !== MOMENTS_BRIDGE_PROTOCOL_VERSION ||
        payload.snapshotId !== this.snapshotId ||
        payload.targets?.public?.bucket !== this.buckets.public ||
        payload.targets?.private?.bucket !== this.buckets.private ||
        payload.maximumObjectBytes !== this.maximumObjectBytes ||
        payload.maximumMultipartObjectBytes < this.maximumMultipartObjectBytes ||
        payload.maximumMultipartPartBytes < this.multipartPartBytes ||
        payload.minimumMultipartPartBytes !== MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES ||
        payload.maximumMultipartParts !== MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS ||
        payload.capabilities?.join(",") !== EXPECTED_CAPABILITIES.join(",")
      ) {
        throw protocolError("Moments bridge target metadata does not match this capture.");
      }
    }
  }

  async head(object, { signal } = {}) {
    validateObject(object, this.snapshotId, this.maximumMultipartObjectBytes);
    try {
      return await this.#withRetries(async () => {
        const result = await this.#request({
          method: "HEAD",
          path: MOMENTS_BRIDGE_OBJECT_PATH,
          ...object,
          signal,
        });
        if (!result) throw retryableObjectNotFoundError();
        return result;
      }, signal);
    } catch (error) {
      if (error?.code === "MOMENTS_BRIDGE_OBJECT_NOT_FOUND") return null;
      throw error;
    }
  }

  async uploadFile(object, path, { signal } = {}) {
    validateObject(object, this.snapshotId, this.maximumObjectBytes);
    const details = await stat(path);
    if (!details.isFile() || details.size !== object.byteLength) {
      throw protocolError("Local media file does not match the declared object length.");
    }
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== object.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== object.sha256
    ) {
      throw protocolError("Local media bytes changed while preparing the upload.");
    }
    return this.#withRetries(
      () =>
        this.#request({
          method: "PUT",
          path: MOMENTS_BRIDGE_OBJECT_PATH,
          ...object,
          bodySha256: object.sha256,
          bytes,
          signal,
        }),
      signal,
    );
  }

  async createMultipartUpload(object, { signal } = {}) {
    validateObject(object, this.snapshotId, this.maximumMultipartObjectBytes);
    return this.#withRetries(
      () =>
        this.#request({
          method: "POST",
          path: MOMENTS_BRIDGE_MULTIPART_CREATE_PATH,
          ...object,
          signal,
        }),
      signal,
    );
  }

  async uploadMultipartPart(object, uploadId, partNumber, bytes, { signal } = {}) {
    validateObject(object, this.snapshotId, this.maximumMultipartObjectBytes);
    validateUploadId(uploadId);
    validatePartNumber(partNumber);
    const body = Buffer.from(bytes);
    if (body.byteLength < 1 || body.byteLength > this.multipartPartBytes) {
      throw protocolError("Multipart part length is outside the configured bound.");
    }
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    return this.#withRetries(
      () =>
        this.#request({
          method: "PUT",
          path: MOMENTS_BRIDGE_MULTIPART_PART_PATH,
          ...object,
          uploadId,
          partNumber,
          partByteLength: body.byteLength,
          bodySha256,
          bytes: body,
          signal,
        }),
      signal,
    );
  }

  async completeMultipartUpload(object, uploadId, parts, { signal } = {}) {
    validateObject(object, this.snapshotId, this.maximumMultipartObjectBytes);
    validateUploadId(uploadId);
    const normalized = validateCompletedParts(parts, object.byteLength, this.multipartPartBytes);
    const bytes = Buffer.from(JSON.stringify({ parts: normalized }));
    const bodySha256 = createHash("sha256").update(bytes).digest("hex");
    return this.#withRetries(
      () =>
        this.#request({
          method: "POST",
          path: MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH,
          ...object,
          uploadId,
          bodySha256,
          bytes,
          signal,
        }),
      signal,
    );
  }

  async abortMultipartUpload(object, uploadId, { signal } = {}) {
    validateObject(object, this.snapshotId, this.maximumMultipartObjectBytes);
    validateUploadId(uploadId);
    return this.#withRetries(
      () =>
        this.#request({
          method: "POST",
          path: MOMENTS_BRIDGE_MULTIPART_ABORT_PATH,
          ...object,
          uploadId,
          signal,
        }),
      signal,
    );
  }

  async #request({
    method,
    path,
    target,
    key,
    byteLength,
    sha256,
    contentType,
    uploadId = "-",
    partNumber = 0,
    partByteLength = 0,
    bodySha256 = "-",
    bytes,
    signal,
  }) {
    const bucket = this.buckets[target];
    if (!bucket) throw protocolError("Moments bridge target is invalid.");
    const timestamp = Math.floor(this.now() / 1000);
    const payload = createMomentsBridgeSignaturePayload({
      method,
      path,
      target,
      bucket,
      snapshotId: this.snapshotId,
      key,
      byteLength,
      sha256,
      contentType,
      uploadId,
      partNumber,
      partByteLength,
      bodySha256,
      timestamp,
    });
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `${MOMENTS_BRIDGE_AUTH_SCHEME} ${signature}`,
      "X-POAPin-Target": target,
      "X-POAPin-Bucket": bucket,
      "X-POAPin-Snapshot": this.snapshotId,
      "X-POAPin-Timestamp": String(timestamp),
    });
    if (method !== "GET") {
      headers.set("X-POAPin-Object-Key", key);
      headers.set("X-POAPin-Object-Byte-Length", String(byteLength));
      headers.set("X-POAPin-SHA256", sha256);
      headers.set("X-POAPin-Content-Type", contentType);
    }
    if (uploadId !== "-") headers.set("X-POAPin-Multipart-Upload-ID", uploadId);
    if (partNumber > 0) headers.set("X-POAPin-Multipart-Part-Number", String(partNumber));
    if (partByteLength > 0) {
      headers.set("X-POAPin-Multipart-Part-Byte-Length", String(partByteLength));
    }
    if (bodySha256 !== "-") headers.set("X-POAPin-Body-SHA256", bodySha256);
    if (
      [MOMENTS_BRIDGE_MULTIPART_CREATE_PATH, MOMENTS_BRIDGE_MULTIPART_ABORT_PATH].includes(path)
    ) {
      headers.set("Content-Length", "0");
    }
    if (bytes) {
      headers.set("Content-Length", String(bytes.byteLength));
      headers.set(
        "Content-Type",
        path === MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH
          ? "application/json"
          : path === MOMENTS_BRIDGE_MULTIPART_PART_PATH
            ? "application/octet-stream"
            : contentType,
      );
    }
    const response = await this.fetchImpl(new URL(path, this.endpoint), {
      method,
      headers,
      ...(bytes ? { body: bytes } : {}),
      redirect: "error",
      signal,
    });
    if (method === "HEAD") {
      return parseHead(response, { target, key, byteLength, sha256, contentType });
    }
    const result = await parseJson(response);
    if (!response.ok) throw responseError(response, result?.code);
    return validateResponse(path, result, {
      target,
      key,
      byteLength,
      sha256,
      contentType,
      uploadId,
      partNumber,
      partByteLength,
      bodySha256,
    });
  }

  async #withRetries(task, signal) {
    let latest;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        latest = error;
        if (signal?.aborted || !isRetryable(error) || attempt === this.attempts) break;
        await this.sleep(
          Math.round(250 * 2 ** (attempt - 1) * (0.75 + this.random() * 0.5)),
          undefined,
          { signal },
        );
      }
    }
    throw latest;
  }
}

function validateResponse(path, result, expected) {
  if (path === MOMENTS_BRIDGE_STATUS_PATH) return result;
  if (path === MOMENTS_BRIDGE_MULTIPART_CREATE_PATH) {
    if (
      !["created", "reused"].includes(result?.disposition) ||
      !matchesObjectResponse(result, expected) ||
      (result.disposition === "created" && !UPLOAD_ID_PATTERN.test(result.uploadId ?? "")) ||
      (result.disposition === "reused" && !ETAG_PATTERN.test(result.etag ?? ""))
    ) {
      throw protocolError("Moments bridge returned an invalid multipart-create response.");
    }
    return result;
  }
  if (path === MOMENTS_BRIDGE_MULTIPART_PART_PATH) {
    if (
      result?.disposition !== "uploaded" ||
      result.target !== expected.target ||
      result.key !== expected.key ||
      result.uploadId !== expected.uploadId ||
      result.partNumber !== expected.partNumber ||
      result.byteLength !== expected.partByteLength ||
      result.sha256 !== expected.bodySha256 ||
      !ETAG_PATTERN.test(result.etag ?? "")
    ) {
      throw protocolError("Moments bridge returned an invalid multipart-part response.");
    }
    return result;
  }
  if (path === MOMENTS_BRIDGE_MULTIPART_ABORT_PATH) {
    if (
      !["aborted", "already_absent"].includes(result?.disposition) ||
      result.target !== expected.target ||
      result.key !== expected.key ||
      result.uploadId !== expected.uploadId
    ) {
      throw protocolError("Moments bridge returned an invalid multipart-abort response.");
    }
    return result;
  }
  if (
    !["uploaded", "reused"].includes(result?.disposition) ||
    !matchesObjectResponse(result, expected) ||
    !ETAG_PATTERN.test(result.etag ?? "")
  ) {
    throw protocolError("Moments bridge returned an invalid immutable-object response.");
  }
  return result;
}

function matchesObjectResponse(result, expected) {
  return (
    result.target === expected.target &&
    result.key === expected.key &&
    result.byteLength === expected.byteLength &&
    result.sha256 === expected.sha256 &&
    result.contentType === expected.contentType
  );
}

function validateObject(object, snapshotId, maximumBytes) {
  if (
    !object ||
    !["public", "private"].includes(object.target) ||
    typeof object.key !== "string" ||
    !Number.isSafeInteger(object.byteLength) ||
    object.byteLength < 1 ||
    object.byteLength > maximumBytes ||
    !SHA256_PATTERN.test(object.sha256 ?? "") ||
    typeof object.contentType !== "string" ||
    !classifyMomentsMediaObject({ snapshotId, ...object })
  ) {
    throw protocolError("Immutable media object metadata is invalid.");
  }
}

function validateUploadId(value) {
  if (!UPLOAD_ID_PATTERN.test(value ?? "")) {
    throw protocolError("Multipart upload ID is invalid.");
  }
}

function validatePartNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS) {
    throw protocolError("Multipart part number is invalid.");
  }
}

function validateCompletedParts(parts, objectByteLength, maximumPartBytes) {
  if (
    !Array.isArray(parts) ||
    parts.length < 1 ||
    parts.length > MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS
  ) {
    throw protocolError("Multipart completion parts are invalid.");
  }
  let total = 0;
  const normalized = parts.map((part, index) => {
    validatePartNumber(part?.partNumber);
    if (part.partNumber !== index + 1 || !ETAG_PATTERN.test(part.etag ?? "")) {
      throw protocolError("Multipart completion parts must be contiguous and ordered.");
    }
    if (
      !Number.isSafeInteger(part.byteLength) ||
      part.byteLength < 1 ||
      part.byteLength > maximumPartBytes ||
      !SHA256_PATTERN.test(part.sha256 ?? "") ||
      (index < parts.length - 1 && part.byteLength < MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES)
    ) {
      throw protocolError("Multipart completion part metadata is invalid.");
    }
    total += part.byteLength;
    return {
      partNumber: part.partNumber,
      etag: part.etag,
      byteLength: part.byteLength,
      sha256: part.sha256,
    };
  });
  if (total !== objectByteLength) {
    throw protocolError("Multipart completion length does not match the immutable object.");
  }
  return normalized;
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("--bridge-url must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw configurationError("--bridge-url must be an HTTPS origin without a path or credentials.");
  }
  return url.origin;
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw protocolError("Moments bridge returned invalid JSON.");
  }
}

function parseHead(response, expected) {
  if (response.status === 404) return null;
  if (!response.ok) {
    throw responseError(response, response.headers.get("x-poapin-error-code"), {
      conflictFields: parseConflictFields(response.headers.get("x-poapin-conflict-fields")),
    });
  }
  const byteLength = Number(response.headers.get("x-poapin-object-byte-length"));
  const result = {
    target: response.headers.get("x-poapin-target"),
    key: response.headers.get("x-poapin-object-key"),
    byteLength,
    sha256: response.headers.get("x-poapin-sha256"),
    contentType: response.headers.get("x-poapin-content-type"),
    etag: response.headers.get("etag"),
  };
  if (!matchesObjectResponse(result, expected) || !ETAG_PATTERN.test(result.etag ?? "")) {
    throw protocolError("Moments bridge HEAD response did not match the immutable object.");
  }
  return result;
}

function responseError(response, code, { conflictFields = [] } = {}) {
  const conflictSummary =
    conflictFields.length > 0 ? ` Conflict fields: ${conflictFields.join(", ")}.` : "";
  const error = new Error(
    `Moments bridge returned HTTP ${response.status} (${code ?? "request_failed"}).` +
      conflictSummary,
  );
  error.name = "MomentsBridgeResponseError";
  error.code = code ?? "MOMENTS_BRIDGE_REQUEST_FAILED";
  error.httpStatus = response.status;
  error.conflictFields = conflictFields;
  return error;
}

function retryableObjectNotFoundError() {
  const error = new Error("Moments bridge object was not found.");
  error.name = "MomentsBridgeObjectNotFoundError";
  error.code = "MOMENTS_BRIDGE_OBJECT_NOT_FOUND";
  return error;
}

function parseConflictFields(value) {
  if (typeof value !== "string" || value.length > 512) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((field) => field.trim())
        .filter((field) => CONFLICT_FIELDS.has(field)),
    ),
  ];
}

function isRetryable(error) {
  return !error?.httpStatus || error.httpStatus === 429 || error.httpStatus >= 500;
}

function configurationError(message) {
  return new MomentsBridgeConfigurationError(message);
}

function protocolError(message) {
  const error = new Error(message);
  error.name = "MomentsBridgeProtocolError";
  error.code = "MOMENTS_BRIDGE_PROTOCOL_ERROR";
  return error;
}
