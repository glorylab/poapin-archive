import { artworkUrl } from "./media";
import {
  EXPORT_BATCH_SIZE,
  fetchExportCatalog,
  fetchExportHoldingBatch,
  safeExternalUrl,
} from "./repository";
import type { D1ReadClient, ExportCatalogRow, ExportRecord, HoldingRow } from "./types";

export const MAX_SYNC_EXPORT_RECORDS = 5_000;

type ExportFormat = "csv" | "json";

interface ExportOptions {
  format: ExportFormat;
  address: string;
  total: number;
  snapshotId: string;
  snapshotAt: string;
  holdingsDb: D1ReadClient;
  catalogDb: D1ReadClient;
  mediaBaseUrl: string;
}

const CSV_HEADER = [
  "snapshot_id",
  "snapshot_at",
  "queried_address",
  "source_uid",
  "poap_id",
  "drop_id",
  "title",
  "start_date",
  "end_date",
  "city",
  "country",
  "event_url",
  "network",
  "minted_on",
  "transfer_count",
  "artwork_url",
].join(",");

export function createExportResponse(options: ExportOptions): Response {
  const stream = createExportStream(options);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(options.snapshotAt)?.[0] ?? "snapshot";
  const contentType =
    options.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";

  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="poapin-${options.address}-${date}.${options.format}"`,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function createExportStream(options: ExportOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let started = false;
  let emitted = 0;
  let cursor: { poapId: number; sourceUid: string } | null = null;
  const catalogCache = new Map<number, ExportCatalogRow>();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        if (options.format === "csv") {
          controller.enqueue(encoder.encode(`\uFEFF${CSV_HEADER}\r\n`));
        } else {
          const envelope = JSON.stringify({
            schema_version: "poapin-address-export-v1",
            snapshot_id: options.snapshotId,
            snapshot_at: options.snapshotAt,
            generated_at: new Date().toISOString(),
            queried_address: options.address,
            count: options.total,
            notice:
              "Public onchain holdings recorded at a fixed archive snapshot; this is not live wallet data.",
          });
          controller.enqueue(encoder.encode(`${envelope.slice(0, -1)},"tokens":[`));
        }
        if (options.total === 0) {
          if (options.format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
        }
        return;
      }

      try {
        const holdings = await fetchExportHoldingBatch(options.holdingsDb, options.address, cursor);
        if (holdings.length === 0) {
          if (options.format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
          return;
        }

        const missingDropIds = holdings
          .map((holding) => holding.drop_id)
          .filter((dropId) => !catalogCache.has(dropId));
        const fetchedCatalog = await fetchExportCatalog(options.catalogDb, missingDropIds);
        for (const [dropId, drop] of fetchedCatalog) catalogCache.set(dropId, drop);
        const records = holdings.map((holding) =>
          toExportRecord(options, holding, catalogCache.get(holding.drop_id)),
        );
        const payload =
          options.format === "csv"
            ? records.map(toCsvRow).join("")
            : records
                .map(
                  (record, index) =>
                    `${emitted > 0 || index > 0 ? "," : ""}${JSON.stringify(record)}`,
                )
                .join("");
        controller.enqueue(encoder.encode(payload));
        emitted += holdings.length;

        const last = holdings.at(-1)!;
        cursor = { poapId: last.poap_id, sourceUid: last.source_uid };
        if (holdings.length < EXPORT_BATCH_SIZE || emitted >= options.total) {
          if (options.format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function toExportRecord(
  options: ExportOptions,
  holding: HoldingRow,
  drop: ExportCatalogRow | undefined,
): ExportRecord {
  return {
    snapshot_id: options.snapshotId,
    snapshot_at: options.snapshotAt,
    queried_address: options.address,
    source_uid: holding.source_uid,
    poap_id: holding.poap_id,
    drop_id: holding.drop_id,
    title: drop?.title ?? `Archived POAP #${holding.poap_id}`,
    start_date: drop?.start_date ?? "",
    end_date: drop?.end_date ?? "",
    city: drop?.city ?? null,
    country: drop?.country ?? null,
    event_url: safeExternalUrl(drop?.event_url ?? null),
    network: holding.network,
    minted_on: holding.minted_on,
    transfer_count: holding.transfer_count,
    artwork_url: numericArtworkAvailable(drop)
      ? artworkUrl(options.mediaBaseUrl, options.snapshotId, holding.drop_id)
      : null,
  };
}

function toCsvRow(record: ExportRecord): string {
  return (
    [
      record.snapshot_id,
      record.snapshot_at,
      record.queried_address,
      record.source_uid,
      record.poap_id,
      record.drop_id,
      record.title,
      record.start_date,
      record.end_date,
      record.city,
      record.country,
      record.event_url,
      record.network,
      record.minted_on,
      record.transfer_count,
      record.artwork_url,
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

function numericArtworkAvailable(drop: ExportCatalogRow | undefined): boolean {
  return drop !== undefined && Number(drop.has_artwork) === 1;
}

/** RFC 4180 quoting plus spreadsheet formula neutralization. */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
