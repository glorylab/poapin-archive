import { useState } from "react";
import { Link } from "../router";
import type { MomentMediaPreview, MomentSummary } from "../types";
import { isBrowserRenderableMomentImage, safeMomentMediaUrl } from "../utils";

interface MomentCardProps {
  moment: MomentSummary;
  priority?: boolean;
  deferMedia?: boolean;
}

export function MomentCard({ moment, priority = false, deferMedia = false }: MomentCardProps) {
  const description = moment.description?.trim() ?? "";
  const author = moment.author;
  const authorIsAddress = typeof author === "string" && /^0x[a-fA-F0-9]{40}$/.test(author);
  const title = moment.dropIds.length
    ? `Moment from Drop #${moment.dropIds[0]}`
    : moment.previewMedia
      ? `${formatMediaKind(moment.previewMedia.kind)} moment`
      : moment.mediaPreservationState === "pending"
        ? "Moment awaiting media preservation"
        : "POAP Moment";

  return (
    <article className="moment-card">
      <MomentPreview
        media={moment.previewMedia}
        title={title}
        momentId={moment.momentId}
        mediaCount={moment.mediaCount}
        sourceMediaCount={moment.sourceMediaCount}
        preservationState={moment.mediaPreservationState}
        priority={priority}
        deferMedia={deferMedia}
      />
      <div className="moment-card__body">
        <div className="moment-card__byline">
          {authorIsAddress && author ? (
            <Link href={`/owners/${author.toLowerCase()}/moments`}>{shortAddress(author)}</Link>
          ) : (
            <span>{author || "Unknown author"}</span>
          )}
          <span aria-hidden="true">·</span>
          <time dateTime={moment.createdOn}>{formatDate(moment.createdOn)}</time>
        </div>
        <h3>{title}</h3>
        {description ? (
          <p className="moment-card__description">{description}</p>
        ) : (
          <p className="moment-card__description is-muted">No caption was preserved.</p>
        )}

        {moment.dropIds.length || moment.collectionIds.length ? (
          <div className="moment-card__relations" aria-label="Related archive records">
            {moment.dropIds.slice(0, 2).map((dropId) => (
              <Link href={`/drop/${dropId}`} key={`drop-${dropId}`}>
                Drop #{dropId}
              </Link>
            ))}
            {moment.collectionIds.slice(0, 2).map((collectionId) => (
              <Link href={`/collections/${collectionId}`} key={`collection-${collectionId}`}>
                Collection #{collectionId}
              </Link>
            ))}
            {moment.dropIds.length + moment.collectionIds.length > 4 ? (
              <span>+{moment.dropIds.length + moment.collectionIds.length - 4}</span>
            ) : null}
          </div>
        ) : null}

        <Link
          className="moment-card__open"
          href={`/moments/${encodeURIComponent(moment.momentId)}`}
        >
          Open moment <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

function MomentPreview({
  media,
  title,
  momentId,
  mediaCount,
  sourceMediaCount,
  preservationState,
  priority,
  deferMedia,
}: {
  media: MomentMediaPreview | null;
  title: string;
  momentId: string;
  mediaCount: number;
  sourceMediaCount: number;
  preservationState: MomentSummary["mediaPreservationState"];
  priority: boolean;
  deferMedia: boolean;
}) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const mediaUrl = safeMomentMediaUrl(media?.url);
  const thumbnailUrl = safeMomentMediaUrl(media?.thumbnailUrl);
  const detailHref = `/moments/${encodeURIComponent(momentId)}`;
  const downloadOnlyImage = Boolean(
    media && media.kind === "image" && !isBrowserRenderableMomentImage(media),
  );
  const previewKind =
    !deferMedia && media && mediaUrl && !mediaFailed
      ? downloadOnlyImage
        ? "other"
        : media.kind
      : null;
  const downloadOnlyType = downloadOnlyImage && media ? formatDownloadOnlyImageType(media) : null;

  return (
    <div className={`moment-card__preview moment-card__preview--${media?.kind ?? "text"}`}>
      {previewKind === "image" && thumbnailUrl ? (
        <Link className="moment-card__image" href={detailHref} aria-label={`Open ${title}`}>
          <img
            src={thumbnailUrl}
            alt=""
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            decoding="async"
            onError={() => setMediaFailed(true)}
          />
        </Link>
      ) : null}

      {previewKind === "image" && !thumbnailUrl ? (
        <Link className="moment-card__text" href={detailHref} aria-label={`Open ${title}`}>
          <img src="/brand/logo_poap.svg" alt="" />
          <span>Open this Moment to choose whether to load the original image</span>
        </Link>
      ) : null}

      {previewKind === "video" && thumbnailUrl ? (
        <Link className="moment-card__image" href={detailHref} aria-label={`Open ${title} to play`}>
          <img
            src={thumbnailUrl}
            alt=""
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            decoding="async"
            onError={() => setMediaFailed(true)}
          />
        </Link>
      ) : null}

      {previewKind === "video" && !thumbnailUrl ? (
        <Link className="moment-card__text" href={detailHref} aria-label={`Open ${title} to play`}>
          <img src="/brand/logo_poap.svg" alt="" />
          <span>Open this Moment to load the video</span>
        </Link>
      ) : null}

      {previewKind === "audio" ? (
        <Link className="moment-card__text" href={detailHref} aria-label={`Open ${title} to play`}>
          <img src="/brand/logo_poap.svg" alt="" />
          <span>Open this Moment to load the audio</span>
        </Link>
      ) : null}

      {previewKind === "other" ? (
        <a
          className="moment-card__other"
          href={mediaUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          download={
            downloadOnlyType ? `archived-moment.${downloadOnlyType.toLowerCase()}` : undefined
          }
        >
          <span>{downloadOnlyType ? `Archived ${downloadOnlyType} file` : "Archived file"}</span>
          <strong>
            {downloadOnlyType ? "Download original" : media?.mimeType || "Open original media"}
          </strong>
        </a>
      ) : null}

      {!previewKind ? (
        <Link className="moment-card__text" href={detailHref} aria-label={`Open ${title}`}>
          <img src="/brand/logo_poap.svg" alt="" />
          <span>
            {deferMedia && media
              ? "Open this Moment to choose whether to load media"
              : media
                ? "Media unavailable"
                : preservationState === "pending"
                  ? "Media preservation pending"
                  : "No media attached"}
          </span>
        </Link>
      ) : null}

      {media ? (
        <span className="moment-card__kind">
          {formatMediaKind(media.kind)}
          {preservationState === "partial"
            ? ` · ${mediaCount}/${sourceMediaCount} preserved`
            : mediaCount > 1
              ? ` · ${mediaCount}`
              : ""}
        </span>
      ) : null}
    </div>
  );
}

function formatMediaKind(kind: MomentMediaPreview["kind"]) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatDownloadOnlyImageType(media: MomentMediaPreview) {
  return /dng/i.test(media.mimeType ?? "") || /\.dng$/i.test(media.url) ? "DNG" : "HEIC";
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
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
