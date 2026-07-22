# POAPin Archive

> **POAP is dead. Long live POAP!**

POAPin Archive is an independent, public browser for a preserved POAP snapshot.
It exists because a community's memories should not disappear when a website
does.

The project is designed for Cloudflare Workers and for a deliberately small
operational footprint: static React assets at the edge, a Hono API, indexed D1
lookups, original artwork in R2, and versioned public responses in Workers
Cache.

The public site is [`poap.in`](https://poap.in), with immutable archive
artwork served from [`media.poap.in`](https://media.poap.in).

> [!IMPORTANT]
> The public deployment serves a fixed snapshot captured on July 2, 2026, not a
> canonical or live view of POAP ownership. Its catalog, holdings, and 73,795
> original artwork objects have been integrity-checked and published.

## What it is

- A fast, read-only browser for drops in a published snapshot.
- An address view for finding and exporting the POAPs recorded for an address.
- A transparent archive: every published dataset should identify its source,
  capture time, checksum, and known limitations.
- A small service that can remain affordable even when it becomes popular.

It is not a wallet, an ownership oracle, or a replacement for a live indexer.
No wallet connection is required.

## Architecture

| Layer    | Technology                       | Responsibility                                                  |
| -------- | -------------------------------- | --------------------------------------------------------------- |
| Web      | React + Vite                     | Accessible browsing, filtering, and export controls             |
| API      | Hono on Cloudflare Workers       | Validation, bounded reads, and cache-safe responses             |
| Catalog  | Cloudflare D1 (`CATALOG_DB`)     | Drops, snapshot metadata, search fields, and artwork references |
| Holdings | Cloudflare D1 (`HOLDINGS_DB`)    | Address-to-token lookup, isolated from catalog traffic          |
| Media    | Cloudflare R2 (`ARCHIVE_BUCKET`) | Immutable original artwork; derived thumbnails may follow later |
| Cache    | Workers Cache + HTTP caching     | Snapshot-versioned public GET responses and immutable media     |

Splitting catalog and holdings keeps their access patterns and growth paths
independent. Cache is an expendable acceleration layer; D1 and R2 remain the
sources of served data. See [Architecture](docs/architecture.md) for the request
and data flow.

## Cost is a design constraint

The archive is intentionally optimized for predictable edge cost and low CPU
time:

- serve built assets without application work;
- cache only public, deterministic GET responses using the snapshot ID;
- use indexed keyset pagination with hard page-size limits;
- precompute counts, normalized search fields, and export-ready records during
  import rather than during a request;
- store and serve original images from R2 without synchronous transformation;
- keep imports, integrity scans, and derivative generation outside the request
  path; and
- measure Worker CPU, D1 rows read, R2 operations, and cache effectiveness
  before increasing limits.

Current prices and platform limits are intentionally not copied into this
README. Review the official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[Cache documentation](https://developers.cloudflare.com/workers/runtime-apis/cache/)
before operating a production deployment.

## Privacy by default

Blockchain addresses and holdings may be public, but browsing intent is still
personal. The project therefore aims to:

- require no account, wallet signature, or cookie for ordinary use;
- avoid behavioral advertising and third-party tracking;
- never cache personalized responses or responses containing cookies;
- avoid placing exported content in server logs; and
- collect only the operational telemetry needed to keep the service healthy,
  with short, documented retention.

An address export describes the selected archive snapshot, not current
ownership. Persistent Worker invocation logs are disabled by default because
address routes would otherwise retain lookup intent; operators must review all
Cloudflare logging and retention settings before enabling them.

## Local development

Requirements:

- Node.js 22 or newer
- npm
- a Cloudflare account only when creating or deploying remote resources

```bash
npm ci
npm run db:setup:local
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` also performs a Wrangler dry-run. Tests use the Cloudflare
Workers runtime rather than a Node-only approximation.

The checked-in local fixture is intentionally tiny and synthetic. It is kept
outside the migration chain, so applying production migrations can never insert
sample wallets or events.

## Data import

The archive ZIP is not committed to Git. Its ZIP64 layout, SQLite schema, row
counts, artwork coverage, and important data-quality findings are recorded in
the [source inventory](docs/source-inventory.md). The importer checksums its
input, creates bounded D1 SQL parts and an R2 object manifest, and writes a
machine-readable validation report before publication.

See [Data import](docs/data-import.md) for the reproducible import contract.
The resulting reviewed artwork manifest can be uploaded without extracting the
source ZIP by following the [R2 media uploader guide](tools/r2-media-upload/README.md).

## Deployment

`wrangler.jsonc` names the Glory Lab production D1 databases, R2 bucket, and
`poap.in` custom domain. Forks must create their own resources and replace the
checked-in database IDs and domain configuration before deploying.

Do not deploy by guessing those values. Follow the one-time provisioning,
migration, validation, and deployment checklist in
[Deployment](docs/deployment.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), our
[Code of Conduct](CODE_OF_CONDUCT.md), and the [Security Policy](SECURITY.md)
before opening a pull request. The project uses Conventional Commits and expects
tests and documentation to travel with behavior changes.

## License and archive rights

The project code is available under the [MIT License](LICENSE). That license
does **not** automatically grant rights to imported archive data, POAP event
artwork, third-party logos, names, or trademarks. Those materials remain subject
to their respective rights and source terms. See
[Notices](NOTICE.md) and [Data and licensing](docs/data-and-licensing.md) before mirroring or
redistributing a snapshot.

POAPin Archive is an independent preservation project and is not endorsed by or
affiliated with POAP or the operators of POAP Archive.

---

Created and maintained by [Kira](mailto:kira@glorylab.xyz).
