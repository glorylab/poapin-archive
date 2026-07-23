import { useEffect, useRef, useState } from "react";
import { getMoments } from "../api";
import { MomentCard } from "../components/MomentCard";
import { MomentExportButtons } from "../components/MomentExportButtons";
import { EmptyState, ErrorState } from "../components/States";
import { ArrowIcon } from "../icons";
import { Link } from "../router";
import type { MomentSummary } from "../types";
import { isAbortError } from "../utils";

export function OwnerMomentsPage({ address }: { address: string }) {
  const [items, setItems] = useState<MomentSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setItems([]);
    setCursor(null);
    setSnapshotId("");

    getMoments({ author: address, limit: 24 }, controller.signal)
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

    return () => {
      controller.abort();
      loadMoreController.current?.abort();
    };
  }, [address, retry]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getMoments({ author: address, cursor, limit: 24 }, controller.signal);
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
    <main className="owner-moments-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/moments">
        ← Back to Moments
      </Link>

      <section className="owner-moments-hero glass-panel">
        <div>
          <span className="eyebrow">Public Moment author</span>
          <h1>{shortAddress(address)}</h1>
          <code>{address}</code>
          <p>
            These are Moments created by this address in the public archive. This page does not
            imply current ownership and does not include private or merely tagged memories.
          </p>
        </div>
        <Link className="button button--outline" href={`/address/${address}`}>
          View POAP holdings
        </Link>
      </section>

      <section className="moment-export-panel" aria-labelledby="moment-export-heading">
        <div>
          <span className="eyebrow">Portable by design</span>
          <h2 id="moment-export-heading">Download every public Moment created here</h2>
          <p>
            The browser reads the archive in small cursor pages, then builds one JSON or
            spreadsheet-safe CSV file on this device. Large histories can take a minute or more;
            keep this tab open and it will slow down or resume automatically when needed.
          </p>
        </div>
        <MomentExportButtons address={address} />
      </section>

      <div className="privacy-note">
        <strong>Exact-address access only.</strong>
        <span>
          POAPin supports direct public-address lookup, but does not provide author directories or
          bulk identity discovery.
        </span>
      </div>

      <section
        className="archive-section owner-moments-feed"
        aria-labelledby="owner-moments-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Created Moments</span>
            <h2 id="owner-moments-heading">Public memories by this address</h2>
          </div>
          {!loading ? (
            <span className="result-count" aria-live="polite">
              {items.length}
              {cursor ? "+" : ""} shown
            </span>
          ) : null}
        </div>

        {loading ? <OwnerMomentsSkeleton /> : null}
        {!loading && error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <EmptyState title="No public created Moments">
            This address may have private Moments, tagged Moments, or none in this archive snapshot.
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
              {loadingMore ? "Loading…" : "Load more created Moments"}
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

function OwnerMomentsSkeleton() {
  return (
    <div
      className="moment-grid"
      role="status"
      aria-label="Loading created Moments"
      aria-busy="true"
    >
      {Array.from({ length: 4 }, (_, index) => (
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

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
