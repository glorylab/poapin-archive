import { useEffect, useRef, useState } from "react";
import { getMeta } from "./api";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { EmptyState } from "./components/States";
import { AboutPage } from "./pages/AboutPage";
import { AddressRoutePage } from "./pages/AddressRoutePage";
import { CollectionPage } from "./pages/CollectionPage";
import { CollectionsPage } from "./pages/CollectionsPage";
import { DropPage } from "./pages/DropPage";
import { DropsPage } from "./pages/DropsPage";
import { HomePage } from "./pages/HomePage";
import { MomentDetailPage } from "./pages/MomentDetailPage";
import { MomentsPage } from "./pages/MomentsPage";
import { OwnerMomentsPage } from "./pages/OwnerMomentsPage";
import { PersonalSiteExportPage } from "./pages/PersonalSiteExportPage";
import { focusHashTarget, Link, navigate, useLocation } from "./router";
import type { ArchiveMeta } from "./types";
import { isAbortError } from "./utils";

export default function App() {
  const location = useLocation();
  const previousPathname = useRef(location.pathname);
  const [meta, setMeta] = useState<ArchiveMeta | null>(null);
  const [metaError, setMetaError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getMeta(controller.signal)
      .then(setMeta)
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setMetaError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (location.pathname === "/") document.title = "POAP Archive · POAPin";
    else if (location.pathname === "/drops" || location.pathname === "/drops/")
      document.title = "POAP Drops · POAPin Archive";
    else if (location.pathname === "/collections" || location.pathname === "/collections/")
      document.title = "POAP Collections · POAPin Archive";
    else if (location.pathname.startsWith("/collections/"))
      document.title = "POAP Collection · POAPin Archive";
    else if (location.pathname === "/moments" || location.pathname === "/moments/")
      document.title = "POAP Moments · POAPin Archive";
    else if (location.pathname.startsWith("/moments/"))
      document.title = "POAP Moment · POAPin Archive";
    else if (/^\/owners\/[^/]+\/moments\/?$/.test(location.pathname))
      document.title = "Created Moments · POAPin Archive";
    else if (/^\/address\/[^/]+\/site\/?$/.test(location.pathname))
      document.title = "Build a personal POAP site · POAPin Archive";
    else if (location.pathname === "/about-data") document.title = "About the data · POAP Archive";
    else if (location.pathname.startsWith("/drop/")) document.title = "POAP drop · POAP Archive";
    else if (location.pathname.startsWith("/address/"))
      document.title = "Address collection · POAP Archive";
    else document.title = "Page not found · POAP Archive";
  }, [location.pathname]);

  useEffect(() => {
    if (!location.hash) return;
    const frame = window.requestAnimationFrame(() => focusHashTarget(location.hash));
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.pathname]);

  useEffect(() => {
    const pathnameChanged = previousPathname.current !== location.pathname;
    previousPathname.current = location.pathname;
    if (!pathnameChanged || location.hash) return;

    const frame = window.requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Header meta={meta} />
      {metaError ? (
        <div className="metadata-warning" role="status">
          Snapshot metadata is temporarily unavailable. Browsing may still work.
        </div>
      ) : null}
      <Route pathname={location.pathname} search={location.search} meta={meta} />
      <Footer meta={meta} />
    </div>
  );
}

function Route({
  pathname,
  search,
  meta,
}: {
  pathname: string;
  search: string;
  meta: ArchiveMeta | null;
}) {
  if (pathname === "/") {
    if (hasLegacyDropQuery(search)) return <LegacyDropsRedirect search={search} />;
    return <HomePage meta={meta} />;
  }
  if (pathname === "/drops" || pathname === "/drops/") return <DropsPage meta={meta} />;
  if (pathname === "/collections" || pathname === "/collections/") return <CollectionsPage />;
  if (pathname === "/moments" || pathname === "/moments/") return <MomentsPage />;
  if (pathname === "/about-data") return <AboutPage meta={meta} />;

  const momentMatch = pathname.match(
    /^\/moments\/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\/?$/,
  );
  if (momentMatch) return <MomentDetailPage momentId={momentMatch[1].toLowerCase()} />;

  const ownerMomentsMatch = pathname.match(/^\/owners\/(0x[a-fA-F0-9]{40})\/moments\/?$/);
  if (ownerMomentsMatch) return <OwnerMomentsPage address={ownerMomentsMatch[1].toLowerCase()} />;

  const personalSiteMatch = pathname.match(/^\/address\/(0x[a-fA-F0-9]{40})\/site\/?$/);
  if (personalSiteMatch) {
    return <PersonalSiteExportPage address={personalSiteMatch[1].toLowerCase()} />;
  }

  const collectionMatch = pathname.match(/^\/collections\/([1-9]\d{0,9})\/?$/);
  if (collectionMatch) {
    const collectionId = Number(collectionMatch[1]);
    if (Number.isSafeInteger(collectionId)) return <CollectionPage collectionId={collectionId} />;
  }

  const dropMatch = pathname.match(/^\/drop\/([1-9]\d{0,9})\/?$/);
  if (dropMatch) {
    const dropId = Number(dropMatch[1]);
    if (Number.isSafeInteger(dropId)) return <DropPage dropId={dropId} />;
  }

  const ownerMatch = pathname.match(/^\/address\/([^/]+)\/?$/);
  if (ownerMatch) {
    const identifier = decodePathSegment(ownerMatch[1]);
    if (identifier) {
      return <AddressRoutePage identifier={identifier} pathname={pathname} meta={meta} />;
    }
  }

  return (
    <main className="not-found shell" id="main-content" tabIndex={-1}>
      <EmptyState title="This page is outside the archive">
        Check the URL or return to preserved POAP drops.
      </EmptyState>
      <Link className="button button--gold" href="/drops">
        Browse preserved Drops
      </Link>
    </main>
  );
}

function LegacyDropsRedirect({ search }: { search: string }) {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      navigate(`/drops${search}`, { replace: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [search]);

  return (
    <main className="not-found shell" id="main-content" tabIndex={-1}>
      <p role="status">Opening the preserved Drops catalog…</p>
    </main>
  );
}

function hasLegacyDropQuery(search: string) {
  const params = new URLSearchParams(search);
  return ["q", "year", "type", "sort"].some((key) => params.has(key));
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}
