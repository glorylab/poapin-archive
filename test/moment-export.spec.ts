import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getMomentAuthorExport } from "../src/react-app/api";
import {
  collectMomentAuthorExport,
  type MomentExportProgress,
} from "../src/react-app/moment-export";
import type { MomentAuthorExportPage, MomentDetail } from "../src/react-app/types";

const AUTHOR = "0x1111111111111111111111111111111111111111";

describe("Moment author export pacing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a 64-page export below sixty request starts per minute without skipping data", async () => {
    let now = 0;
    let request = 0;
    const requestStarts: number[] = [];
    const requestedCursors: Array<string | null> = [];
    const waits: number[] = [];

    const result = await collectMomentAuthorExport(
      AUTHOR.toUpperCase(),
      new AbortController().signal,
      () => undefined,
      {
        now: () => now,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
          now += milliseconds;
        },
        getPage: async (address, cursor) => {
          expect(address).toBe(AUTHOR);
          requestedCursors.push(cursor);
          requestStarts.push(now);
          request += 1;
          return page(request < 64 ? `cursor-${request}` : null, {
            items: [moment(request)],
          });
        },
      },
    );

    expect(result.items.map((item) => item.momentId)).toEqual(
      Array.from({ length: 64 }, (_, index) => moment(index + 1).momentId),
    );
    expect(requestedCursors).toEqual([
      null,
      ...Array.from({ length: 63 }, (_, index) => `cursor-${index + 1}`),
    ]);
    expect(requestStarts).toHaveLength(64);
    expect(waits).toHaveLength(63);
    expect(waits.every((milliseconds) => milliseconds === 1_100)).toBe(true);
    for (const startedAt of requestStarts) {
      expect(
        requestStarts.filter((value) => value >= startedAt && value < startedAt + 60_000).length,
      ).toBeLessThan(60);
    }
  });

  it("honors Retry-After and resumes the same page without losing progress", async () => {
    let now = 0;
    let attempts = 0;
    const requestedCursors: Array<string | null> = [];
    const waits: number[] = [];
    const progress: MomentExportProgress[] = [];

    const result = await collectMomentAuthorExport(
      AUTHOR,
      new AbortController().signal,
      (value) => progress.push(value),
      {
        now: () => now,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
          now += milliseconds;
        },
        getPage: async (_address, cursor) => {
          requestedCursors.push(cursor);
          attempts += 1;
          if (cursor === null) return page("cursor-1", { items: [moment(1)] });
          if (attempts === 2) throw new ApiError(429, "rate limited", 7_000);
          return page(null, { items: [moment(2)] });
        },
      },
    );

    expect(attempts).toBe(3);
    expect(requestedCursors).toEqual([null, "cursor-1", "cursor-1"]);
    expect(result.items.map((item) => item.momentId)).toEqual([
      moment(1).momentId,
      moment(2).momentId,
    ]);
    expect(waits).toEqual([1_100, 7_000]);
    expect(progress).toEqual([
      { pages: 1, records: 1 },
      { pages: 1, records: 1, retryAfterSeconds: 7 },
      { pages: 2, records: 2 },
    ]);
  });

  it("uses a safe minimum interval and a conservative fallback for 429 responses", async () => {
    let now = 0;
    let attempts = 0;
    const waits: number[] = [];

    await collectMomentAuthorExport(AUTHOR, new AbortController().signal, () => undefined, {
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      getPage: async () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError(429, "short retry", 250);
        if (attempts === 2) throw new ApiError(429, "missing retry");
        return page(null);
      },
    });

    expect(waits).toEqual([1_100, 60_000]);
  });

  it("parses numeric and HTTP-date Retry-After response headers", async () => {
    const now = Date.parse("2026-07-23T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimitedResponse("2.5"))
      .mockResolvedValueOnce(rateLimitedResponse("Thu, 23 Jul 2026 00:00:05 GMT"));

    await expect(getMomentAuthorExport(AUTHOR)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 2_500,
    });
    await expect(getMomentAuthorExport(AUTHOR)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 5_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Moment author export consistency", () => {
  it("stops before accepting a page that changes the immutable snapshot", async () => {
    const progress: MomentExportProgress[] = [];
    let request = 0;

    await expect(
      collectMomentAuthorExport(
        AUTHOR,
        new AbortController().signal,
        (value) => progress.push(value),
        immediateRuntime(async () => {
          request += 1;
          return request === 1
            ? page("cursor-1", { items: [moment(1)] })
            : page(null, { snapshotId: "moments-other", items: [moment(2)] });
        }),
      ),
    ).rejects.toThrow("snapshot changed");
    expect(progress).toEqual([{ pages: 1, records: 1 }]);
  });

  it("stops before accepting a page that repeats a cursor", async () => {
    const progress: MomentExportProgress[] = [];
    const requestedCursors: Array<string | null> = [];

    await expect(
      collectMomentAuthorExport(
        AUTHOR,
        new AbortController().signal,
        (value) => progress.push(value),
        immediateRuntime(async (_address, cursor) => {
          requestedCursors.push(cursor);
          return cursor === null
            ? page("cursor-1", { items: [moment(1)] })
            : page("cursor-1", { items: [moment(2)] });
        }),
      ),
    ).rejects.toThrow("cursor repeated");
    expect(requestedCursors).toEqual([null, "cursor-1"]);
    expect(progress).toEqual([{ pages: 1, records: 1 }]);
  });

  it.each([
    [
      "schema",
      { schemaVersion: "unexpected-schema" as MomentAuthorExportPage["schemaVersion"] },
      "schema changed",
    ],
    ["snapshot", { snapshotId: "" }, "did not identify its snapshot"],
    ["author", { author: "0x2222222222222222222222222222222222222222" }, "author changed"],
  ])("rejects an invalid %s before reporting page progress", async (_label, overrides, message) => {
    const progress: MomentExportProgress[] = [];
    await expect(
      collectMomentAuthorExport(
        AUTHOR,
        new AbortController().signal,
        (value) => progress.push(value),
        immediateRuntime(async () => page(null, overrides)),
      ),
    ).rejects.toThrow(message);
    expect(progress).toEqual([]);
  });
});

describe("Moment author export cancellation", () => {
  it("does not start a request for a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;

    await expect(
      collectMomentAuthorExport(
        AUTHOR,
        controller.signal,
        () => undefined,
        immediateRuntime(async () => {
          requests += 1;
          return page(null);
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);
  });

  it("discards a final page when its request aborts before returning", async () => {
    const controller = new AbortController();
    const progress: MomentExportProgress[] = [];

    await expect(
      collectMomentAuthorExport(
        AUTHOR,
        controller.signal,
        (value) => progress.push(value),
        immediateRuntime(async () => {
          controller.abort();
          return page(null, { items: [moment(1)] });
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toEqual([]);
  });

  it("does not return or download after cancellation from final-page progress", async () => {
    const controller = new AbortController();

    await expect(
      collectMomentAuthorExport(
        AUTHOR,
        controller.signal,
        () => controller.abort(),
        immediateRuntime(async () => page(null, { items: [moment(1)] })),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

function immediateRuntime(
  getPage: (
    address: string,
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<MomentAuthorExportPage>,
) {
  let now = 0;
  return {
    now: () => now,
    wait: async (milliseconds: number) => {
      now += milliseconds;
    },
    getPage,
  };
}

function page(
  nextCursor: string | null,
  overrides: Partial<MomentAuthorExportPage> = {},
): MomentAuthorExportPage {
  return {
    schemaVersion: "poapin-moment-author-export-v1",
    snapshotId: "moments-test",
    author: AUTHOR,
    items: [],
    nextCursor,
    ...overrides,
  };
}

function moment(index: number): MomentDetail {
  return {
    momentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    displayId: `moment-${index}`,
    author: AUTHOR,
    description: null,
    createdOn: "2026-07-23T00:00:00.000Z",
    updatedOn: null,
    isUpdated: false,
    sourceMediaCount: 0,
    mediaCount: 0,
    mediaPreservationState: "none",
    previewMedia: null,
    dropIds: [],
    collectionIds: [],
    cid: null,
    tokenId: null,
    media: [],
    links: [],
    userTags: [],
    capsules: [],
  };
}

function rateLimitedResponse(retryAfter: string) {
  return new Response(JSON.stringify({ error: "rate limited" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": retryAfter,
    },
  });
}
