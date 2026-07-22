export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_AUTH_SCHEME = "POAPin-HMAC-SHA256";
export const BRIDGE_STATUS_PATH = "/v1/status";
export const BRIDGE_UPLOAD_PATH = "/v1/upload";
export const BRIDGE_CLOCK_SKEW_SECONDS = 300;

const PROTOCOL_LINE = "POAPIN-R2-UPLOAD/1";

export function createBridgeSignaturePayload({
  method,
  path,
  bucket,
  snapshotId,
  key = "-",
  byteLength = 0,
  sha256 = "-",
  timestamp,
}) {
  return [
    PROTOCOL_LINE,
    method,
    path,
    bucket,
    snapshotId,
    key,
    String(byteLength),
    sha256,
    String(timestamp),
  ].join("\n");
}
