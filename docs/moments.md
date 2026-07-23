# Moments preservation

POAP Moments is a user-generated memory layer around POAP drops. POAPin
preserves Moment records as content and treats drops, collections, people, and
capsules as ways to organize that content. Those concepts intentionally do not
share one table or one meaning.

## Product model

The public Compass schema contains several similarly named concepts:

- A **Moment** is the authored record. It may contain text, media, links, user
  tags, and one or more drop relationships.
- A **drop album** is the feed of public Moments related to one POAP drop. The
  current POAP Moments product also presents featured drops as “Featured
  Capsules”; this is a product view over a drop, not a row from
  `moments_capsules`.
- A **collection album** is a POAPin projection derived through
  `Moment -> Drop -> Collection item -> Collection`.
- A **personal timeline** groups Moments created by, or explicitly tagging, an
  address. It is not proof that the address currently owns a related POAP.
- A **curated capsule** is an explicit `moments_capsules` container joined
  through `moments_capsule_moments`. This source model is preserved, but empty
  or unlinked containers are not promoted as public albums.

The archived Web project's “Time Capsule” was a personal chronological view. It
did not read `moments_capsules` and should not be used as evidence that a curated
capsule exists.

## Measured source shape

The research inventory on July 23, 2026 observed the following anonymous
Compass state before the reproducible capture was built:

| Entity or projection                     |   Rows |
| ---------------------------------------- | -----: |
| Moments                                  | 25,959 |
| Moments related to at least one drop     | 25,182 |
| Default Explore public projection        | 24,459 |
| Moments on eight hidden drops            |    723 |
| Moments without a drop relationship      |    777 |
| Media records                            | 32,891 |
| Media related to a Moment                | 27,746 |
| Media in the default public projection   | 26,199 |
| Orphan media with no Moment              |  5,145 |
| Media gateways                           | 64,862 |
| User tags                                |  1,638 |
| Links                                    |    210 |
| Explicit capsules                        |      7 |
| Explicit capsule-to-Moment relationships |      0 |

Only five Moments had a non-null `token_id`. The primary semantic relationship
is therefore to one or more POAP drops, not to an individual minted token. The
legacy singular `drop_id` is not a safe replacement for the many-to-many
`moments_moment_drops` relationship.

These numbers are research observations, not release assertions. A published
snapshot records its own bounded counts and checksums.

## Preserved structured release

The `moments-2026-07-23-v1` release was captured twice into independent local
directories. Both passes contain 1,376 raw GraphQL pages, 136,970 raw rows, and
163,491 normalized rows. All twelve normalized artifacts compare byte-for-byte
without a row, window, or digest difference.

| Artifact                  | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Pass 1 manifest           | `1628dd0f02970bf13fe90635029821dc4e90af9975ca05546ff39a47fd590a71` |
| Pass 2 manifest           | `a3c5a65ba08dba9c308343803a9f622c9b5b165e698e8a02494dbd42266b2389` |
| Pass 1 structured package | `2ce28ad3dca6f15f0ec5f5b033e878ab2f5e484a597e2eb30e81075e4a594be2` |
| Pass 2 structured package | `200b49ddd87fe26a7d21599189e5a58479c7dbe26b8c2605cb933b62a181e52b` |

The two packages and checksum sidecars are stored in the private
`poapin-moments-backups` bucket under
`backups/moments/moments-2026-07-23-v1/structured/`. Each package was streamed
back from remote R2 and matched against its local SHA-256 digest.

The derived Collection projection contains 35,071 Moment-to-Collection pairs,
covering 15,614 Moments and 835 Collections. Its canonical NDJSON digest is
`9c8ffecf23b2834fbf994bb3b72f22f74a877e4253eaec122ddc31199dbf9976`.

### Media-bound serving release

The first serving release publishes 24,459 public Moments. Its finalized media
manifest contains 32,891 rows: 26,198 public objects, 3,505 private preserved
objects, and 3,188 explicit source-missing terminals. Content addressing reduces
the stored set to 30,548 unique R2 objects.

Every stored object passed two independent authenticated remote HEAD scans with
zero failures. Pass 2 binds the raw SHA-256 of pass 1, and the D1 builder
recomputed the complete object set from the immutable capture and recovery
journals before accepting either report.

| Release evidence            | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Stored-object set           | `f8ebe6e77bedea3aced76a78d53096d3893f82593a1daf56551d1784a643b079` |
| Remote verification pass 1  | `8ac335e7ce752eb0bf479b8249d2b415c154eead071c84864346f9fb8d5b57f5` |
| Remote verification pass 2  | `5f101ddce68799ffb1a057d0334c9cf0b84c69e16f429d2df6cb3e61ca480c11` |
| Remote verification chain   | `8f5af63eb67cb64279a09961fd0556f76c9472224550b0256f50da0bfa54b1cb` |
| Source database             | `d1ffe1d63601f7109bc1c3f87a4e72b1bc91a29f21b92a87c0b037be64fa55cd` |
| Activated D1 build manifest | `21ef4c8ef6351b59a92210cd0ba4631c5e9ef9034ec0dd5b0ddf9ac3dd702bf3` |

## Snapshot boundary

Compass exposes an anonymous read-only GraphQL role, but not a transaction that
spans requests. The service also caps a root list at 100 rows, rejects multiple
root fields in one operation, and enforces a query-complexity ceiling. The
capture therefore:

1. saves the complete observed introspection schema and exact query text;
2. freezes a deterministic upper boundary for every independently pageable
   root;
3. uses keyset pagination with stable tie-breakers and a page size no greater
   than 100;
4. captures Moment-to-drop rows through the nested relationship because that
   join is not available as an anonymous root;
5. refuses to accept a nested relationship that reaches its configured hard
   limit;
6. preserves raw response pages and separately writes canonical NDJSON;
7. records counts, byte lengths, and SHA-256 digests in a manifest;
8. repeats the structured capture and requires canonical artifacts to match;
   and
9. documents that deleted history, private fields, and a database transaction
   boundary are outside the API-level snapshot.

The raw package and operational gateway metadata remain private. The D1 build
is a separate, deliberately smaller serving projection.

## Public projection

Publishing fails closed. A Moment is eligible only when all of the following
are true in the activated snapshot:

- it is explicitly present in the release allowlist;
- it has at least one normalized drop relationship;
- none of its related drops is in the Moment hidden-drop set;
- it has no active POAPin suppression; and
- every emitted media URL points to a verified public R2 object.

The initial public projection follows the current POAP Moments Explore
semantics. Hidden-drop Moments, no-drop Moments, orphan uploads, invalid media,
raw source URLs, and unrestricted gateway metadata are retained only in the
private preservation layer. A later reviewed release may make a narrower or
broader selection, but must never broaden visibility merely because a row was
reachable through the source API.

User-tag addresses are historical source fields, not identity claims. Public
gateway metadata uses an allowlist such as media kind, dimensions, byte length,
and the POAPin object digest. Camera identifiers, software strings, location,
unreviewed EXIF, redirects, source ETags, and upstream operational fields do not
enter the public D1 response.

## Storage layout

Moments has an independent `MOMENTS_DB` and release identifier. The database
stores normalized records, relations, public media descriptors, materialized
collection relationships, precomputed counts, and release metadata. It does
not store media bytes.

The private source package and non-public media use a private R2 bucket with no
public development URL or custom domain. Public, verified objects use immutable
keys in the existing media origin:

```text
snapshots/<moments-snapshot-id>/moments/original/sha256/<prefix>/<sha256>.<ext>
snapshots/<moments-snapshot-id>/moments/thumbnail/sha256/<prefix>/<sha256>.webp
```

An upstream hash is evidence, not authority. Every downloaded object is hashed
from its bytes before publication. Originals are preserved first; thumbnails
and other derivatives can be generated offline later and must record their
source digest and encoder provenance.

Media acquisition is a resumable operator job. It downloads one bounded object
to a temporary file, verifies type and digest, uploads immutable private and
eligible public copies, verifies the remote object, checkpoints the result, and
then removes the temporary bytes. This keeps local disk use bounded even when
the complete source is tens of gigabytes.

Objects above the single-request ceiling use a separately authenticated R2
multipart protocol. Its recovery journal is append-only and bound to the
capture plan, capture-checkpoint digest, recovery plan, normalized
`moment_media.ndjson` digest and row count, target buckets, part size, and byte
ceilings. Recovery and finalization first require the plan to cover every
normalized media key exactly once and the recovery plan to exactly cover the
latest capture rows that still require work. Recovery rows bind the capture
status/error/HTTP status and normalized SHA-256, while every original strategy
must require that same digest. A missing pass-one checkpoint row remains
unattempted. Every part is independently hashed and checkpointed; a restart
resumes the same upload ID and skips only recorded parts. Configuration and
per-object preflight both reject an upload that could exceed 10,000 parts
before creating an upload ID. Hash aliases are accepted only when downloaded
bytes match the normalized SHA-256. Each snapshot has one
recovery/finalization writer; the offline evaluator parses and hashes every
immutable NDJSON input from the same fixed-size descriptor snapshot, then
rechecks the inputs after output generation and rejects a concurrent append.

Unavailable originals may have private thumbnail or HLS derivatives preserved,
but those use explicit `private/derivative/...` keys and never satisfy an
original-media or public-projection gate. An offline finalizer combines the
immutable capture and recovery journals, emits public URLs only for verified
public originals, and regenerates the D1 media manifest and proof. The media
proof remains incomplete until all recovery rows are terminal and every
`publicEligible` media row has its public original. A derivative or
metadata-only result can terminate only a non-public row; a public row remains
resumable until a non-quarantined original is stored in the public target.
`publicEligible: true` is public-required even when an older media plan has a
null target; compatible recovered bytes go to the public original prefix and
incompatible bytes remain quarantined and nonterminal.
Public rows with no fixed candidate use a nonterminal
`public_original_required` plan placeholder. A legacy frozen plan or checkpoint
with a public `metadata_only` placeholder is accepted only as nonterminal
resume input and is superseded by `PUBLIC_ORIGINAL_REQUIRED`; it can never
satisfy completion. If all fixed recovery strategies for a non-public,
private-target row are exhausted, the append-only journal records a terminal
metadata-only result with the exact reason
`all_recovery_candidates_exhausted` and preserves the ordered per-strategy
failure audit. Finalization maps that result to `source_missing`; it rejects a
different reason, a mismatched attempt audit, or the same fallback on any
public row. Disk, network-transient, bridge authentication, R2, and multipart
failures remain failed and resumable rather than being reclassified as
exhausted source candidates. Only a capture error explicitly identified as
`SOURCE_HTTP_ERROR` with source HTTP 403, 404, or 410 is a permanent HTTP
candidate outcome; the same status from Bridge, WAF, R2, or another subsystem
remains retryable. Other generalized 4xx failures plan a retry when a canonical
source exists and otherwise retain a nonterminal `private_recovery_required`
gate. A separate reviewed-retirement rule covers the exact
legacy `cdn.registry.poap.tech` origin only when every retry of every candidate
has the exact direct `getaddrinfo ENOTFOUND` cause, the row is explicitly
non-public/private, and no other strategy exists; its candidate and attempt
counts are retained and validated. Any mixed or generic DNS/network result
remains failed.

## D1 release gate

The offline builder first requires `validation/stability.json` to bind the
canonical primary manifest to a distinct, later second capture and to prove all
normalized artifacts byte-identical. The report and secondary-manifest digests
become part of the serving database identity. The builder then emits canonical
schema migrations and byte-bounded data shards. No generated file contains
explicit transaction control; each data shard records an `import_shards` marker
beside its rows so an interrupted load can resume without replaying committed
work. A first-shard import plan sets exact row ceilings before source rows are
loaded; database triggers reject later inserts beyond those ceilings and reject
all source-row updates or deletes. Every artifact is imported from a fresh,
checksum-verified private copy.

A media-bound build also requires two separately written remote HEAD
verification reports. Each report binds the snapshot, canonical HTTPS bridge
origin, exact public/private bucket names, media plan, media manifest and
proof, normalized media, capture checkpoint, selected recovery inputs, stored
object count, and a deterministic digest of the complete stored-object set.
The public and private bindings must name different physical buckets; a
private-looking prefix in a public bucket is not accepted as isolation.
The selected checkpoint mode is explicit: `capture-only` requires
`recovery: null`, while `recovery-finalized` requires the exact recovery-plan
and recovery-checkpoint SHA-256 digests. The two reports must have identical
bindings, zero failures, `stored = verified`, different file digests, distinct
128-bit CSPRNG run IDs, and non-overlapping canonical UTC intervals. Pass 2
also binds the raw-file SHA-256 of pass 1. Timestamp-only copies, reused run
IDs, and a different predecessor are rejected.

`capture-only` is eligible only when every public-eligible media row is
`public_stored` and no non-public row remains failed, oversize, or
unattempted. An explicit `source_missing` result is accepted as a metadata-only
terminal only for a non-public row. Every other state must be covered exactly
by a recovery plan and finalized as `recovery-finalized`. Older proofs without
an explicit checkpoint mode are not inferred or upgraded in place.

The D1 builder does not trust those reports for the object inventory. It
re-evaluates the plan, normalized media, capture journal, recovery plan,
recovery journal, manifest, and proof, then recomputes the exact object set
before accepting either report. Raw reports are copied into the package under
content-addressed `evidence/media-verification/` paths. The loader requires
regular non-symlink files with the declared sizes and SHA-256 values and
revalidates the chain. This is local operator audit evidence against stale
inputs and mistakes, not third-party unforgeability against an operator who
controls both code and bridge credentials.

Remote publication is split into four phases:

1. `preflight` resolves the exact D1 name and UUID and requires a pristine
   staging database;
2. `load` applies the canonical schema and resumable data shards while
   `moments_meta.ready` remains `0`;
3. `verify` checks schema definitions, source-bound row and shard counts,
   foreign keys, database integrity, indexes, media status counts, and the
   fail-closed public views, then writes a target-bound report; and
4. `activate` rechecks the unchanged remote state, stores the build-manifest
   and verification-report digests, and uses one atomic guarded update to
   change `ready` to `1` only while the complete staged state still matches.

An initial metadata-only release is explicit in both the D1 build manifest and
verification report. All media rows remain `pending`, `media.ready` is false,
and activation requires the additional `--allow-metadata-only` guard. A later
media-bound build uses a new release identifier and repeats the complete gate.

Runtime publication is bound to the exact database identity, not only its
logical snapshot name. The deployment carries the expected source-database and
build-manifest SHA-256 digests; D1 readiness must match both values and the
activated snapshot. Those digests also participate in the Moments cache
namespace, so replacing a binding cannot reuse a prior cached response.

Public Moment responses expose `sourceMediaCount`, the count of source media
relationships, separately from `mediaCount`, the count of verified public R2
objects. `mediaPreservationState` is `none`, `pending`, `partial`, or `complete`
from those two counts, so a metadata-only release never presents pending media
as a text-only Moment. No pending object key or source gateway URL is exposed.

## Public routes

The first serving release supports:

- `/moments` — the public Moment hub;
- `/moments/:id` — one Moment and its reviewed relationships;
- `/owners/:address/moments` — Moments authored by an address, with an explicit
  label that author is not current owner;
- drop and Collection Moment feeds; and
- bounded JSON/CSV metadata export assembled without server-side archive
  compression.

Until derived thumbnails are published, Hub cards use local placeholders
instead of treating an R2 original as a thumbnail. Detail pages mount no
archived image, video, audio, link image, or capsule image on first render.
Images load individually or in batches of at most four after an explicit
choice; audio and video players are mounted only after a click and retain
`preload="none"` without autoplay. DNG and HEIC originals remain download-only.

The UI may call a drop album a Capsule when that matches the product context,
but URLs, API fields, and accessibility text distinguish it from an explicit
curated capsule. Curated-capsule navigation is enabled only when the activated
snapshot contains public capsule relationships.

## CPU and cache rules

All parsing, hashing, media inspection, collection materialization, and export
shard generation happen before deployment. Worker requests use indexed D1
predicates and stable cursors, select bounded rows, and return precomputed media
descriptors. The Worker does not decode media, generate thumbnails, crawl
Compass, or create ZIP files.

Public JSON responses are cached under the Moments snapshot and release IDs.
Immutable objects on `media.poap.in` use Cloudflare Cache through the R2 custom
domain after a user requests them. Private or authenticated responses are
never placed in the public cache.

## Suppression and takedown runbook

A public takedown is an ordered operation. Complete every step before treating
the request as resolved:

1. insert a new applicable D1 suppression row with `active = 1` (suppression is
   monotonic; do not update or delete an existing row);
2. bump `MOMENTS_RELEASE_ID` and deploy the Worker so new API cache keys cannot
   reuse the suppressed release;
3. delete every affected object from the public R2 bucket while retaining the
   private preservation copy;
4. purge the affected API responses from the Worker Cache API and Cloudflare
   cache, and purge each affected `media.poap.in` URL; and
5. verify that public list, detail, drop, Collection, and export APIs no longer
   return the suppressed record, and that every deleted public media URL is no
   longer accessible from R2 or the Cloudflare edge.

Do not rely on the D1 suppression alone: previously cached API responses and
direct media URLs remain independently reachable until their cache entries and
public objects are removed.
