import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createPortableSiteZip } from "../src/react-app/portable-site-zip";

const encoder = new TextEncoder();

describe("portable site ZIP", () => {
  it("compresses the exact generated file map without a server round trip", async () => {
    const files = new Map<string, Uint8Array>([
      ["index.html", encoder.encode("<!doctype html><title>POAP</title>")],
      ["data/holdings-0001.json", encoder.encode('{"items":[1,2,3]}\n')],
    ]);
    const progress: Array<{ completedFiles: number; totalFiles: number }> = [];
    const result = await createPortableSiteZip(
      files,
      "2026-07-23T00:00:00.000Z",
      new AbortController().signal,
      (update) => progress.push(update),
    );
    expect(result.fileCount).toBe(2);
    expect(result.uncompressedBytes).toBe(
      [...files.values()].reduce((total, value) => total + value.byteLength, 0),
    );
    expect(result.blob.type).toBe("application/zip");

    const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(archive).sort()).toEqual(["data/holdings-0001.json", "index.html"]);
    expect(strFromU8(archive["index.html"]!)).toContain("<title>POAP</title>");
    expect(progress).toEqual([
      { completedFiles: 1, totalFiles: 2 },
      { completedFiles: 2, totalFiles: 2 },
    ]);
  });

  it("rejects traversal paths and Cloudflare Drop's strict package limits", async () => {
    const signal = new AbortController().signal;
    await expect(
      createPortableSiteZip(
        new Map([["../secret.txt", encoder.encode("no")]]),
        "2026-07-23T00:00:00.000Z",
        signal,
      ),
    ).rejects.toThrow("unsafe path");
    await expect(
      createPortableSiteZip(
        new Map([["large.bin", new Uint8Array(5 * 1024 * 1024 + 1)]]),
        "2026-07-23T00:00:00.000Z",
        signal,
      ),
    ).rejects.toThrow("5 MiB");
    await expect(
      createPortableSiteZip(
        new Map(
          Array.from({ length: 1_001 }, (_, index) => [`data/${index}.json`, encoder.encode("{}")]),
        ),
        "2026-07-23T00:00:00.000Z",
        signal,
      ),
    ).rejects.toThrow("1,000 files");
  });

  it("does no work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createPortableSiteZip(
        new Map([["index.html", encoder.encode("cancelled")]]),
        "2026-07-23T00:00:00.000Z",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops safely when cancellation arrives between files", async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    await expect(
      createPortableSiteZip(
        new Map([
          ["data/one.json", encoder.encode('{"item":1}\n')],
          ["data/two.json", encoder.encode('{"item":2}\n')],
        ]),
        "2026-07-23T00:00:00.000Z",
        controller.signal,
        ({ completedFiles }) => {
          progress.push(completedFiles);
          controller.abort();
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toEqual([1]);
  });
});
