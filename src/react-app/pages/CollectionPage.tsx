import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getCollection, getCollectionItems } from "../api";
import { CollectionExportPanel } from "../components/CollectionExportPanel";
import { CollectionItemCard } from "../components/CollectionItemCard";
import { EmptyState, ErrorState } from "../components/States";
import { ArrowIcon, ExternalIcon } from "../icons";
import { Link } from "../router";
import type {
  CollectionDetailResponse,
  CollectionItem,
  CollectionMedia,
  CollectionUiSettings,
} from "../types";
import { isAbortError, safeHttpUrl } from "../utils";

export function CollectionPage({ collectionId }: { collectionId: number }) {
  const [profile, setProfile] = useState<CollectionDetailResponse | null>(null);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [itemsError, setItemsError] = useState("");
  const [retry, setRetry] = useState(0);
  const [bannerFailed, setBannerFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => () => loadMoreController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setItemsError("");
    setProfile(null);
    setItems([]);
    setCursor(null);
    setTotal(0);
    setBannerFailed(false);
    setLogoFailed(false);

    getCollection(collectionId, controller.signal)
      .then((response) => {
        setProfile(response);
        setItems(response.items.items);
        setCursor(response.items.nextCursor);
        setTotal(response.items.total);
        const title = response.collection.title.trim() || `Collection #${collectionId}`;
        document.title = `${title.slice(0, 100)} · POAP Collections`;
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown Collections archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [collectionId, retry]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setItemsError("");
    try {
      const response = await getCollectionItems(collectionId, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
      setTotal(response.total);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setItemsError(
        cause instanceof Error ? cause.message : "Could not load more collection items",
      );
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  if (loading) {
    return (
      <main className="collection-detail-page shell" id="main-content" tabIndex={-1}>
        <div className="collection-detail-skeleton" role="status" aria-label="Loading collection">
          <span className="skeleton collection-detail-skeleton__banner" />
          <span className="skeleton collection-detail-skeleton__logo" />
          <span className="skeleton collection-detail-skeleton__title" />
          <span className="skeleton collection-detail-skeleton__copy" />
        </div>
      </main>
    );
  }

  if (error || !profile) {
    return (
      <main className="collection-detail-page shell" id="main-content" tabIndex={-1}>
        <Link className="back-link" href="/collections">
          ← Back to Collections
        </Link>
        <ErrorState
          message={error || "Collection not found"}
          onRetry={() => setRetry((value) => value + 1)}
        />
      </main>
    );
  }

  const collection = profile.collection;
  const title = collection.title.trim() || `Collection #${collection.collectionId}`;
  const bannerUrl = safeHttpUrl(collection.bannerUrl);
  const logoUrl = safeHttpUrl(collection.logoUrl);
  const externalUrl = safeHttpUrl(collection.externalUrl);
  const publicUrls = profile.urls.flatMap((entry) => {
    const url = safeHttpUrl(entry.url);
    return url ? [{ ...entry, url }] : [];
  });
  const sectionLabels = new Map(
    profile.sections.map((section) => [
      section.sectionId,
      section.name?.trim() || "Untitled section",
    ]),
  );

  return (
    <main className="collection-detail-page" id="main-content" tabIndex={-1}>
      <div className="shell">
        <Link className="back-link" href="/collections">
          ← Back to Collections
        </Link>
      </div>

      <article className="collection-profile shell">
        <div className="collection-profile__banner">
          <div className="collection-profile__banner-fallback" aria-hidden="true" />
          {bannerUrl && !bannerFailed ? (
            <img src={bannerUrl} alt="" decoding="async" onError={() => setBannerFailed(true)} />
          ) : null}
          <div className="collection-profile__status" aria-label="Collection status">
            {collection.isFeatured ? <span>Featured</span> : null}
            {collection.isVerified ? <span>Verified</span> : null}
          </div>
        </div>

        <div className="collection-profile__body glass-panel">
          <div className="collection-profile__logo">
            {logoUrl && !logoFailed ? (
              <img src={logoUrl} alt="" decoding="async" onError={() => setLogoFailed(true)} />
            ) : (
              <img src="/brand/logo_poap.svg" alt="" aria-hidden="true" />
            )}
          </div>

          <div className="collection-profile__heading">
            <span className="collection-profile__kicker">
              {formatCollectionType(collection.type)} · Collection #{collection.collectionId}
            </span>
            <h1>{title}</h1>
            <p className="collection-profile__slug">/{collection.slug}</p>
          </div>

          {collection.description ? (
            <p className="collection-profile__description">{collection.description}</p>
          ) : (
            <p className="collection-profile__description is-muted">
              No description was included in this snapshot.
            </p>
          )}

          <div className="collection-profile__actions">
            {externalUrl ? (
              <a
                className="button button--gold"
                href={externalUrl}
                target="_blank"
                rel="nofollow noopener noreferrer"
              >
                Visit collection source <ExternalIcon />
              </a>
            ) : null}
            <Link className="button button--outline" href="#export">
              Export collection
            </Link>
            <Link
              className="button button--outline"
              href={`/moments?collection=${collection.collectionId}`}
            >
              Explore Moments
            </Link>
          </div>

          <dl className="collection-profile__facts">
            <MetaItem label="POAP items" value={formatNumber(collection.itemCount)} />
            <MetaItem label="Sections" value={formatNumber(collection.sectionCount)} />
            <MetaItem label="Year" value={collection.year ? String(collection.year) : "—"} />
            <MetaItem label="Type" value={formatCollectionType(collection.type)} />
            <MetaItem label="Created" value={formatDate(collection.createdOn)} />
            <MetaItem label="Updated" value={formatDate(collection.updatedOn)} />
            {collection.typeRank !== null ? (
              <MetaItem label="Type rank" value={formatNumber(collection.typeRank)} />
            ) : null}
            <MetaItem label="Snapshot" value={profile.snapshotId} />
          </dl>
        </div>
      </article>

      <div className="collection-profile-grid shell">
        <section
          className="collection-info-panel glass-panel"
          aria-labelledby="collection-links-heading"
        >
          <span className="eyebrow">Profile</span>
          <h2 id="collection-links-heading">Links and verification</h2>
          {collection.verification ? (
            <p className="collection-verification">
              Verified by <strong>{collection.verification.organizationName}</strong> on{" "}
              {formatDate(collection.verification.verifiedOn)}.
            </p>
          ) : (
            <p className="collection-muted-copy">No verification record in this snapshot.</p>
          )}
          {publicUrls.length > 0 ? (
            <ul className="collection-link-list">
              {publicUrls.map((entry) => (
                <li key={entry.urlId}>
                  <a href={entry.url} target="_blank" rel="nofollow noopener noreferrer">
                    {displayUrl(entry.url)} <ExternalIcon />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="collection-muted-copy">No additional public links were archived.</p>
          )}
          {collection.ownerAddress ? (
            <p className="collection-owner">
              <span>Owner address</span>
              <code>{collection.ownerAddress}</code>
            </p>
          ) : null}
        </section>

        <UiMetadataPanel settings={profile.uiSettings} media={profile.media} />
      </div>

      <CollectionRelations
        sections={profile.sections}
        artists={profile.artists}
        organizations={profile.organizations}
      />

      <section
        className="collection-items-section shell"
        aria-labelledby="collection-items-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Inside this collection</span>
            <h2 id="collection-items-heading">Preserved POAP items</h2>
          </div>
          <span className="result-count" aria-live="polite">
            {formatNumber(items.length)} of {formatNumber(total)} shown
          </span>
        </div>

        {items.length > 0 ? (
          <div className="collection-items-grid">
            {items.map((item, index) => (
              <CollectionItemCard
                item={item}
                priority={index < 2}
                sectionNames={item.sections
                  .map((membership) => sectionLabels.get(membership.sectionId))
                  .filter((value): value is string => Boolean(value))}
                key={item.itemId}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="No POAP items">
            This collection did not contain item memberships at the archived snapshot.
          </EmptyState>
        )}
        {itemsError ? <ErrorState message={itemsError} /> : null}
        {cursor ? (
          <div className="load-more">
            <button
              className="button button--outline"
              type="button"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more POAPs"}
              <ArrowIcon />
            </button>
          </div>
        ) : null}
        <p className="collection-items-section__privacy">
          Private and hidden drop records are deliberately shown as ID-only placeholders.
        </p>
      </section>

      <div className="shell">
        <CollectionExportPanel collection={collection} />
      </div>
    </main>
  );
}

function CollectionRelations({
  sections,
  artists,
  organizations,
}: Pick<CollectionDetailResponse, "sections" | "artists" | "organizations">) {
  if (sections.length === 0 && artists.length === 0 && organizations.length === 0) return null;
  return (
    <section className="collection-relations shell" aria-labelledby="collection-relations-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Snapshot relationships</span>
          <h2 id="collection-relations-heading">People, groups, and sections</h2>
        </div>
      </div>
      <div className="collection-relations__grid">
        {artists.length > 0 ? (
          <RelationGroup title="Artists">
            {artists.map((artist) => (
              <li key={artist.artistId}>
                <strong>{artist.name?.trim() || artist.ens?.trim() || "Unnamed artist"}</strong>
                <span>{artist.ens?.trim() || artist.slug?.trim() || `ID ${artist.artistId}`}</span>
              </li>
            ))}
          </RelationGroup>
        ) : null}
        {organizations.length > 0 ? (
          <RelationGroup title="Organizations">
            {organizations.map((organization) => (
              <li key={organization.organizationId}>
                <strong>{organization.name}</strong>
                <span>/{organization.slug}</span>
              </li>
            ))}
          </RelationGroup>
        ) : null}
        {sections.length > 0 ? (
          <RelationGroup title="Sections">
            {sections.map((section) => (
              <li key={section.sectionId}>
                <strong>{section.name?.trim() || "Untitled section"}</strong>
                <span>Position {section.position}</span>
              </li>
            ))}
          </RelationGroup>
        ) : null}
      </div>
    </section>
  );
}

function RelationGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="collection-relation-group glass-panel">
      <h3>{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

function UiMetadataPanel({
  settings,
  media,
}: {
  settings: CollectionUiSettings | null;
  media: CollectionMedia[];
}) {
  const colors = useMemo(
    () =>
      settings
        ? [
            ["Primary", settings.primaryColor],
            ["Highlight", settings.highlightColor],
            ["Dark", settings.darkColor],
            ["Grey", settings.greyColor],
            ["White", settings.whiteColor],
          ]
        : [],
    [settings],
  );

  return (
    <section className="collection-info-panel glass-panel" aria-labelledby="collection-ui-heading">
      <span className="eyebrow">Archived presentation</span>
      <h2 id="collection-ui-heading">UI metadata</h2>
      {settings ? (
        <>
          <div className="collection-ui-flags">
            <span>
              {settings.isVisibleInRecentList
                ? "Visible in recent list"
                : "Hidden from recent list"}
            </span>
            <span>
              {settings.togglePoapElements ? "POAP elements enabled" : "POAP elements disabled"}
            </span>
            <span>{media.length} media records</span>
          </div>
          <ul className="collection-color-list">
            {colors.map(([label, color]) => (
              <li key={label}>
                <span
                  className="collection-color-list__swatch"
                  style={safeColor(color) ? { backgroundColor: color ?? undefined } : undefined}
                  aria-hidden="true"
                />
                <span>{label}</span>
                <code>{color || "Not set"}</code>
              </li>
            ))}
          </ul>
          <p className="collection-ui-note">
            Source colors are shown as metadata only. POAPin keeps its own high-contrast controls
            and text instead of applying untrusted collection themes.
          </p>
        </>
      ) : (
        <p className="collection-muted-copy">
          This collection has no archived presentation settings. {media.length} media records were
          captured separately.
        </p>
      )}
      {media.length > 0 ? (
        <div className="collection-media-summary">
          <h3>Archived media</h3>
          <ul>
            {media.map((entry) => {
              const objectUrl = safeHttpUrl(entry.objectUrl);
              const detail = [
                entry.width && entry.height ? `${entry.width}×${entry.height}` : null,
                typeof entry.byteLength === "number" ? formatBytes(entry.byteLength) : null,
                entry.eligibleForPublish ? "available" : entry.status,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={entry.role}>
                  <span>{formatMediaRole(entry.role)}</span>
                  {objectUrl ? (
                    <a href={objectUrl} target="_blank" rel="noopener noreferrer">
                      {detail} <ExternalIcon />
                    </a>
                  ) : (
                    <span>{detail}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function formatCollectionType(value: CollectionDetailResponse["collection"]["type"]): string {
  if (value === "artist") return "Artist";
  if (value === "organization") return "Organization";
  if (value === "user") return "User";
  return "Unclassified";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10) || "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.hostname}${path}`;
  } catch {
    return value;
  }
}

function safeColor(value: string | null): boolean {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value);
}

function formatMediaRole(role: CollectionMedia["role"]): string {
  if (role === "mobile_banner") return "Mobile banner";
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
