import { useEffect, useRef, useState } from "react";
import { getOwner } from "../api";
import { DropCard } from "../components/DropCard";
import { EmptyState, ErrorState, GridSkeleton } from "../components/States";
import { DownloadIcon } from "../icons";
import { Link } from "../router";
import type { ArchiveMeta, Holding } from "../types";
import { isAbortError } from "../utils";

const MAX_SYNC_EXPORT_RECORDS = 5_000;

interface OwnerPageProps {
  address: string;
  meta: ArchiveMeta | null;
}

export function OwnerPage({ address, meta }: OwnerPageProps) {
  const [items, setItems] = useState<Holding[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);
  const valid = /^0x[a-f0-9]{40}$/.test(address);

  useEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robots = existing ?? document.createElement("meta");
    const previousContent = existing?.content;
    if (!existing) {
      robots.name = "robots";
      document.head.appendChild(robots);
    }
    robots.content = "noindex,nofollow";
    document.title = `${shortAddress(address)} · POAP Archive`;
    return () => {
      if (existing) robots.content = previousContent ?? "";
      else robots.remove();
    };
  }, [address]);

  useEffect(() => {
    if (!valid) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setItems([]);
    setCursor(null);
    setTotal(null);
    getOwner(address, null, controller.signal)
      .then((response) => {
        setItems(response.items);
        setCursor(response.nextCursor);
        setTotal(response.total);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      loadMoreController.current?.abort();
    };
  }, [address, retry, valid]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getOwner(address, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
      setTotal(response.total);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Could not load more holdings");
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  if (!valid) {
    return (
      <main className="owner-page shell" id="main-content" tabIndex={-1}>
        <Link className="back-link" href="/">
          ← Back to the archive
        </Link>
        <EmptyState title="That address is not valid">
          Use a complete 0x address with 40 hexadecimal characters.
        </EmptyState>
      </main>
    );
  }

  const encoded = encodeURIComponent(address);
  const exportTooLarge = total !== null && total > MAX_SYNC_EXPORT_RECORDS;

  return (
    <main className="owner-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/#address">
        ← Try another address
      </Link>
      <section className="owner-hero glass-panel">
        <div>
          <span className="eyebrow">Public address collection</span>
          <h1>{shortAddress(address)}</h1>
          <code>{address}</code>
          <p>
            Holdings recorded at {meta ? formatSnapshot(meta.snapshotAt) : "the archive snapshot"}.
            This is not a live wallet view.
          </p>
        </div>
        <div className="owner-count">
          <strong>{total === null ? "—" : new Intl.NumberFormat("en").format(total)}</strong>
          <span>POAPs in snapshot</span>
        </div>
      </section>

      <section className="export-panel">
        <div>
          <h2>Take the whole history with you</h2>
          <p>
            Build a deployable personal site with holdings, every available public Drop detail,
            Collections, authored and tagged Moments, and public Capsules—or keep a simple
            holdings-only data file.
          </p>
        </div>
        <div className="export-panel__actions">
          <Link className="button button--gold" href={`/address/${address}/site`}>
            <DownloadIcon />
            Build personal site
          </Link>
          {!exportTooLarge ? (
            <>
              <a
                className="button button--outline"
                href={`/api/owners/${encoded}/export.csv`}
                download
              >
                Download CSV
              </a>
              <a
                className="button button--outline"
                href={`/api/owners/${encoded}/export.json`}
                download
              >
                Download JSON
              </a>
            </>
          ) : null}
        </div>
        {exportTooLarge ? (
          <p className="export-panel__limit" role="status">
            The legacy one-file CSV/JSON download stops at 5,000 records. The personal-site exporter
            above is paginated and supports this complete address.
          </p>
        ) : null}
      </section>

      <div className="privacy-note">
        <strong>Public, but personal.</strong>
        <span>
          Exact-address lookup is supported; address discovery and holder lists are intentionally
          not provided.
        </span>
      </div>

      <section className="archive-section" aria-labelledby="holdings-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Preserved collection</span>
            <h2 id="holdings-heading">POAPs held by this address</h2>
          </div>
          {!loading ? (
            <span className="result-count" aria-live="polite">
              {items.length}
              {cursor ? "+" : ""} shown
            </span>
          ) : null}
        </div>

        {loading ? <GridSkeleton /> : null}
        {!loading && error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <EmptyState title="No POAPs in this snapshot">
            The address may have received POAPs after the archive date, or held none at that time.
          </EmptyState>
        ) : null}
        {items.length ? (
          <div className="drop-grid">
            {items.map((holding, index) => (
              <DropCard
                drop={holding}
                priority={index < 2}
                tokenLabel={`${holding.network || "unknown network"} · token ${holding.poapId}`}
                key={holding.sourceUid}
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
              {loadingMore ? "Loading…" : "Load more POAPs"}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatSnapshot(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
