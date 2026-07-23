const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function momentsMediaObjectKey(snapshotId, target, sha256, extension) {
  if (!SNAPSHOT.test(snapshotId ?? "") || !["public", "private"].includes(target)) {
    throw new Error("Media object identity is invalid.");
  }
  if (!SHA256.test(sha256 ?? "") || !/^[a-z0-9]{2,5}$/.test(extension ?? "")) {
    throw new Error("Media digest or extension is invalid.");
  }
  const path = target === "public" ? "original" : "private/original";
  return `snapshots/${snapshotId}/moments/${path}/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}
