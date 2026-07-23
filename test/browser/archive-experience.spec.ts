import { expect, test, type Page } from "@playwright/test";

const ADDRESS = "0x17470261d36fd5f3c6d19e750f6f6f7b389df357";

const archiveMeta = {
  snapshotId: "2026-07-02-v1",
  snapshotAt: "2026-07-02T00:00:00.000Z",
  counts: { drops: 73_876, tokens: 6_218_154, owners: 1_236_466, artworks: 73_795 },
  years: [2026, 2025],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/meta", (route) => route.fulfill({ json: archiveMeta }));
  await page.route("**/api/collections/meta", (route) =>
    route.fulfill({
      json: {
        snapshotId: "collections-2026-07-23-v1",
        releaseId: "collections-2026-07-23-r1",
        snapshotAt: "2026-07-23T00:00:00.000Z",
        count: 2_016,
      },
    }),
  );
  await page.route("**/api/moments/meta", (route) =>
    route.fulfill({
      json: {
        snapshotId: "moments-2026-07-23-v1",
        snapshotAt: "2026-07-23T00:00:00.000Z",
        counts: { sourceMoments: 25_959, publicMoments: 24_459, media: 32_891, capsules: 0 },
      },
    }),
  );
  await page.route("**/api/drops?*", (route) =>
    route.fulfill({ json: { items: [drop(1, "Archive opening")], nextCursor: null } }),
  );
});

test("homepage makes address and ENS lookup the primary action", async ({ page }) => {
  let requestedName = "";
  await page.route("**/api/resolve-address?*", async (route) => {
    requestedName = new URL(route.request().url()).searchParams.get("name") ?? "";
    await route.fulfill({ json: { name: "ericmwalk.eth", address: ADDRESS } });
  });
  await mockOwnerPage(page, {
    items: [holding(3, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Find the POAPs you kept/i })).toBeVisible();
  await expect(page.getByLabel("Look up a collection")).toBeVisible();
  await expect(page.getByLabel("Search drops")).toBeVisible();
  await expect(page.getByText("Search the archive")).toHaveCount(0);
  await expect(page.getByText("collections", { exact: true })).toBeVisible();
  await expect(page.getByText("public moments", { exact: true })).toBeVisible();

  const heroHeading = page.getByRole("heading", { level: 1 });
  const heroFontSize = await heroHeading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(heroFontSize).toBeLessThanOrEqual(64);

  const lookupBox = await page.getByLabel("Look up a collection").boundingBox();
  const dropSearchBox = await page.getByLabel("Search drops").boundingBox();
  expect(lookupBox).not.toBeNull();
  expect(dropSearchBox).not.toBeNull();
  expect(lookupBox!.y).toBeLessThan(dropSearchBox!.y);

  await page.getByLabel("Look up a collection").fill("ericmwalk.eth");
  await page.getByRole("button", { name: "View collection" }).click();
  await expect(page).toHaveURL(`/address/${ADDRESS}`);
  expect(requestedName).toBe("ericmwalk.eth");
});

test("address page leads with the collection, exact relationships, and month groups", async ({
  page,
}) => {
  await mockOwnerPage(page, {
    items: [holding(30, 1_770_854_400), holding(29, 1_773_619_200), holding(28, null)],
    nextCursor: null,
  });

  await page.goto(`/address/${ADDRESS}`);

  await expect(page.getByRole("heading", { name: "POAP collection" })).toBeVisible();
  await expect(page.getByText("2,477", { exact: true })).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await expect(page.getByText("3,053", { exact: true })).toBeVisible();
  await expect(page.getByText("46", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Minted in March 2026" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Minted in February 2026" })).toBeVisible();
  await expect(page.locator(".owner-month__heading h3")).toHaveText([
    "Minted in March 2026",
    "Minted in February 2026",
    "Mint date unavailable",
  ]);

  const holdingsTop = await page
    .locator(".owner-holdings")
    .evaluate((element) => element.offsetTop);
  const exportTop = await page.locator(".export-panel").evaluate((element) => element.offsetTop);
  expect(holdingsTop).toBeLessThan(exportTop);

  const firstCard = await page.locator(".owner-month .drop-card").first().boundingBox();
  expect(firstCard).not.toBeNull();
  expect(firstCard!.y).toBeLessThan(900);
});

test("loading another page merges holdings into the existing month", async ({ page }) => {
  await mockOwnerPage(page, {
    items: [holding(30, 1_773_705_600), holding(29, 1_773_619_200)],
    nextCursor: "next-page",
    nextItems: [holding(28, 1_773_532_800)],
  });

  await page.goto(`/address/${ADDRESS}`);
  await expect(page.locator(".owner-month")).toHaveCount(1);
  await expect(page.locator(".owner-month__heading")).toContainText("2 loaded");

  await page.getByRole("button", { name: "Load more POAPs" }).click();
  await expect(page.locator(".owner-month")).toHaveCount(1);
  await expect(page.locator(".owner-month__heading")).toContainText("3 loaded");
});

test("the refreshed lookup and address summary do not overflow a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOwnerPage(page, {
    items: [holding(30, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto("/");
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ viewport: 390, content: 390 });

  await page.goto(`/address/${ADDRESS}`);
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ viewport: 390, content: 390 });
});

async function mockOwnerPage(
  page: Page,
  {
    items,
    nextCursor,
    nextItems = [],
  }: {
    items: ReturnType<typeof holding>[];
    nextCursor: string | null;
    nextItems?: ReturnType<typeof holding>[];
  },
) {
  await page.route(`**/api/owners/${ADDRESS}?*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      json: {
        address: ADDRESS,
        total: 2_477,
        uniqueDrops: 2_400,
        items: cursor ? nextItems : items,
        nextCursor: cursor ? null : nextCursor,
      },
    });
  });
  await page.route(`**/api/owners/${ADDRESS}/export/manifest`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-personal-export-v1",
        address: ADDRESS,
        snapshots: {
          holdings: "2026-07-02-v1",
          collections: "collections-2026-07-23-v1",
          moments: "moments-2026-07-23-v1",
        },
        sources: {
          holdings: { snapshotId: "2026-07-02-v1" },
          collections: {
            snapshotId: "collections-2026-07-23-v1",
            releaseId: "collections-2026-07-23-r1",
          },
          moments: {
            snapshotId: "moments-2026-07-23-v1",
            releaseId: "moments-2026-07-23-r1",
            sourceDatabaseSha256: "a".repeat(64),
            buildManifestSha256: "b".repeat(64),
          },
        },
        counts: {
          holdings: 2_477,
          authoredMoments: 3_053,
          taggedMoments: 46,
          ownedCollections: 12,
          ownedCapsules: 0,
        },
        segments: {
          holdings: { path: `/api/owners/${ADDRESS}/export/holdings?limit=480`, pageSize: 480 },
          ownedCollections: {
            path: `/api/collections/owners/${ADDRESS}/export?limit=48`,
            pageSize: 48,
          },
          moments: { path: `/api/moments/authors/${ADDRESS}/export?limit=48`, pageSize: 48 },
          taggedMoments: { path: `/api/moments/tags/${ADDRESS}/export?limit=48`, pageSize: 48 },
          ownedCapsules: { path: `/api/capsules/owners/${ADDRESS}/export?limit=48`, pageSize: 48 },
        },
      },
    }),
  );
}

function holding(dropId: number, mintedOn: number | null) {
  return {
    ...drop(dropId, `Collected Drop ${dropId}`),
    sourceUid: `source-${dropId}`,
    poapId: dropId,
    mintedOn,
    ownerAddress: ADDRESS,
    network: "ethereum",
    transferCount: 0,
  };
}

function drop(dropId: number, title: string) {
  return {
    dropId,
    title,
    startDate: "2026-01-01T00:00:00.000Z",
    year: 2026,
    imageUrl: "/brand/logo_poap.svg",
    hasArtwork: true,
    tokenCount: 1,
  };
}
