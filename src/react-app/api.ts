import type {
  ArchiveMeta,
  CollectionDetailResponse,
  CollectionExportManifest,
  CollectionItemsPage,
  CollectionSummary,
  CollectionType,
  Drop,
  DropSort,
  EventType,
  OwnerPageResponse,
  PageResponse,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Keep the status-based fallback when an edge error is not JSON.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export function getMeta(signal?: AbortSignal) {
  return requestJson<ArchiveMeta>("/api/meta", signal);
}

export interface DropQuery {
  q?: string;
  year?: number;
  type?: EventType;
  sort?: DropSort;
  cursor?: string | null;
  limit?: number;
}

export function getDrops(query: DropQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q.trim());
  if (query.year) params.set("year", String(query.year));
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.sort && query.sort !== "recent") params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 48));
  return requestJson<PageResponse<Drop>>(`/api/drops?${params}`, signal);
}

export function getDrop(dropId: number, signal?: AbortSignal) {
  return requestJson<Drop>(`/api/drops/${dropId}`, signal);
}

export function getOwner(address: string, cursor?: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<OwnerPageResponse>(
    `/api/owners/${encodeURIComponent(address)}?${params}`,
    signal,
  );
}

export interface CollectionsQuery {
  q?: string;
  year?: number;
  type?: CollectionType;
  cursor?: string | null;
  limit?: number;
}

export function getCollections(query: CollectionsQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q.trim());
  if (query.year) params.set("year", String(query.year));
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 24));
  return requestJson<PageResponse<CollectionSummary>>(`/api/collections?${params}`, signal);
}

export function getCollection(collectionId: number, signal?: AbortSignal) {
  return requestJson<CollectionDetailResponse>(`/api/collections/${collectionId}`, signal);
}

export function getCollectionItems(
  collectionId: number,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "24" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<CollectionItemsPage>(
    `/api/collections/${collectionId}/items?${params}`,
    signal,
  );
}

export function getCollectionExportManifest(collectionId: number, signal?: AbortSignal) {
  return requestJson<CollectionExportManifest>(`/api/collections/${collectionId}/export`, signal);
}
