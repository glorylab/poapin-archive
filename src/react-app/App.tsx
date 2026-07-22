import { useEffect, useRef, useState } from "react";
import { getMeta } from "./api";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { EmptyState } from "./components/States";
import { AboutPage } from "./pages/AboutPage";
import { BrowsePage } from "./pages/BrowsePage";
import { CollectionPage } from "./pages/CollectionPage";
import { CollectionsPage } from "./pages/CollectionsPage";
import { DropPage } from "./pages/DropPage";
import { OwnerPage } from "./pages/OwnerPage";
import { focusHashTarget, Link, useLocation } from "./router";
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
    else if (location.pathname === "/collections" || location.pathname === "/collections/")
      document.title = "POAP Collections · POAPin Archive";
    else if (location.pathname.startsWith("/collections/"))
      document.title = "POAP Collection · POAPin Archive";
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
      <Route pathname={location.pathname} meta={meta} />
      <Footer meta={meta} />
    </div>
  );
}

function Route({ pathname, meta }: { pathname: string; meta: ArchiveMeta | null }) {
  if (pathname === "/") return <BrowsePage meta={meta} />;
  if (pathname === "/collections" || pathname === "/collections/") return <CollectionsPage />;
  if (pathname === "/about-data") return <AboutPage meta={meta} />;

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

  const ownerMatch = pathname.match(/^\/address\/(0x[a-fA-F0-9]{40})\/?$/);
  if (ownerMatch) return <OwnerPage address={ownerMatch[1].toLowerCase()} meta={meta} />;

  return (
    <main className="not-found shell" id="main-content" tabIndex={-1}>
      <EmptyState title="This page is outside the archive">
        Check the URL or return to preserved POAP drops.
      </EmptyState>
      <Link className="button button--gold" href="/">
        Browse the archive
      </Link>
    </main>
  );
}
