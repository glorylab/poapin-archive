import { type FormEvent, useEffect, useState } from "react";
import { getCollections, getCollectionsMeta, getDrops, getMoments, getMomentsMeta } from "../api";
import { CollectionCard } from "../components/CollectionCard";
import { DropCard } from "../components/DropCard";
import { MomentCard } from "../components/MomentCard";
import { ErrorState, GridSkeleton } from "../components/States";
import { ArrowIcon, SearchIcon } from "../icons";
import { Link, navigate } from "../router";
import type { ArchiveMeta, CollectionSummary, Drop, MomentSummary } from "../types";
import { isAbortError } from "../utils";

interface HomePageProps {
  meta: ArchiveMeta | null;
}

type PreviewStatus = "loading" | "ready" | "error";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function HomePage({ meta }: HomePageProps) {
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [collectionCount, setCollectionCount] = useState<number>();
  const [momentCount, setMomentCount] = useState<number>();
  const [drops, setDrops] = useState<Drop[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [moments, setMoments] = useState<MomentSummary[]>([]);
  const [dropStatus, setDropStatus] = useState<PreviewStatus>("loading");
  const [collectionStatus, setCollectionStatus] = useState<PreviewStatus>("loading");
  const [momentStatus, setMomentStatus] = useState<PreviewStatus>("loading");
  const [previewRetry, setPreviewRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getCollectionsMeta(controller.signal)
      .then((response) => setCollectionCount(response.count))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setCollectionCount(undefined);
      });
    getMomentsMeta(controller.signal)
      .then((response) => setMomentCount(response.counts.publicMoments))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setMomentCount(undefined);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDrops([]);
    setCollections([]);
    setMoments([]);
    setDropStatus("loading");
    setCollectionStatus("loading");
    setMomentStatus("loading");

    getDrops({ sort: "recent", limit: 4 }, controller.signal)
      .then((response) => {
        setDrops(response.items);
        setDropStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setDropStatus("error");
      });

    getCollections({ limit: 3 }, controller.signal)
      .then((response) => {
        setCollections(response.items);
        setCollectionStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setCollectionStatus("error");
      });

    getMoments({ limit: 3 }, controller.signal)
      .then((response) => {
        setMoments(response.items);
        setMomentStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setMomentStatus("error");
      });

    return () => controller.abort();
  }, [previewRetry]);

  const openAddress = (event: FormEvent) => {
    event.preventDefault();
    const value = address.trim();
    if (ADDRESS_PATTERN.test(value)) {
      setAddressError("");
      navigate(`/address/${value.toLowerCase()}`);
      return;
    }

    if (!value || !value.includes(".")) {
      setAddressError("Enter a complete 0x address or an ENS name such as name.eth.");
      return;
    }

    setAddressError("");
    navigate(`/address/${encodeURIComponent(value)}`);
  };

  const retryPreviews = () => setPreviewRetry((value) => value + 1);

  return (
    <main className="home-page" id="main-content" tabIndex={-1}>
      <section className="hero shell" id="address" tabIndex={-1}>
        <div className="hero__copy">
          <span className="eyebrow">An open snapshot of POAP</span>
          <h1>
            Find the POAPs you kept.
            <br />
            <em>Keep the story.</em>
          </h1>
          <p>
            Look up a public address or ENS name to browse its preserved collection, then take the
            full archive with you. <strong>POAP is dead. Long live POAP!</strong>
          </p>
        </div>

        <form className="hero__lookup glass-panel" onSubmit={openAddress} noValidate>
          <label htmlFor="address-lookup">Look up a collection</label>
          <div className={addressError ? "lookup-input has-error" : "lookup-input"}>
            <SearchIcon aria-hidden="true" />
            <input
              id="address-lookup"
              type="text"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                if (addressError) setAddressError("");
              }}
              placeholder="0x or name.eth"
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-invalid={addressError ? "true" : undefined}
              aria-describedby={addressError ? "address-error" : "address-help"}
            />
            <button className="button button--gold" type="submit">
              View collection
              <ArrowIcon />
            </button>
          </div>
          <span className="search-hint" id="address-help">
            No wallet connection; your browser never contacts an RPC provider.
          </span>
          {addressError ? (
            <span className="lookup-error" id="address-error" role="alert">
              {addressError}
            </span>
          ) : null}
        </form>
      </section>

      <section className="stats shell" aria-label="Archive statistics">
        <Stat value={meta?.counts.drops} label="drops" />
        <Stat value={collectionCount} label="collections" />
        <Stat value={momentCount} label="public moments" />
        <Stat value={meta?.counts.tokens} label="POAPs held" />
        <Stat value={meta?.counts.owners} label="collectors" />
      </section>

      <section
        className="home-preview home-preview--drops shell"
        aria-labelledby="home-drops-heading"
      >
        <PreviewHeading
          eyebrow="Latest from the catalog"
          heading="Preserved Drops"
          id="home-drops-heading"
          copy="A small selection from the public snapshot, with the full catalog one click away."
          href="/drops"
          linkLabel="Browse all Drops"
        />
        {dropStatus === "loading" ? <GridSkeleton count={4} /> : null}
        {dropStatus === "error" ? (
          <ErrorState
            message="The Drop preview is temporarily unavailable."
            onRetry={retryPreviews}
          />
        ) : null}
        {dropStatus === "ready" && drops.length === 0 ? (
          <PreviewEmpty>There are no public Drops in this snapshot.</PreviewEmpty>
        ) : null}
        {drops.length > 0 ? (
          <div className="drop-grid">
            {drops.map((drop) => (
              <DropCard drop={drop} key={drop.dropId} />
            ))}
          </div>
        ) : null}
      </section>

      <section
        className="home-preview home-preview--collections shell"
        aria-labelledby="home-collections-heading"
      >
        <PreviewHeading
          eyebrow="Curated histories"
          heading="Collections"
          id="home-collections-heading"
          copy="POAP stories gathered by artists, organizations, and communities."
          href="/collections"
          linkLabel="Explore Collections"
        />
        {collectionStatus === "loading" ? <PreviewSkeleton count={3} /> : null}
        {collectionStatus === "error" ? (
          <ErrorState
            message="The Collections preview is temporarily unavailable."
            onRetry={retryPreviews}
          />
        ) : null}
        {collectionStatus === "ready" && collections.length === 0 ? (
          <PreviewEmpty>There are no public Collections in this snapshot.</PreviewEmpty>
        ) : null}
        {collections.length > 0 ? (
          <div className="collection-grid">
            {collections.map((collection) => (
              <CollectionCard collection={collection} key={collection.collectionId} />
            ))}
          </div>
        ) : null}
      </section>

      <section
        className="home-preview home-preview--moments shell"
        aria-labelledby="home-moments-heading"
      >
        <PreviewHeading
          eyebrow="Public memories"
          heading="Moments"
          id="home-moments-heading"
          copy="Photos, recordings, notes, and links around POAPs. Media stays deferred on this page."
          href="/moments"
          linkLabel="Browse public Moments"
        />
        {momentStatus === "loading" ? <PreviewSkeleton count={3} /> : null}
        {momentStatus === "error" ? (
          <ErrorState
            message="The public Moments preview is temporarily unavailable."
            onRetry={retryPreviews}
          />
        ) : null}
        {momentStatus === "ready" && moments.length === 0 ? (
          <PreviewEmpty>There are no public Moments in this snapshot.</PreviewEmpty>
        ) : null}
        {moments.length > 0 ? (
          <div className="moment-grid">
            {moments.map((moment) => (
              <MomentCard moment={moment} deferMedia key={moment.momentId} />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function Stat({ value, label }: { value?: number; label: string }) {
  return (
    <div className="stat">
      <strong>{typeof value === "number" ? new Intl.NumberFormat("en").format(value) : "—"}</strong>
      <span>{label}</span>
    </div>
  );
}

function PreviewHeading({
  eyebrow,
  heading,
  id,
  copy,
  href,
  linkLabel,
}: {
  eyebrow: string;
  heading: string;
  id: string;
  copy: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="home-preview__heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 id={id}>{heading}</h2>
        <p>{copy}</p>
      </div>
      <Link className="home-preview__link" href={href}>
        {linkLabel}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function PreviewSkeleton({ count }: { count: number }) {
  return (
    <div className="home-preview__skeleton" role="status" aria-label="Loading preview">
      {Array.from({ length: count }, (_, index) => (
        <span className="skeleton" key={index} />
      ))}
    </div>
  );
}

function PreviewEmpty({ children }: { children: string }) {
  return <p className="home-preview__empty">{children}</p>;
}
