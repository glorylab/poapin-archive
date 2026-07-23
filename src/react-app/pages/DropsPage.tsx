import { useEffect, useMemo, useRef, useState } from "react";
import { getDrops } from "../api";
import { DropCard } from "../components/DropCard";
import { EmptyState, ErrorState, GridSkeleton } from "../components/States";
import { ArrowIcon, SearchIcon } from "../icons";
import type { ArchiveMeta, Drop, DropSort, EventType } from "../types";
import { isAbortError } from "../utils";

interface DropsPageProps {
  meta: ArchiveMeta | null;
}

export function DropsPage({ meta }: DropsPageProps) {
  const initial = useMemo(readBrowseState, []);
  const [query, setQuery] = useState(initial.query);
  const [year, setYear] = useState(initial.year);
  const [eventType, setEventType] = useState<EventType>(initial.eventType);
  const [sort, setSort] = useState<DropSort>(initial.sort);
  const [items, setItems] = useState<Drop[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 320);
  const queryTooShort = debouncedQuery.length === 1;

  useEffect(() => {
    const syncFromHistory = () => {
      if (window.location.pathname !== "/drops" && window.location.pathname !== "/drops/") return;
      const next = readBrowseState();
      setQuery(next.query);
      setYear(next.year);
      setEventType(next.eventType);
      setSort(next.sort);
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

    syncQueryString({ q: debouncedQuery, year, eventType, sort });
    if (queryTooShort) {
      setLoading(false);
      return () => controller.abort();
    }

    getDrops(
      {
        q: debouncedQuery || undefined,
        year: year || undefined,
        type: eventType,
        sort,
        limit: 48,
      },
      controller.signal,
    )
      .then((response) => {
        setItems(response.items);
        setCursor(response.nextCursor);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [debouncedQuery, eventType, queryTooShort, retry, sort, year]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getDrops(
        {
          q: debouncedQuery || undefined,
          year: year || undefined,
          type: eventType,
          sort,
          cursor,
          limit: 48,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Could not load more POAPs");
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  return (
    <main className="drops-page" id="main-content" tabIndex={-1}>
      <section className="drops-intro shell">
        <span className="eyebrow">The preserved catalog</span>
        <h1>Browse POAP Drops</h1>
        <p>
          Search the public snapshot by event, place, year, or format. Every result is read-only and
          exportable.
        </p>
      </section>

      <section className="archive-section drops-browser shell" aria-labelledby="archive-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">The collection</span>
            <h2 id="archive-heading">
              {debouncedQuery ? `Results for “${debouncedQuery}”` : "Browse preserved drops"}
            </h2>
          </div>
          <span className="result-count" aria-live="polite">
            {loading ? "Loading…" : `${items.length}${cursor ? "+" : ""} shown`}
          </span>
        </div>

        <div className="archive-search glass-panel">
          <label htmlFor="archive-search">Search drops</label>
          <div className="search-input">
            <SearchIcon />
            <input
              id="archive-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Event, city, or country"
              maxLength={64}
              autoComplete="off"
              aria-describedby="archive-search-hint"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                ×
              </button>
            ) : null}
          </div>
          <span className="search-hint" id="archive-search-hint">
            Use at least two characters. Results come from the preserved snapshot.
          </span>
        </div>

        <div className="filters glass-panel">
          <label>
            <span>Year</span>
            <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
              <option value={0}>All years</option>
              {(meta?.years ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Format</span>
            <select
              value={eventType}
              onChange={(event) => setEventType(event.target.value as EventType)}
            >
              <option value="all">All events</option>
              <option value="virtual">Virtual</option>
              <option value="in-person">In person</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as DropSort)}>
              <option value="recent">Most recent</option>
              <option value="oldest">Oldest first</option>
              <option value="popular">Most collected</option>
            </select>
          </label>
          {query || year || eventType !== "all" || sort !== "recent" ? (
            <button
              className="filter-reset"
              type="button"
              onClick={() => {
                setQuery("");
                setYear(0);
                setEventType("all");
                setSort("recent");
              }}
            >
              Reset
            </button>
          ) : null}
        </div>

        {loading ? <GridSkeleton /> : null}
        {!loading && error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && items.length === 0 ? (
          queryTooShort ? (
            <EmptyState title="Keep typing">Search terms need at least two characters.</EmptyState>
          ) : (
            <EmptyState title="No drops found">
              Try a broader search or clear one of the filters.
            </EmptyState>
          )
        ) : null}
        {items.length > 0 ? (
          <div className="drop-grid">
            {items.map((drop, index) => (
              <DropCard drop={drop} priority={index < 2} key={drop.dropId} />
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
              {loadingMore ? "Loading…" : "Explore more"}
              <ArrowIcon />
            </button>
          </div>
        ) : null}
      </section>
    </main>
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

function asEventType(value: string | null): EventType {
  return value === "virtual" || value === "in-person" ? value : "all";
}

function asSort(value: string | null): DropSort {
  return value === "oldest" || value === "popular" ? value : "recent";
}

function readBrowseState() {
  const params = new URLSearchParams(window.location.search);
  const rawYear = params.get("year");
  const year =
    rawYear && /^\d{4}$/.test(rawYear) && Number(rawYear) >= 1900 && Number(rawYear) <= 2100
      ? Number(rawYear)
      : 0;
  return {
    query: (params.get("q") ?? "").trim().slice(0, 64),
    year,
    eventType: asEventType(params.get("type")),
    sort: asSort(params.get("sort")),
  };
}

function syncQueryString(values: {
  q: string;
  year: number;
  eventType: EventType;
  sort: DropSort;
}) {
  const params = new URLSearchParams();
  if (values.q) params.set("q", values.q);
  if (values.year) params.set("year", String(values.year));
  if (values.eventType !== "all") params.set("type", values.eventType);
  if (values.sort !== "recent") params.set("sort", values.sort);
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
