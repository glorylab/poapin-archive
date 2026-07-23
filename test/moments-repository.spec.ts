import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fetchAuthorMomentExportPage,
  fetchCollectionMomentCount,
  fetchCollectionMoments,
  fetchDropMomentCount,
  fetchDropMoments,
  fetchMoment,
  fetchMoments,
  fetchMomentsMeta,
  makeBrowseStatement,
  safeMomentExternalUrl,
  type MomentCursor,
  type MomentsQuery,
} from "../src/worker/moments-repository";
import { safeExternalUrl } from "../src/worker/repository";
import type { D1ReadClient } from "../src/worker/types";
import { isBrowserRenderableMomentImage, safeMomentMediaUrl } from "../src/react-app/utils";

const SNAPSHOT_ID = "moments-2026-07-23-v1";
const SOURCE_DATABASE_SHA256 = "a".repeat(64);
const BUILD_MANIFEST_SHA256 = "b".repeat(64);
const RELEASE = {
  snapshotId: SNAPSHOT_ID,
  sourceDatabaseSha256: SOURCE_DATABASE_SHA256,
  buildManifestSha256: BUILD_MANIFEST_SHA256,
};
const MEDIA_BASE_URL = "https://media.poap.in";
const AUTHOR_A = "0x1111111111111111111111111111111111111111";
const PUBLIC_1 = "00000000-0000-4000-8000-000000000001";
const PUBLIC_2 = "00000000-0000-4000-8000-000000000002";
const PUBLIC_3 = "00000000-0000-4000-8000-000000000003";
const MOMENTS_API_VERSION = [
  "v1",
  "moments-v2",
  "moments-test-release",
  SOURCE_DATABASE_SHA256,
  BUILD_MANIFEST_SHA256,
].join(".");

interface MomentsTestBindings {
  MOMENTS_DB: D1Database;
  TEST_MOMENTS_FIXTURE: string;
  TEST_MOMENTS_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as MomentsTestBindings;

beforeAll(async () => {
  await applyD1Migrations(bindings.MOMENTS_DB, bindings.TEST_MOMENTS_MIGRATIONS);
  await executeSql(bindings.MOMENTS_DB, bindings.TEST_MOMENTS_FIXTURE);
});

describe("Moments repository", () => {
  it("reads a ready, versioned Moments snapshot", async () => {
    await expect(fetchMomentsMeta(db(), RELEASE)).resolves.toEqual({
      snapshotId: SNAPSHOT_ID,
      snapshotAt: "2026-07-23T00:00:00.000Z",
      counts: { sourceMoments: 8, publicMoments: 3, media: 5, capsules: 2 },
    });
    await expect(
      fetchMomentsMeta(db(), { ...RELEASE, snapshotId: "wrong-snapshot" }),
    ).rejects.toMatchObject({
      code: "snapshot_mismatch",
    });
    await expect(
      fetchMomentsMeta(db(), { ...RELEASE, buildManifestSha256: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "moments_release_mismatch" });
  });

  it("fails closed for hidden, no-Drop, non-public, suppressed, and mixed-hidden Moments", async () => {
    const page = await fetchMoments(db(), momentsQuery(), RELEASE, MEDIA_BASE_URL);
    expect(page.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_2, PUBLIC_1]);
    expect(page.items[0]).toMatchObject({
      sourceMediaCount: 2,
      mediaCount: 1,
      mediaPreservationState: "partial",
    });
    expect(page.items[1]).toMatchObject({
      sourceMediaCount: 1,
      mediaCount: 1,
      mediaPreservationState: "complete",
    });

    for (const momentId of [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
      "00000000-0000-4000-8000-000000000014",
    ]) {
      await expect(fetchMoment(db(), momentId, RELEASE, MEDIA_BASE_URL)).resolves.toBeNull();
    }
  });

  it("uses a stable created_on plus moment_id keyset when timestamps tie", async () => {
    const firstQuery = momentsQuery({ limit: 1 });
    const first = await fetchMoments(db(), firstQuery, RELEASE, MEDIA_BASE_URL);
    expect(first.items.map((item) => item.momentId)).toEqual([PUBLIC_3]);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchMoments(
      db(),
      momentsQuery({ limit: 1, cursor: decodeCursor(first.nextCursor!) }),
      RELEASE,
      MEDIA_BASE_URL,
    );
    expect(second.items.map((item) => item.momentId)).toEqual([PUBLIC_2]);

    const third = await fetchMoments(
      db(),
      momentsQuery({ limit: 1, cursor: decodeCursor(second.nextCursor!) }),
      RELEASE,
      MEDIA_BASE_URL,
    );
    expect(third.items.map((item) => item.momentId)).toEqual([PUBLIC_1]);
    expect(third.nextCursor).toBeNull();
  });

  it("binds author, Drop, Collection, and public-media-kind filters", async () => {
    const [author, drop, collection, video] = await Promise.all([
      fetchMoments(db(), momentsQuery({ author: AUTHOR_A }), RELEASE, MEDIA_BASE_URL),
      fetchMoments(db(), momentsQuery({ dropId: 1001 }), RELEASE, MEDIA_BASE_URL),
      fetchMoments(db(), momentsQuery({ collectionId: 101 }), RELEASE, MEDIA_BASE_URL),
      fetchMoments(db(), momentsQuery({ mediaKind: "video" }), RELEASE, MEDIA_BASE_URL),
    ]);
    expect(author.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
    expect(drop.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
    expect(collection.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
    expect(video.items.map((item) => item.momentId)).toEqual([PUBLIC_2]);

    const injection = await fetchMoments(
      db(),
      momentsQuery({ author: `${AUTHOR_A}' OR 1=1 --` }),
      RELEASE,
      MEDIA_BASE_URL,
    );
    expect(injection.items).toEqual([]);
    const remaining = await bindings.MOMENTS_DB.prepare(
      "SELECT COUNT(*) AS count FROM moments",
    ).all<{
      count: number;
    }>();
    expect(remaining.results[0]?.count).toBe(8);
  });

  it("returns only verified content-addressed media and reviewed detail relationships", async () => {
    const detail = await fetchMoment(db(), PUBLIC_3, RELEASE, MEDIA_BASE_URL);
    expect(detail).toMatchObject({
      momentId: PUBLIC_3,
      cid: "bafy-public-003",
      tokenId: "3003",
      sourceMediaCount: 2,
      mediaCount: 1,
      mediaPreservationState: "partial",
      dropIds: [1001],
      collectionIds: [101],
      media: [
        {
          mediaId: "media-public-image",
          kind: "image",
          mimeType: "image/jpeg",
          url: `https://media.poap.in/snapshots/${SNAPSHOT_ID}/moments/original/sha256/aa/${"a".repeat(64)}.jpg`,
          thumbnailUrl: null,
        },
      ],
      userTags: [{ address: "0x3333333333333333333333333333333333333333" }],
      capsules: [{ capsuleId: 1, title: "A public sibling capsule" }],
    });
    expect(detail?.links).toHaveLength(2);
    expect(detail?.links[0]).toMatchObject({
      linkId: "link-public-safe",
      url: "https://example.invalid/moment",
    });
    expect(detail?.links[1]).toMatchObject({ linkId: "link-public-unsafe", url: null });
    expect(JSON.stringify(detail)).not.toContain("moments/private/");
    expect(JSON.stringify(detail)).not.toContain("source_status");
    expect(JSON.stringify(detail)).not.toContain("EXIF");
  });

  it("distinguishes pending source media from a Moment with no attached media", async () => {
    const detail = await fetchMoment(db(), PUBLIC_1, RELEASE, MEDIA_BASE_URL);
    expect(detail).toMatchObject({
      sourceMediaCount: 1,
      mediaCount: 0,
      mediaPreservationState: "pending",
      previewMedia: null,
      media: [],
    });
  });

  it("uses production browse SQL with ordered or selective indexes", async () => {
    for (const [query, expectedIndex, allowsSort] of [
      [momentsQuery(), "idx_moments_recent", false],
      [momentsQuery({ author: AUTHOR_A }), "idx_moments_author_recent", false],
      [momentsQuery({ dropId: 1001 }), "idx_moment_drops_drop", true],
      [momentsQuery({ collectionId: 101 }), "idx_moment_collections_collection", true],
    ] as const) {
      const browse = makeBrowseStatement(query);
      const plan = await bindings.MOMENTS_DB.prepare(`EXPLAIN QUERY PLAN ${browse.sql}`)
        .bind(...browse.values)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join("\n");
      expect(details).toContain(expectedIndex);
      if (!allowsSort) expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  it("enforces public URL boundaries for external links and Moment media", () => {
    expect(safeExternalUrl("https://user:secret@example.invalid/path")).toBeNull();
    expect(safeMomentExternalUrl("http://example.invalid/moment")).toBeNull();
    expect(safeMomentExternalUrl("https://example.invalid/moment")).toBe(
      "https://example.invalid/moment",
    );

    const digest = "a".repeat(64);
    const canonical = `https://media.poap.in/snapshots/${SNAPSHOT_ID}/moments/original/sha256/aa/${digest}.jpg`;
    expect(safeMomentMediaUrl(canonical)).toBe(canonical);
    expect(safeMomentMediaUrl(canonical.replace("https://", "http://"))).toBeNull();
    expect(safeMomentMediaUrl(canonical.replace("media.poap.in", "poap.in"))).toBeNull();
    expect(safeMomentMediaUrl(`${canonical}?download=1`)).toBeNull();
    expect(safeMomentMediaUrl(canonical.replace("/aa/", "/bb/"))).toBeNull();
  });

  it("treats HEIC and DNG originals as download-only files", () => {
    const mediaUrl = (extension: string) =>
      `https://media.poap.in/snapshots/${SNAPSHOT_ID}/moments/original/sha256/aa/${"a".repeat(64)}.${extension}`;

    expect(
      isBrowserRenderableMomentImage({
        kind: "image",
        mimeType: "image/jpeg",
        url: mediaUrl("jpg"),
      }),
    ).toBe(true);
    expect(
      isBrowserRenderableMomentImage({
        kind: "image",
        mimeType: "image/heic",
        url: mediaUrl("heic"),
      }),
    ).toBe(false);
    expect(
      isBrowserRenderableMomentImage({
        kind: "image",
        mimeType: "image/x-adobe-dng",
        url: mediaUrl("dng"),
      }),
    ).toBe(false);
    expect(
      isBrowserRenderableMomentImage({
        kind: "image",
        mimeType: null,
        url: mediaUrl("heic"),
      }),
    ).toBe(false);
  });

  it("rejects a public_stored media row whose key is not its immutable public key", async () => {
    const detail = await fetchMoment(db(), PUBLIC_3, RELEASE, MEDIA_BASE_URL);
    expect(detail?.sourceMediaCount).toBe(2);
    expect(detail?.media.map((media) => media.mediaId)).toEqual(["media-public-image"]);
    expect(detail?.mediaCount).toBe(1);
  });

  it("exports complete public details for an exact author without claiming ownership", async () => {
    const page = await fetchAuthorMomentExportPage(
      db(),
      AUTHOR_A,
      pageQuery("author-export"),
      RELEASE,
      MEDIA_BASE_URL,
    );
    expect(page).toMatchObject({
      schemaVersion: "poapin-moment-author-export-v1",
      snapshotId: SNAPSHOT_ID,
      author: AUTHOR_A,
      nextCursor: null,
    });
    expect(page.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
    expect(page.items[0]?.media).toHaveLength(1);
    expect(page.items[0]?.links).toHaveLength(2);
  });

  it("returns every media and Collection relation in the largest release-shaped detail", async () => {
    const synthetic = syntheticMomentsDb({
      momentCount: 1,
      mediaCounts: [565],
      collectionsPerMoment: 14,
    });
    const detail = await fetchMoment(
      synthetic.db,
      synthetic.momentIds[0]!,
      RELEASE,
      MEDIA_BASE_URL,
    );

    expect(detail?.media).toHaveLength(565);
    expect(detail?.media[0]?.position).toBe(0);
    expect(detail?.media.at(-1)?.position).toBe(564);
    expect(detail?.collectionIds).toHaveLength(14);
    expect(detail?.collectionIds.at(-1)).toBe(1_014);
    expect(synthetic.maxBoundParameters()).toBeLessThanOrEqual(49);
  });

  it("keeps dense media and Collection relations complete across a 48-Moment export page", async () => {
    const synthetic = syntheticMomentsDb({
      momentCount: 48,
      mediaCounts: [565, 347],
      collectionsPerMoment: 10,
    });
    const page = await fetchAuthorMomentExportPage(
      synthetic.db,
      AUTHOR_A,
      pageQuery("dense-author-export"),
      RELEASE,
      MEDIA_BASE_URL,
    );

    expect(page.items).toHaveLength(48);
    expect(page.items.reduce((total, item) => total + item.media.length, 0)).toBe(912);
    expect(page.items.reduce((total, item) => total + item.collectionIds.length, 0)).toBe(480);
    expect(page.items.every((item) => item.collectionIds.length === 10)).toBe(true);
    expect(synthetic.maxBoundParameters()).toBeLessThanOrEqual(49);
  });

  it("fails closed before an anomalous media relation can exceed the Worker memory bound", async () => {
    const synthetic = syntheticMomentsDb({
      momentCount: 1,
      mediaCounts: [1_025],
      collectionsPerMoment: 0,
    });

    await expect(
      fetchMoment(synthetic.db, synthetic.momentIds[0]!, RELEASE, MEDIA_BASE_URL),
    ).rejects.toMatchObject({
      code: "moments_shape_unsupported",
    });
  });

  it("serves bounded Drop and Collection feeds and matching public counts", async () => {
    const [dropCount, collectionCount, dropPage, collectionPage] = await Promise.all([
      fetchDropMomentCount(db(), 1001, RELEASE),
      fetchCollectionMomentCount(db(), 101, RELEASE),
      fetchDropMoments(db(), 1001, pageQuery("drop-1001"), RELEASE, MEDIA_BASE_URL),
      fetchCollectionMoments(db(), 101, pageQuery("collection-101"), RELEASE, MEDIA_BASE_URL),
    ]);
    expect(dropCount).toBe(2);
    expect(collectionCount).toBe(2);
    expect(dropPage.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
    expect(collectionPage.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
  });
});

describe("Moments HTTP API", () => {
  it("serves release-versioned metadata", async () => {
    const response = await SELF.fetch("https://poap.in/api/moments/meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe(
      `${MOMENTS_API_VERSION}.public-meta-v2`,
    );
    await expect(response.json()).resolves.toEqual({
      snapshotId: SNAPSHOT_ID,
      snapshotAt: "2026-07-23T00:00:00.000Z",
      counts: { sourceMoments: 8, publicMoments: 3, media: 5, capsules: 2 },
    });
  });

  it("paginates the hub with its release-scoped canonical cache", async () => {
    const first = await SELF.fetch("https://poap.in/api/moments?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-archive-api-version")).toBe(MOMENTS_API_VERSION);
    const firstPage = await first.json<{
      items: Array<{ momentId: string }>;
      nextCursor: string;
    }>();
    expect(firstPage.items.map((item) => item.momentId)).toEqual([PUBLIC_3]);

    const cached = await SELF.fetch("https://poap.in/api/moments?limit=1");
    expect(cached.headers.get("x-archive-cache")).toBe("HIT");
    expect(cached.headers.get("x-archive-api-version")).toBe(MOMENTS_API_VERSION);
    await cached.arrayBuffer();

    const params = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const second = await SELF.fetch(`https://poap.in/api/moments?${params}`);
    const secondPage = await second.json<{ items: Array<{ momentId: string }> }>();
    expect(secondPage.items.map((item) => item.momentId)).toEqual([PUBLIC_2]);
  });

  it("exports complete public Moment metadata for an exact author", async () => {
    const response = await SELF.fetch(
      `https://poap.in/api/moments/authors/${AUTHOR_A}/export?limit=48`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe(MOMENTS_API_VERSION);
    const page = await response.json<{
      schemaVersion: string;
      author: string;
      items: Array<{ momentId: string; media: unknown[]; links: unknown[] }>;
    }>();
    expect(page.schemaVersion).toBe("poapin-moment-author-export-v1");
    expect(page.author).toBe(AUTHOR_A);
    expect(page.items.map((item) => item.momentId)).toEqual([PUBLIC_3, PUBLIC_1]);
    expect(page.items[0]?.media).toHaveLength(1);
    expect(page.items[0]?.links).toHaveLength(2);
  });

  it("rejects invalid filters and UUIDs and returns hidden details as not found", async () => {
    const [badMedia, badUuid, hidden] = await Promise.all([
      SELF.fetch("https://poap.in/api/moments?media=document"),
      SELF.fetch("https://poap.in/api/moments/not-a-uuid"),
      SELF.fetch("https://poap.in/api/moments/00000000-0000-4000-8000-000000000010"),
    ]);
    expect([badMedia.status, badUuid.status, hidden.status]).toEqual([400, 400, 404]);
    for (const response of [badMedia, badUuid, hidden]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

function db() {
  return bindings.MOMENTS_DB.withSession("first-primary");
}

function momentsQuery(overrides: Partial<Omit<MomentsQuery, "filterKey">> = {}): MomentsQuery {
  const values = {
    author: overrides.author ?? null,
    dropId: overrides.dropId ?? null,
    collectionId: overrides.collectionId ?? null,
    mediaKind: overrides.mediaKind ?? null,
    limit: overrides.limit ?? 48,
  };
  return {
    ...values,
    cursor: overrides.cursor ?? null,
    filterKey: JSON.stringify(values),
  };
}

function pageQuery(scope: string) {
  return { mediaKind: null, limit: 48, cursor: null, filterKey: scope };
}

function decodeCursor(value: string): MomentCursor {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as MomentCursor;
}

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

interface SyntheticStatement {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => SyntheticStatement;
}

function syntheticMomentsDb(options: {
  momentCount: number;
  mediaCounts: number[];
  collectionsPerMoment: number;
}): {
  db: D1ReadClient;
  momentIds: string[];
  maxBoundParameters: () => number;
} {
  const momentIds = Array.from(
    { length: options.momentCount },
    (_, index) => `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
  );
  const summaries = momentIds.map((momentId, index) => ({
    moment_id: momentId,
    display_id: `SYNTHETIC${index + 1}`,
    author: AUTHOR_A,
    description: `Synthetic dense Moment ${index + 1}.`,
    created_on: `2026-07-20T12:00:${index.toString().padStart(2, "0")}.000Z`,
    updated_on: null,
    updated: 0,
  }));
  const mediaRows = summaries.flatMap((summary, momentIndex) =>
    Array.from({ length: options.mediaCounts[momentIndex] ?? 0 }, (_, mediaIndex) => {
      const ordinal = momentIndex * 2_000 + mediaIndex + 1;
      const digest = ordinal.toString(16).padStart(64, "0");
      return {
        media_key: `synthetic-media-${momentIndex}-${mediaIndex}`,
        moment_id: summary.moment_id,
        media_kind: "image",
        object_key: `snapshots/${SNAPSHOT_ID}/moments/original/sha256/${digest.slice(0, 2)}/${digest}.jpg`,
        archive_sha256: digest,
        archive_byte_length: 1_024,
        archive_content_type: "image/jpeg",
        archive_status: "public_stored",
        width: 1_200,
        height: 800,
        duration_ms: null,
        position: mediaIndex,
      };
    }),
  );
  const collectionRows = summaries.flatMap((summary) =>
    Array.from({ length: options.collectionsPerMoment }, (_, collectionIndex) => ({
      moment_id: summary.moment_id,
      collection_id: 1_001 + collectionIndex,
    })),
  );
  const dropRows = summaries.map((summary) => ({
    moment_id: summary.moment_id,
    drop_id: 1_001,
  }));
  const mediaByMoment = new Map<string, typeof mediaRows>();
  for (const row of mediaRows) {
    const rows = mediaByMoment.get(row.moment_id) ?? [];
    rows.push(row);
    mediaByMoment.set(row.moment_id, rows);
  }
  const readinessRows = [
    { key: "snapshot_id", value: SNAPSHOT_ID },
    { key: "ready", value: "1" },
    { key: "source_database_sha256", value: SOURCE_DATABASE_SHA256 },
    { key: "build_manifest_sha256", value: BUILD_MANIFEST_SHA256 },
  ];
  const prepared: SyntheticStatement[] = [];

  const rowsFor = (statement: SyntheticStatement): unknown[] => {
    const sql = statement.sql;
    if (sql.includes("SELECT key, value") && sql.includes("FROM moments_meta")) {
      return readinessRows;
    }
    if (sql.includes("COUNT(*) AS source_media_count")) {
      return summaries.flatMap((summary) => {
        const count = mediaByMoment.get(summary.moment_id)?.length ?? 0;
        return count === 0
          ? []
          : [{ moment_id: summary.moment_id, source_media_count: count, media_count: count }];
      });
    }
    if (sql.includes("FROM moment_media preview")) {
      return summaries.flatMap(
        (summary) => mediaByMoment.get(summary.moment_id)?.slice(0, 1) ?? [],
      );
    }
    if (sql.includes("FROM moment_drops")) return dropRows;
    if (sql.includes("FROM moment_collections")) return collectionRows;
    if (sql.includes("SELECT moment_id, cid, token_id")) {
      return summaries.map((summary, index) => ({
        moment_id: summary.moment_id,
        cid: `bafy-synthetic-${index + 1}`,
        token_id: String(index + 1),
      }));
    }
    if (sql.includes("FROM moment_media media")) return mediaRows;
    if (sql.includes("FROM moment_links")) return [];
    if (sql.includes("FROM moment_user_tags")) return [];
    if (sql.includes("FROM capsule_moments")) return [];
    if (sql.includes("FROM public_moments moment")) {
      const requestedId = statement.values[0];
      return summaries.filter((summary) => summary.moment_id === requestedId);
    }
    if (sql.includes("FROM moments moment")) return summaries;
    throw new Error(`Unexpected synthetic Moments query: ${sql}`);
  };

  const rawClient = {
    prepare(sql: string) {
      const statement: SyntheticStatement = {
        sql,
        values: [],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: SyntheticStatement[]) {
      return statements.map((statement) => ({
        results: rowsFor(statement),
        success: true,
        meta: {},
      }));
    },
  };

  return {
    db: rawClient as unknown as D1ReadClient,
    momentIds,
    maxBoundParameters: () =>
      prepared.reduce((maximum, statement) => Math.max(maximum, statement.values.length), 0),
  };
}
