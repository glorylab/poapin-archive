import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { strToU8, unzipSync } from "fflate";

import {
  buildPortableSiteFiles,
  type PortableSiteSnapshot,
} from "../../src/react-app/portable-site";
import { createPortableSiteZip } from "../../src/react-app/portable-site-zip";

const ADDRESS = "0x1111111111111111111111111111111111111111";

test("the downloaded ZIP opens directly through file://", async ({ page }, testInfo) => {
  const root = await extractPortableSite(testInfo);
  const errors = watchPageFailures(page);
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(pathToFileURL(join(root, "index.html")).href);

  await expect(page.locator(".poap-card h3", { hasText: "Portable POAP" })).toBeVisible();
  await expect(page.locator(".error-card")).toHaveCount(0);
  await expect(page.getByText("Failed to fetch")).toHaveCount(0);
  await expect(page.locator("#owner-address")).toHaveText(ADDRESS);
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ viewport: 320, content: 320 });
  expect(requestedUrls.filter((url) => url.startsWith("https://media.poap.in/"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("the same extracted package works from an HTTP static origin", async ({ page }, testInfo) => {
  const root = await extractPortableSite(testInfo);
  const server = await serveDirectory(root);
  const errors = watchPageFailures(page);

  try {
    await page.goto(server.url);
    await expect(page.locator(".poap-card h3", { hasText: "Portable POAP" })).toBeVisible();
    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByRole("heading", { name: "Archive summary" })).toBeVisible();
    await expect(page.locator(".error-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeServer(server.server);
  }
});

test("file:// rejects a same-length tampered data payload", async ({ page }, testInfo) => {
  const root = await extractPortableSite(testInfo);
  const transportPath = join(root, "data", "drops-0001.data.js");
  const transport = await readFile(transportPath, "utf8");
  const match = transport.match(/("[A-Za-z0-9_-]{40,}")/u);
  if (!match?.[1]) throw new Error("Could not locate the generated data payload.");
  const payload = match[1];
  const offset = Math.floor(payload.length / 2);
  const replacement = payload[offset] === "A" ? "B" : "A";
  const tampered = `${payload.slice(0, offset)}${replacement}${payload.slice(offset + 1)}`;
  await writeFile(transportPath, transport.replace(payload, tampered));

  await page.goto(pathToFileURL(join(root, "index.html")).href);

  await expect(page.locator(".error-card")).toContainText(
    "data/drops-0001.data.js failed its payload SHA-256 check.",
  );
  await expect(page.getByText("Portable POAP", { exact: true })).toHaveCount(0);
});

test("an empty personal archive also opens directly through file://", async ({
  page,
}, testInfo) => {
  const snapshot = fixture();
  snapshot.holdings = [];
  snapshot.drops = [];
  const root = await extractPortableSite(testInfo, snapshot);
  const errors = watchPageFailures(page);

  await page.goto(pathToFileURL(join(root, "index.html")).href);

  await expect(page.getByText("Nothing was exported for this section.")).toBeVisible();
  await expect(page.locator(".error-card")).toHaveCount(0);
  await expect(page.locator("#owner-address")).toHaveText(ADDRESS);
  expect(errors).toEqual([]);
});

async function extractPortableSite(
  testInfo: TestInfo,
  snapshot: PortableSiteSnapshot = fixture(),
): Promise<string> {
  const files = await buildPortableSiteFiles(snapshot);
  const result = await createPortableSiteZip(
    files,
    "2026-07-23T00:00:00.000Z",
    new AbortController().signal,
  );
  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const root = testInfo.outputPath("portable-site");
  await mkdir(root, { recursive: true });
  for (const [path, bytes] of Object.entries(archive)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return root;
}

function watchPageFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    failures.push(`requestfailed: ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`);
  });
  return failures;
}

async function serveDirectory(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, "") || "index.html";
      if (relative.split("/").includes("..")) throw new Error("Unsafe path");
      const body = await readFile(join(root, relative));
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType(relative));
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end(strToU8("Not found"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the test server.");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function contentType(path: string): string {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
    }[extname(path)] ?? "application/octet-stream"
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function fixture(): PortableSiteSnapshot {
  const snapshots = {
    holdings: "catalog-2026-07-23",
    collections: "collections-2026-07-23",
    moments: "moments-2026-07-23",
  };
  return {
    address: ADDRESS,
    generatedAt: "2026-07-23T00:00:00.000Z",
    snapshotIds: snapshots,
    sources: {
      holdings: { snapshotId: snapshots.holdings },
      collections: {
        snapshotId: snapshots.collections,
        releaseId: "collections-2026-07-23-r1",
      },
      moments: {
        snapshotId: snapshots.moments,
        releaseId: "moments-2026-07-23-r1",
        sourceDatabaseSha256: "a".repeat(64),
        buildManifestSha256: "b".repeat(64),
      },
    },
    holdings: [
      {
        sourceUid: "source-1",
        poapId: 1,
        dropId: 42,
        mintedOn: 1_700_000_000,
        ownerAddress: ADDRESS,
        network: "ethereum",
        transferCount: 0,
      },
    ],
    drops: [
      {
        dropId: 42,
        fancyId: "portable-poap",
        title: "Portable POAP",
        description: "A portable archive that opens without a local server.",
        startDate: "2026-07-23T00:00:00.000Z",
        endDate: null,
        city: null,
        country: null,
        year: 2026,
        isVirtual: true,
        eventUrl: "https://poap.in",
        imageUrl: "https://media.poap.in/snapshots/catalog/artwork/42.webp",
      },
    ],
    unavailableDropIds: [],
    collectionProfiles: [],
    heldDropMemberships: [],
    authoredMomentAssociations: [],
    taggedMomentAssociations: [],
    ownedCollectionExports: [],
    publicAuthoredMoments: [],
    publicTaggedMoments: [],
    ownedCapsules: [],
  };
}
