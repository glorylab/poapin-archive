import { useEffect, useState } from "react";
import { getMoment } from "../api";
import { ErrorState } from "../components/States";
import { ExternalIcon } from "../icons";
import { Link } from "../router";
import type { MomentCapsule, MomentDetail, MomentLinkRecord, MomentMedia } from "../types";
import {
  isAbortError,
  isBrowserRenderableMomentImage,
  safeHttpUrl,
  safeMomentMediaUrl,
} from "../utils";

const IMAGE_BATCH_SIZE = 4;

export function MomentDetailPage({ momentId }: { momentId: string }) {
  const [moment, setMoment] = useState<Awaited<ReturnType<typeof getMoment>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMoment(null);
    getMoment(momentId, controller.signal)
      .then(setMoment)
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown Moment archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [momentId, retry]);

  if (loading) {
    return (
      <main className="moment-detail-page shell" id="main-content" tabIndex={-1}>
        <div
          className="moment-detail-skeleton"
          role="status"
          aria-label="Loading Moment"
          aria-busy="true"
        >
          <span className="skeleton moment-detail-skeleton__media" />
          <div className="glass-panel">
            <span className="skeleton moment-detail-skeleton__byline" />
            <span className="skeleton moment-detail-skeleton__title" />
            <span className="skeleton moment-detail-skeleton__copy" />
          </div>
        </div>
      </main>
    );
  }

  if (error || !moment) {
    return (
      <main className="moment-detail-page shell" id="main-content" tabIndex={-1}>
        <Link className="back-link" href="/moments">
          ← Back to Moments
        </Link>
        <ErrorState
          message={error || "Moment not found"}
          onRetry={() => setRetry((value) => value + 1)}
        />
      </main>
    );
  }

  const description = moment.description?.trim() ?? "";
  const visibleLinks = moment.links.filter((link) => safeHttpUrl(link.url));
  const title = moment.dropIds.length
    ? `Moment from Drop #${moment.dropIds[0]}`
    : moment.media.length
      ? "Archived multimedia Moment"
      : moment.mediaPreservationState === "pending"
        ? "Moment awaiting media preservation"
        : "Archived POAP Moment";

  return (
    <main className="moment-detail-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/moments">
        ← Back to Moments
      </Link>

      <article className="moment-detail">
        <section className="moment-detail__media" aria-label="Archived Moment media">
          {moment.media.length ? (
            <MomentMediaGallery moment={moment} title={title} key={moment.momentId} />
          ) : (
            <div className="moment-detail__text-media glass-panel">
              <img src="/brand/logo_poap.svg" alt="" />
              <span>
                {moment.mediaPreservationState === "pending"
                  ? "Media preservation pending"
                  : "No media attached"}
              </span>
              <strong>
                {moment.mediaPreservationState === "pending"
                  ? `${moment.sourceMediaCount} media file${moment.sourceMediaCount === 1 ? " is" : "s are"} still moving into the archive.`
                  : "This Moment was preserved without a media file."}
              </strong>
            </div>
          )}
        </section>

        <div className="moment-detail__content glass-panel">
          <span className="eyebrow">Public POAP Moment</span>
          <h1>{title}</h1>
          <div className="moment-detail__byline">
            <span>Created by</span>
            <AuthorLink address={moment.author} />
            <span aria-hidden="true">·</span>
            <time dateTime={moment.createdOn}>{formatDateTime(moment.createdOn)}</time>
          </div>

          {description ? (
            <p className="moment-detail__description">{description}</p>
          ) : (
            <p className="moment-detail__description is-muted">
              This public Moment did not include a caption.
            </p>
          )}

          <dl className="moment-detail__metadata">
            <MetaItem label="Media" value={formatPreservationCount(moment)} />
            <MetaItem label="Published" value={formatDate(moment.createdOn)} />
            <MetaItem
              label="Updated"
              value={
                moment.updatedOn ? formatDate(moment.updatedOn) : moment.isUpdated ? "Yes" : "No"
              }
            />
            {moment.tokenId !== null ? (
              <MetaItem label="Token ID" value={String(moment.tokenId)} />
            ) : null}
          </dl>

          <div className="moment-detail__relations">
            <div>
              <span>Author</span>
              <AuthorLink address={moment.author} />
            </div>
            {moment.dropIds.length ? (
              <div>
                <span>POAP Drops</span>
                <div>
                  {moment.dropIds.map((dropId) => (
                    <Link href={`/drop/${dropId}`} key={dropId}>
                      Drop #{dropId}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            {moment.collectionIds.length ? (
              <div>
                <span>Collections</span>
                <div>
                  {moment.collectionIds.map((collectionId) => (
                    <Link href={`/collections/${collectionId}`} key={collectionId}>
                      Collection #{collectionId}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <details className="moment-detail__ids">
            <summary>Preserved source identifiers</summary>
            <dl>
              <MetaItem label="Moment ID" value={moment.momentId} />
              {moment.displayId ? <MetaItem label="Display ID" value={moment.displayId} /> : null}
              {moment.cid ? <MetaItem label="CID" value={moment.cid} /> : null}
            </dl>
          </details>

          <p className="snapshot-note">
            This page is a read-only public archive. Private Moments, hidden Drops, unsafe links,
            upstream media URLs, and embedded metadata are excluded.
          </p>
        </div>
      </article>

      {visibleLinks.length ? (
        <section className="moment-detail-section" aria-labelledby="moment-links-heading">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Links</span>
              <h2 id="moment-links-heading">Shared with this Moment</h2>
            </div>
          </div>
          <div className="moment-link-grid">
            {visibleLinks.map((link) => (
              <MomentLinkCard link={link} key={link.linkId} />
            ))}
          </div>
        </section>
      ) : null}

      {moment.userTags.length ? (
        <section className="moment-detail-section" aria-labelledby="moment-people-heading">
          <div className="section-heading">
            <div>
              <span className="eyebrow">People</span>
              <h2 id="moment-people-heading">Publicly tagged</h2>
            </div>
          </div>
          <div className="moment-people-list">
            {moment.userTags.map((tag) => (
              <div key={tag.tagId}>
                <strong>{tag.ens?.trim() || shortAddress(tag.address)}</strong>
                <AuthorLink address={tag.address} label="View created Moments" />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {moment.capsules.length ? (
        <section className="moment-detail-section" aria-labelledby="moment-capsules-heading">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Capsules</span>
              <h2 id="moment-capsules-heading">Part of these public stories</h2>
            </div>
          </div>
          <div className="moment-capsule-grid">
            {moment.capsules.map((capsule) => (
              <CapsuleCard capsule={capsule} key={capsule.capsuleId} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function MomentMediaGallery({ moment, title }: { moment: MomentDetail; title: string }) {
  const [loadedImageIds, setLoadedImageIds] = useState<ReadonlySet<string>>(() => new Set());
  const loadableImages = moment.media.filter(isBrowserRenderableMomentImage);
  const unloadedImages = loadableImages.filter((media) => !loadedImageIds.has(media.mediaId));
  const nextBatchSize = Math.min(IMAGE_BATCH_SIZE, unloadedImages.length);

  const loadImage = (mediaId: string) => {
    setLoadedImageIds((current) => {
      if (current.has(mediaId)) return current;
      const next = new Set(current);
      next.add(mediaId);
      return next;
    });
  };

  const loadNextBatch = () => {
    setLoadedImageIds((current) => {
      const next = new Set(current);
      for (const media of loadableImages) {
        if (next.has(media.mediaId)) continue;
        next.add(media.mediaId);
        if (next.size - current.size === IMAGE_BATCH_SIZE) break;
      }
      return next;
    });
  };

  return (
    <>
      {loadableImages.length ? (
        <div className="moment-media-loader glass-panel">
          <div>
            <span className="eyebrow">Data-friendly gallery</span>
            <strong>Images stay unloaded until you choose</strong>
            <p>
              This page does not download archived originals automatically. Load one image below, or
              request up to {IMAGE_BATCH_SIZE} at a time.
            </p>
          </div>
          <div className="moment-media-loader__actions">
            {unloadedImages.length ? (
              <button className="button button--outline" type="button" onClick={loadNextBatch}>
                Load next {nextBatchSize} {nextBatchSize === 1 ? "image" : "images"}
              </button>
            ) : null}
            <span role="status" aria-live="polite" aria-atomic="true">
              {loadedImageIds.size} of {loadableImages.length} loaded
            </span>
          </div>
        </div>
      ) : null}

      {moment.media.map((media, index) => (
        <MomentMediaPanel
          media={media}
          title={title}
          index={index}
          imageActivated={loadedImageIds.has(media.mediaId)}
          onActivateImage={() => loadImage(media.mediaId)}
          key={media.mediaId}
        />
      ))}

      {moment.mediaPreservationState === "partial" ? (
        <div className="moment-detail__text-media glass-panel">
          <img src="/brand/logo_poap.svg" alt="" />
          <span>Preservation in progress</span>
          <strong>
            {moment.mediaCount} of {moment.sourceMediaCount} media files are available.
          </strong>
        </div>
      ) : null}
    </>
  );
}

function MomentMediaPanel({
  media,
  title,
  index,
  imageActivated,
  onActivateImage,
}: {
  media: MomentMedia;
  title: string;
  index: number;
  imageActivated: boolean;
  onActivateImage: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [activated, setActivated] = useState(false);
  const mediaUrl = safeMomentMediaUrl(media.url);
  const thumbnailUrl = safeMomentMediaUrl(media.thumbnailUrl);
  const available = Boolean(mediaUrl && !failed);
  const browserRenderableImage = isBrowserRenderableMomentImage(media);
  const downloadOnlyImage = media.kind === "image" && !browserRenderableImage;
  const fileType = formatArchivedFileType(media);

  return (
    <figure
      className={`moment-media-panel moment-media-panel--${
        downloadOnlyImage ? "other" : media.kind
      }`}
    >
      <div className="moment-media-panel__asset">
        {available && browserRenderableImage && !imageActivated ? (
          <button
            className="moment-media-panel__deferred moment-media-panel__deferred--image"
            type="button"
            onClick={onActivateImage}
          >
            <img src="/brand/logo_poap.svg" alt="" />
            <span>Archived image {index + 1}</span>
            <strong>{thumbnailUrl ? "Load image preview" : "Load original image"}</strong>
            <small>
              {thumbnailUrl
                ? "The full-size original stays unloaded."
                : `${formatOptionalBytes(media.byteLength)} Nothing loads until you choose.`}
            </small>
          </button>
        ) : null}
        {available && browserRenderableImage && imageActivated ? (
          <a href={mediaUrl ?? undefined} target="_blank" rel="noopener noreferrer">
            <img
              src={thumbnailUrl ?? mediaUrl ?? undefined}
              alt={`Media ${index + 1} for ${title}`}
              decoding="async"
              fetchPriority={index === 0 ? "high" : "auto"}
              onError={() => setFailed(true)}
            />
          </a>
        ) : null}
        {available && media.kind === "video" && !activated ? (
          <button
            className="moment-media-panel__deferred"
            type="button"
            onClick={() => setActivated(true)}
          >
            <img src="/brand/logo_poap.svg" alt="" />
            <span>Archived video</span>
            <strong>Load video controls</strong>
          </button>
        ) : null}
        {available && media.kind === "video" && activated ? (
          <video
            controls
            playsInline
            preload="none"
            poster={thumbnailUrl ?? undefined}
            onError={() => setFailed(true)}
          >
            <source src={mediaUrl ?? undefined} type={media.mimeType ?? undefined} />
          </video>
        ) : null}
        {available && media.kind === "audio" && !activated ? (
          <button
            className="moment-media-panel__deferred"
            type="button"
            onClick={() => setActivated(true)}
          >
            <img src="/brand/logo_poap.svg" alt="" />
            <span>Archived audio</span>
            <strong>Load audio controls</strong>
          </button>
        ) : null}
        {available && media.kind === "audio" && activated ? (
          <div className="moment-media-panel__audio">
            <img src="/brand/logo_poap.svg" alt="" />
            <span>Archived audio</span>
            <audio
              controls
              preload="none"
              src={mediaUrl ?? undefined}
              onError={() => setFailed(true)}
            >
              Your browser cannot play this archived audio.
            </audio>
          </div>
        ) : null}
        {available && (media.kind === "other" || downloadOnlyImage) ? (
          <a
            className="moment-media-panel__file"
            href={mediaUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            download={
              downloadOnlyImage
                ? `archived-moment-${index + 1}.${fileType.toLowerCase()}`
                : undefined
            }
          >
            <img src="/brand/logo_poap.svg" alt="" />
            <span>{downloadOnlyImage ? `${fileType} image file` : "Archived file"}</span>
            <strong>
              {downloadOnlyImage ? `Download original ${fileType} file` : "Open archived file"}
            </strong>
            <small>{formatMediaDetails(media)}</small>
          </a>
        ) : null}
        {!available ? (
          <div className="moment-media-panel__unavailable">
            <img src="/brand/logo_poap.svg" alt="" />
            <span>Archived media unavailable</span>
          </div>
        ) : null}
      </div>
      <figcaption>
        <span>{downloadOnlyImage ? `${fileType} file` : formatMediaKind(media.kind)}</span>
        <span>{formatMediaDetails(media)}</span>
        {mediaUrl ? (
          <a href={mediaUrl} target="_blank" rel="noopener noreferrer">
            Original <ExternalIcon />
          </a>
        ) : null}
      </figcaption>
    </figure>
  );
}

function MomentLinkCard({ link }: { link: MomentLinkRecord }) {
  const url = safeHttpUrl(link.url);
  if (!url) return null;
  return (
    <a className="moment-link-card" href={url} target="_blank" rel="nofollow noopener noreferrer">
      <div>
        <strong>{link.title?.trim() || linkHostname(url)}</strong>
        {link.description?.trim() ? <p>{link.description.trim()}</p> : null}
        <span>
          {linkHostname(url)} <ExternalIcon />
        </span>
      </div>
    </a>
  );
}

function CapsuleCard({ capsule }: { capsule: MomentCapsule }) {
  const url = safeHttpUrl(capsule.url);
  const content = (
    <>
      <div>
        <span>Capsule #{capsule.capsuleId}</span>
        <strong>{capsule.title?.trim() || "Untitled Capsule"}</strong>
        {capsule.description?.trim() ? <p>{capsule.description.trim()}</p> : null}
      </div>
    </>
  );
  return url ? (
    <a
      className="moment-capsule-card"
      href={url}
      target="_blank"
      rel="nofollow noopener noreferrer"
    >
      {content}
    </a>
  ) : (
    <div className="moment-capsule-card">{content}</div>
  );
}

function AuthorLink({ address, label }: { address: string | null; label?: string }) {
  if (typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return <code>{address || "Unknown"}</code>;
  }
  return (
    <Link href={`/owners/${address.toLowerCase()}/moments`}>{label ?? shortAddress(address)}</Link>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatMediaKind(kind: MomentMedia["kind"]) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatArchivedFileType(media: MomentMedia) {
  if (/dng/i.test(media.mimeType ?? "") || /\.dng$/i.test(media.url)) return "DNG";
  if (/hei[cf]/i.test(media.mimeType ?? "") || /\.hei[cf]$/i.test(media.url)) return "HEIC";
  return media.mimeType?.trim() || "Unknown";
}

function formatOptionalBytes(bytes: number | null) {
  return bytes === null ? "" : `${formatBytes(bytes)} original.`;
}

function formatPreservationCount(
  moment: Pick<MomentDetail, "mediaCount" | "sourceMediaCount" | "mediaPreservationState">,
) {
  if (moment.mediaPreservationState === "none") return "None attached";
  if (moment.mediaPreservationState === "complete") {
    return `${new Intl.NumberFormat("en").format(moment.mediaCount)} preserved`;
  }
  return `${new Intl.NumberFormat("en").format(moment.mediaCount)} of ${new Intl.NumberFormat("en").format(moment.sourceMediaCount)} preserved`;
}

function formatMediaDetails(media: MomentMedia) {
  const parts = [media.mimeType];
  if (media.width && media.height) parts.push(`${media.width} × ${media.height}`);
  if (media.durationMs !== null) parts.push(formatDuration(media.durationMs));
  if (media.byteLength !== null) parts.push(formatBytes(media.byteLength));
  return parts.filter(Boolean).join(" · ") || "Details unavailable";
}

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes ? `${minutes}:${String(remaining).padStart(2, "0")}` : `${remaining}s`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function shortAddress(value: string | null) {
  if (!value) return "Unknown address";
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function linkHostname(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "External link";
  }
}
