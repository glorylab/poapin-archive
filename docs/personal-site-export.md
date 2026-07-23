# Portable personal-site export

POAPin Archive can assemble an address-scoped, read-only website entirely in
the browser and download it as a ZIP. The Worker exposes bounded, independently
cacheable JSON pages; it never builds or compresses the website. This keeps a
large export out of the Worker CPU and memory path and leaves the downloaded
copy under the user's control.

The export describes three independently released snapshots:

- the fixed Holdings and Drop archive;
- the POAP Collections release; and
- the public POAP Moments release.

It is historical archive data, not a statement of current ownership.

## Collection and packaging flow

The browser performs the following steps:

1. Request `GET /api/owners/:address/export/manifest`. The response identifies
   all three snapshots; exact Holdings, authored-Moment, tagged-Moment,
   owned-Collection, and owner-matched Capsule counts; and the first paginated
   path for each primary segment. It also binds Collections to its release ID
   and Moments to its release ID, source-database SHA-256, and build-manifest
   SHA-256.
2. Follow the Holdings cursor until every token in the manifest count has been
   collected. For every page, require its unique token `dropId` references to
   be partitioned exactly between public `drops` and opaque
   `unavailableDropIds`.
3. Follow the public authored-Moment and tagged-Moment cursors separately and
   require one unchanged Moments release across both datasets.
4. Follow the owner-Capsule cursor independently so public Capsules without a
   related public Moment are not lost.
5. Resolve unique held Drop IDs with public details to formal Collection
   memberships in batches of at most 96. IDs already classified unavailable
   are not sent to the Collection resolver.
6. Page through Collections whose normalized archived owner address exactly
   matches the requested address.
7. Fetch complete Collection profiles in batches of at most 16 for the union of
   held-Drop, owned-Collection, authored-Moment, and tagged-Moment Collection
   IDs.
8. For each owned Collection, fetch its export manifest and follow every
   declared `items`, `artist-drops`, `suggestions`, and `drop-stats`
   `nextPath` to `null`. Optional segments that are absent from the Collection
   manifest remain absent; a declared segment must be collected completely.
9. Form the union of Drop IDs referenced by Holdings, authored and tagged
   Moments, and every owned-Collection segment. Resolve IDs not already
   classified by the Holdings pages through
   `GET /api/drops/export/batch?ids=…` in batches of at most 96.
10. Generate a pure-static site, encode every file as UTF-8, and compress the
    files to a ZIP in the browser.

The collector rejects repeated cursors, paths, token identities, and Collection
IDs. Moment identities must be unique within each authored or tagged segment;
the same Moment may legitimately appear once in both because authorship and
tagging are separate relationships. Capsule IDs are unique in the owner-Capsule
segment. The collector also rejects count, address, schema, release, or snapshot
changes between pages. Requests are paced, `429 Retry-After` responses are
handled with bounded retries, and cancelling the browser operation aborts both
collection and ZIP creation.

Nothing in this flow writes a server-side export job, temporary R2 object, or
private export state. The bounded JSON responses are public and deterministic;
the Worker may edge-cache them under canonical keys that include the normalized
address and relevant release identity, while sending browser `max-age=0` on the
address-scoped export routes.

## Holdings and normalized Drop records

The legacy address browser joins a small Holdings page to a Drop summary. The
personal-site endpoint instead returns one token array and two availability
partitions:

- token-level `items` containing `sourceUid`, `poapId`, `dropId`, `mintedOn`,
  archived owner address, network, and transfer count;
- page-unique `drops` containing each referenced public Drop's numeric and
  fancy IDs, title, description, dates, location, classification, safe event
  and immutable artwork URLs, and public aggregates; and
- page-unique `unavailableDropIds` containing only a referenced positive Drop
  ID when no public detail can be returned.

The Worker first reads a keyset page from `HOLDINGS_DB`, then loads the
corresponding unique public Drop details from `CATALOG_DB` in fixed 96-ID
lookups. It does not perform an unbounded cross-database join, and multiple
tokens from the same Drop do not repeat that Drop's metadata in either
availability array. `drops` contains public details only. A private or missing
Catalog Drop is represented only by its ID in `unavailableDropIds`; those two
cases are intentionally indistinguishable, and the response contains no
reason, placeholder metadata, private description, URL, artwork, or aggregate.

For each page, the unique `dropId` set referenced by `items` must equal the
disjoint union of `drops[].dropId` and `unavailableDropIds`. An ID can never
appear in both. This is a strict completeness and privacy invariant, not a
best-effort hint.

`GET /api/owners/:address/export/holdings` accepts `limit=1..480`. Its cursor is
bound to the normalized address, page limit, Holdings snapshot, and export
scope, so it cannot be reused for a different query.

The browser validates that exact partition on every page, merges the token
references, deduplicates unchanged public Drop records across pages, and keeps
a unique unavailable-ID set. If an ID changes between public and unavailable
across pages, collection stops rather than guessing.

## Complete Drop reference coverage

Holdings are not the only source of Drop references. Public authored and tagged
Moments contain Drop IDs, and historically owned Collection segments may
contain IDs in items, artist-Drop relations, approved suggestions, and Drop
statistics.

After those datasets are complete, the collector computes their union with the
Holdings references. It requests every still-unclassified ID through
`GET /api/drops/export/batch?ids=…`. The endpoint accepts 1–96 submitted IDs;
it validates the submitted comma-separated part count before deduplicating and
sorting the canonical request. Its response contains:

- `requestedDropIds`, the canonical requested set;
- `drops`, public complete Drop details only; and
- `unavailableDropIds`, IDs for which public details were not returned.

The latter two arrays must be disjoint and together cover every
`requestedDropId`. The collector rejects an unexpected, repeated, overlapping,
or omitted ID and requires the Holdings snapshot to remain unchanged. As with
Holdings pages, an unavailable ID deliberately does not reveal whether its
Catalog row was private or absent.

The final normalized public-Drop and unavailable-ID sets therefore partition
every Drop reference packaged from Holdings, authored/tagged Moments, formal
held-Drop memberships, and owned-Collection segments.

## Three Collection meanings

The generated site keeps three relationships distinct even when the same
Collection appears in more than one:

1. **Held-Drop Collection** — at least one Drop represented by the address's
   archived holdings is a formal `collection_items` member. Artist-Drop links
   and approved suggestions do not establish this relationship.
2. **Owned Collection** — the Collection snapshot's normalized
   `owner_address` exactly equals the requested address. This means ownership
   recorded by that historical snapshot, not current control. Owned
   Collections receive the complete public segmented export.
3. **Authored-Moment Collection** — a public Moment authored by the address is
   associated with the Collection through the preserved
   Moment-to-Collection projection. These associations are retained even when
   the address holds no Drop from, and did not own, that Collection.

These are personal-export relationship scopes. They are unrelated to the
Collection record's `artist`, `organization`, or `user` type classification.

The Moment-to-Collection projection is built offline from formal
Moment-to-Drop and `collection_items` Drop relations. Like held-Drop
resolution, it does not treat artist-Drop links or suggestions as membership.
It describes a content relationship; it does not say that the Moment author
owns or joined the Collection.

Held-Drop membership resolution receives only IDs for which the Catalog
returned public Drop detail. An opaque `unavailableDropId` is preserved as a
reference but is not sent to the Collection resolver, so the service does not
use another dataset to distinguish a private Drop from a missing one.

Profiles are fetched once for the union of those IDs. The reasons remain in
their respective records: held-Drop membership rows, owned-Collection exports,
and each Moment's Collection IDs. Multiple tokens for the same held Drop are
deduplicated before membership resolution and do not multiply the relationship.

Tagged-Moment Collection associations are also retained so the separately
tagged Moment view has its Collection context. They are not promoted into one
of the three scopes above: being tagged in content does not mean the address
authored the Moment, held a member Drop, or owned the Collection.

The relevant bounded APIs are:

| Purpose                                 | Endpoint                                      | Bound                                                        |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Resolve formal held-Drop memberships    | `GET /api/collections/resolve?drop_ids=…`     | 1–96 submitted IDs; 4,096 distinct Collection/Drop relations |
| Page archived owner matches             | `GET /api/collections/owners/:address/export` | 48 Collections per page                                      |
| Fetch complete profiles                 | `GET /api/collections/export/batch?ids=…`     | 1–16 submitted Collection IDs                                |
| Discover an owned Collection's segments | `GET /api/collections/:id/export`             | Manifest only                                                |
| Read each paginated owned segment       | paths returned by that manifest               | 48 records per page                                          |

ID-list endpoints canonicalize their accepted input by deduplicating and
sorting it, but the submitted comma-separated part count must still fit the
stated bound. More than 4,096 distinct formal Collection/Drop relations returns
`503 collections_shape_unsupported`; that number is not a limit on top-level
Collection objects.

A batched profile remains fail-closed at 100 URLs, 4 media records, 100
sections, 16 artists, and 16 organizations per Collection. A profile exceeding
those imported-shape bounds returns `503 collections_shape_unsupported`. The
batch API omits unknown IDs, while the browser collector requires every
requested profile and stops if any is unavailable.

The checked-in production configuration currently allows 60 owner-class
requests per minute, 120 browse/Collection-segment requests per minute, and
three legacy single-file exports per minute. The browser collector intentionally
paces requests below those ceilings and honors `Retry-After`; operators must
recheck deployed bindings before changing that pacing.

Private and hidden Collection Drop cards retain their existing ID-only public
forms. The personal-site builder does not reverse those redactions.

## Public Moments and Capsules

The personal site preserves three separate historical relationships from the
same activated Moments release:

| Relationship    | Endpoint                                   | Result                                                     |
| --------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Authored Moment | `GET /api/moments/authors/:address/export` | Complete public `MomentDetail` pages authored by address   |
| Tagged Moment   | `GET /api/moments/tags/:address/export`    | Complete public `MomentDetail` pages that tag address      |
| Owned Capsule   | `GET /api/capsules/owners/:address/export` | Public Capsules whose archived normalized owner is address |

All three endpoints accept `limit=1..48` and the personal flow uses 48. Authored
and tagged Moment endpoints may accept a media filter for other clients; the
complete personal export does not set one. Every response identifies the same
Moments snapshot, release ID, source-database SHA-256, and build-manifest
SHA-256, and every cursor is bound to its relationship scope and page size.

Each Moment export includes the public description, timestamps, content IDs,
Drop and Collection associations, preserved media descriptors, links, user
tags, and related Capsules. Authorship and tagging are not collapsed: a Moment
authored by and tagging the same address appears in both named datasets, while
a merely tagged Moment does not enter the authored dataset or establish the
Authored-Moment Collection relationship.

The Capsule export is a sibling dataset, not a projection of the two Moment
lists. It includes public, unsuppressed Capsules whose archived
`owner_address_norm` exactly equals the address, including a Capsule that has no
relation to any public Moment. Each record preserves its Capsule and external
IDs, title, description, verified image reference when available, safe URL,
source owner value, and creation time. Historical owner equality does not claim
current control.

Only rows in the activated public projections are eligible. Moments require
public visibility, at least one Drop, no link to a Moments-hidden Drop, and no
active Moment suppression. Capsules require public Capsule visibility and no
active Capsule suppression. Media URLs appear only for verified archived
objects. Private or suppressed source records are not copied into the ZIP.

## Static package contract

The generated folder contains:

- `index.html` and relative `assets/site.css` / `assets/site.js`;
- `manifest.json`;
- chunked `data/*.json` datasets;
- `README.md` and `DEPLOY.md`; and
- agent prompts for Cloudflare, Vercel, Filebase, and ICP.

`manifest.json` records the address, three snapshot IDs, Collections and Moments
release identities, Moments source/build digests, dataset and Drop-availability
counts, separate authored-Moment, tagged-Moment, and owner-Capsule coverage,
remote-media coverage, chunk paths, UTF-8 byte length, record count, and
SHA-256 digest of every generated file except `manifest.json` itself. Excluding
the manifest avoids a recursive self-digest. All paths are relative, and the
page uses hash navigation, so the same folder works at an HTTP origin, an IPFS
root, or an asset canister without server rewrites.

Public details remain in the `drops` dataset. Every referenced ID without
public detail appears once in the `unavailable-drop-references` dataset with
only its Drop ID and the generic `not-public-or-not-found` classification. The
manifest's `counts.uniqueDrops` counts public Drop records, while
`counts.unavailableDropReferences` counts the opaque unavailable references.
The two counts describe disjoint sets; the latter never separates private from
missing Catalog rows.

Data JSON chunks are strictly smaller than 4 MiB. The complete generated folder
contains at most 1,000 files, and every extracted file is at most 5 MiB. A
single record that cannot fit the data-chunk envelope stops generation instead
of producing an undeployable package. There is no separate aggregate ZIP-size
ceiling, so browser memory and the destination's total-upload limit can still
bound very large addresses.

The Overview route reads only `manifest.json`. POAPs, related Collections,
owned Collection segments, authored Moments, tagged Moments, and Capsules are
fetched from their JSON chunks only when the visitor opens the corresponding
tab. The Moments tab loads the three separately labelled Moment/Capsule
datasets.

Because those local files are read with browser `fetch()`, the extracted folder
must be served from a static HTTP origin; opening `index.html` directly through
`file://` is not the supported viewing path. Once hosted, the viewer needs no
POAPin API or database.

## Remote media policy

Artwork, Moment media, and Capsule images are not embedded in the ZIP. Their
archived HTTPS URLs remain in the JSON, but the static viewer does not attach an
image, video, audio, or source URL during initial rendering. It creates the
media element only after an explicit visitor click; audio and video use
controls, preload nothing, and do not start automatically.

This keeps ZIP size and destination storage cost proportional to metadata
rather than to the full media archive. A later visit that chooses to load media
still reads from the configured media host. If that host is unavailable, the
portable metadata remains readable but the remote object does not.

## Legacy downloads versus the paginated export

The original endpoints remain available:

- `GET /api/owners/:address/export.json`
- `GET /api/owners/:address/export.csv`

They synchronously stream one file and are capped at 5,000 holdings. An address
above that limit receives `413 export_too_large`. Those endpoints contain the
legacy address export and do not assemble Collections, Moments, a static
viewer, or deployment guidance.

The personal-site path has no equivalent whole-address response. It starts with
the versioned manifest and follows snapshot-bound keyset pages. Work per Worker
request remains bounded even when the complete browser-side export contains
more than 5,000 holdings.

## Deploying the generated package

Always verify `manifest.json` before publishing, keep `index.html` at the
published root, and preserve the generated relative paths. Provider limits,
pricing, retention, and authentication flows can change; review the linked
official documentation at deployment time.

### Cloudflare

[Cloudflare Drop](https://www.cloudflare.com/drop/) accepts a completed static
folder or ZIP and returns a `workers.dev` URL. An unclaimed deployment must be
claimed within the window shown by Drop to be retained. For repeatable
repository or CLI deployments, use the official
[Workers static-assets workflow](https://developers.cloudflare.com/workers/static-assets/);
the generated folder does not require application Worker code or an API
backend.

### Vercel

[Vercel Drop](https://vercel.com/drop) accepts a file, folder, or ZIP without a
build configuration. Deploy the generated package as already-built static
output, with `index.html` at its root. A Vercel CLI or Git project is optional,
not part of the package contract.

Vercel currently publishes
[no Drop-specific file-count or size caps](https://vercel.com/kb/guide/vercel-drop-vs-cloudflare-direct-upload).
That absence is not a guarantee that an arbitrarily large browser upload will
succeed, so validate the largest real package before recommending this path.
The source-size and source-file limits in Vercel's
[general limits](https://vercel.com/docs/limits) explicitly describe CLI
deployments and should not be presented as Vercel Drop limits.

### Filebase

For [Filebase Sites](https://filebase.com/docs/ipfs/sites/overview), upload the
extracted folder to an IPFS bucket, retain the root CID, and create or update a
Site with that CID. Filebase gives the Site an IPNS-backed URL; changing the
site updates the CID behind that URL. Pinning is an availability service, not a
claim that the data will remain available after the Site and all other pins are
removed. Large folders can be converted to CAR before upload as described in
the [Sites management guide](https://filebase.com/docs/ipfs/sites/managing-sites).

### Internet Computer

ICP does not consume the transport ZIP as a complete project by itself. Use an
[asset canister](https://docs.internetcomputer.org/references/application-canisters/)
and configure its asset directory to the extracted generated folder. The asset
canister is the standard static-frontend host on ICP and serves certified HTTP
responses. No application backend is required for this read-only site, but the
operator still needs an ICP project, identity, canister, and cycles.

## Operator checks

Before exposing the personal-site control in production:

- apply and verify the Collections owner index described in
  [Deployment](deployment.md#collections-owner-index-gate);
- smoke-test an empty address, a small address, an address above the legacy
  5,000-record limit, an address with all three Collection relationship types,
  an address with authored and tagged overlap, an independent owner Capsule,
  and authored/tagged image, video, and audio Moments;
- test Holdings and Drop-detail batch responses containing public, private, and
  missing IDs; require an exact public/unavailable partition and verify that
  private and missing entries remain indistinguishable;
- confirm a generated manifest against the extracted ZIP bytes, including
  `counts.unavailableDropReferences` and the
  `unavailable-drop-references` dataset;
- require the public and unavailable portable datasets to partition every Drop
  ID referenced anywhere in the package;
- serve the extracted folder locally and verify that Overview does not request
  data chunks or remote media;
- verify that each tab loads only its declared chunks and media remains idle
  until clicked; and
- cancel collection and ZIP creation at several stages to confirm no partial
  download is presented as complete.
