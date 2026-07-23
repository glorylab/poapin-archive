import {
  MOMENTS_BRIDGE_AUTH_SCHEME,
  MOMENTS_BRIDGE_CLOCK_SKEW_SECONDS,
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const ETAG_PATTERN = /^[\x20-\x7e]{1,256}$/;
const MAXIMUM_ALLOWED_OBJECT_BYTES = 100_000_000;
const MAXIMUM_ALLOWED_MULTIPART_OBJECT_BYTES = 5_000_000_000_000;
const MAXIMUM_COMPLETE_BODY_BYTES = 2_000_000;
const CAPABILITIES = Object.freeze([
  "head",
  "put-if-absent",
  "multipart-create-if-absent",
  "multipart-upload-part",
  "multipart-complete-if-absent",
  "multipart-abort",
]);

export default {
  fetch(request, env) {
    return handleMomentsBridgeRequest(request, env);
  },
};

export async function handleMomentsBridgeRequest(request, env, now = Date.now) {
  const config = readConfig(env);
  if (!config) return jsonError(503, "bridge_unavailable");

  const url = new URL(request.url);
  if (url.search || url.hash) return jsonError(404, "not_found");

  if (url.pathname === MOMENTS_BRIDGE_STATUS_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const input = statusInput(request, config);
    if (!input || !(await authorize(request, config, input, now))) {
      return jsonError(401, "authorization_failed");
    }
    return jsonResponse(200, {
      protocolVersion: MOMENTS_BRIDGE_PROTOCOL_VERSION,
      snapshotId: config.snapshotId,
      targets: {
        public: {
          bucket: config.targets.public.bucketName,
          cacheControl: config.targets.public.cacheControl,
        },
        private: {
          bucket: config.targets.private.bucketName,
          cacheControl: config.targets.private.cacheControl,
        },
      },
      maximumObjectBytes: config.maximumObjectBytes,
      maximumMultipartObjectBytes: config.maximumMultipartObjectBytes,
      minimumMultipartPartBytes: MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES,
      maximumMultipartPartBytes: config.maximumMultipartPartBytes,
      maximumMultipartParts: MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS,
      capabilities: CAPABILITIES,
    });
  }

  if (url.pathname === MOMENTS_BRIDGE_OBJECT_PATH) {
    return handleObjectRequest(request, url, config, now);
  }
  if (
    [
      MOMENTS_BRIDGE_MULTIPART_CREATE_PATH,
      MOMENTS_BRIDGE_MULTIPART_PART_PATH,
      MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH,
      MOMENTS_BRIDGE_MULTIPART_ABORT_PATH,
    ].includes(url.pathname)
  ) {
    return handleMultipartRequest(request, url, config, now);
  }
  return jsonError(404, "not_found");
}

async function handleObjectRequest(request, url, config, now) {
  if (!["HEAD", "PUT"].includes(request.method)) return methodNotAllowed("HEAD, PUT");
  const object = readObjectHeaders(
    request,
    config,
    request.method === "HEAD" ? config.maximumMultipartObjectBytes : config.maximumObjectBytes,
  );
  if (!object.ok) return jsonError(object.status, object.code);
  const bodySha256 =
    request.method === "PUT" ? (request.headers.get("x-poapin-body-sha256") ?? "") : "-";
  if (request.method === "PUT" && bodySha256 !== object.sha256) {
    return jsonError(400, "invalid_body_sha256");
  }
  if (
    !(await authorize(
      request,
      config,
      {
        method: request.method,
        path: url.pathname,
        ...object,
        bodySha256,
      },
      now,
    ))
  ) {
    return jsonError(401, "authorization_failed");
  }

  const bucket = config.targets[object.target].binding;
  if (request.method === "HEAD") return headObject(bucket, config, object);
  if (request.body === null) return jsonError(400, "body_required");
  const contentLength = parsePositiveInteger(request.headers.get("content-length"));
  if (contentLength !== object.byteLength) return jsonError(400, "content_length_mismatch");
  if (normalizeContentType(request.headers.get("content-type")) !== object.contentType) {
    return jsonError(415, "invalid_media_type");
  }
  if (hasNonIdentityEncoding(request)) return jsonError(415, "content_encoding_not_allowed");
  return putObject(bucket, config, object, request.body);
}

async function handleMultipartRequest(request, url, config, now) {
  if (
    (url.pathname === MOMENTS_BRIDGE_MULTIPART_PART_PATH && request.method !== "PUT") ||
    (url.pathname !== MOMENTS_BRIDGE_MULTIPART_PART_PATH && request.method !== "POST")
  ) {
    return methodNotAllowed(url.pathname === MOMENTS_BRIDGE_MULTIPART_PART_PATH ? "PUT" : "POST");
  }
  const object = readObjectHeaders(request, config, config.maximumMultipartObjectBytes);
  if (!object.ok) return jsonError(object.status, object.code);
  const uploadId =
    url.pathname === MOMENTS_BRIDGE_MULTIPART_CREATE_PATH
      ? "-"
      : (request.headers.get("x-poapin-multipart-upload-id") ?? "");
  if (uploadId !== "-" && !UPLOAD_ID_PATTERN.test(uploadId)) {
    return jsonError(400, "invalid_multipart_upload_id");
  }
  const partNumber =
    url.pathname === MOMENTS_BRIDGE_MULTIPART_PART_PATH
      ? parsePositiveInteger(request.headers.get("x-poapin-multipart-part-number"))
      : 0;
  const partByteLength =
    url.pathname === MOMENTS_BRIDGE_MULTIPART_PART_PATH
      ? parsePositiveInteger(request.headers.get("x-poapin-multipart-part-byte-length"))
      : 0;
  const bodySha256 = [
    MOMENTS_BRIDGE_MULTIPART_PART_PATH,
    MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH,
  ].includes(url.pathname)
    ? (request.headers.get("x-poapin-body-sha256") ?? "")
    : "-";
  if (
    url.pathname === MOMENTS_BRIDGE_MULTIPART_PART_PATH &&
    (partNumber === null ||
      partNumber > MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS ||
      partByteLength === null ||
      partByteLength > config.maximumMultipartPartBytes ||
      !SHA256_PATTERN.test(bodySha256))
  ) {
    return jsonError(400, "invalid_multipart_part");
  }
  if (url.pathname === MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH && !SHA256_PATTERN.test(bodySha256)) {
    return jsonError(400, "invalid_body_sha256");
  }
  const authorizationInput = {
    method: request.method,
    path: url.pathname,
    ...object,
    uploadId,
    partNumber,
    partByteLength,
    bodySha256,
  };
  if (!(await authorize(request, config, authorizationInput, now))) {
    return jsonError(401, "authorization_failed");
  }

  const bucket = config.targets[object.target].binding;
  if (url.pathname === MOMENTS_BRIDGE_MULTIPART_CREATE_PATH) {
    if (!hasNormalizedZeroLengthBody(request)) return jsonError(400, "body_not_allowed");
    return createMultipartUpload(bucket, config, object);
  }
  if (url.pathname === MOMENTS_BRIDGE_MULTIPART_ABORT_PATH) {
    if (!hasNormalizedZeroLengthBody(request)) return jsonError(400, "body_not_allowed");
    return abortMultipartUpload(bucket, object, uploadId);
  }
  if (request.body === null) return jsonError(400, "body_required");
  if (hasNonIdentityEncoding(request)) return jsonError(415, "content_encoding_not_allowed");
  const contentLength = parsePositiveInteger(request.headers.get("content-length"));

  if (url.pathname === MOMENTS_BRIDGE_MULTIPART_PART_PATH) {
    if (
      contentLength !== partByteLength ||
      normalizeContentType(request.headers.get("content-type")) !== "application/octet-stream"
    ) {
      return jsonError(400, "multipart_part_body_mismatch");
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== partByteLength || (await sha256Hex(bytes)) !== bodySha256) {
      return jsonError(422, "checksum_mismatch");
    }
    return uploadMultipartPart(bucket, object, uploadId, partNumber, bodySha256, bytes);
  }

  if (
    contentLength === null ||
    contentLength > MAXIMUM_COMPLETE_BODY_BYTES ||
    normalizeContentType(request.headers.get("content-type")) !== "application/json"
  ) {
    return jsonError(400, "invalid_multipart_complete_body");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== contentLength || (await sha256Hex(bytes)) !== bodySha256) {
    return jsonError(422, "checksum_mismatch");
  }
  const parts = parseCompleteParts(bytes, object.byteLength, config.maximumMultipartPartBytes);
  if (!parts) return jsonError(400, "invalid_multipart_complete_parts");
  return completeMultipartUpload(bucket, config, object, uploadId, parts);
}

function statusInput(request, config) {
  const target = request.headers.get("x-poapin-target") ?? "";
  const selected = config.targets[target];
  if (!selected || request.headers.get("x-poapin-bucket") !== selected.bucketName) return null;
  return {
    method: "GET",
    path: MOMENTS_BRIDGE_STATUS_PATH,
    target,
    bucket: selected.bucketName,
    key: "-",
    byteLength: 0,
    sha256: "-",
    contentType: "-",
  };
}

function readObjectHeaders(request, config, maximumBytes) {
  const target = request.headers.get("x-poapin-target") ?? "";
  const selected = config.targets[target];
  if (!selected || request.headers.get("x-poapin-bucket") !== selected.bucketName) {
    return { ok: false, status: 400, code: "invalid_target" };
  }
  const key = request.headers.get("x-poapin-object-key") ?? "";
  const sha256 = request.headers.get("x-poapin-sha256") ?? "";
  const contentType = normalizeContentType(request.headers.get("x-poapin-content-type"));
  const byteLength = parsePositiveInteger(request.headers.get("x-poapin-object-byte-length"));
  if (byteLength === null || byteLength > maximumBytes) {
    return { ok: false, status: 413, code: "invalid_object_size" };
  }
  if (!SHA256_PATTERN.test(sha256)) {
    return { ok: false, status: 400, code: "invalid_sha256" };
  }
  const classification = classifyMomentsMediaObject({
    snapshotId: config.snapshotId,
    target,
    key,
    sha256,
    contentType,
  });
  if (!classification) {
    return { ok: false, status: 400, code: "invalid_object_key_or_type" };
  }
  return {
    ok: true,
    target,
    bucket: selected.bucketName,
    key,
    sha256,
    contentType,
    byteLength,
    ...classification,
  };
}

async function authorize(request, config, input, now) {
  const timestampText = request.headers.get("x-poapin-timestamp") ?? "";
  if (
    request.headers.get("x-poapin-snapshot") !== config.snapshotId ||
    !/^[0-9]{10}$/.test(timestampText)
  ) {
    return false;
  }
  const timestamp = Number(timestampText);
  if (Math.abs(Math.floor(now() / 1000) - timestamp) > MOMENTS_BRIDGE_CLOCK_SKEW_SECONDS) {
    return false;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = `${MOMENTS_BRIDGE_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return false;
  const signature = authorization.slice(prefix.length);
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  const payload = createMomentsBridgeSignaturePayload({
    ...input,
    snapshotId: config.snapshotId,
    timestamp,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(config.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(payload),
  );
}

async function headObject(bucket, config, expected) {
  try {
    const object = await bucket.head(expected.key);
    if (!object) return headResponse(404, "object_not_found");
    const conflicts = objectConflictFields(object, expected, config);
    if (conflicts.length > 0) {
      return headResponse(409, "existing_object_conflict", null, null, conflicts);
    }
    return headResponse(200, null, object, expected);
  } catch {
    return headResponse(503, "r2_head_failed");
  }
}

async function putObject(bucket, config, expected, body) {
  const targetConfig = config.targets[expected.target];
  try {
    const created = await bucket.put(expected.key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: expected.sha256,
      ...objectMetadata(config, expected, targetConfig),
    });
    if (created) {
      if (!matches(created, expected, config)) {
        return jsonError(503, "r2_write_verification_failed");
      }
      return objectResponse(201, "uploaded", created, expected);
    }
    const existing = await bucket.head(expected.key);
    if (!matches(existing, expected, config)) {
      return jsonError(409, "existing_object_conflict");
    }
    return objectResponse(200, "reused", existing, expected);
  } catch (error) {
    if (error?.code === 10037) return jsonError(422, "checksum_mismatch");
    return jsonError(503, "r2_write_failed");
  }
}

async function createMultipartUpload(bucket, config, expected) {
  try {
    const existing = await bucket.head(expected.key);
    if (existing) {
      return matches(existing, expected, config)
        ? objectResponse(200, "reused", existing, expected)
        : jsonError(409, "existing_object_conflict");
    }
    const upload = await bucket.createMultipartUpload(
      expected.key,
      objectMetadata(config, expected, config.targets[expected.target]),
    );
    if (upload?.key !== expected.key || !UPLOAD_ID_PATTERN.test(upload.uploadId ?? "")) {
      return jsonError(503, "r2_multipart_create_verification_failed");
    }
    return jsonResponse(201, {
      disposition: "created",
      target: expected.target,
      key: expected.key,
      byteLength: expected.byteLength,
      sha256: expected.sha256,
      contentType: expected.contentType,
      uploadId: upload.uploadId,
    });
  } catch {
    return jsonError(503, "r2_multipart_create_failed");
  }
}

async function uploadMultipartPart(bucket, expected, uploadId, partNumber, partSha256, bytes) {
  try {
    const upload = bucket.resumeMultipartUpload(expected.key, uploadId);
    const part = await upload.uploadPart(partNumber, bytes);
    if (part?.partNumber !== partNumber || !ETAG_PATTERN.test(part.etag ?? "")) {
      return jsonError(503, "r2_multipart_part_verification_failed");
    }
    return jsonResponse(200, {
      disposition: "uploaded",
      target: expected.target,
      key: expected.key,
      uploadId,
      partNumber,
      byteLength: bytes.byteLength,
      sha256: partSha256,
      etag: part.etag,
    });
  } catch (error) {
    return isMissingUpload(error)
      ? jsonError(404, "multipart_upload_not_found")
      : jsonError(503, "r2_multipart_part_failed");
  }
}

async function completeMultipartUpload(bucket, config, expected, uploadId, parts) {
  try {
    const existing = await bucket.head(expected.key);
    if (existing) {
      await bestEffortAbort(bucket, expected.key, uploadId);
      return matches(existing, expected, config)
        ? objectResponse(200, "reused", existing, expected)
        : jsonError(409, "existing_object_conflict");
    }
    const upload = bucket.resumeMultipartUpload(expected.key, uploadId);
    await upload.complete(
      parts.map(({ partNumber, etag }) => ({
        partNumber,
        etag,
      })),
    );
    const created = await bucket.head(expected.key);
    if (!matches(created, expected, config)) {
      return jsonError(503, "r2_multipart_complete_verification_failed");
    }
    return objectResponse(201, "uploaded", created, expected);
  } catch (error) {
    return isMissingUpload(error)
      ? jsonError(404, "multipart_upload_not_found")
      : jsonError(503, "r2_multipart_complete_failed");
  }
}

async function abortMultipartUpload(bucket, expected, uploadId) {
  try {
    await bucket.resumeMultipartUpload(expected.key, uploadId).abort();
    return jsonResponse(200, {
      disposition: "aborted",
      target: expected.target,
      key: expected.key,
      uploadId,
    });
  } catch (error) {
    if (!isMissingUpload(error)) return jsonError(503, "r2_multipart_abort_failed");
    return jsonResponse(200, {
      disposition: "already_absent",
      target: expected.target,
      key: expected.key,
      uploadId,
    });
  }
}

function parseCompleteParts(bytes, expectedLength, maximumPartBytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (
    !body ||
    Object.keys(body).join(",") !== "parts" ||
    !Array.isArray(body.parts) ||
    body.parts.length < 1 ||
    body.parts.length > MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS
  ) {
    return null;
  }
  let total = 0;
  for (let index = 0; index < body.parts.length; index += 1) {
    const part = body.parts[index];
    if (
      !part ||
      Object.keys(part).join(",") !== "partNumber,etag,byteLength,sha256" ||
      part.partNumber !== index + 1 ||
      !ETAG_PATTERN.test(part.etag ?? "") ||
      !Number.isSafeInteger(part.byteLength) ||
      part.byteLength < 1 ||
      part.byteLength > maximumPartBytes ||
      !SHA256_PATTERN.test(part.sha256 ?? "") ||
      (index < body.parts.length - 1 &&
        part.byteLength < MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES)
    ) {
      return null;
    }
    total += part.byteLength;
  }
  return total === expectedLength ? body.parts : null;
}

function objectMetadata(config, expected, targetConfig) {
  return {
    httpMetadata: {
      contentType: expected.contentType,
      cacheControl: targetConfig.cacheControl,
    },
    customMetadata: {
      sha256: expected.sha256,
      snapshotId: config.snapshotId,
      source: "poapin-moments-backup",
      target: expected.target,
      fidelity: expected.fidelity,
      derivativeKind: expected.derivativeKind ?? "",
      immutable: "true",
    },
  };
}

function readConfig(env) {
  const maximumObjectBytes = Number(env.MAX_OBJECT_BYTES);
  const maximumMultipartObjectBytes = Number(env.MAX_MULTIPART_OBJECT_BYTES);
  const maximumMultipartPartBytes = Number(env.MAX_MULTIPART_PART_BYTES);
  const targets = {
    public: {
      binding: env.PUBLIC_BUCKET,
      bucketName: env.PUBLIC_BUCKET_NAME ?? "",
      cacheControl: env.PUBLIC_CACHE_CONTROL ?? "",
    },
    private: {
      binding: env.PRIVATE_BUCKET,
      bucketName: env.PRIVATE_BUCKET_NAME ?? "",
      cacheControl: env.PRIVATE_CACHE_CONTROL ?? "",
    },
  };
  let bucketPairValid = false;
  try {
    validateMomentsBucketPair(targets.public.bucketName, targets.private.bucketName);
    bucketPairValid = true;
  } catch {
    bucketPairValid = false;
  }
  if (
    !SNAPSHOT_PATTERN.test(env.SNAPSHOT_ID ?? "") ||
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > MAXIMUM_ALLOWED_OBJECT_BYTES ||
    !Number.isSafeInteger(maximumMultipartObjectBytes) ||
    maximumMultipartObjectBytes < maximumObjectBytes ||
    maximumMultipartObjectBytes > MAXIMUM_ALLOWED_MULTIPART_OBJECT_BYTES ||
    !Number.isSafeInteger(maximumMultipartPartBytes) ||
    maximumMultipartPartBytes < MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES ||
    maximumMultipartPartBytes > maximumObjectBytes ||
    !SECRET_PATTERN.test(env.MOMENTS_R2_BRIDGE_SECRET ?? "") ||
    !bucketPairValid ||
    !Object.values(targets).every(
      (target) =>
        target.binding && target.cacheControl.length > 0 && target.cacheControl.length <= 256,
    )
  ) {
    return null;
  }
  return {
    snapshotId: env.SNAPSHOT_ID,
    maximumObjectBytes,
    maximumMultipartObjectBytes,
    maximumMultipartPartBytes,
    secret: env.MOMENTS_R2_BRIDGE_SECRET,
    targets,
  };
}

function matches(object, expected, config) {
  return objectConflictFields(object, expected, config).length === 0;
}

function objectConflictFields(object, expected, config) {
  if (!object) return ["object"];
  const checksum = object?.checksums?.toJSON?.().sha256;
  const metadata = object?.customMetadata;
  const v2MetadataMatches =
    metadata?.fidelity === expected.fidelity &&
    metadata?.derivativeKind === (expected.derivativeKind ?? "") &&
    metadata?.immutable === "true";
  const legacyOriginalMatches =
    expected.fidelity === "original" &&
    (expected.derivativeKind ?? "") === "" &&
    metadata?.fidelity === undefined &&
    metadata?.derivativeKind === undefined &&
    metadata?.immutable === undefined;
  const conflicts = [];
  if (object.key !== expected.key) conflicts.push("key");
  if (object.size !== expected.byteLength) conflicts.push("size");
  if (!object.etag) conflicts.push("etag");
  if (checksum !== undefined && checksum !== expected.sha256) conflicts.push("checksum");
  if (object.httpMetadata?.contentType !== expected.contentType) {
    conflicts.push("contentType");
  }
  if (object.httpMetadata?.cacheControl !== config.targets[expected.target].cacheControl) {
    conflicts.push("cacheControl");
  }
  if (metadata?.sha256 !== expected.sha256) conflicts.push("customMetadata.sha256");
  if (metadata?.snapshotId !== config.snapshotId) {
    conflicts.push("customMetadata.snapshotId");
  }
  if (metadata?.source !== "poapin-moments-backup") {
    conflicts.push("customMetadata.source");
  }
  if (metadata?.target !== expected.target) conflicts.push("customMetadata.target");
  if (!v2MetadataMatches && !legacyOriginalMatches) {
    if (metadata?.fidelity !== expected.fidelity) {
      conflicts.push("customMetadata.fidelity");
    }
    if (metadata?.derivativeKind !== (expected.derivativeKind ?? "")) {
      conflicts.push("customMetadata.derivativeKind");
    }
    if (metadata?.immutable !== "true") conflicts.push("customMetadata.immutable");
  }
  return conflicts;
}

function normalizeContentType(value) {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function parsePositiveInteger(value) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function hasNonIdentityEncoding(request) {
  const encoding = request.headers.get("content-encoding");
  return Boolean(encoding && encoding.toLowerCase() !== "identity");
}

function hasNormalizedZeroLengthBody(request) {
  return request.headers.get("content-length") === "0" && !request.headers.has("transfer-encoding");
}

function isMissingUpload(error) {
  return Boolean(
    error?.status === 404 ||
    error?.code === 10024 ||
    /(?:no such|not found|missing).{0,30}upload/i.test(String(error?.message ?? "")),
  );
}

async function bestEffortAbort(bucket, key, uploadId) {
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    // A completed or expired upload is already harmless.
  }
}

function objectResponse(status, disposition, object, expected) {
  return jsonResponse(status, {
    disposition,
    target: expected.target,
    key: expected.key,
    byteLength: expected.byteLength,
    sha256: expected.sha256,
    contentType: expected.contentType,
    etag: object.etag,
  });
}

function headResponse(status, code = null, object = null, expected = null, conflictFields = []) {
  const headers = securityHeaders();
  if (code) headers.set("X-POAPin-Error-Code", code);
  if (conflictFields.length > 0) {
    headers.set("X-POAPin-Conflict-Fields", conflictFields.join(","));
  }
  if (object && expected) {
    headers.set("X-POAPin-Target", expected.target);
    headers.set("X-POAPin-Object-Key", expected.key);
    headers.set("X-POAPin-Object-Byte-Length", String(expected.byteLength));
    headers.set("X-POAPin-SHA256", expected.sha256);
    headers.set("X-POAPin-Content-Type", expected.contentType);
    headers.set("ETag", object.etag);
  }
  return new Response(null, { status, headers });
}

function jsonResponse(status, value) {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response(`${JSON.stringify(value)}\n`, { status, headers });
}

function jsonError(status, code) {
  return jsonResponse(status, { error: "Request failed.", code });
}

function methodNotAllowed(allow) {
  const response = jsonError(405, "method_not_allowed");
  response.headers.set("Allow", allow);
  return response;
}

function securityHeaders() {
  return new Headers({
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
}
