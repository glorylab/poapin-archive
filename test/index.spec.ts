import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { csvCell } from "../src/worker/exports";
import { artworkUrl } from "../src/worker/media";
import { fetchDrop, fetchDrops, fetchMeta, fetchOwnerTotal } from "../src/worker/repository";
import type { Bindings } from "../src/worker/types";
import { parseDropsQuery } from "../src/worker/validation";

const ADDRESS = "0x1111111111111111111111111111111111111111";
interface TestBindings extends Bindings {
  TEST_CATALOG_FIXTURE: string;
  TEST_CATALOG_MIGRATIONS: D1Migration[];
  TEST_HOLDINGS_FIXTURE: string;
  TEST_HOLDINGS_MIGRATIONS: D1Migration[];
}
const bindings = env as unknown as TestBindings;

beforeAll(async () => {
  await applyD1Migrations(bindings.CATALOG_DB, bindings.TEST_CATALOG_MIGRATIONS);
  await applyD1Migrations(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_MIGRATIONS);
  await executeSql(bindings.CATALOG_DB, bindings.TEST_CATALOG_FIXTURE);
  await executeSql(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_FIXTURE);
  await bindings.CATALOG_DB.prepare(
    "UPDATE drops SET event_url = 'javascript:alert(1)' WHERE drop_id = 2",
  ).run();
});

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

describe("archive API", () => {
  it("returns precomputed snapshot metadata", async () => {
    const response = await SELF.fetch("https://poap.in/api/meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe("v1");
    expect(await response.json()).toEqual({
      snapshotId: "2026-07-02-v1",
      snapshotAt: "2026-07-02T14:28:17.259Z",
      counts: { drops: 3, tokens: 3, owners: 2, artworks: 2 },
      years: [2018, 2015],
    });
  });

  it("uses keyset cursors and canonical R2 artwork URLs", async () => {
    const first = await SELF.fetch("https://poap.in/api/drops?limit=1");
    const firstPage = await first.json<{
      items: Array<{ dropId: number; imageUrl: string }>;
      nextCursor: string;
    }>();
    expect(firstPage.items[0]).toMatchObject({
      dropId: 2,
      imageUrl: "https://media.poap.in/snapshots/2026-07-02-v1/artwork/2.webp",
    });

    const params = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const second = await SELF.fetch(`https://poap.in/api/drops?${params}`);
    const secondPage = await second.json<{
      items: Array<{ dropId: number }>;
      nextCursor: string;
    }>();
    expect(secondPage.items[0]?.dropId).toBe(1);

    const finalParams = new URLSearchParams({ limit: "1", cursor: secondPage.nextCursor });
    const final = await SELF.fetch(`https://poap.in/api/drops?${finalParams}`);
    const finalPage = await final.json<{
      items: Array<{ dropId: number }>;
      nextCursor: null;
    }>();
    expect(finalPage.items[0]?.dropId).toBe(3);
    expect(finalPage.nextCursor).toBeNull();
  });

  it("sanitizes FTS input and filters virtual drops", async () => {
    const response = await SELF.fetch(
      "https://poap.in/api/drops?q=virtual%20OR%20gathering&type=virtual&limit=48",
    );
    expect(response.status).toBe(200);
    const page = await response.json<{ items: Array<{ dropId: number }> }>();
    // OR is searched as an ordinary word joined with AND, never as an FTS operator.
    expect(page.items).toEqual([]);
  });

  it("returns details and removes unsafe event URLs", async () => {
    const response = await SELF.fetch("https://poap.in/api/drops/2");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dropId: 2,
      eventUrl: null,
      reservationsTotal: 2,
      reservationsMinted: 1,
    });
  });

  it("paginates exact owner lookups without exposing address discovery", async () => {
    const first = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}?limit=1`);
    expect(first.status).toBe(200);
    const page = await first.json<{
      address: string;
      total: number;
      items: Array<{ poapId: number; dropId: number }>;
      nextCursor: string;
    }>();
    expect(page).toMatchObject({
      address: ADDRESS,
      total: 2,
      items: [{ poapId: 2, dropId: 2 }],
    });

    const params = new URLSearchParams({ limit: "1", cursor: page.nextCursor });
    const second = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}?${params}`);
    const nextPage = await second.json<{ items: Array<{ poapId: number }>; nextCursor: null }>();
    expect(nextPage.items[0]?.poapId).toBe(1);
    expect(nextPage.nextCursor).toBeNull();
  });

  it("streams a versioned JSON owner export", async () => {
    const response = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(".json");
    const body = await response.json<{
      schema_version: string;
      queried_address: string;
      count: number;
      tokens: Array<{ source_uid: string; artwork_url: string }>;
    }>();
    expect(body.schema_version).toBe("poapin-address-export-v1");
    expect(body.queried_address).toBe(ADDRESS);
    expect(body.count).toBe(2);
    expect(body.tokens).toHaveLength(2);
    expect(body.tokens[0]?.artwork_url).toBe(
      "https://media.poap.in/snapshots/2026-07-02-v1/artwork/2.webp",
    );
  });

  it("rejects invalid and CPU-amplifying parameters", async () => {
    const [badLimit, shortSearch, unknown, badAddress] = await Promise.all([
      SELF.fetch("https://poap.in/api/drops?limit=49"),
      SELF.fetch("https://poap.in/api/drops?q=a"),
      SELF.fetch("https://poap.in/api/drops?offset=100000"),
      SELF.fetch("https://poap.in/api/owners/0x1234"),
    ]);
    expect([badLimit.status, shortSearch.status, unknown.status, badAddress.status]).toEqual([
      400, 400, 400, 400,
    ]);
    for (const response of [badLimit, shortSearch, unknown, badAddress]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("uses a schema-versioned canonical cache key", async () => {
    const first = await SELF.fetch("https://poap.in/api/drops?year=2015&limit=48");
    expect(first.headers.get("x-archive-cache")).toBe("MISS");
    expect(first.headers.get("x-archive-api-version")).toBe("v1");
    await first.arrayBuffer();

    const reordered = await SELF.fetch("https://poap.in/api/drops?limit=48&year=2015");
    expect(reordered.headers.get("x-archive-cache")).toBe("HIT");
  });

  it("uses the popular partial index without a temporary sort", async () => {
    const plan = await bindings.CATALOG_DB.prepare(
      `
      EXPLAIN QUERY PLAN
      SELECT drop_id, token_count
      FROM drops
      WHERE is_private = 0
      ORDER BY token_count DESC, drop_id DESC
      LIMIT 49
    `,
    ).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_drops_popular");
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  it("fails closed when either D1 snapshot does not match the deployment", async () => {
    const catalogDb = bindings.CATALOG_DB.withSession("first-primary");
    const browseQuery = parseDropsQuery(
      new URL("https://poap.in/api/drops?limit=1"),
      "wrong-snapshot",
    );
    await expect(fetchMeta(catalogDb, "wrong-snapshot")).rejects.toMatchObject({
      code: "snapshot_mismatch",
    });
    await expect(
      fetchDrops(catalogDb, browseQuery, "wrong-snapshot", "https://media.poap.in"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
    await expect(
      fetchDrop(catalogDb, 2, "https://media.poap.in", "wrong-snapshot"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
    await expect(
      fetchOwnerTotal(bindings.HOLDINGS_DB.withSession("first-primary"), ADDRESS, "wrong-snapshot"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
  });

  it("does not advertise a known-missing artwork in exports", async () => {
    const address = "0x3333333333333333333333333333333333333333";
    const response = await SELF.fetch(`https://poap.in/api/owners/${address}/export.json`);
    const body = await response.json<{
      snapshot_id: string;
      tokens: Array<{ artwork_url: string | null }>;
    }>();
    expect(body.snapshot_id).toBe("2026-07-02-v1");
    expect(body.tokens[0]?.artwork_url).toBeNull();
  });
});

describe("export and media helpers", () => {
  it("neutralizes spreadsheet formulas after RFC 4180 escaping", () => {
    expect(csvCell('=HYPERLINK("https://bad")')).toBe('"\'=HYPERLINK(""https://bad"")"');
  });

  it("normalizes the media base URL", () => {
    expect(artworkUrl("https://media.poap.in///", "2026-07-02-v1", 42)).toBe(
      "https://media.poap.in/snapshots/2026-07-02-v1/artwork/42.webp",
    );
  });
});
