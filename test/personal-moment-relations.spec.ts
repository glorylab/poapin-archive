import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  makeOwnedCapsulesStatement,
  makeTaggedMomentStatement,
  type CapsuleCursor,
  type MomentCursor,
} from "../src/worker/moments-repository";
import type { Bindings } from "../src/worker/types";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";
const UNUSED_ADDRESS = "0x9999999999999999999999999999999999999999";
const AUTHORED_AND_TAGGED = "10000000-0000-4000-8000-000000000001";
const TAGGED_ONLY = "10000000-0000-4000-8000-000000000002";
const SUPPRESSED_TAGGED = "10000000-0000-4000-8000-000000000003";
const SNAPSHOT_ID = "moments-2026-07-23-v1";

interface TestBindings extends Bindings {
  TEST_CATALOG_FIXTURE: string;
  TEST_CATALOG_MIGRATIONS: D1Migration[];
  TEST_HOLDINGS_FIXTURE: string;
  TEST_HOLDINGS_MIGRATIONS: D1Migration[];
  TEST_COLLECTIONS_FIXTURE: string;
  TEST_COLLECTIONS_MIGRATIONS: D1Migration[];
  TEST_MOMENTS_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestBindings;

beforeAll(async () => {
  await applyD1Migrations(bindings.CATALOG_DB, bindings.TEST_CATALOG_MIGRATIONS);
  await applyD1Migrations(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_MIGRATIONS);
  await applyD1Migrations(bindings.COLLECTIONS_DB, bindings.TEST_COLLECTIONS_MIGRATIONS);
  // This focused fixture exercises the immutable public views from the schema.
  // Import-guard behavior is covered by the dedicated Moments loader tests.
  await applyD1Migrations(bindings.MOMENTS_DB, bindings.TEST_MOMENTS_MIGRATIONS.slice(0, 1));
  await executeSql(bindings.CATALOG_DB, bindings.TEST_CATALOG_FIXTURE);
  await executeSql(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_FIXTURE);
  await executeSql(bindings.COLLECTIONS_DB, bindings.TEST_COLLECTIONS_FIXTURE);
  await executeSql(bindings.MOMENTS_DB, RELATION_FIXTURE);
});

describe("complete personal Moment relationships", () => {
  it("adds exact authored, tagged, and independently owned Capsule counts to the manifest", async () => {
    const response = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export/manifest`);
    expect(response.status).toBe(200);
    const body = await response.json<{
      sources: {
        moments: {
          snapshotId: string;
          releaseId: string;
          sourceDatabaseSha256: string;
          buildManifestSha256: string;
        };
      };
      counts: {
        authoredMoments: number;
        taggedMoments: number;
        ownedCapsules: number;
      };
      segments: Record<string, { path: string; pageSize: number }>;
    }>();
    expect(body.sources.moments).toEqual({
      snapshotId: SNAPSHOT_ID,
      releaseId: bindings.MOMENTS_RELEASE_ID,
      sourceDatabaseSha256: bindings.MOMENTS_SOURCE_DATABASE_SHA256,
      buildManifestSha256: bindings.MOMENTS_BUILD_MANIFEST_SHA256,
    });
    expect(body.counts).toMatchObject({
      authoredMoments: 1,
      taggedMoments: 2,
      ownedCapsules: 2,
    });
    expect(body.segments).toMatchObject({
      moments: {
        path: `/api/moments/authors/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
      taggedMoments: {
        path: `/api/moments/tags/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
      ownedCapsules: {
        path: `/api/capsules/owners/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
    });
  });

  it("deduplicates tagged Moments while preserving authored/tagged overlap and full detail", async () => {
    const first = await SELF.fetch(`https://poap.in/api/moments/tags/${ADDRESS}/export?limit=1`);
    expect(first.status).toBe(200);
    const firstPage = await first.json<{
      schemaVersion: string;
      snapshotId: string;
      releaseId: string;
      sourceDatabaseSha256: string;
      buildManifestSha256: string;
      address: string;
      items: Array<{
        momentId: string;
        cid: string | null;
        userTags: unknown[];
        media: unknown[];
        links: unknown[];
        capsules: unknown[];
      }>;
      nextCursor: string;
    }>();
    expect(firstPage).toMatchObject({
      schemaVersion: "poapin-moment-tagged-export-v1",
      snapshotId: SNAPSHOT_ID,
      releaseId: bindings.MOMENTS_RELEASE_ID,
      sourceDatabaseSha256: bindings.MOMENTS_SOURCE_DATABASE_SHA256,
      buildManifestSha256: bindings.MOMENTS_BUILD_MANIFEST_SHA256,
      address: ADDRESS,
    });
    expect(firstPage.items).toEqual([
      expect.objectContaining({
        momentId: AUTHORED_AND_TAGGED,
        cid: "bafy-authored-and-tagged",
        userTags: expect.any(Array),
        media: [],
        links: [],
        capsules: [expect.objectContaining({ capsuleId: 1 })],
      }),
    ]);
    // Two source tag rows for the same address must not duplicate the Moment.
    expect(firstPage.items[0]?.userTags).toHaveLength(2);

    const cursor = decodeCursor<MomentCursor>(firstPage.nextCursor);
    expect(cursor).toMatchObject({
      c: "moments",
      s: SNAPSHOT_ID,
      p: 2,
    });
    expect(cursor.f).toContain(`tagged-export:${ADDRESS}`);
    expect(cursor.f).toContain(bindings.MOMENTS_RELEASE_ID);
    expect(cursor.f).toContain(bindings.MOMENTS_SOURCE_DATABASE_SHA256);
    expect(cursor.f).toContain(bindings.MOMENTS_BUILD_MANIFEST_SHA256);

    const params = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const second = await SELF.fetch(`https://poap.in/api/moments/tags/${ADDRESS}/export?${params}`);
    await expect(second.json()).resolves.toMatchObject({
      items: [{ momentId: TAGGED_ONLY }],
      nextCursor: null,
    });

    const authored = await SELF.fetch(
      `https://poap.in/api/moments/authors/${ADDRESS}/export?limit=48`,
    );
    const authoredPage = await authored.json<{ items: Array<{ momentId: string }> }>();
    expect(authoredPage.items.map((item) => item.momentId)).toEqual([AUTHORED_AND_TAGGED]);
  });

  it("exports public Capsules by archived owner even when no Moment relation exists", async () => {
    const first = await SELF.fetch(`https://poap.in/api/capsules/owners/${ADDRESS}/export?limit=1`);
    expect(first.status).toBe(200);
    const firstPage = await first.json<{
      schemaVersion: string;
      snapshotId: string;
      releaseId: string;
      sourceDatabaseSha256: string;
      buildManifestSha256: string;
      address: string;
      items: Array<{
        capsuleId: number;
        externalId: string | null;
        title: string | null;
        description: string | null;
        imageUrl: string | null;
        url: string | null;
        owner: string | null;
        createdOn: string;
      }>;
      nextCursor: string;
    }>();
    expect(firstPage).toMatchObject({
      schemaVersion: "poapin-capsule-owner-export-v1",
      snapshotId: SNAPSHOT_ID,
      releaseId: bindings.MOMENTS_RELEASE_ID,
      sourceDatabaseSha256: bindings.MOMENTS_SOURCE_DATABASE_SHA256,
      buildManifestSha256: bindings.MOMENTS_BUILD_MANIFEST_SHA256,
      address: ADDRESS,
      items: [
        {
          capsuleId: 2,
          externalId: "independent-capsule",
          title: "Independent public Capsule",
          description: "This Capsule has no capsule_moments row.",
          imageUrl: null,
          url: "https://example.invalid/independent-capsule",
          owner: ADDRESS,
          createdOn: "2026-07-19T00:00:00.000Z",
        },
      ],
    });
    const relation = await bindings.MOMENTS_DB.prepare(
      "SELECT COUNT(*) AS count FROM capsule_moments WHERE capsule_id = 2",
    ).all<{ count: number }>();
    expect(relation.results[0]?.count).toBe(0);

    const cursor = decodeCursor<CapsuleCursor>(firstPage.nextCursor);
    expect(cursor).toMatchObject({ c: "capsules", s: SNAPSHOT_ID, p: 2, i: 2 });
    expect(cursor.f).toContain(bindings.MOMENTS_RELEASE_ID);
    const params = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const second = await SELF.fetch(
      `https://poap.in/api/capsules/owners/${ADDRESS}/export?${params}`,
    );
    const secondPage = await second.json<{
      items: Array<{ capsuleId: number }>;
      nextCursor: null;
    }>();
    expect(secondPage.items).toEqual([
      {
        capsuleId: 1,
        externalId: "attached-capsule",
        title: "Attached public Capsule",
        description: "This Capsule is attached to a public Moment.",
        imageUrl: null,
        url: "https://example.invalid/attached-capsule",
        owner: ADDRESS,
        createdOn: "2026-07-18T00:00:00.000Z",
      },
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(JSON.stringify([firstPage, secondPage])).not.toContain("suppressed capsule secret");
    expect(JSON.stringify([firstPage, secondPage])).not.toContain("private capsule secret");
  });

  it("rejects cursors from another relation, address, limit, or release", async () => {
    const response = await SELF.fetch(`https://poap.in/api/moments/tags/${ADDRESS}/export?limit=1`);
    const page = await response.json<{ nextCursor: string }>();
    const decoded = decodeCursor<MomentCursor>(page.nextCursor);
    const wrongRelease = encodeCursor({
      ...decoded,
      f: decoded.f.replace(bindings.MOMENTS_RELEASE_ID, "wrong-release"),
    });
    const wrongAddress = new URLSearchParams({ limit: "1", cursor: page.nextCursor });
    const wrongLimit = new URLSearchParams({ limit: "2", cursor: page.nextCursor });
    const wrongReleaseParams = new URLSearchParams({ limit: "1", cursor: wrongRelease });
    const wrongRelation = new URLSearchParams({ limit: "1", cursor: page.nextCursor });
    const results = await Promise.all([
      SELF.fetch(`https://poap.in/api/moments/tags/${OTHER_ADDRESS}/export?${wrongAddress}`),
      SELF.fetch(`https://poap.in/api/moments/tags/${ADDRESS}/export?${wrongLimit}`),
      SELF.fetch(`https://poap.in/api/moments/tags/${ADDRESS}/export?${wrongReleaseParams}`),
      SELF.fetch(`https://poap.in/api/capsules/owners/${ADDRESS}/export?${wrongRelation}`),
    ]);
    expect(results.map((item) => item.status)).toEqual([400, 400, 400, 400]);
  });

  it("starts both relationship exports from their selective address indexes", async () => {
    const tagged = makeTaggedMomentStatement(ADDRESS, {
      mediaKind: null,
      limit: 48,
      cursor: null,
      filterKey: "plan",
    });
    const capsules = makeOwnedCapsulesStatement({
      address: ADDRESS,
      limit: 48,
      cursor: null,
      filterKey: "plan",
      canonicalSearch: "limit=48",
    });
    const [taggedPlan, capsulesPlan] = await Promise.all([
      bindings.MOMENTS_DB.prepare(`EXPLAIN QUERY PLAN ${tagged.sql}`)
        .bind(...tagged.values)
        .all<{ detail: string }>(),
      bindings.MOMENTS_DB.prepare(`EXPLAIN QUERY PLAN ${capsules.sql}`)
        .bind(...capsules.values)
        .all<{ detail: string }>(),
    ]);
    const taggedDetails = taggedPlan.results.map((row) => row.detail).join("\n");
    const capsuleDetails = capsulesPlan.results.map((row) => row.detail).join("\n");
    expect(taggedDetails).toContain("idx_moment_user_tags_address");
    expect(capsuleDetails).toContain("idx_capsules_owner");
    expect(capsuleDetails).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("fails every relationship and manifest endpoint closed when Moments is not ready", async () => {
    await bindings.MOMENTS_DB.prepare(
      "UPDATE moments_meta SET value = '0' WHERE key = 'ready'",
    ).run();
    try {
      const responses = await Promise.all([
        SELF.fetch(`https://poap.in/api/moments/tags/${UNUSED_ADDRESS}/export?limit=48`),
        SELF.fetch(`https://poap.in/api/capsules/owners/${UNUSED_ADDRESS}/export?limit=48`),
        SELF.fetch(`https://poap.in/api/owners/${UNUSED_ADDRESS}/export/manifest`),
      ]);
      expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
      for (const response of responses) {
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        await expect(response.json()).resolves.toMatchObject({
          code: "moments_unavailable",
        });
      }
    } finally {
      await bindings.MOMENTS_DB.prepare(
        "UPDATE moments_meta SET value = '1' WHERE key = 'ready'",
      ).run();
    }
  });
});

function decodeCursor<T>(value: string): T {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

const RELATION_FIXTURE = `
  PRAGMA foreign_keys = ON;

  INSERT INTO moments_meta (key, value) VALUES
    ('snapshot_id', '${SNAPSHOT_ID}'),
    ('snapshot_at', '2026-07-23T00:00:00.000Z'),
    ('ready', '1'),
    ('source_database_sha256', '${"a".repeat(64)}'),
    ('build_manifest_sha256', '${"b".repeat(64)}');

  INSERT INTO moments (
    moment_id, display_id, author, author_address_norm, description, cid,
    token_id, legacy_drop_id, created_on, updated_on, updated
  ) VALUES
    (
      '${AUTHORED_AND_TAGGED}', 'OVERLAP', '${ADDRESS}', '${ADDRESS}',
      'Authored and tagged public Moment.', 'bafy-authored-and-tagged',
      '101', 1001, '2026-07-20T00:00:00.000Z', NULL, 0
    ),
    (
      '${TAGGED_ONLY}', 'TAGGED_ONLY', '${OTHER_ADDRESS}', '${OTHER_ADDRESS}',
      'Tagged but not authored public Moment.', 'bafy-tagged-only',
      '102', 1002, '2026-07-19T00:00:00.000Z', NULL, 0
    ),
    (
      '${SUPPRESSED_TAGGED}', 'SUPPRESSED_TAGGED', '${ADDRESS}', '${ADDRESS}',
      'suppressed Moment secret', NULL,
      NULL, 1001, '2026-07-21T00:00:00.000Z', NULL, 0
    );

  INSERT INTO moment_visibility (moment_id, is_public, source_scope, evaluated_on) VALUES
    ('${AUTHORED_AND_TAGGED}', 1, 'test', '2026-07-23T00:00:00.000Z'),
    ('${TAGGED_ONLY}', 1, 'test', '2026-07-23T00:00:00.000Z'),
    ('${SUPPRESSED_TAGGED}', 1, 'test', '2026-07-23T00:00:00.000Z');

  INSERT INTO moment_drops (moment_id, drop_id, position) VALUES
    ('${AUTHORED_AND_TAGGED}', 1001, 0),
    ('${TAGGED_ONLY}', 1002, 0),
    ('${SUPPRESSED_TAGGED}', 1001, 0);

  INSERT INTO moment_suppressions (
    moment_id, reason_code, public_message, suppressed_on, active
  ) VALUES (
    '${SUPPRESSED_TAGGED}', 'rights_request', NULL, '2026-07-23T00:00:00.000Z', 1
  );

  INSERT INTO moment_user_tags (
    tag_id, moment_id, address, address_norm, ens, created_by,
    x, y, created_on, position
  ) VALUES
    (
      'overlap-tag-1', '${AUTHORED_AND_TAGGED}', '${ADDRESS}', '${ADDRESS}',
      NULL, '${OTHER_ADDRESS}', 10, 20, '2026-07-20T00:01:00.000Z', 0
    ),
    (
      'overlap-tag-2', '${AUTHORED_AND_TAGGED}', '${ADDRESS}', '${ADDRESS}',
      NULL, '${OTHER_ADDRESS}', 30, 40, '2026-07-20T00:02:00.000Z', 1
    ),
    (
      'tagged-only-tag', '${TAGGED_ONLY}', '${ADDRESS}', '${ADDRESS}',
      NULL, '${OTHER_ADDRESS}', 50, 60, '2026-07-19T00:01:00.000Z', 0
    ),
    (
      'suppressed-tag', '${SUPPRESSED_TAGGED}', '${ADDRESS}', '${ADDRESS}',
      NULL, '${OTHER_ADDRESS}', 70, 80, '2026-07-21T00:01:00.000Z', 0
    );

  INSERT INTO capsules (
    capsule_id, external_id, owner, owner_address_norm, title, description,
    url, image_object_key, image_sha256, image_mime_type,
    image_archive_status, created_on
  ) VALUES
    (
      1, 'attached-capsule', '${ADDRESS}', '${ADDRESS}',
      'Attached public Capsule', 'This Capsule is attached to a public Moment.',
      'https://example.invalid/attached-capsule', NULL, NULL, NULL,
      'pending', '2026-07-18T00:00:00.000Z'
    ),
    (
      2, 'independent-capsule', '${ADDRESS}', '${ADDRESS}',
      'Independent public Capsule', 'This Capsule has no capsule_moments row.',
      'https://example.invalid/independent-capsule', NULL, NULL, NULL,
      'pending', '2026-07-19T00:00:00.000Z'
    ),
    (
      3, 'suppressed-capsule', '${ADDRESS}', '${ADDRESS}',
      'suppressed capsule secret', NULL, 'https://example.invalid/suppressed',
      NULL, NULL, NULL, 'pending', '2026-07-20T00:00:00.000Z'
    ),
    (
      4, 'private-capsule', '${ADDRESS}', '${ADDRESS}',
      'private capsule secret', NULL, 'https://example.invalid/private',
      NULL, NULL, NULL, 'pending', '2026-07-21T00:00:00.000Z'
    );

  INSERT INTO capsule_visibility (capsule_id, is_public, source_scope, evaluated_on) VALUES
    (1, 1, 'test', '2026-07-23T00:00:00.000Z'),
    (2, 1, 'test', '2026-07-23T00:00:00.000Z'),
    (3, 1, 'test', '2026-07-23T00:00:00.000Z'),
    (4, 0, 'test', '2026-07-23T00:00:00.000Z');

  INSERT INTO capsule_suppressions (
    capsule_id, reason_code, suppressed_on, active
  ) VALUES (3, 'rights_request', '2026-07-23T00:00:00.000Z', 1);

  INSERT INTO capsule_moments (
    capsule_id, moment_id, created_on, created_by, position
  ) VALUES (
    1, '${AUTHORED_AND_TAGGED}', '2026-07-20T01:00:00.000Z', 'test', 0
  );
`;
