import { describe, expect, it } from "vitest";
import { collectionDropArtworkUrl, collectionMediaObjectUrl } from "../src/worker/media";

const MEDIA_ORIGIN = "https://media.poap.in";
const ARCHIVE_SNAPSHOT = "2026-07-02-v1";
const COLLECTIONS_SNAPSHOT = "collections-2026-07-22-v1";
const SHA256 = "ab" + "c".repeat(62);
const COLLECTION_MEDIA_KEY = `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.png`;
const COLLECTION_DROP_KEY = `snapshots/${COLLECTIONS_SNAPSHOT}/collections/drop-artwork/sha256/ab/${SHA256}.gif`;
const ARCHIVE_DROP_KEY = `snapshots/${ARCHIVE_SNAPSHOT}/artwork/42.webp`;

describe("public media object-key policy", () => {
  it("maps only current-snapshot Collection branding objects", () => {
    expect(
      collectionMediaObjectUrl(`${MEDIA_ORIGIN}///`, COLLECTION_MEDIA_KEY, COLLECTIONS_SNAPSHOT),
    ).toBe(`${MEDIA_ORIGIN}/${COLLECTION_MEDIA_KEY}`);

    for (const key of [
      COLLECTION_DROP_KEY,
      ARCHIVE_DROP_KEY,
      `snapshots/older-collections/collections/media/sha256/ab/${SHA256}.png`,
      "private/backup.tar.gz",
      `snapshots/${COLLECTIONS_SNAPSHOT}/backup/sha256/ab/${SHA256}.png`,
    ]) {
      expect(collectionMediaObjectUrl(MEDIA_ORIGIN, key, COLLECTIONS_SNAPSHOT)).toBeNull();
    }
  });

  it("maps drop artwork only from the active archive or Collections snapshot", () => {
    expect(
      collectionDropArtworkUrl(
        MEDIA_ORIGIN,
        ARCHIVE_DROP_KEY,
        ARCHIVE_SNAPSHOT,
        COLLECTIONS_SNAPSHOT,
        42,
      ),
    ).toBe(`${MEDIA_ORIGIN}/${ARCHIVE_DROP_KEY}`);
    expect(
      collectionDropArtworkUrl(
        MEDIA_ORIGIN,
        COLLECTION_DROP_KEY,
        ARCHIVE_SNAPSHOT,
        COLLECTIONS_SNAPSHOT,
        42,
      ),
    ).toBe(`${MEDIA_ORIGIN}/${COLLECTION_DROP_KEY}`);

    for (const key of [
      COLLECTION_MEDIA_KEY,
      `snapshots/older-archive/artwork/42.webp`,
      `snapshots/older-collections/collections/drop-artwork/sha256/ab/${SHA256}.gif`,
      "private/backup.tar.gz",
      "snapshots/../private/backup.tar.gz",
    ]) {
      expect(
        collectionDropArtworkUrl(MEDIA_ORIGIN, key, ARCHIVE_SNAPSHOT, COLLECTIONS_SNAPSHOT, 42),
      ).toBeNull();
    }
  });

  it("rejects malformed hashes, prefixes, extensions, IDs, and configured snapshots", () => {
    const invalidCollectionKeys = [
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/00/${SHA256}.png`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256.slice(0, 63)}.png`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256.toUpperCase()}.png`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.jpeg`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.svg`,
      `/snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.png`,
    ];
    for (const key of invalidCollectionKeys) {
      expect(collectionMediaObjectUrl(MEDIA_ORIGIN, key, COLLECTIONS_SNAPSHOT)).toBeNull();
    }

    for (const key of [
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/0.webp`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/01.webp`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/43.webp`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/42.png`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/9007199254740992.webp`,
    ]) {
      expect(
        collectionDropArtworkUrl(MEDIA_ORIGIN, key, ARCHIVE_SNAPSHOT, COLLECTIONS_SNAPSHOT, 42),
      ).toBeNull();
    }

    expect(collectionMediaObjectUrl(MEDIA_ORIGIN, COLLECTION_MEDIA_KEY, "../private")).toBeNull();
    expect(
      collectionDropArtworkUrl(
        MEDIA_ORIGIN,
        ARCHIVE_DROP_KEY,
        "ARCHIVE-SNAPSHOT",
        COLLECTIONS_SNAPSHOT,
        42,
      ),
    ).toBeNull();
  });
});
