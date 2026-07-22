import { useEffect, useState } from "react";
import { getCollectionExportManifest } from "../api";
import { DownloadIcon, ExternalIcon } from "../icons";
import type {
  CollectionExportManifest,
  CollectionExportSegmentName,
  CollectionRecord,
} from "../types";
import { isAbortError } from "../utils";
import { ErrorState } from "./States";

const SEGMENTS: Array<{
  name: CollectionExportSegmentName;
  label: string;
  detail: string;
}> = [
  { name: "metadata", label: "Metadata", detail: "Profile, links, media, people, and sections" },
  { name: "items", label: "Items", detail: "Curated membership and public drop cards" },
  { name: "artist-drops", label: "Artist drops", detail: "Artist-to-drop relationships" },
  {
    name: "suggestions",
    label: "Approved suggestions",
    detail: "Only publicly approved suggestions",
  },
  {
    name: "drop-stats",
    label: "Drop statistics",
    detail: "Public aggregate totals and per-chain counts",
  },
];

export function CollectionExportPanel({ collection }: { collection: CollectionRecord }) {
  const [manifest, setManifest] = useState<CollectionExportManifest | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setManifest(null);
    getCollectionExportManifest(collection.collectionId, controller.signal)
      .then(setManifest)
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Could not load the export manifest");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [collection.collectionId, retry]);

  const manifestPath = `/api/collections/${collection.collectionId}/export`;
  const paths = new Map(manifest?.segments.map((segment) => [segment.name, segment.path]) ?? []);

  return (
    <section
      className="collection-export"
      id="export"
      aria-labelledby="collection-export-heading"
      tabIndex={-1}
    >
      <div className="collection-export__intro">
        <span className="eyebrow">Portable by design</span>
        <h2 id="collection-export-heading">Export this collection</h2>
        <p>
          Start with the manifest, then save each JSON segment. Cursor-paginated segments expose a
          <code> nextPath </code> until the export is complete.
        </p>
        <a
          className="button button--gold"
          href={manifestPath}
          download={`poapin-collection-${collection.collectionId}-manifest.json`}
        >
          <DownloadIcon /> Download manifest
        </a>
      </div>

      <div className="collection-export__segments" aria-busy={loading ? "true" : undefined}>
        {loading ? (
          <div className="collection-export__loading" role="status">
            Reading available segments…
          </div>
        ) : null}
        {error ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error
          ? SEGMENTS.map((segment) => {
              const path = paths.get(segment.name);
              return (
                <div className="collection-export__segment" key={segment.name}>
                  <div>
                    <strong>{segment.label}</strong>
                    <span>{segment.detail}</span>
                  </div>
                  {path ? (
                    <a href={path} target="_blank" rel="noopener noreferrer">
                      {segment.name === "metadata" ? "Open JSON" : "Open first page"}
                      <ExternalIcon />
                    </a>
                  ) : (
                    <span className="collection-export__unavailable">No rows</span>
                  )}
                </div>
              );
            })
          : null}
      </div>

      <div className="collection-export__privacy">
        <strong>Public-safe export</strong>
        <p>
          Suggestions are limited to approved records. Hidden and private drops keep only their ID;
          metadata, artwork, and aggregate statistics remain redacted. These safeguards also apply
          to every paginated segment.
        </p>
      </div>
    </section>
  );
}
