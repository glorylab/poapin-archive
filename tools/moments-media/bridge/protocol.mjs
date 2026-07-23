export const MOMENTS_BRIDGE_PROTOCOL_VERSION = 2;
export const MOMENTS_BRIDGE_AUTH_SCHEME = "POAPin-Moments-HMAC-SHA256";
export const MOMENTS_BRIDGE_STATUS_PATH = "/v1/status";
export const MOMENTS_BRIDGE_OBJECT_PATH = "/v1/object";
export const MOMENTS_BRIDGE_MULTIPART_CREATE_PATH = "/v1/multipart/create";
export const MOMENTS_BRIDGE_MULTIPART_PART_PATH = "/v1/multipart/part";
export const MOMENTS_BRIDGE_MULTIPART_COMPLETE_PATH = "/v1/multipart/complete";
export const MOMENTS_BRIDGE_MULTIPART_ABORT_PATH = "/v1/multipart/abort";
export const MOMENTS_BRIDGE_CLOCK_SKEW_SECONDS = 300;
export const MOMENTS_BRIDGE_MINIMUM_MULTIPART_PART_BYTES = 5_242_880;
export const MOMENTS_BRIDGE_MAXIMUM_MULTIPART_PARTS = 10_000;
const MOMENTS_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const MOMENTS_MEDIA_CONTENT_TYPES = Object.freeze({
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  dng: "image/x-adobe-dng",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  m4s: "video/iso.segment",
  bin: "application/octet-stream",
});

const PROTOCOL_LINE = "POAPIN-MOMENTS-R2-UPLOAD/2";

export function validateMomentsBucketName(value, label = "Moments bucket") {
  if (!MOMENTS_BUCKET_NAME.test(value ?? "")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function validateMomentsBucketPair(publicBucket, privateBucket) {
  validateMomentsBucketName(publicBucket, "Public Moments bucket");
  validateMomentsBucketName(privateBucket, "Private Moments bucket");
  if (publicBucket === privateBucket) {
    throw new Error("Public and private Moments buckets must be different.");
  }
  return { publicBucket, privateBucket };
}

export function createMomentsBridgeSignaturePayload({
  method,
  path,
  target,
  bucket,
  snapshotId,
  key = "-",
  byteLength = 0,
  sha256 = "-",
  contentType = "-",
  uploadId = "-",
  partNumber = 0,
  partByteLength = 0,
  bodySha256 = "-",
  timestamp,
}) {
  return [
    PROTOCOL_LINE,
    method,
    path,
    target,
    bucket,
    snapshotId,
    key,
    String(byteLength),
    sha256,
    contentType,
    uploadId,
    String(partNumber),
    String(partByteLength),
    bodySha256,
    String(timestamp),
  ].join("\n");
}

export function classifyMomentsMediaObject({ snapshotId, target, key, sha256, contentType }) {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(snapshotId ?? "") ||
    !["public", "private"].includes(target) ||
    !/^[0-9a-f]{64}$/.test(sha256 ?? "") ||
    typeof key !== "string"
  ) {
    return null;
  }
  const escapedSnapshot = escapeRegex(snapshotId);
  const match =
    target === "public"
      ? new RegExp(
          `^snapshots/${escapedSnapshot}/moments/original/sha256/(?<prefix>[0-9a-f]{2})/(?<digest>[0-9a-f]{64})\\.(?<extension>[a-z0-9]+)$`,
        ).exec(key)
      : new RegExp(
          `^snapshots/${escapedSnapshot}/moments/private/(?<category>original|derivative/(?<derivative>thumbnail|hls-playlist|hls-segment))/sha256/(?<prefix>[0-9a-f]{2})/(?<digest>[0-9a-f]{64})\\.(?<extension>[a-z0-9]+)$`,
        ).exec(key);
  const { prefix, digest, extension, category, derivative } = match?.groups ?? {};
  if (
    !match ||
    prefix !== sha256.slice(0, 2) ||
    digest !== sha256 ||
    MOMENTS_MEDIA_CONTENT_TYPES[extension] !== contentType
  ) {
    return null;
  }
  const derivativeKind = target === "private" ? (derivative ?? null) : null;
  if (
    (derivativeKind === "thumbnail" && (extension !== "webp" || contentType !== "image/webp")) ||
    (derivativeKind === "hls-playlist" &&
      (extension !== "m3u8" || contentType !== "application/vnd.apple.mpegurl")) ||
    (derivativeKind === "hls-segment" && !["ts", "m4s", "mp4", "aac", "bin"].includes(extension))
  ) {
    return null;
  }
  return {
    fidelity: target === "public" || category === "original" ? "original" : "derivative",
    derivativeKind,
    extension,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
