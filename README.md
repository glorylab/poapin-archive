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
> original artwork objects have been integrity-checked and published. Curated
> POAP Collections use a separately verified `collections-2026-07-22-v1`
> snapshot and release lifecycle; every API response identifies the Collections
> snapshot it came from. POAP Moments use an independent, twice-captured
> `moments-2026-07-23-v1` snapshot, D1 release gate, and resumable original-media
> archive. Its media-bound release verified all 30,548 stored R2 objects in two
> independent remote passes with zero failures.

## What it is

- A focused homepage with small Drops, Collections, and public Moments
  previews, plus a complete searchable Drops catalog at `/drops`.
- Bounded browse, detail, and segmented export APIs for preserved POAP
  Collections.
- A Moments hub with Drop and Collection albums, authored timelines,
  bandwidth-safe detail pages, and bounded metadata exports.
- Address lookup that accepts either a complete `0x` address or an ENS name,
  including shareable paths such as `/address/poap.eth`, then opens the matching
  preserved collection without connecting a wallet.
- Exact Drop pages with a cursor-paginated list of every holder record preserved
  in the historical Holdings snapshot.
- A browser-built, deployable personal-site ZIP containing complete paginated
  Holdings, normalized public and holder-proven private Drop records, opaque
  missing or hidden Drop references, relevant Collection profiles and
  owned-Collection exports, public authored and tagged Moments, and historically
  owned Capsules.
- A transparent archive: every published dataset should identify its source,
  capture time, checksum, and known limitations.
- A small service that can remain affordable even when it becomes popular.

It is not a wallet, an ownership oracle, or a replacement for a live indexer.
No wallet connection is required.

## Architecture

| Layer       | Technology                       | Responsibility                                                        |
| ----------- | -------------------------------- | --------------------------------------------------------------------- |
| Web         | React + Vite                     | Browsing, export collection, static-site generation, and ZIP creation |
| API         | Hono on Cloudflare Workers       | Validation, bounded reads, and cache-safe responses                   |
| Catalog     | Cloudflare D1 (`CATALOG_DB`)     | Drops, snapshot metadata, search fields, and artwork references       |
| Holdings    | Cloudflare D1 (`HOLDINGS_DB`)    | Clustered address-to-token and exact-Drop collector lookup            |
| Collections | Cloudflare D1 (`COLLECTIONS_DB`) | Curated collections, memberships, sections, and export relations      |
| Moments     | Cloudflare D1 (`MOMENTS_DB`)     | Moments, tags, Capsules, Drop links, albums, media proof, and exports |
| Media       | Cloudflare R2 (`ARCHIVE_BUCKET`) | Immutable original artwork; derived thumbnails may follow later       |
| Resolver    | ENS Universal Resolver           | Server-side ENS-to-address lookup through a configurable mainnet RPC  |
| Cache       | Workers Cache + HTTP caching     | Snapshot-versioned public GET responses and immutable media           |

Splitting catalog, holdings, Collections, and Moments keeps their access
patterns and snapshot lifecycles independent. Cache is an expendable
acceleration layer; D1 and R2 remain the sources of served data. See
[Architecture](docs/architecture.md) for the request and data flow.

ENS resolution also stays behind the Worker. The browser sends the requested
name to the POAPin API, while the Worker uses `ETHEREUM_RPC_URL` to call the
Ethereum mainnet Universal Resolver. The production default is PublicNode's
keyless public Ethereum endpoint, and operators can replace it with another
HTTPS mainnet JSON-RPC provider without changing the client.

## Cost is a design constraint

The archive is intentionally optimized for predictable edge cost and low CPU
time:

- serve built assets without application work;
- cache only public, deterministic GET responses using the snapshot ID;
- use indexed keyset pagination with hard page-size limits;
- precompute counts, normalized search fields, and export-ready records during
  import rather than during a request;
- collect complete personal exports through bounded pages, then generate and
  compress the static site in the browser rather than in a Worker request;
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

A downloaded personal site contains the selected address and its public
archived history. Publishing that ZIP makes the packaged metadata public at the
chosen host; the archive does not upload it automatically.

## Local development

Requirements:

- Node.js 22.13 or newer
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
npx playwright install chromium
npm run test:browser
npm run build
npm run check
```

`npm run check` also performs a Wrangler dry-run. Tests use the Cloudflare
Workers runtime rather than a Node-only approximation. The focused Chromium
suite verifies that archived audio and video remain network-idle until the user
explicitly asks to load them.

The checked-in local fixtures are intentionally tiny and synthetic. They are
kept outside the migration chain, so applying production migrations can never
insert sample wallets, events, or Collections.

## Data import

The archive ZIP is not committed to Git. Its ZIP64 layout, SQLite schema, row
counts, artwork coverage, and important data-quality findings are recorded in
the [source inventory](docs/source-inventory.md). The importer checksums its
input, creates bounded D1 SQL parts and an R2 object manifest, and writes a
machine-readable validation report before publication.

See [Data import](docs/data-import.md) for the reproducible import contract.
The resulting reviewed artwork manifest can be uploaded without extracting the
source ZIP by following the [R2 media uploader guide](tools/r2-media-upload/README.md).

POAP Compass Collections have their own resumable GraphQL capture, two-pass
stability comparison, media quarantine, verification, D1 projection, and
private backup workflow. See the
[Collections backup guide](tools/collections-backup/README.md).

The final local Collections snapshot preserves 2,016 collections, 35,954 items,
complete cards and anonymous aggregates for 26,004 referenced drops, and a
26,550-object public media proof spanning reused Archive artwork, newly preserved
drop originals, and Collection branding. This is an application-level backup of
data anonymously reachable through Compass, not its physical private database;
all 26,550 public media objects passed a second remote integrity verification,
and the snapshot-scoped D1 database was independently loaded, verified, and
activated before its Worker binding changed.

POAP Moments use a separate two-pass GraphQL capture, canonical stability
comparison, Drop-to-Collection projection, private structured backup, staged D1
loader, and resumable R2 media capture. The preserved source contains 25,959
Moments, 26,521 Moment-to-Drop relationships, 32,891 media records, and 64,862
gateway records. The first media-bound public projection contains 24,459
Moments and 26,198 public media records. See
[Moments preservation](docs/moments.md) and the
[Moments backup guide](tools/moments-backup/README.md).

## Official ZIP versus POAPin supplements

The original POAP Archive download remains the foundation of this project. It
is not the complete preservation set, however: the public Compass GraphQL API
provided later Holdings, Collections, and Moments data that was absent from
the ZIP or newer than its July 2 snapshot.

| Area                        | Official `archive.zip`                                       | POAPin supplement                                                                                                                            |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Drops and POAPs             | 73,876 Drops, 6,218,154 token rows, and 73,795 WebP artworks | 7,714,773 Compass `(poap_id, chain)` holdings; newer, private, and hidden held Drops; 102,219 referenced Drop records                        |
| Address and collector views | Historical `tokens` table                                    | Exact owner holdings, Drop collector pages, owner aggregates, and address-bound exports                                                      |
| Drop metadata               | Public catalog rows                                          | Public/private/hidden Drop metadata tied to a proven holding or an exact Drop ID                                                             |
| Collections                 | Not included                                                 | 2,016 Collections, 35,954 items, 805 artists, 650 organizations, sections, suggestions, and featured records                                 |
| Collection Drop enrichment  | Not included                                                 | 24,777 per-chain statistics, 13,165 anonymous claim aggregates, 553 featured-Drop rows, and 2,505 Moment aggregates                          |
| Collection media            | Not included                                                 | 26,550 verified public objects: 18,533 reused Archive artworks, 7,331 new Drop originals, and 686 Collection-branding objects                |
| Moments                     | Not included                                                 | 25,959 Moments, 26,521 Moment-to-Drop relations, 32,891 media records, 64,862 gateway records, tags, links, and Capsules                     |
| Moments media               | Not included                                                 | 30,548 deduplicated R2 objects: 26,198 public originals and 3,505 private-preservation objects; 3,188 source-missing records remain explicit |

The supplements are separate, versioned snapshots rather than silent edits to
the official SQLite file. Their SQL projections, SQLite packages, manifests,
and media proofs are independently checksummed and can be restored without
running the public Worker.

## Public data releases and downloads

The [archive-data-2026-08-06 release](https://github.com/glorylab/poapin-archive/releases/tag/archive-data-2026-08-06)
is the release index. The actual public data objects live in the R2
`media.poap.in/releases/archive-data-2026-08-06/` prefix, so the multi-gigabyte
backups do not need to be duplicated in GitHub.
Every package contains its own schema, source metadata, checksums, and
restore-oriented D1 SQL where applicable. The
[machine-readable release manifest](https://media.poap.in/releases/archive-data-2026-08-06/poapin-release-manifest.json)
lists every R2 object and its direct download URL.

| Package                                           | Download                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original POAP Archive ZIP                         | [archive.zip](https://downloads.poaparchive.com/archive.zip)                                                                                        |
| Compass Holdings SQLite + D1 package              | [4-part R2 backup manifest](https://media.poap.in/releases/archive-data-2026-08-06/poapin-holdings-2026-07-28-v1.manifest.json)                     |
| Holdings artwork D1 activation and coverage proof | [poapin-holdings-artwork-2026-07-28-v1.tar.gz](https://media.poap.in/releases/archive-data-2026-08-06/poapin-holdings-artwork-2026-07-28-v1.tar.gz) |
| Collections public restore package                | [2-part R2 restore manifest](https://media.poap.in/releases/archive-data-2026-08-06/poapin-collections-2026-07-22-v1-full.manifest.json)            |
| Collections complete source/media backup          | [27-part R2 backup manifest](https://media.poap.in/releases/archive-data-2026-08-06/poapin-collections-2026-07-22-v1-final.manifest.json)           |
| Moments structured snapshot, pass 1               | [poapin-moments-2026-07-23-v1-pass1.tar.gz](https://media.poap.in/releases/archive-data-2026-08-06/poapin-moments-2026-07-23-v1-pass1.tar.gz)       |
| Moments structured snapshot, independent pass 2   | [poapin-moments-2026-07-23-v1-pass2.tar.gz](https://media.poap.in/releases/archive-data-2026-08-06/poapin-moments-2026-07-23-v1-pass2.tar.gz)       |
| Release checksums                                 | [poapin-release-checksums.sha256](https://media.poap.in/releases/archive-data-2026-08-06/poapin-release-checksums.sha256)                           |
| Machine-readable release manifest                 | [poapin-release-manifest.json](https://media.poap.in/releases/archive-data-2026-08-06/poapin-release-manifest.json)                                 |

The Holdings SQLite package and the Collections public restore package are
split into R2 objects because Wrangler's single-object upload limit is 300 MiB.
Download the direct part URLs from the release manifest, or use these repeatable
commands (run each dataset in its own directory):

```sh
base=https://media.poap.in/releases/archive-data-2026-08-06

mkdir holdings && cd holdings
for i in 000 001 002 003; do
  curl -fLO "$base/poapin-holdings-2026-07-28-v1.tar.gz.part-$i"
done
curl -fLO "$base/poapin-holdings-2026-07-28-v1.tar.gz.sha256"
cat poapin-holdings-2026-07-28-v1.tar.gz.part-* > full.tar.gz
shasum -a 256 -c poapin-holdings-2026-07-28-v1.tar.gz.sha256

cd ..
mkdir collections-restore && cd collections-restore
for i in 000 001; do
  curl -fLO "$base/poapin-collections-2026-07-22-v1-full.tar.gz.part-$i"
done
curl -fLO "$base/poapin-collections-2026-07-22-v1-full.tar.gz.sha256"
cat poapin-collections-2026-07-22-v1-full.tar.gz.part-* > full.tar.gz
shasum -a 256 -c poapin-collections-2026-07-22-v1-full.tar.gz.sha256
```

The complete Collections source/media archive is split into 27 checked parts
because it is about 5.58 GB. Download the parts named
`poapin-collections-2026-07-22-v1-final.tar.gz.part-000` through `-026` from
the R2 prefix, then reassemble them in lexical order and verify the published
SHA-256 file:

```sh
base=https://media.poap.in/releases/archive-data-2026-08-06
for i in $(seq 0 26); do
  part=$(printf '%03d' "$i")
  curl -fLO "$base/poapin-collections-2026-07-22-v1-final.tar.gz.part-$part"
done
curl -fLO "$base/poapin-collections-2026-07-22-v1-final.tar.gz.sha256"
cat poapin-collections-2026-07-22-v1-final.tar.gz.part-* > full.tar.gz
shasum -a 256 -c poapin-collections-2026-07-22-v1-final.tar.gz.sha256
```

The database packages do not duplicate the media archive. Public immutable
originals are served from [`media.poap.in`](https://media.poap.in) using the
snapshot-scoped object keys and media manifests inside each package:

```text
https://media.poap.in/snapshots/2026-07-02-v1/artwork/<drop_id>.webp
https://media.poap.in/snapshots/collections-2026-07-22-v1/collections/drop-artwork/sha256/<prefix>/<sha256>.<ext>
https://media.poap.in/snapshots/compass-holdings-2026-07-28-v1/holdings/drop-artwork/sha256/<prefix>/<sha256>.<ext>
https://media.poap.in/snapshots/moments-2026-07-23-v1/moments/original/sha256/<prefix>/<sha256>.<ext>
```

For a single person, the more convenient option remains the address page's
browser-built personal-site ZIP and its separate opt-in image ZIP. The global
release is intended for researchers, self-hosted mirrors, and alternate
frontends.

The code is MIT-licensed, but imported records, artwork, logos, and third-party
metadata retain their respective rights and source terms. Public availability
is not a new license grant; consult [Data and licensing](docs/data-and-licensing.md)
before redistributing a downstream mirror.

## Portable personal sites

The address page can collect a complete personal archive through the paginated
APIs and build a pure-static ZIP in the browser. Each dataset is held to one
unchanged release identity during collection; Holdings, Collections, and
Moments remain three independent snapshots rather than one shared capture time.
The package contains normalized Holdings; public Catalog details; preserved
private or hidden Drop metadata where that exact address's Holdings snapshot
proves the relation; opaque Drop-ID references only for genuinely unavailable
records; three distinct Collection relationship views; complete public exports
for historically owned Collections; separate public authored and tagged Moment
views; and public Capsules whose archived owner is the address. A private or
hidden Drop can also be opened when its exact ID is known. Drop browse, search,
batch export, and Collection projections continue to exclude private and hidden
Drop metadata; an exact Drop page may separately list the public holder
addresses preserved in Holdings.

The deployable ZIP remains metadata-focused: its generated page mounts an image,
video, or audio source only after a visitor explicitly asks to load it. A
separate, opt-in browser export can download the address's deduplicated archived
images as an image ZIP without putting those binaries into the website package.
It accepts only immutable objects in the active Archive, Collections, or
Holdings snapshot namespaces; preserved mutable source URLs are never download
targets. Video and audio are not included in that image archive. The website
ZIP also includes integrity metadata and deployment prompts for Cloudflare,
Vercel, Filebase, and ICP. After extraction, `index.html` can be opened directly
without a local server; the same files remain deployable to an ordinary static
origin.

See [Portable personal-site export](docs/personal-site-export.md) for the API,
data, packaging, media-loading, and deployment contracts. The legacy one-file
CSV/JSON address downloads remain capped at 5,000 holdings; the personal-site
flow follows keyset pages and does not inherit that whole-response limit.

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
