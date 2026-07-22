import { useEffect, useMemo, useRef, useState } from "react";
import { getCollections } from "../api";
import { CollectionCard } from "../components/CollectionCard";
import { EmptyState, ErrorState } from "../components/States";
import { ArrowIcon, SearchIcon } from "../icons";
import type { CollectionSummary, CollectionType } from "../types";
import { isAbortError } from "../utils";

export function CollectionsPage() {
  const initial = useMemo(readCollectionsState, []);
  const [query, setQuery] = useState(initial.query);
  const [yearInput, setYearInput] = useState(initial.year ? String(initial.year) : "");
  const [collectionType, setCollectionType] = useState<CollectionType>(initial.collectionType);
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 320);
  const year = readYear(yearInput);
  const searchIssue = validateSearch(debouncedQuery);
  const yearIssue = validateYear(yearInput);
  const filterIssue = searchIssue || yearIssue;
  const hasFilters = Boolean(query || yearInput || collectionType !== "all");

  useEffect(() => {
    const syncFromHistory = () => {
      if (
        window.location.pathname !== "/collections" &&
        window.location.pathname !== "/collections/"
      )
        return;
      const next = readCollectionsState();
      setQuery(next.query);
      setYearInput(next.year ? String(next.year) : "");
      setCollectionType(next.collectionType);
    };
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  useEffect(() => () => loadMoreController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    setItems([]);
    setCursor(null);

    syncCollectionsQueryString({ q: debouncedQuery, year, collectionType });
    if (filterIssue) {
      setLoading(false);
      return () => controller.abort();
    }

    getCollections(
      {
        q: debouncedQuery || undefined,
        year: year || undefined,
        type: collectionType,
        limit: 24,
      },
      controller.signal,
    )
      .then((response) => {
        setItems(response.items);
        setCursor(response.nextCursor);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown Collections archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [collectionType, debouncedQuery, filterIssue, retry, year, yearInput]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getCollections(
        {
          q: debouncedQuery || undefined,
          year: year || undefined,
          type: collectionType,
          cursor,
          limit: 24,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Could not load more collections");
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  const clearFilters = () => {
    setQuery("");
    setYearInput("");
    setCollectionType("all");
  };

  return (
    <main className="collections-page" id="main-content" tabIndex={-1}>
      <section className="collections-hero shell">
        <div className="collections-hero__copy">
          <span className="eyebrow">Curated histories, preserved</span>
          <h1>
            POAPs gather into
            <br />
            <em>living collections.</em>
          </h1>
          <p>
            Browse the public POAP Collections snapshot by artist, organization, community, or
            year—and take any collection with you as open JSON.
          </p>
        </div>

        <div className="collections-hero__search glass-panel">
          <label htmlFor="collection-search">Search Collections</label>
          <div className="search-input">
            <SearchIcon />
            <input
              id="collection-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, description, or slug"
              maxLength={64}
              autoComplete="off"
              aria-describedby="collection-search-hint"
              aria-invalid={searchIssue ? "true" : undefined}
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                ×
              </button>
            ) : null}
          </div>
          <span className="search-hint" id="collection-search-hint">
            Use up to five words, with at least two characters per word.
          </span>
        </div>
      </section>

      <section className="collections-browser shell" aria-labelledby="collections-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Collections hub</span>
            <h2 id="collections-heading">
              {debouncedQuery ? `Results for “${debouncedQuery}”` : "Explore curated POAP stories"}
            </h2>
          </div>
          <span className="result-count" aria-live="polite">
            {loading ? "Loading…" : `${items.length}${cursor ? "+" : ""} shown`}
          </span>
        </div>

        <div className="collection-filters glass-panel">
          <label>
            <span>Collection type</span>
            <select
              value={collectionType}
              onChange={(event) => setCollectionType(event.target.value as CollectionType)}
            >
              <option value="all">All collections</option>
              <option value="artist">Artist</option>
              <option value="organization">Organization</option>
              <option value="user">User</option>
            </select>
          </label>
          <label>
            <span>Year</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              placeholder="All years"
              value={yearInput}
              onChange={(event) => setYearInput(event.target.value.replace(/\D/g, "").slice(0, 4))}
              aria-label="Collection year"
              aria-invalid={yearIssue ? "true" : undefined}
            />
          </label>
          {hasFilters ? (
            <button className="filter-reset" type="button" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
        </div>

        {loading ? <CollectionGridSkeleton /> : null}
        {!loading && error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && filterIssue ? (
          <EmptyState title="Refine the filters">{filterIssue}</EmptyState>
        ) : null}
        {!loading && !error && !filterIssue && items.length === 0 ? (
          <EmptyState title="No collections found">
            Try a broader search, another year, or clear the filters.
          </EmptyState>
        ) : null}
        {items.length > 0 ? (
          <div className="collection-grid">
            {items.map((collection, index) => (
              <CollectionCard
                collection={collection}
                priority={index < 2}
                key={collection.collectionId}
              />
            ))}
          </div>
        ) : null}
        {error && items.length > 0 ? <ErrorState message={error} /> : null}
        {cursor ? (
          <div className="load-more">
            <button
              className="button button--outline"
              type="button"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Explore more collections"}
              <ArrowIcon />
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function CollectionGridSkeleton() {
  return (
    <div
      className="collection-grid"
      role="status"
      aria-label="Loading Collections"
      aria-busy="true"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div className="collection-skeleton" key={index}>
          <span className="skeleton collection-skeleton__banner" />
          <span className="skeleton collection-skeleton__logo" />
          <span className="skeleton collection-skeleton__title" />
          <span className="skeleton collection-skeleton__line" />
        </div>
      ))}
    </div>
  );
}

function useDebouncedValue<T>(value: T, wait: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), wait);
    return () => window.clearTimeout(timeout);
  }, [value, wait]);
  return debounced;
}

function validateSearch(value: string): string {
  if (!value) return "";
  const terms = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return "Search for letters or numbers.";
  if (terms.length > 5) return "Search supports up to five words.";
  if (terms.some((term) => term.length < 2))
    return "Each search word needs at least two characters.";
  if (terms.some((term) => term.length > 32))
    return "Each search word can be at most 32 characters.";
  return "";
}

function asCollectionType(value: string | null): CollectionType {
  return value === "artist" || value === "organization" || value === "user" ? value : "all";
}

function readYear(value: string): number {
  if (!/^\d{4}$/.test(value)) return 0;
  const year = Number(value);
  return year >= 1900 && year <= 2200 ? year : 0;
}

function validateYear(value: string): string {
  if (!value) return "";
  return readYear(value) ? "" : "Enter a four-digit year from 1900 to 2200.";
}

function readCollectionsState() {
  const params = new URLSearchParams(window.location.search);
  return {
    query: (params.get("q") ?? "").trim().slice(0, 64),
    year: readYear(params.get("year") ?? ""),
    collectionType: asCollectionType(params.get("type")),
  };
}

function syncCollectionsQueryString(values: {
  q: string;
  year: number;
  collectionType: CollectionType;
}) {
  const params = new URLSearchParams();
  if (values.q) params.set("q", values.q);
  if (values.year) params.set("year", String(values.year));
  if (values.collectionType !== "all") params.set("type", values.collectionType);
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
