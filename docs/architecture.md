# Architecture

POAPin Archive is a read-heavy, snapshot-based application. Its architecture is
optimized for bounded work per request, independently replaceable data, and a
service that remains understandable to future maintainers.

## Request path

1. Cloudflare serves the Vite-built React application as static Worker assets.
2. The browser requests a public `/api/*` resource from the Hono Worker.
3. An eligible, snapshot-versioned response may be served from edge cache.
4. On a miss, the Worker validates and bounds input, then queries the one D1
   binding responsible for that dataset.
5. Artwork is addressed by immutable R2-backed URLs and is not transformed in
   the request.
6. The Worker returns explicit cache, content-type, and security headers.

The UI never needs direct D1 or R2 credentials.

## Components and boundaries

### React and Vite

The client is responsible for navigation, progressive rendering, and exposing
bounded server-side export controls. It must remain usable without wallet
extensions. Static assets should be content-hashed and cached immutably.

### Hono Worker

The API boundary owns validation, stable response shapes, cursor encoding, and
hard limits. Routes should issue a small, predictable number of indexed
queries. Expensive aggregation, fuzzy indexing, image processing, or whole-file
parsing belongs in the import pipeline.

### D1 catalog

`CATALOG_DB` contains snapshot metadata and event/drop records. Its query shapes
are browse, exact ID lookup, bounded filtering, full-text search, and
deterministic sorting. Counts and normalized search input should be produced
during import.

### D1 holdings

`HOLDINGS_DB` maps normalized addresses to token and drop identifiers. Separating
it from the catalog isolates a much larger relation, makes address export
traffic visible, and leaves room to shard or replace holdings storage without
rewriting catalog routes.

API responses may join the two datasets in application code only with bounded
ID lists. Never implement an unbounded request fan-out.

### D1 Collections

`COLLECTIONS_DB` preserves the independently captured POAP Compass Collections
view: collection profiles, URLs and UI settings, memberships, ordered sections,
artist and organization records, suggestions, referenced drop cards, and
Collection branding metadata. It deliberately has its own
`COLLECTIONS_SNAPSHOT_ID`; a new Collections capture must not force the much
larger fixed catalog and holdings snapshot to be rewritten.

Collection slugs are not unique. Public identity, cache keys, pagination, and
foreign relations use numeric `collection_id`. Lists and relation exports use
indexed keyset cursors with hard page limits. A collection export is a manifest
of bounded metadata, items, artist-drop, approved-suggestion, and drop-statistics
segments rather than a single unbounded Worker response. Drop-statistics pages
deduplicate all three public relation sources, expose only aggregate email-claim
counts, and fetch per-chain rows only after private and hidden drops are redacted.

#### Public drop-statistics contract

Visible drop cards returned by `items`, `artist-drops`, and approved
`suggestions` include `tokenCount`, `transferCount`,
`emailClaims { minted, reserved, total } | null`, `featuredOn`, and
`momentsUploaded`. Email claims are aggregate counts only; raw claims and claimant
identities are never part of the public projection. Pending, rejected, or any
other non-approved suggestion status is excluded from both the suggestion export
and statistics coverage.

`GET /api/collections/:id/export/drop-stats` returns the deduplicated union of
the collection's items, artist drops, and approved suggestions. A visible entry
contains the same aggregates plus
`byChain { chain, createdOn, poapCount, transferCount }[]`; `createdOn` is the
source Unix-seconds integer, or `null` when the source omitted it. Privacy is
resolved before the per-chain lookup:

- hidden drops return only `{ dropId, isHidden: true }`;
- private or fail-closed drops return only `{ dropId, isPrivate: true }`; and
- a referenced card missing from the projection returns only `{ dropId }`.

No title, aggregate, media field, or per-chain row accompanies those ID-only
forms. The export manifest lists `drop-stats` only when the collection has at
least one eligible item, artist-drop, or approved-suggestion relation.

The endpoint accepts `limit=1..48` and defaults to 24, so a page contains at
most 48 unique drop IDs. Per-chain output is limited to 16 rows per visible drop
and 768 rows across a page; an imported shape beyond either boundary fails with
`503 collections_shape_unsupported` instead of truncating data. The secondary
query receives only the page's visible IDs and uses at most 49 bindings: 48 IDs
plus its row limit.

Pagination is keyset-based. `nextCursor` is bound to the Collections snapshot,
numeric collection ID, `drop-stats` segment, normalized filter, and page limit;
reusing it across a different snapshot, collection, segment, or limit returns 400. Clients should follow the returned `nextPath` unchanged until it becomes
`null`.

Every Collections read checks both the configured snapshot ID and the D1
readiness marker. A fully loaded staging database remains unavailable until its
eligible media has been published and a separately reviewed finalizer marks the
same snapshot ready.

### D1 Moments

`MOMENTS_DB` preserves authored Moments independently from the fixed Drop
archive and Collections. It stores normalized Moment content, many-to-many Drop
relations, links, user tags, explicit capsules, public visibility decisions,
suppression state, verified media descriptors, and the derived
Moment-to-Collection projection. Raw gateway URLs and unrestricted media
metadata remain outside the serving database.

The public view requires an affirmative visibility row, at least one Drop, no
relationship to a Moments-hidden Drop, and no active suppression. A media row
becomes public only after its content-addressed R2 object has been verified.
Metadata-only releases preserve source media counts while exposing no object
keys, allowing the browser to distinguish pending preservation from a genuinely
text-only Moment.

Every Moments request checks the configured snapshot, source-database digest,
build-manifest digest, and activation marker. A new D1 release is staged under a
new database UUID and stays unavailable until the resumable import journal,
table counts, projection, indexes, foreign keys, and integrity checks pass.

### R2 media

`ARCHIVE_BUCKET` stores source artwork and eligible Collection logos and banners
under immutable snapshot-scoped keys. The first version serves originals;
thumbnail or format variants, if introduced, should be generated asynchronously
or during import and stored as separate immutable objects. A request must never
wait for a transform.

The database stores object identity and integrity metadata, not time-limited
signed URLs. Missing media should degrade to an accessible placeholder.

### Workers Cache

Cache is safe only for deterministic public GET/HEAD responses. Cache keys must
include the active snapshot ID plus every normalized input that changes the
response. Do not cache errors by default, responses with `Set-Cookie`, operator
endpoints, or future personalized/authenticated routes.

Collections additionally requires `COLLECTIONS_RELEASE_ID`, which identifies a
specific activated D1 binding and public projection release. The Worker composes
it into both the Collections API version header and every Collections cache key.
It must change whenever that binding or its published contents change, even when
`COLLECTIONS_SNAPSHOT_ID` remains the same. Cache hits therefore need no D1
readiness query merely to detect a replacement release.

Moments cache keys additionally include `MOMENTS_RELEASE_ID`, the expected
source-database SHA-256, and the exact build-manifest SHA-256. The same digests
must exist in the activated D1 metadata, binding a cache namespace to one
verified database build rather than only a logical snapshot name.

The Cache API is data-center-local and does not replace persistent storage.
Where Workers caching can serve a response before Worker execution, prefer it
for truly public, versioned resources. Use explicit `Cache-Control` and
snapshot-versioned cache keys. A new snapshot ID creates a new namespace, which
makes activation cheap and rollback explicit.

## Data lifecycle

A snapshot moves through these states:

1. **Acquired** — the original ZIP is checksummed and recorded without changes.
2. **Inventoried** — file types, schemas, counts, encodings, and media references
   are documented.
3. **Staged** — normalized rows and R2 objects are loaded under a new snapshot
   ID, invisible to public routes.
4. **Validated** — counts, references, samples, indexes, and exports pass checks.
5. **Active** — configuration points public routes at the complete snapshot.
6. **Retired** — the snapshot is no longer the default but remains identifiable
   for rollback or audit according to retention policy.

Activation happens after data and media publication, never halfway through an
import. See [Data import](data-import.md).

The fixed archive ZIP, Compass Collections, and Compass Moments are separate
sources. Compass does not expose a transaction spanning GraphQL requests, so
Collections and Moments releases each require two independent full captures
with identical canonical row counts and SHA-256 digests. These are auditable
API-level captures, not physical copies of the source PostgreSQL database.

## Query and CPU rules

- Require indexed predicates for every public list route.
- Prefer keyset cursors over offset pagination.
- Cap requested page sizes and total export records.
- Select only fields needed by the response.
- Avoid regular expressions, decompression, image decoding, and large JSON
  parsing in Worker requests.
- Put deterministic work in the importer and reuse its output.
- Treat D1 rows read and R2 operations as first-class performance metrics, not
  just Worker wall time.
- Fail closed on malformed cursors and unreasonable input.

These are review rules, not aspirations: a change that introduces an unbounded
path should not merge without an explicit design decision.

## Privacy and abuse boundaries

Public blockchain data is not permission to build behavioral profiles. The
service should collect no account identity, avoid third-party trackers, and
keep operational logs free of response bodies and exported histories. Address
lookups should be rate-limited if traffic shows enumeration or cost abuse.

All export responses must identify the snapshot and capture time. They make no
claim about current ownership.

## Failure model

- A cache failure falls back to a bounded origin read.
- Missing artwork falls back visually without failing the record response.
- One malformed record is quarantined during import, not discovered repeatedly
  on user requests.
- D1 overload returns a short retryable error; the Worker does not amplify it
  with retries.
- Snapshot activation is reversible because old, immutable snapshot data is not
  overwritten in place.

## Deferred decisions

The following require evidence from the source ZIP and load testing:

- final source-to-target field mapping;
- whether the initial D1 FTS index remains the best search strategy at full
  snapshot scale;
- holdings sharding thresholds;
- maximum synchronous export size and whether large exports need an offline
  job; and
- thumbnail dimensions, formats, and generation schedule.
