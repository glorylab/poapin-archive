import { useState } from "react";
import { ExternalIcon } from "../icons";
import type { CollectionDropCard, CollectionItem, CollectionVisibleDropCard } from "../types";
import { safeHttpUrl } from "../utils";

export function CollectionItemCard({
  item,
  sectionNames,
  priority = false,
}: {
  item: CollectionItem;
  sectionNames: string[];
  priority?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const drop = item.drop;

  if (!drop) {
    return (
      <RedactedCollectionItem
        dropId={null}
        label="Record unavailable"
        detail="The referenced drop was not present in the archived public projection."
        sectionNames={sectionNames}
      />
    );
  }
  if (!isVisibleDrop(drop)) {
    const isHidden = "isHidden" in drop && drop.isHidden;
    return (
      <RedactedCollectionItem
        dropId={drop.dropId}
        label={isHidden ? "Hidden record" : "Private record"}
        detail={
          isHidden
            ? "This drop is preserved by ID only; its public fields are intentionally hidden."
            : "This drop is preserved by ID only; private fields and statistics are redacted."
        }
        sectionNames={sectionNames}
      />
    );
  }

  const visibleDrop = drop;
  const imageUrl = safeHttpUrl(visibleDrop.imageUrl);
  const eventUrl = safeHttpUrl(visibleDrop.eventUrl);
  const title = visibleDrop.title.trim() || `POAP drop #${visibleDrop.dropId}`;
  const location = [visibleDrop.city?.trim(), visibleDrop.country?.trim()]
    .filter(Boolean)
    .join(", ");

  return (
    <article className="collection-item-card">
      <div className="collection-item-card__artwork">
        <div className="collection-item-card__fallback" aria-hidden="true">
          <img src="/brand/logo_poap.svg" alt="" />
        </div>
        {imageUrl && !imageFailed ? (
          <a
            href={imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open the original artwork for ${title}`}
          >
            <img
              src={imageUrl}
              alt={`Artwork for ${title}`}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              decoding="async"
              onError={() => setImageFailed(true)}
            />
          </a>
        ) : null}
        <span className="collection-item-card__id">#{visibleDrop.dropId}</span>
        {visibleDrop.featuredOn ? (
          <span className="collection-item-card__featured">Featured</span>
        ) : null}
      </div>

      <div className="collection-item-card__body">
        <h3>{title}</h3>
        <p className="collection-item-card__date">
          {formatDate(visibleDrop.startDate) ||
            (visibleDrop.year > 0 ? String(visibleDrop.year) : "Date unavailable")}
          {location ? ` · ${location}` : ""}
        </p>
        {sectionNames.length > 0 ? (
          <p className="collection-item-card__sections">{sectionNames.join(" · ")}</p>
        ) : null}
        <dl className="collection-item-card__stats">
          <div>
            <dt>Collected</dt>
            <dd>{formatNullableNumber(visibleDrop.tokenCount)}</dd>
          </div>
          <div>
            <dt>Transfers</dt>
            <dd>{formatNullableNumber(visibleDrop.transferCount)}</dd>
          </div>
        </dl>
        <div className="collection-item-card__actions">
          {imageUrl && !imageFailed ? (
            <a href={imageUrl} target="_blank" rel="noopener noreferrer">
              Original artwork <ExternalIcon />
            </a>
          ) : (
            <span>Artwork unavailable</span>
          )}
          {eventUrl ? (
            <a href={eventUrl} target="_blank" rel="nofollow noopener noreferrer">
              Event <ExternalIcon />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function RedactedCollectionItem({
  dropId,
  label,
  detail,
  sectionNames,
}: {
  dropId: number | null;
  label: string;
  detail: string;
  sectionNames: string[];
}) {
  return (
    <article className="collection-item-card collection-item-card--redacted">
      <div className="collection-item-card__redacted-mark" aria-hidden="true">
        <img src="/brand/logo_poap.svg" alt="" />
      </div>
      <div className="collection-item-card__body">
        <span className="collection-item-card__privacy-label">{label}</span>
        <h3>{dropId ? `Drop #${dropId}` : "Unresolved drop"}</h3>
        <p className="collection-item-card__redacted-copy">{detail}</p>
        {sectionNames.length > 0 ? (
          <p className="collection-item-card__sections">{sectionNames.join(" · ")}</p>
        ) : null}
      </div>
    </article>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatNullableNumber(value: number | null): string {
  return typeof value === "number" ? new Intl.NumberFormat("en").format(value) : "—";
}

function isVisibleDrop(drop: CollectionDropCard): drop is CollectionVisibleDropCard {
  return (
    "isPrivate" in drop && drop.isPrivate === false && "isHidden" in drop && drop.isHidden === false
  );
}
