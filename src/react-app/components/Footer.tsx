import type { ArchiveMeta } from "../types";
import { Link } from "../router";

export function Footer({ meta }: { meta: ArchiveMeta | null }) {
  return (
    <footer className="footer">
      <div className="shell footer__inner">
        <div className="footer__brand">
          <img src="/brand/logo_poap.svg" alt="" width="34" height="44" />
          <div>
            <strong>POAPin Archive</strong>
            <span>Built to keep public memories portable.</span>
          </div>
        </div>
        <div className="footer__links">
          <Link href="/">Browse drops</Link>
          <Link href="/collections">Collections hub</Link>
          <Link href="/moments">Browse Moments</Link>
          <Link href="/about-data">About the data</Link>
          <a
            href="https://github.com/glorylab/poapin-archive"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open source on GitHub
          </a>
        </div>
        <p className="footer__legal">
          Code is open source. Archived data and issuer artwork retain their respective rights.
          {meta ? ` Snapshot ${meta.snapshotAt.slice(0, 10)}.` : ""}
        </p>
      </div>
    </footer>
  );
}
