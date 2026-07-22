import type { DropCursor, DropSort, DropsQuery, EventType, OwnerCursor, OwnerQuery } from "./types";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SOURCE_UID = /^[A-Za-z0-9:_-]{1,128}$/;
const SEARCH_TERM = /[\p{L}\p{N}]+/gu;
const DROP_PARAMS = new Set(["q", "year", "type", "sort", "cursor", "limit"]);
const OWNER_PARAMS = new Set(["cursor", "limit"]);
const SORTS = new Set<DropSort>(["recent", "oldest", "popular"]);
const EVENT_TYPES = new Set<EventType>(["all", "virtual", "in-person"]);

export type ApiStatus = 400 | 404 | 413 | 503;

export class ApiError extends Error {
  constructor(
    readonly status: ApiStatus,
    message: string,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function assertNoQuery(url: URL): void {
  let hasParameter = false;
  url.searchParams.forEach(() => {
    hasParameter = true;
  });
  if (hasParameter) {
    throw new ApiError(400, "This endpoint does not accept query parameters.");
  }
}

export function parseDropId(raw: string): number {
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new ApiError(400, "Drop ID must be a positive integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(400, "Drop ID is outside the supported range.");
  }
  return value;
}

export function normalizeAddress(raw: string): string {
  if (!ADDRESS.test(raw)) {
    throw new ApiError(400, "Enter an exact 0x-prefixed, 40-character address.");
  }
  return raw.toLowerCase();
}

export function parseDropsQuery(url: URL, snapshotId: string): DropsQuery {
  assertKnownParams(url.searchParams, DROP_PARAMS);

  const rawQuery = optionalParam(url.searchParams, "q");
  const search = rawQuery === null ? null : normalizeSearch(rawQuery);
  const year = parseOptionalInteger(url.searchParams, "year", 1900, 2100);
  const type = parseEnum(url.searchParams, "type", EVENT_TYPES, "all");
  const sort = parseEnum(url.searchParams, "sort", SORTS, "recent");
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({ q: search?.text ?? "", year, type, sort, limit });

  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateDropCursor(decodeCursor<DropCursor>(rawCursor), snapshotId, filterKey, sort);

  const canonical = new URLSearchParams();
  if (search) canonical.set("q", search.text);
  if (year !== null) canonical.set("year", String(year));
  if (type !== "all") canonical.set("type", type);
  if (sort !== "recent") canonical.set("sort", sort);
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));

  return {
    q: search?.text ?? null,
    ftsQuery: search?.ftsQuery ?? null,
    year,
    type,
    sort,
    limit,
    cursor,
    filterKey,
    canonicalSearch: canonical.toString(),
  };
}

export function parseOwnerQuery(url: URL, rawAddress: string, snapshotId: string): OwnerQuery {
  assertKnownParams(url.searchParams, OWNER_PARAMS);
  const address = normalizeAddress(rawAddress);
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({ address, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateOwnerCursor(decodeCursor<OwnerCursor>(rawCursor), snapshotId, filterKey);

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));

  return { address, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function encodeCursor(value: DropCursor | OwnerCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor<T>(raw: string): T {
  if (raw.length < 8 || raw.length > 768 || !BASE64URL.test(raw)) {
    throw new ApiError(400, "Cursor is invalid.");
  }
  try {
    const padded = raw
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(raw.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new ApiError(400, "Cursor is invalid.");
  }
}

function validateDropCursor(
  cursor: DropCursor,
  snapshotId: string,
  filterKey: string,
  sort: DropSort,
): DropCursor {
  const validCommon =
    isObject(cursor) &&
    cursor.v === 1 &&
    cursor.s === snapshotId &&
    cursor.f === filterKey &&
    Number.isInteger(cursor.p) &&
    cursor.p >= 2 &&
    cursor.p <= 10_000 &&
    Number.isSafeInteger(cursor.i) &&
    cursor.i > 0;
  const validKey =
    sort === "popular"
      ? Number.isSafeInteger(cursor.k) && Number(cursor.k) >= 0
      : typeof cursor.k === "string" &&
        cursor.k.length > 0 &&
        cursor.k.length <= 64 &&
        !/[\u0000-\u001f]/.test(cursor.k);
  if (!validCommon || !validKey) {
    throw new ApiError(400, "Cursor does not belong to this query or snapshot.");
  }
  return cursor;
}

function validateOwnerCursor(
  cursor: OwnerCursor,
  snapshotId: string,
  filterKey: string,
): OwnerCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isSafeInteger(cursor.p) ||
    cursor.p < 0 ||
    !SOURCE_UID.test(cursor.u)
  ) {
    throw new ApiError(400, "Cursor does not belong to this address or snapshot.");
  }
  return cursor;
}

function normalizeSearch(raw: string): { text: string; ftsQuery: string } {
  const text = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (text.length === 0 || text.length > 64) {
    throw new ApiError(400, "Search must contain between 1 and 64 characters.");
  }
  const terms = text.match(SEARCH_TERM) ?? [];
  if (
    terms.length === 0 ||
    terms.length > 5 ||
    terms.some((term) => term.length < 2 || term.length > 32)
  ) {
    throw new ApiError(400, "Search supports up to five words of 2 to 32 characters each.");
  }
  // Reconstructing the expression from letter/number-only terms prevents callers
  // from injecting FTS operators, leading wildcards, column filters, or NEAR scans.
  // Two-character terms use exact matching; broader prefixes start at three.
  const ftsQuery = terms.map((term) => `"${term}"${term.length >= 3 ? "*" : ""}`).join(" AND ");
  return { text, ftsQuery };
}

function assertKnownParams(params: URLSearchParams, allowed: ReadonlySet<string>): void {
  let unknownKey: string | null = null;
  params.forEach((_value, key) => {
    if (!allowed.has(key) && unknownKey === null) unknownKey = key;
  });
  if (unknownKey !== null) throw new ApiError(400, `Unknown query parameter: ${unknownKey}.`);
  for (const key of allowed) {
    if (params.getAll(key).length > 1)
      throw new ApiError(400, `Query parameter ${key} may only be provided once.`);
  }
}

function optionalParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value === null) return null;
  if (value.length === 0) throw new ApiError(400, `Query parameter ${key} cannot be empty.`);
  return value;
}

function parseLimit(params: URLSearchParams, fallback: number): number {
  const raw = optionalParam(params, "limit");
  if (raw === null) return fallback;
  if (!/^\d{1,2}$/.test(raw)) throw new ApiError(400, "Limit must be an integer from 1 to 48.");
  const value = Number(raw);
  if (value < 1 || value > 48) throw new ApiError(400, "Limit must be an integer from 1 to 48.");
  return value;
}

function parseOptionalInteger(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  const raw = optionalParam(params, key);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `Query parameter ${key} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(400, `Query parameter ${key} is outside the supported range.`);
  }
  return value;
}

function parseEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  values: ReadonlySet<T>,
  fallback: T,
): T {
  const raw = optionalParam(params, key);
  if (raw === null) return fallback;
  if (!values.has(raw as T)) throw new ApiError(400, `Query parameter ${key} is invalid.`);
  return raw as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
