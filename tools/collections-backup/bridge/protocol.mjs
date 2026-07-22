export const COLLECTIONS_BRIDGE_PROTOCOL_VERSION = 2;
export const COLLECTIONS_BRIDGE_AUTH_SCHEME = "POAPin-Collections-HMAC-SHA256";
export const COLLECTIONS_BRIDGE_STATUS_PATH = "/v1/status";
export const COLLECTIONS_BRIDGE_OBJECT_PATH = "/v1/object";
export const COLLECTIONS_BRIDGE_CLOCK_SKEW_SECONDS = 300;

const PROTOCOL_LINE = "POAPIN-COLLECTIONS-R2-UPLOAD/2";

export function createCollectionsBridgeSignaturePayload({
  method,
  path,
  bucket,
  snapshotId,
  objectPrefix,
  mode = "status",
  key = "-",
  byteLength = 0,
  sha256 = "-",
  contentType = "-",
  timestamp,
}) {
  return [
    PROTOCOL_LINE,
    method,
    path,
    bucket,
    snapshotId,
    objectPrefix,
    mode,
    key,
    String(byteLength),
    sha256,
    contentType,
    String(timestamp),
  ].join("\n");
}
