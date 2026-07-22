import {
  COLLECTIONS_BRIDGE_AUTH_SCHEME,
  COLLECTIONS_BRIDGE_CLOCK_SKEW_SECONDS,
  COLLECTIONS_BRIDGE_OBJECT_PATH,
  COLLECTIONS_BRIDGE_PROTOCOL_VERSION,
  COLLECTIONS_BRIDGE_STATUS_PATH,
  createCollectionsBridgeSignaturePayload,
} from "./protocol.mjs";

const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_ALLOWED_OBJECT_BYTES = 100_000_000;
const MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
});
let cachedHmacSecret = null;
let cachedHmacKey = null;

export default {
  fetch(request, env) {
    return handleCollectionsBridgeRequest(request, env);
  },
};

export async function handleCollectionsBridgeRequest(request, env, now = Date.now) {
  const config = readBridgeConfig(env);
  if (!config) return jsonError(503, "bridge_unavailable");

  const url = new URL(request.url);
  if (url.search || url.hash) return jsonError(404, "not_found");

  if (url.pathname === COLLECTIONS_BRIDGE_STATUS_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const input = {
      method: "GET",
      path: COLLECTIONS_BRIDGE_STATUS_PATH,
      key: "-",
      byteLength: 0,
      sha256: "-",
      contentType: "-",
      mode: "status",
    };
    if (!(await authorize(request, config, input, now))) {
      return jsonError(401, "authorization_failed");
    }
    return jsonResponse(200, {
      protocolVersion: COLLECTIONS_BRIDGE_PROTOCOL_VERSION,
      bucket: config.bucket,
      snapshotId: config.snapshotId,
      archiveSnapshotId: config.archiveSnapshotId,
      objectPrefix: config.objectPrefix,
      cacheControl: config.cacheControl,
      maximumObjectBytes: config.maximumObjectBytes,
      capabilities: ["head", "put-if-absent", "archive-reuse-head"],
    });
  }

  if (url.pathname !== COLLECTIONS_BRIDGE_OBJECT_PATH) return jsonError(404, "not_found");
  if (!["HEAD", "PUT"].includes(request.method)) return methodNotAllowed("HEAD, PUT");

  const object = readObjectHeaders(request, config);
  if (!object.ok) return jsonError(object.status, object.code);
  if (
    !(await authorize(
      request,
      config,
      { method: request.method, path: url.pathname, ...object },
      now,
    ))
  ) {
    return jsonError(401, "authorization_failed");
  }

  if (request.method === "HEAD") return headObject(env.COLLECTIONS_BUCKET, config, object);
  if (object.mode !== "upload") return methodNotAllowed("HEAD");
  if (request.body === null) return jsonError(400, "body_required");
  const contentLength = parsePositiveInteger(request.headers.get("content-length"));
  if (contentLength !== object.byteLength) return jsonError(400, "content_length_mismatch");
  if (request.headers.get("content-type")?.toLowerCase() !== object.contentType) {
    return jsonError(415, "invalid_media_type");
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return jsonError(415, "content_encoding_not_allowed");
  }
  return putObject(env.COLLECTIONS_BUCKET, config, object, request.body);
}

async function headObject(bucket, config, expected) {
  try {
    const existing = await bucket.head(expected.key);
    if (!existing) return headResponse(404, "object_not_found");
    if (!matchesExistingObject(existing, expected, config)) {
      return headResponse(409, "existing_object_conflict");
    }
    return headResponse(200, null, existing, expected);
  } catch {
    return headResponse(503, "r2_head_failed");
  }
}

async function putObject(bucket, config, expected, body) {
  try {
    const created = await bucket.put(expected.key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: expected.sha256,
      httpMetadata: {
        contentType: expected.contentType,
        cacheControl: config.cacheControl,
      },
      customMetadata: {
        sha256: expected.sha256,
        snapshotId: config.snapshotId,
        source: "poapin-collections-backup",
      },
    });
    if (created) {
      if (!matchesExistingObject(created, expected, config)) {
        return jsonError(503, "r2_write_verification_failed");
      }
      return objectResponse(201, "uploaded", created, expected);
    }

    const existing = await bucket.head(expected.key);
    if (!matchesExistingObject(existing, expected, config)) {
      return jsonError(409, "existing_object_conflict");
    }
    return objectResponse(200, "reused", existing, expected);
  } catch (error) {
    if (error?.code === 10037) return jsonError(422, "checksum_mismatch");
    return jsonError(503, "r2_write_failed");
  }
}

function readObjectHeaders(request, config) {
  const mode = request.headers.get("x-poapin-object-mode") ?? "";
  const key = request.headers.get("x-poapin-object-key") ?? "";
  const sha256 = request.headers.get("x-poapin-sha256") ?? "";
  const contentType = request.headers.get("x-poapin-content-type")?.toLowerCase() ?? "";
  const byteLength = parsePositiveInteger(request.headers.get("x-poapin-object-byte-length"));
  if (byteLength === null || byteLength > config.maximumObjectBytes) {
    return { ok: false, status: 413, code: "invalid_object_size" };
  }
  if (!SHA256_PATTERN.test(sha256)) {
    return { ok: false, status: 400, code: "invalid_sha256" };
  }
  const uploadMatch = new RegExp(
    `^snapshots/${escapeRegex(config.snapshotId)}/collections/(?:media|drop-artwork)/sha256/([0-9a-f]{2})/([0-9a-f]{64})\\.(png|jpg|gif|webp|avif)$`,
  ).exec(key);
  const archiveMatch = new RegExp(
    `^snapshots/${escapeRegex(config.archiveSnapshotId)}/artwork/([1-9][0-9]*)\\.webp$`,
  ).exec(key);
  const uploadValid =
    mode === "upload" &&
    uploadMatch &&
    uploadMatch[1] === sha256.slice(0, 2) &&
    uploadMatch[2] === sha256 &&
    MEDIA_TYPES[uploadMatch[3]] === contentType;
  const archiveValid = mode === "archive-reuse" && archiveMatch && contentType === "image/webp";
  if (!uploadValid && !archiveValid) {
    return { ok: false, status: 400, code: "invalid_object_key_or_type" };
  }
  return { ok: true, key, sha256, contentType, byteLength, mode };
}

async function authorize(request, config, input, now) {
  const requestBucket = request.headers.get("x-poapin-bucket");
  const requestSnapshot = request.headers.get("x-poapin-snapshot");
  const requestPrefix = request.headers.get("x-poapin-object-prefix");
  const requestMode = request.headers.get("x-poapin-object-mode");
  const timestampText = request.headers.get("x-poapin-timestamp") ?? "";
  if (
    requestBucket !== config.bucket ||
    requestSnapshot !== config.snapshotId ||
    requestPrefix !== config.objectPrefix ||
    requestMode !== input.mode ||
    !/^[0-9]{10}$/.test(timestampText)
  ) {
    return false;
  }
  const timestamp = Number(timestampText);
  if (Math.abs(Math.floor(now() / 1000) - timestamp) > COLLECTIONS_BRIDGE_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = `${COLLECTIONS_BRIDGE_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return false;
  const signature = authorization.slice(prefix.length);
  if (!SIGNATURE_PATTERN.test(signature)) return false;

  const payload = createCollectionsBridgeSignaturePayload({
    method: input.method,
    path: input.path,
    bucket: requestBucket,
    snapshotId: requestSnapshot,
    objectPrefix: requestPrefix,
    mode: requestMode,
    key: input.key,
    byteLength: input.byteLength,
    sha256: input.sha256,
    contentType: input.contentType,
    timestamp,
  });
  const key = await hmacVerificationKey(config.secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(payload),
  );
}

function hmacVerificationKey(secret) {
  if (secret !== cachedHmacSecret || !cachedHmacKey) {
    cachedHmacSecret = secret;
    cachedHmacKey = crypto.subtle.importKey(
      "raw",
      decodeBase64Url(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  return cachedHmacKey;
}

function readBridgeConfig(env) {
  const snapshotId = env.SNAPSHOT_ID ?? "";
  const archiveSnapshotId = env.ARCHIVE_SNAPSHOT_ID ?? "";
  const expectedPrefix = "snapshots/";
  const maximumObjectBytes = Number(env.MAX_OBJECT_BYTES);
  if (
    !env.COLLECTIONS_BUCKET ||
    !SNAPSHOT_PATTERN.test(snapshotId) ||
    !SNAPSHOT_PATTERN.test(archiveSnapshotId) ||
    !BUCKET_PATTERN.test(env.BUCKET_NAME ?? "") ||
    env.OBJECT_PREFIX !== expectedPrefix ||
    typeof env.CACHE_CONTROL !== "string" ||
    env.CACHE_CONTROL.length === 0 ||
    env.CACHE_CONTROL.length > 256 ||
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > MAXIMUM_ALLOWED_OBJECT_BYTES ||
    !SECRET_PATTERN.test(env.COLLECTIONS_R2_BRIDGE_SECRET ?? "")
  ) {
    return null;
  }
  return {
    bucket: env.BUCKET_NAME,
    snapshotId,
    archiveSnapshotId,
    objectPrefix: env.OBJECT_PREFIX,
    cacheControl: env.CACHE_CONTROL,
    maximumObjectBytes,
    secret: env.COLLECTIONS_R2_BRIDGE_SECRET,
  };
}

function matchesExistingObject(object, expected, config) {
  const storedSha256 = object?.checksums?.toJSON?.().sha256;
  const common = Boolean(
    object &&
    object.key === expected.key &&
    object.size === expected.byteLength &&
    object.etag &&
    (storedSha256 === undefined || storedSha256 === expected.sha256) &&
    object.httpMetadata?.contentType === expected.contentType &&
    object.httpMetadata?.cacheControl === config.cacheControl &&
    object.customMetadata?.sha256 === expected.sha256,
  );
  if (!common) return false;
  if (expected.mode === "archive-reuse") {
    return object.customMetadata?.source === "poap-archive";
  }
  return Boolean(
    object.customMetadata?.snapshotId === config.snapshotId &&
    object.customMetadata?.source === "poapin-collections-backup",
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePositiveInteger(value) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function objectResponse(status, disposition, object, expected) {
  return jsonResponse(status, {
    disposition,
    key: expected.key,
    byteLength: expected.byteLength,
    sha256: expected.sha256,
    contentType: expected.contentType,
    etag: object.etag,
  });
}

function headResponse(status, code = null, object = null, expected = null) {
  const headers = securityHeaders();
  if (code) headers.set("X-POAPin-Error-Code", code);
  if (object && expected) {
    headers.set("X-POAPin-Object-Key", expected.key);
    headers.set("X-POAPin-Object-Byte-Length", String(expected.byteLength));
    headers.set("X-POAPin-SHA256", expected.sha256);
    headers.set("X-POAPin-Content-Type", expected.contentType);
    headers.set("ETag", object.etag);
  }
  return new Response(null, { status, headers });
}

function methodNotAllowed(method) {
  const response = jsonError(405, "method_not_allowed");
  response.headers.set("Allow", method);
  return response;
}

function jsonError(status, code) {
  return jsonResponse(status, { error: "The upload request was rejected.", code });
}

function jsonResponse(status, payload) {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

function securityHeaders() {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

export const collectionsBridgeInternals = {
  readBridgeConfig,
  readObjectHeaders,
  matchesExistingObject,
};
