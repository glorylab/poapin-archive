import { ApiError, getMomentAuthorExport } from "./api";
import type { MomentAuthorExportPage, MomentDetail } from "./types";

export type MomentExportFormat = "json" | "csv";

export interface MomentExportProgress {
  pages: number;
  records: number;
  retryAfterSeconds?: number;
}

export interface MomentExportRelease {
  snapshotId: string;
  releaseId: string;
  sourceDatabaseSha256: string;
  buildManifestSha256: string;
}

interface MomentExportRuntime {
  getPage(
    address: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<MomentAuthorExportPage>;
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const PAGE_INTERVAL_MS = 1_100;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 5;

const browserRuntime: MomentExportRuntime = {
  getPage: getMomentAuthorExport,
  now: Date.now,
  wait: abortableWait,
};

export async function collectMomentAuthorExport(
  address: string,
  signal: AbortSignal,
  onProgress: (progress: MomentExportProgress) => void,
  runtime: MomentExportRuntime = browserRuntime,
) {
  const normalizedAddress = address.toLowerCase();
  const items: MomentDetail[] = [];
  const momentIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let release: MomentExportRelease | null = null;
  let pages = 0;
  let lastRequestStartedAt: number | null = null;

  do {
    signal.throwIfAborted();
    if (lastRequestStartedAt !== null) {
      await runtime.wait(
        Math.max(0, PAGE_INTERVAL_MS - (runtime.now() - lastRequestStartedAt)),
        signal,
      );
    }

    let rateLimitRetries = 0;
    let page: MomentAuthorExportPage;
    for (;;) {
      signal.throwIfAborted();
      lastRequestStartedAt = runtime.now();
      try {
        page = await runtime.getPage(normalizedAddress, cursor, signal);
        signal.throwIfAborted();
        break;
      } catch (cause) {
        if (
          !(cause instanceof ApiError) ||
          cause.status !== 429 ||
          rateLimitRetries >= MAX_RATE_LIMIT_RETRIES
        ) {
          throw cause;
        }
        rateLimitRetries += 1;
        const retryAfterMs = Math.max(
          cause.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
          PAGE_INTERVAL_MS,
        );
        onProgress({
          pages,
          records: items.length,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1_000),
        });
        await runtime.wait(retryAfterMs, signal);
      }
    }

    if (page.schemaVersion !== "poapin-moment-author-export-v1") {
      throw new Error("The export schema changed; please refresh the archive and try again.");
    }
    if (page.author.toLowerCase() !== normalizedAddress) {
      throw new Error("The export author changed between pages; the download was stopped safely.");
    }
    const pageRelease = momentExportRelease(page);
    if (!pageRelease) {
      throw new Error("The export page did not identify its release; the download was stopped.");
    }
    if (release && !sameMomentExportRelease(pageRelease, release)) {
      throw new Error(
        "The archive release changed during export; please start the download again.",
      );
    }
    if (page.nextCursor && seenCursors.has(page.nextCursor)) {
      throw new Error("The export cursor repeated; the download was stopped safely.");
    }

    release ??= pageRelease;
    for (const item of page.items) {
      if (!item.momentId || momentIds.has(item.momentId)) {
        throw new Error("The export repeated a Moment; the download was stopped safely.");
      }
      momentIds.add(item.momentId);
      items.push(item);
    }
    pages += 1;
    onProgress({ pages, records: items.length });
    signal.throwIfAborted();

    if (page.nextCursor) seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);

  signal.throwIfAborted();
  if (!release) throw new Error("The export did not return a release identity.");
  return { normalizedAddress, snapshotId: release.snapshotId, release, items };
}

export async function downloadMomentAuthorExport(
  address: string,
  format: MomentExportFormat,
  signal: AbortSignal,
  onProgress: (progress: MomentExportProgress) => void,
) {
  const { normalizedAddress, snapshotId, release, items } = await collectMomentAuthorExport(
    address,
    signal,
    onProgress,
  );
  signal.throwIfAborted();
  const filename = `poapin-moments-${normalizedAddress}.${format}`;
  if (format === "json") {
    const payload = {
      schemaVersion: "poapin-moment-author-browser-export-v1",
      snapshotId,
      release,
      author: normalizedAddress,
      exportedAt: new Date().toISOString(),
      count: items.length,
      items,
    };
    saveBlob(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    return items.length;
  }

  saveBlob(filename, toCsv(items, snapshotId), "text/csv;charset=utf-8");
  return items.length;
}

function momentExportRelease(page: MomentAuthorExportPage): MomentExportRelease | null {
  if (
    !page.snapshotId ||
    !page.releaseId ||
    !/^[0-9a-f]{64}$/.test(page.sourceDatabaseSha256) ||
    !/^[0-9a-f]{64}$/.test(page.buildManifestSha256)
  ) {
    return null;
  }
  return {
    snapshotId: page.snapshotId,
    releaseId: page.releaseId,
    sourceDatabaseSha256: page.sourceDatabaseSha256,
    buildManifestSha256: page.buildManifestSha256,
  };
}

function sameMomentExportRelease(left: MomentExportRelease, right: MomentExportRelease): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.releaseId === right.releaseId &&
    left.sourceDatabaseSha256 === right.sourceDatabaseSha256 &&
    left.buildManifestSha256 === right.buildManifestSha256
  );
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });

    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted() {
      window.clearTimeout(timeout);
      reject(signal.reason);
    }
  });
}

function toCsv(items: MomentDetail[], snapshotId: string) {
  const headings = [
    "snapshot_id",
    "moment_id",
    "display_id",
    "author",
    "description",
    "created_on",
    "updated_on",
    "is_updated",
    "cid",
    "token_id",
    "source_media_count",
    "media_count",
    "media_preservation_state",
    "media_ids",
    "media_kinds",
    "media_mime_types",
    "media_urls",
    "media_byte_lengths",
    "media_duration_ms",
    "media_widths",
    "media_heights",
    "media_positions",
    "drop_ids",
    "collection_ids",
    "link_urls",
    "link_titles",
    "tagged_addresses",
    "tagged_ens",
    "capsule_ids",
    "capsule_external_ids",
    "capsule_titles",
    "capsule_urls",
  ];
  const rows = items.map((moment) => [
    snapshotId,
    moment.momentId,
    moment.displayId ?? "",
    moment.author ?? "",
    moment.description ?? "",
    moment.createdOn,
    moment.updatedOn ?? "",
    moment.isUpdated,
    moment.cid ?? "",
    moment.tokenId ?? "",
    moment.sourceMediaCount,
    moment.mediaCount,
    moment.mediaPreservationState,
    moment.media.map((media) => media.mediaId).join(" | "),
    moment.media.map((media) => media.kind).join(" | "),
    moment.media.map((media) => media.mimeType ?? "").join(" | "),
    moment.media.map((media) => media.url).join(" | "),
    moment.media.map((media) => media.byteLength ?? "").join(" | "),
    moment.media.map((media) => media.durationMs ?? "").join(" | "),
    moment.media.map((media) => media.width ?? "").join(" | "),
    moment.media.map((media) => media.height ?? "").join(" | "),
    moment.media.map((media) => media.position).join(" | "),
    moment.dropIds.join(" | "),
    moment.collectionIds.join(" | "),
    moment.links
      .map((link) => link.url)
      .filter(Boolean)
      .join(" | "),
    moment.links.map((link) => link.title ?? "").join(" | "),
    moment.userTags
      .map((tag) => tag.address)
      .filter(Boolean)
      .join(" | "),
    moment.userTags.map((tag) => tag.ens ?? "").join(" | "),
    moment.capsules.map((capsule) => capsule.capsuleId).join(" | "),
    moment.capsules.map((capsule) => capsule.externalId ?? "").join(" | "),
    moment.capsules.map((capsule) => capsule.title ?? "").join(" | "),
    moment.capsules.map((capsule) => capsule.url ?? "").join(" | "),
  ]);

  return `\uFEFF${[headings, ...rows]
    .map((row) => row.map((value) => csvCell(String(value))).join(","))
    .join("\r\n")}\r\n`;
}

function csvCell(value: string) {
  const spreadsheetSafe = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

function saveBlob(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
