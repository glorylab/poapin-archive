import type { ArchiveMeta } from "../types";
import { Link, useLocation } from "../router";

interface HeaderProps {
  meta: ArchiveMeta | null;
}

export function Header({ meta }: HeaderProps) {
  const { pathname, hash } = useLocation();
  const onMomentsRoute =
    pathname.startsWith("/moments") || /^\/owners\/[^/]+\/moments\/?$/.test(pathname);
  const active = onMomentsRoute
    ? "moments"
    : pathname.startsWith("/address") || (pathname === "/" && hash === "#address")
      ? "address"
      : pathname.startsWith("/collections")
        ? "collections"
        : pathname === "/about-data"
          ? "about"
          : "browse";

  return (
    <header className="site-header">
      <div className="site-header__inner shell">
        <Link className="brand" href="/" aria-label="POAPin Archive home">
          <img src="/brand/title_poapin_s.png" alt="POAPin" width="132" height="32" />
          <span className="brand__archive">Archive</span>
        </Link>

        <nav className="nav" aria-label="Primary navigation">
          <Link
            className={active === "browse" ? "nav__link is-active" : "nav__link"}
            href="/"
            aria-current={active === "browse" ? "page" : undefined}
          >
            Drops
          </Link>
          <Link
            className={active === "collections" ? "nav__link is-active" : "nav__link"}
            href="/collections"
            aria-current={active === "collections" ? "page" : undefined}
          >
            Collections
          </Link>
          <Link
            className={active === "moments" ? "nav__link is-active" : "nav__link"}
            href="/moments"
            aria-current={active === "moments" ? "page" : undefined}
          >
            Moments
          </Link>
          <Link
            className={active === "address" ? "nav__link is-active" : "nav__link"}
            href="/#address"
            aria-current={active === "address" ? "page" : undefined}
            data-nav-optional="export"
          >
            Export
          </Link>
          <Link
            className={active === "about" ? "nav__link is-active" : "nav__link"}
            href="/about-data"
            aria-current={active === "about" ? "page" : undefined}
            data-nav-optional="about"
          >
            About
          </Link>
        </nav>

        <div
          className="snapshot-pill"
          title={meta?.snapshotAt ?? "Loading snapshot metadata"}
          aria-live="polite"
        >
          <span className="snapshot-pill__dot" aria-hidden="true" />
          <span>{meta ? `Snapshot ${formatSnapshot(meta.snapshotAt)}` : "Snapshot"}</span>
        </div>
      </div>
    </header>
  );
}

function formatSnapshot(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
