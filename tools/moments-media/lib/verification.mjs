import { createHash } from "node:crypto";

import { classifyMomentsMediaObject } from "../bridge/protocol.mjs";

export { validateMomentsBucketName, validateMomentsBucketPair } from "../bridge/protocol.mjs";

export const MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA =
  "poapin-moments-media-remote-verification-v3";
export const MOMENTS_MEDIA_VERIFICATION_CHAIN_SCHEMA = "poapin-moments-media-verification-chain-v2";

const SHA256 = /^[0-9a-f]{64}$/;
const MAXIMUM_R2_OBJECT_BYTES = 5_000_000_000_000;
const STORED_OBJECT_SET_DOMAIN = "POAPIN-MOMENTS-STORED-OBJECT-SET/1\n";

export function canonicalMomentsBridgeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Moments bridge origin is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Moments bridge must be a canonical HTTPS origin.");
  }
  return url.origin;
}

export function buildMomentsStoredObjectSet(records, { snapshotId } = {}) {
  const unique = new Map();
  for (const input of records) {
    const object = canonicalStoredObject(input);
    if (
      !classifyMomentsMediaObject({
        snapshotId,
        target: object.target,
        key: object.objectKey,
        sha256: object.sha256,
        contentType: object.contentType,
      })
    ) {
      throw new Error("Stored media object is outside the snapshot-scoped key allowlist.");
    }
    const identity = `${object.target}\0${object.objectKey}`;
    const prior = unique.get(identity);
    if (prior && JSON.stringify(prior) !== JSON.stringify(object)) {
      throw new Error("Stored media checkpoints disagree about an immutable object.");
    }
    unique.set(identity, object);
  }
  const objects = [...unique.values()].sort(compareStoredObjects);
  const hash = createHash("sha256");
  hash.update(STORED_OBJECT_SET_DOMAIN);
  for (const object of objects) hash.update(`${JSON.stringify(object)}\n`);
  return {
    objects,
    stored: objects.length,
    sha256: hash.digest("hex"),
  };
}

export function momentsMediaVerificationBindingSha256(binding) {
  return createHash("sha256")
    .update("POAPIN-MOMENTS-MEDIA-VERIFICATION-BINDING/1\n")
    .update(`${JSON.stringify(binding)}\n`)
    .digest("hex");
}

export function momentsMediaVerificationChainSha256(bindingSha256, reports) {
  return createHash("sha256")
    .update("POAPIN-MOMENTS-MEDIA-VERIFICATION-CHAIN/2\n")
    .update(`${JSON.stringify({ bindingSha256, reports })}\n`)
    .digest("hex");
}

export function isSha256(value) {
  return SHA256.test(value ?? "");
}

function canonicalStoredObject(record) {
  const object = {
    target: record?.target,
    objectKey: record?.objectKey,
    byteLength: record?.byteLength,
    sha256: record?.sha256,
    contentType: record?.contentType,
  };
  if (
    !["public", "private"].includes(object.target) ||
    typeof object.objectKey !== "string" ||
    object.objectKey.length < 1 ||
    !Number.isSafeInteger(object.byteLength) ||
    object.byteLength < 1 ||
    object.byteLength > MAXIMUM_R2_OBJECT_BYTES ||
    !SHA256.test(object.sha256 ?? "") ||
    typeof object.contentType !== "string" ||
    object.contentType.length < 1 ||
    object.contentType.length > 256
  ) {
    throw new Error("Stored media object metadata is invalid.");
  }
  return object;
}

function compareStoredObjects(left, right) {
  return (
    compareCanonicalString(left.target, right.target) ||
    compareCanonicalString(left.objectKey, right.objectKey) ||
    compareCanonicalString(left.sha256, right.sha256)
  );
}

function compareCanonicalString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
