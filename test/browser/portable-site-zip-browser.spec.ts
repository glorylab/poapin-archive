import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

const LARGE_DATA_FILE_BYTES = 192 * 1024;
const HARNESS_PATH = "/__playwright__/portable-site-zip";

interface PortableSiteZipModule {
  createPortableSiteZip(
    files: ReadonlyMap<string, Uint8Array>,
    generatedAt: string,
    signal: AbortSignal,
  ): Promise<{
    blob: Blob;
    fileCount: number;
    uncompressedBytes: number;
  }>;
}

test("the production CSP permits only same-origin dedicated workers", async () => {
  const policy = await readProductionContentSecurityPolicy();
  const workerSources = parseDirective(policy, "worker-src");

  expect(workerSources).toEqual(["'self'"]);
  expect(policy).not.toContain("blob:");
});

test("a generated data file above fflate's async threshold compresses in a real browser", async ({
  page,
}) => {
  const policy = await readProductionContentSecurityPolicy();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.addInitScript(() => {
    const workerUrls: string[] = [];
    const workerMessages: Array<{
      type: string;
      completedFiles?: number;
      final?: boolean;
      totalFiles?: number;
    }> = [];
    const NativeWorker = window.Worker;
    const ObservedWorker = new Proxy(NativeWorker, {
      construct(target, argumentsList) {
        workerUrls.push(String(argumentsList[0]));
        const worker = Reflect.construct(target, argumentsList) as Worker;
        worker.addEventListener("message", (event) => {
          const message = event.data as {
            type?: unknown;
            completedFiles?: unknown;
            final?: unknown;
            totalFiles?: unknown;
          };
          workerMessages.push({
            type: typeof message.type === "string" ? message.type : "unknown",
            completedFiles:
              typeof message.completedFiles === "number" ? message.completedFiles : undefined,
            final: typeof message.final === "boolean" ? message.final : undefined,
            totalFiles: typeof message.totalFiles === "number" ? message.totalFiles : undefined,
          });
        });
        return worker;
      },
    });

    Object.defineProperties(window, {
      Worker: { configurable: true, value: ObservedWorker },
      __poapinObservedWorkerMessages: { value: workerMessages },
      __poapinObservedWorkerUrls: { value: workerUrls },
    });
  });
  await page.route(`**${HARNESS_PATH}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "Content-Security-Policy": policy },
      body: "<!doctype html><title>Portable site ZIP browser harness</title>",
    });
  });
  await page.goto(HARNESS_PATH);

  const outcome = await page.evaluate(
    async ({ dataFileBytes, moduleUrl }) => {
      const zipModule = (await import(moduleUrl)) as PortableSiteZipModule;
      const source = new TextEncoder().encode(
        `globalThis.__POAPIN_TRANSPORT__?.push("${"A".repeat(dataFileBytes)}");`,
      );
      const index = new TextEncoder().encode("<!doctype html><title>Portable POAP</title>");
      const compression = zipModule
        .createPortableSiteZip(
          new Map([
            ["data/drops-0001.data.js", source],
            ["index.html", index],
          ]),
          "2026-07-24T00:00:00.000Z",
          new AbortController().signal,
        )
        .then(async (result) => {
          const bytes = new Uint8Array(await result.blob.arrayBuffer());
          const binaryChunks: string[] = [];
          for (let offset = 0; offset < bytes.length; offset += 32_768) {
            binaryChunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
          }
          return {
            status: "completed" as const,
            blobBytes: result.blob.size,
            fileCount: result.fileCount,
            indexBytes: index.byteLength,
            signature: Array.from(bytes.subarray(0, 4)),
            sourceBytes: source.byteLength,
            uncompressedBytes: result.uncompressedBytes,
            zipBase64: btoa(binaryChunks.join("")),
          };
        })
        .catch((error: unknown) => ({
          status: "failed" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
      const timeout = new Promise<{ status: "timed-out" }>((resolve) => {
        window.setTimeout(() => resolve({ status: "timed-out" }), 8_000);
      });
      const result = await Promise.race([compression, timeout]);
      const workerUrls = [
        ...(window as typeof window & { __poapinObservedWorkerUrls: string[] })
          .__poapinObservedWorkerUrls,
      ];
      const workerMessages = [
        ...(
          window as typeof window & {
            __poapinObservedWorkerMessages: Array<{
              type: string;
              completedFiles?: number;
              final?: boolean;
              totalFiles?: number;
            }>;
          }
        ).__poapinObservedWorkerMessages,
      ];

      return { ...result, workerMessages, workerUrls };
    },
    {
      dataFileBytes: LARGE_DATA_FILE_BYTES,
      moduleUrl: new URL("/src/react-app/portable-site-zip.ts", "http://127.0.0.1:4173").href,
    },
  );

  expect(outcome).toMatchObject({
    status: "completed",
    fileCount: 2,
    signature: [0x50, 0x4b, 0x03, 0x04],
  });
  if (outcome.status !== "completed") return;
  expect(outcome.sourceBytes).toBeGreaterThan(160_000);
  expect(outcome.uncompressedBytes).toBe(outcome.sourceBytes + outcome.indexBytes);
  expect(outcome.blobBytes).toBeGreaterThan(0);
  expect(outcome.workerUrls.length).toBeGreaterThan(0);
  for (const workerUrl of outcome.workerUrls) {
    expect(workerUrl.startsWith("blob:")).toBe(false);
    expect(new URL(workerUrl, page.url()).origin).toBe(new URL(page.url()).origin);
  }
  expect(outcome.workerMessages.filter(({ type }) => type === "ready")).toHaveLength(1);
  expect(
    outcome.workerMessages
      .filter(({ type }) => type === "progress")
      .map(({ completedFiles, totalFiles }) => ({ completedFiles, totalFiles })),
  ).toEqual([
    { completedFiles: 1, totalFiles: 2 },
    { completedFiles: 2, totalFiles: 2 },
  ]);
  expect(
    outcome.workerMessages.filter(({ type, final }) => type === "chunk" && final),
  ).toHaveLength(1);

  const archive = unzipSync(new Uint8Array(Buffer.from(outcome.zipBase64, "base64")));
  expect(Object.keys(archive).sort()).toEqual(["data/drops-0001.data.js", "index.html"]);
  expect(archive["data/drops-0001.data.js"]?.byteLength).toBe(outcome.sourceBytes);
  expect(strFromU8(archive["index.html"]!)).toBe("<!doctype html><title>Portable POAP</title>");
  expect(browserErrors).toEqual([]);
});

async function readProductionContentSecurityPolicy(): Promise<string> {
  const headers = await readFile("public/_headers", "utf8");
  const line = headers
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith("Content-Security-Policy:"));
  if (!line) throw new Error("public/_headers must define Content-Security-Policy.");
  return line.slice(line.indexOf(":") + 1).trim();
}

function parseDirective(policy: string, name: string): string[] | undefined {
  const directive = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return directive?.split(/\s+/u).slice(1);
}
