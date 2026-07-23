import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getMoments } from "../api";
import { MomentCard } from "../components/MomentCard";
import { EmptyState, ErrorState } from "../components/States";
import { ArrowIcon } from "../icons";
import { Link } from "../router";
import type { MomentMediaKind, MomentSummary } from "../types";
import { isAbortError } from "../utils";

type MomentMediaFilter = "all" | MomentMediaKind;

interface MomentFiltersState {
  author: string;
  drop: number;
  collection: number;
  media: MomentMediaFilter;
}

const EMPTY_FILTERS: MomentFiltersState = {
  author: "",
  drop: 0,
  collection: 0,
  media: "all",
};

export function MomentsPage() {
  const initial = useMemo(readMomentsState, []);
  const [authorInput, setAuthorInput] = useState(initial.author);
  const [dropInput, setDropInput] = useState(initial.drop ? String(initial.drop) : "");
  const [collectionInput, setCollectionInput] = useState(
    initial.collection ? String(initial.collection) : "",
  );
  const [mediaInput, setMediaInput] = useState<MomentMediaFilter>(initial.media);
  const [filters, setFilters] = useState(initial);
  const [filterIssue, setFilterIssue] = useState(() => validateFilters(initial));
  const [items, setItems] = useState<MomentSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);
  const hasFilters = Boolean(
    filters.author || filters.drop || filters.collection || filters.media !== "all",
  );
  const authorInvalid = Boolean(
    filterIssue && authorInput.trim() && !/^0x[a-fA-F0-9]{40}$/.test(authorInput.trim()),
  );
  const dropInvalid = Boolean(filterIssue && dropInput && !readPositiveId(dropInput));
  const collectionInvalid = Boolean(
    filterIssue && collectionInput && !readPositiveId(collectionInput),
  );

  useEffect(() => {
    const syncFromHistory = () => {
      if (window.location.pathname !== "/moments" && window.location.pathname !== "/moments/")
        return;
      const next = readMomentsState();
      setAuthorInput(next.author);
      setDropInput(next.drop ? String(next.drop) : "");
      setCollectionInput(next.collection ? String(next.collection) : "");
      setMediaInput(next.media);
      setFilters(next);
      setFilterIssue(validateFilters(next));
    };
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  useEffect(() => () => loadMoreController.current?.abort(), []);

  useEffect(() => {
    if (!filters.author) return;
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robots = existing ?? document.createElement("meta");
    const previousContent = existing?.content;
    if (!existing) {
      robots.name = "robots";
      document.head.appendChild(robots);
    }
    robots.content = "noindex,nofollow";
    return () => {
      if (existing) robots.content = previousContent ?? "";
      else robots.remove();
    };
  }, [filters.author]);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    setItems([]);
    setCursor(null);
    setSnapshotId("");
    syncMomentsQueryString(filters);

    if (filterIssue) {
      setLoading(false);
      return () => controller.abort();
    }

    getMoments(
      {
        author: filters.author || undefined,
        drop: filters.drop || undefined,
        collection: filters.collection || undefined,
        media: filters.media === "all" ? undefined : filters.media,
        limit: 24,
      },
      controller.signal,
    )
      .then((response) => {
        setItems(response.items);
        setCursor(response.nextCursor);
        setSnapshotId(response.snapshotId);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown Moments archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [filterIssue, filters.author, filters.collection, filters.drop, filters.media, retry]);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    const next: MomentFiltersState = {
      author: authorInput.trim().toLowerCase(),
      drop: readPositiveId(dropInput),
      collection: readPositiveId(collectionInput),
      media: mediaInput,
    };
    const issue = validateDraftFilters(authorInput, dropInput, collectionInput);
    setFilterIssue(issue);
    if (!issue) setFilters(next);
  };

  const clearFilters = () => {
    setAuthorInput("");
    setDropInput("");
    setCollectionInput("");
    setMediaInput("all");
    setFilterIssue("");
    setFilters(EMPTY_FILTERS);
  };

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getMoments(
        {
          author: filters.author || undefined,
          drop: filters.drop || undefined,
          collection: filters.collection || undefined,
          media: filters.media === "all" ? undefined : filters.media,
          cursor,
          limit: 24,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
      setSnapshotId(response.snapshotId);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Could not load more Moments");
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  return (
    <main className="moments-page" id="main-content" tabIndex={-1}>
      <section className="moments-hero shell">
        <div className="moments-hero__copy">
          <span className="eyebrow">The memories around the POAPs</span>
          <h1>
            Moments make attendance
            <br />
            <em>feel alive again.</em>
          </h1>
          <p>
            Browse public photos, recordings, videos, links, and notes connected to preserved POAP
            Drops and Collections.
          </p>
        </div>
        <aside className="moments-hero__note glass-panel">
          <strong>Public by design, private by default.</strong>
          <p>
            This view keeps only Moments linked to the public Moments Drop set. Hidden Drops stay
            excluded, and media appears only after its archived copy passes verification.
          </p>
        </aside>
      </section>

      <section className="moments-browser shell" aria-labelledby="moments-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Moments archive</span>
            <h2 id="moments-heading">
              {hasFilters ? "Filtered public memories" : "Latest public memories"}
            </h2>
          </div>
          <span className="result-count" aria-live="polite">
            {loading ? "Loading…" : `${items.length}${cursor ? "+" : ""} shown`}
          </span>
        </div>

        <form className="moments-filters glass-panel" onSubmit={applyFilters} noValidate>
          <label>
            <span>Created by address</span>
            <input
              type="text"
              placeholder="0x…"
              value={authorInput}
              maxLength={42}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setAuthorInput(event.target.value)}
              aria-invalid={authorInvalid ? "true" : undefined}
              aria-describedby={filterIssue ? "moments-filter-error" : undefined}
            />
          </label>
          <label>
            <span>Drop ID</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Any Drop"
              value={dropInput}
              aria-invalid={dropInvalid ? "true" : undefined}
              aria-describedby={filterIssue ? "moments-filter-error" : undefined}
              onChange={(event) => setDropInput(event.target.value.replace(/\D/g, "").slice(0, 10))}
            />
          </label>
          <label>
            <span>Collection ID</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Any Collection"
              value={collectionInput}
              aria-invalid={collectionInvalid ? "true" : undefined}
              aria-describedby={filterIssue ? "moments-filter-error" : undefined}
              onChange={(event) =>
                setCollectionInput(event.target.value.replace(/\D/g, "").slice(0, 10))
              }
            />
          </label>
          <label>
            <span>Media</span>
            <select
              value={mediaInput}
              onChange={(event) => setMediaInput(event.target.value as MomentMediaFilter)}
            >
              <option value="all">Every kind</option>
              <option value="image">Images</option>
              <option value="video">Videos</option>
              <option value="audio">Audio</option>
              <option value="other">Other files</option>
            </select>
          </label>
          <button className="button button--gold" type="submit">
            Apply filters
          </button>
          {hasFilters ? (
            <button className="filter-reset" type="button" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
          {filterIssue ? (
            <span className="moments-filters__error" id="moments-filter-error" role="alert">
              {filterIssue}
            </span>
          ) : null}
        </form>

        {filters.author && !filterIssue ? (
          <div className="moments-author-shortcut">
            <span>Viewing Moments created by {shortAddress(filters.author)}.</span>
            <Link href={`/owners/${filters.author}/moments`}>
              Open the author page and export →
            </Link>
          </div>
        ) : null}

        {loading ? <MomentsGridSkeleton /> : null}
        {!loading && error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && !filterIssue && items.length === 0 ? (
          <EmptyState title="No public Moments found">
            Try removing a filter or browse all preserved public memories.
          </EmptyState>
        ) : null}
        {items.length ? (
          <div className="moment-grid">
            {items.map((moment, index) => (
              <MomentCard moment={moment} priority={index < 2} key={moment.momentId} />
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
              {loadingMore ? "Loading…" : "Explore more Moments"}
              <ArrowIcon />
            </button>
          </div>
        ) : null}
        {snapshotId ? (
          <p className="moments-snapshot">Public projection · snapshot {snapshotId}</p>
        ) : null}
      </section>
    </main>
  );
}

function MomentsGridSkeleton() {
  return (
    <div className="moment-grid" role="status" aria-label="Loading Moments" aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div className="moment-skeleton" key={index}>
          <span className="skeleton moment-skeleton__media" />
          <span className="skeleton moment-skeleton__byline" />
          <span className="skeleton moment-skeleton__title" />
          <span className="skeleton moment-skeleton__copy" />
        </div>
      ))}
    </div>
  );
}

function readMomentsState(): MomentFiltersState {
  const params = new URLSearchParams(window.location.search);
  return {
    author: (params.get("author") ?? "").trim().slice(0, 42).toLowerCase(),
    drop: readPositiveId(params.get("drop") ?? ""),
    collection: readPositiveId(params.get("collection") ?? ""),
    media: asMediaFilter(params.get("media")),
  };
}

function syncMomentsQueryString(filters: MomentFiltersState) {
  const params = new URLSearchParams();
  if (filters.author) params.set("author", filters.author);
  if (filters.drop) params.set("drop", String(filters.drop));
  if (filters.collection) params.set("collection", String(filters.collection));
  if (filters.media !== "all") params.set("media", filters.media);
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function validateFilters(filters: MomentFiltersState) {
  if (filters.author && !/^0x[a-f0-9]{40}$/.test(filters.author)) {
    return "Use a complete 0x address with 40 hexadecimal characters.";
  }
  return "";
}

function validateDraftFilters(author: string, drop: string, collection: string) {
  const normalizedAuthor = author.trim().toLowerCase();
  if (normalizedAuthor && !/^0x[a-f0-9]{40}$/.test(normalizedAuthor)) {
    return "Use a complete 0x address with 40 hexadecimal characters.";
  }
  if (drop && !readPositiveId(drop)) return "Drop ID must be a positive whole number.";
  if (collection && !readPositiveId(collection)) {
    return "Collection ID must be a positive whole number.";
  }
  return "";
}

function readPositiveId(value: string) {
  if (!/^[1-9]\d{0,9}$/.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function asMediaFilter(value: string | null): MomentMediaFilter {
  return value === "image" || value === "video" || value === "audio" || value === "other"
    ? value
    : "all";
}

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
