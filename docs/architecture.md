# Architecture

POAPin Archive is a read-heavy, snapshot-based application. Its architecture is
optimized for bounded work per request, independently replaceable data, and a
service that remains understandable to future maintainers.

## Request path

1. Cloudflare serves the Vite-built React application as static Worker assets.
2. The browser requests a public `/api/*` resource from the Hono Worker.
3. An eligible, snapshot-versioned response may be served from edge cache.
4. On a miss, the Worker validates and bounds input, then queries one D1 binding.
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

### R2 media

`ARCHIVE_BUCKET` stores source artwork under immutable keys. The first version
serves originals; thumbnail or format variants, if introduced, should be
generated asynchronously or during import and stored as separate immutable
objects. A request must never wait for a transform.

The database stores object identity and integrity metadata, not time-limited
signed URLs. Missing media should degrade to an accessible placeholder.

### Workers Cache

Cache is safe only for deterministic public GET/HEAD responses. Cache keys must
include the active snapshot ID plus every normalized input that changes the
response. Do not cache errors by default, responses with `Set-Cookie`, operator
endpoints, or future personalized/authenticated routes.

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
