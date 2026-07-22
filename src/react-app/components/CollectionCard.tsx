import { useState } from "react";
import { Link } from "../router";
import type { CollectionSummary } from "../types";
import { safeHttpUrl } from "../utils";

export function CollectionCard({
  collection,
  priority = false,
}: {
  collection: CollectionSummary;
  priority?: boolean;
}) {
  const [bannerFailed, setBannerFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const bannerUrl = safeHttpUrl(collection.bannerUrl);
  const logoUrl = safeHttpUrl(collection.logoUrl);
  const title = collection.title.trim() || `Collection #${collection.collectionId}`;
  const type = formatCollectionType(collection.type);

  return (
    <article className="collection-card">
      <Link
        className="collection-card__link"
        href={`/collections/${collection.collectionId}`}
        aria-label={`View ${title}`}
      >
        <div className="collection-card__visual">
          <div className="collection-card__banner-fallback" aria-hidden="true" />
          {bannerUrl && !bannerFailed ? (
            <img
              className="collection-card__banner"
              src={bannerUrl}
              alt=""
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              decoding="async"
              onError={() => setBannerFailed(true)}
            />
          ) : null}
          <div className="collection-card__badges" aria-label="Collection status">
            {collection.isFeatured ? <span>Featured</span> : null}
            {collection.isVerified ? <span>Verified</span> : null}
          </div>
          <div className="collection-card__logo">
            {logoUrl && !logoFailed ? (
              <img
                src={logoUrl}
                alt=""
                loading={priority ? "eager" : "lazy"}
                decoding="async"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <img src="/brand/logo_poap.svg" alt="" aria-hidden="true" />
            )}
          </div>
        </div>

        <div className="collection-card__body">
          <span className="collection-card__kicker">
            {type}
            {collection.year ? ` · ${collection.year}` : ""}
          </span>
          <h2 title={title}>{title}</h2>
          {collection.description ? (
            <p>{collection.description}</p>
          ) : (
            <p className="is-muted">No description was included in the snapshot.</p>
          )}
          <dl className="collection-card__counts">
            <div>
              <dt>POAPs</dt>
              <dd>{formatNumber(collection.itemCount)}</dd>
            </div>
            <div>
              <dt>Sections</dt>
              <dd>{formatNumber(collection.sectionCount)}</dd>
            </div>
          </dl>
        </div>
      </Link>
    </article>
  );
}

function formatCollectionType(value: CollectionSummary["type"]): string {
  if (value === "artist") return "Artist collection";
  if (value === "organization") return "Organization collection";
  if (value === "user") return "User collection";
  return "Collection";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}
