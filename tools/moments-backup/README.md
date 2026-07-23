# POAPin Moments metadata backup

This directory contains a standalone, resumable exporter for the Moments data
visible through POAP Compass. It preserves GraphQL responses and produces a
deterministic normalized projection suitable for verification and D1 import.

The tool does **not** download media bodies. It records `moment_media` rows,
gateway URLs, and gateway metadata so a separate media pipeline can make its
own privacy, retention, and object-storage decisions.

## Model

A Moment is the authored record. Its current Drop membership is represented by
the `moments.drops` many-to-many relation; the legacy `moments.drop_id` field is
preserved but must not be treated as the complete relationship.

Capsules are kept in the same archive domain because they group Moments and are
presented by the same product, but they are not Moments. They are stored as
independent `capsules` and `capsule_moments` entities. The two Moments and Drops
hidden/featured namespaces are both retained instead of assuming they are
equivalent.

## Commands

No command performs network access by default. `compare`, `verify`,
`build-collection-map`, and `build-d1` are local-only. Network capture requires
an explicit operational guard:

```sh
node tools/moments-backup/cli.mjs snapshot \
  --output data/moments/2026-07-23-v1 \
  --acknowledge-bulk-capture
```

Interrupted captures can be continued with the same endpoint and exporter:

```sh
node tools/moments-backup/cli.mjs snapshot \
  --output data/moments/2026-07-23-v1 \
  --acknowledge-bulk-capture \
  --resume
```

Verification checks captured schema and query hashes, every compressed raw
page, normalized hashes and row counts, strict key ordering, upper bounds, and
cross-entity references:

```sh
node tools/moments-backup/cli.mjs verify --input data/moments/2026-07-23-v1
```

Two independent captures can be compared without relying on capture times:

```sh
node tools/moments-backup/cli.mjs compare \
  --primary data/moments/run-a \
  --secondary data/moments/run-b \
  --output data/moments/run-a/validation/stability.json
```

The optional report atomically records both manifest digests and capture
windows plus a path-sorted comparison of every normalized artifact. Omitting
`--output` keeps the comparison on stdout only.

`build-d1` requires the canonical primary report at
`validation/stability.json`. The report must bind the primary manifest exactly,
identify a distinct secondary manifest with a complete later capture window,
and prove every normalized artifact byte-identical. The stability-report digest
and secondary manifest digest become part of the D1 source identity.

Build the reproducible Moment-to-Collection bridge from two verified source
snapshots:

```sh
node tools/moments-backup/cli.mjs build-collection-map \
  --input data/moments/2026-07-23-v1 \
  --collections-input data/collections/2026-07-22-v1
```

The command fully verifies the Moments snapshot. It independently checks the
Collections dataset manifest and the declared SHA-256, byte length, and row
count of `collections.ndjson` and `collection_drop_ids.ndjson` without
modifying the Collections snapshot. It then joins the canonical
`moment_drops.ndjson` relation through Drop IDs, removes duplicate pairs, and
writes UUID/Collection-ID sorted output to
`derived/moment_collections.ndjson`. The adjacent
`derived/moment_collections.report.json` binds both source manifests, all three
input artifacts, the output digest, and relationship counts. `--output
<ndjson>` can place both output files elsewhere.

Build Cloudflare D1-compatible, resumable SQL shards:

```sh
node tools/moments-backup/cli.mjs build-d1 \
  --input data/moments/2026-07-23-v1 \
  --snapshot-id moments-2026-07-23-v1
```

A media-bound build requires the finalized media result plus two independent
remote-verification reports. Pass the same repeatable option exactly twice:
first the canonical pass-1 report, then the pass-2 report whose
`previousReportSha256` is the SHA-256 of the raw pass-1 file:

```sh
node tools/moments-backup/cli.mjs build-d1 \
  --input data/moments/2026-07-23-v1 \
  --snapshot-id moments-2026-07-23-v1 \
  --media-manifest data/moments/2026-07-23-v1/media/d1-media-manifest.ndjson \
  --media-verification-report data/moments/2026-07-23-v1/media/verify-report-pass1.json \
  --media-verification-report data/moments/2026-07-23-v1/media/verify-report-pass2.json
```

Both reports must be complete, have zero failures, verify every stored object,
bind the same canonical object-set digest, use distinct 128-bit CSPRNG run IDs,
and have strictly ordered, non-overlapping time intervals. The builder rejects
a missing report, the same path twice, copied reports with the same file
digest, timestamp-only clones, reused run IDs, an incorrect predecessor,
reordered passes, or a report whose checkpoint binding differs.

The reports are not trusted as a source of object counts. `build-d1` reruns the
same pure evaluator as media finalization over the selected media plan,
normalized media, capture checkpoint, recovery plan, and recovery checkpoint.
It recomputes the exact manifest, proof, stored-object count, and object-set
digest, then requires both reports to match. Defaults select the journals
inside `<input>/media`; relocated immutable journals can be selected with
`--media-capture-checkpoint`, `--media-recovery-plan`, and
`--media-recovery-checkpoint`. Recovery overrides are rejected for a
`capture-only` proof, and all journal options are rejected for a metadata-only
build.

Each raw verification report is copied into the D1 package at
`evidence/media-verification/passN-<sha256>.json`. Those content-addressed,
relative paths, byte sizes, SHA-256 values, pass metadata, and the complete
chain digest participate in `sourceDatabaseSha256`. The loader requires each
path to remain inside the package, be a regular non-symlink file, and match its
declared size and digest.

This is local operator audit evidence against stale inputs and accidental
substitution, not a third-party signature or a claim of unforgeability against
an operator who controls the source and bridge secret.

Each media-manifest line has this contract:

```json
{
  "mediaKey": "source key",
  "objectKey": "snapshots/moments-v1/moments/original/sha256/ab/abcdef...webp",
  "sha256": "64 lowercase hex",
  "byteLength": 1234,
  "contentType": "image/webp",
  "status": "public_stored"
}
```

`objectKey` is nullable. It is written into the public D1 projection only when
`status` is exactly `public_stored`; all other statuses retain audit metadata
without exposing an object key.

Public keys use the content-addressed layout
`snapshots/<snapshot>/moments/original/sha256/<prefix>/<sha>.<ext>`. The accepted
statuses are `pending`, `public_stored`, `private_stored`, `missing`,
`quarantined`, and `failed`. Optional `width`, `height`, and `durationMs` fields
are copied into D1.

The adjacent file with the same basename and a `.json` extension is mandatory.
It binds the manifest digest and row count to the canonical snapshot ID and
media-plan digest, records both capture completion and public-projection
readiness, and selects exactly one checkpoint mode. A `capture-only` proof
binds the normalized-media and capture-checkpoint digests and declares
`recovery: null`. A `recovery-finalized` proof additionally binds the exact
recovery-plan and recovery-checkpoint digests. `build-d1` rejects the media
manifest unless that proof is complete, byte-for-byte matched, and identical
to the mode selected by both remote reports.

Metadata-only builds omit the media manifest and both verification-report
options. They remain supported and cannot claim a media verification chain.

Media-pipeline detail statuses are projected explicitly:
`quarantined_stored → quarantined`, `source_missing → missing`,
`oversize → failed`, and `unattempted → pending`. The original status counts
remain in the D1 build manifest.

A build writes `moments_meta.ready=0`. SQL is split by actual UTF-8 byte length:
every statement stays below 100,000 bytes and every file stays far below the
5 GiB `d1 execute` ceiling. Generated files contain no explicit transaction
control. Each data shard appends an `import_shards` marker so Wrangler commits
the data and its resume proof in the same implicit import transaction. See
Cloudflare's [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [import guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Use the dedicated loader against a newly created staging D1. It resolves the
exact database name/UUID through an isolated Wrangler config and never uses the
repository binding name:

```sh
npm run moments:load-d1 -- preflight \
  --input data/moments/2026-07-23-v1/d1 \
  --database-name <staging-name> \
  --database-id <staging-uuid>

npm run moments:load-d1 -- load \
  --input data/moments/2026-07-23-v1/d1 \
  --database-name <staging-name> \
  --database-id <staging-uuid>

npm run moments:load-d1 -- verify \
  --input data/moments/2026-07-23-v1/d1 \
  --database-name <staging-name> \
  --database-id <staging-uuid>
```

If that staging UUID is already present in `wrangler.jsonc`, every phase also
requires `--allow-configured-empty-target --confirm-worker-not-activated`.
Those guards make the empty, non-serving staging state explicit before import.

`verify` checks exact schema definitions, shard markers and table counts,
foreign keys, SQLite integrity, representative index query plans, media status
counts, and fail-closed public projections. It writes
`d1/verification/<staging-uuid>.json` while `ready` remains `0`.

The first load shard installs a source-bound `moments_import_plan`. Database
triggers then cap every source table at its declared row count and reject all
source-row updates or deletes, including between resumable shards. The loader
also imports each SQL artifact from a newly copied, checksum-verified private
file, so changing a build file after preflight cannot change the imported
bytes. Import-plan expectations and the resume journal are immutable; loaded
row counters only move forward through source-row insert triggers.

Activation requires that exact target- and build-bound report:

```sh
npm run moments:load-d1 -- activate \
  --input data/moments/2026-07-23-v1/d1 \
  --database-name <staging-name> \
  --database-id <staging-uuid> \
  --verification-report data/moments/2026-07-23-v1/d1/verification/<staging-uuid>.json
```

A first release may deliberately omit media bodies. Its verification report
uses `media.mode = "metadata-only"`, `media.ready = false`, and records every
media row as `pending`; activation then additionally requires
`--allow-metadata-only`. Activation stores the build-manifest and verification-
report digests in `moments_meta`; one final guarded `UPDATE` atomically rechecks
the staged metadata, row plan, journal, projections, and media counts before
changing `ready` to `1`.

After activation, suppression rows are a monotonic emergency-off switch: a new
active suppression may be inserted, but an existing suppression cannot be
updated, deleted, or changed back to inactive. Re-publication requires a new
reviewed release instead of an in-place database edit.

Because Collections use a separate D1 database, a precomputed bridge may be
supplied with `--collection-map <ndjson>`. Lines accept either camelCase or
snake_case identifiers:

```json
{ "momentId": "uuid", "collectionId": 123 }
```

Without this artifact, `moment_collections` is deliberately empty. The emitted
schema includes explicit visibility rows, suppression tables, and fail-closed
`public_moments` / `public_capsules` views. Original gateway URLs and arbitrary
gateway metadata (including EXIF) remain in the verified snapshot and are not
copied into D1.

When a collection map is supplied, `build-d1` also requires its adjacent
`.report.json` and binds both the Moments and Collections source-manifest
digests into the D1 build identity.

## Snapshot layout

```text
source.json
schema/introspection.json
schema/response.json
queries/*.graphql
state/*.json
raw/<entity>/<page>.json.gz
normalized/*.ndjson
derived/moment_collections.ndjson
derived/moment_collections.report.json
manifest.json
manifest.sha256
validation/report.json
validation/report.sha256
d1/prepare/000001_schema.sql
d1/prepare/000002_import_shards.sql
d1/prepare/000003_import_guards.sql
d1/evidence/media-verification/pass1-<sha256>.json
d1/evidence/media-verification/pass2-<sha256>.json
d1/load/*.sql
d1/manifest.json
d1/verification/<database-uuid>.json
```

Normalized tables are `moments`, `moment_drops`, `moment_media`, `gateways`,
`links`, `user_tags`, `capsules`, `capsule_moments`,
`moments_hidden_drops`, `moments_featured_drops`, `drops_hidden_drops`, and
`drops_featured_drops`.

## Consistency boundaries

- Pagination is a bounded keyset scan: every entity freezes its maximum key
  before reading pages, and aggregate counts are frozen when Compass exposes
  them.
- Compass does not provide a multi-query transaction. A snapshot is therefore
  not transactionally consistent across roots.
- Compass does not expose deletion tombstones or a change stream. Comparing
  snapshots can reveal visible differences, but cannot recover rows deleted
  before capture.
- Root pages and nested Moment Drop relations use a hard limit of 100. If a
  Moment returns 100 Drop relations, capture stops with
  `NESTED_RELATION_LIMIT`; it never records a potentially truncated relation as
  complete.
