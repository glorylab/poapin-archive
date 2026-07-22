# Offline archive import

This tool converts the immutable `poap.sqlite` snapshot into bounded SQL files
for the two D1 databases and a machine-readable R2 artwork manifest. It is an
operator-side data job: the importer does not make network requests, upload
media, mutate Cloudflare resources, or run inside a Worker. A separate inventory
command makes bounded HTTP Range reads against the pinned source archive.

## Requirements

- Node.js 22 or newer;
- the `sqlite3` command-line client with JSON1 and FTS5 support;
- enough free space for the generated SQL (the holdings output is large); and
- either a verified Range inventory, the original archive ZIP, or an extracted
  artwork directory.

Keep the source files outside Git. The repository ignores SQLite databases,
archive ZIPs, artwork, `data/`, and `import-reports/`.

## Generate an import

Use a new or empty output directory. Supplying expected digests makes checksum
failure an immediate hard error. `--retrieved-at` must describe acquisition,
not the time at which this command happens to run.

The recommended path does not download the 15.8 GB ZIP. It fetches only the
final ZIP records and the 7.2 MB ZIP64 central directory from the fixed archive
URL, validates exact `Content-Range`/length/ETag responses, and checks pinned
central-directory and canonical artwork-entry SHA-256 digests:

```sh
node tools/archive-import/inventory.mjs \
  --output /absolute/path/to/import-reports/2026-07-02-v1/artwork-inventory.json
```

Use the resulting inventory as the artwork input:

```sh
node tools/archive-import/cli.mjs \
  --database /absolute/path/to/poap.sqlite \
  --artwork-inventory /absolute/path/to/artwork-inventory.json \
  --output /absolute/path/to/import-reports/2026-07-02-v1/sql \
  --source-url https://downloads.poaparchive.com/archive.zip \
  --expected-database-sha256 18a052ec76a0b38f492ade7ff62869ead4556cd66cd8020a8550da9aa0e6a506 \
  --expected-archive-sha256 046850de3bd4b3c6aa75c33c4a1a589b4ab176aacdd5986c1a824df803c07633 \
  --retrieved-at 2026-07-22T00:00:00Z
```

An expected whole-archive SHA-256 is a pin, not proof that every archive byte
was read. Range inventories explicitly record the whole-archive digest as
`not-measured`; `report.json` and both D1 `archive_meta` tables retain the
`expected-only-not-measured` status. Only a local full-ZIP pass or the media
uploader's complete forward stream can produce a measured matching digest.

To inventory and hash a complete local ZIP instead, use:

```sh
node tools/archive-import/cli.mjs \
  --database /absolute/path/to/poap.sqlite \
  --archive /absolute/path/to/archive.zip \
  --output /absolute/path/to/import-reports/2026-07-02-v1 \
  --source-url https://downloads.poaparchive.com/archive.zip \
  --expected-database-sha256 <64-lowercase-hex> \
  --expected-archive-sha256 <64-lowercase-hex> \
  --retrieved-at 2026-07-22T00:00:00Z
```

For already extracted artwork, replace the artwork input with:

```sh
--artwork-directory /absolute/path/to/artwork
```

Directory input hashes every original WebP. ZIP input hashes the complete ZIP
and records each entry's uncompressed size, compressed size, compression
method, and CRC-32. Use `--skip-artwork-hashes` only when a separate verified
content manifest exists. Metadata-only development runs must explicitly pass
`--allow-missing-artwork` and remain publish-blocking unless the flag was
deliberate.

The command derives `2026-07-02-v1` from `snapshot_at` and source schema version
unless `--snapshot-id` is supplied. The media base defaults to
`https://media.poap.in`.

## Outputs

```text
<output>/
├── catalog/
│   ├── 000000_prepare.sql
│   ├── 100001_drops.sql ...
│   ├── 200001_drop_stats.sql ...
│   └── 999999_finalize.sql
├── holdings/
│   ├── 000000_prepare.sql
│   ├── 100001_tokens.sql ...
│   ├── 800001_owner_stats.sql ...
│   └── 999999_finalize.sql
├── quality/
│   ├── rejected-drops.ndjson
│   ├── rejected-tokens.ndjson
│   ├── rejected-email-reservation-stats.ndjson
│   └── rejected-owner-stats.ndjson
├── r2/artwork-manifest.ndjson
└── report.json
```

`report.json` records source metadata and checksums, target counts, normalized
owner counts, network distribution, duplicate POAP IDs, orphan relationships,
media coverage, every artifact's byte length and SHA-256, warnings, and
publish-blocking issues. The CLI exits with status 2 after writing the report
when review is required.

Every R2 manifest row carries `snapshotId`. The manifest uses snapshot-isolated
immutable keys in the form `snapshots/{snapshotId}/artwork/{dropId}.webp` and
contains upload metadata plus `eligibleForPublish`. It is an object list, not an
upload instruction; an uploader must skip any row where that flag is false.

After review, use the separate [R2 media uploader](../r2-media-upload/README.md),
which consumes this manifest verbatim and maintains a resumable checkpoint.

## Transformation contract

- Rows are read in stable primary-key order and output with stable column order.
- Owner addresses are checked as 20-byte hexadecimal addresses and normalized
  to lowercase. Only `owner_address_norm` is loaded; the redundant raw source
  address is not copied into D1.
- `drop_id` and `minted_on` are required in the target holdings table. Invalid
  source rows are quarantined instead of being silently coerced.
- `drops.token_count` and `drops.has_artwork` are populated from accepted token
  rows and the verified media inventory. `drop_stats` contains only valid email
  reservation totals for every accepted drop.
- SQLite streams tokens in normalized clustered-key order with bounded disk
  temporary storage; the importer derives one bounded in-memory owner aggregate
  at a time. Target validation rejects null source timestamps.
- The importer checks both the source primary-key declaration and the complete
  dataset for global `source_uid` uniqueness. The 51 known duplicate `poap_id`
  values are preserved; `source_uid` is the stable pagination tie-breaker.
- The same inputs, options, Node/sqlite versions, and importer version produce
  the same logical output. No wall-clock timestamp is invented.

## Why the files are shaped this way

D1 has per-statement and import-file limits. Multi-row inserts are capped at 100
rows and 90 KiB by default; shards are capped at 8 MiB. A single source row that
cannot fit below the statement ceiling fails the run rather than being
truncated. These values can be lowered with `--rows-per-statement`,
`--max-statement-kib`, and `--max-shard-mib`.

The schema migration already creates catalog FTS triggers. Holdings are emitted
in `(owner_address_norm, poap_id DESC, source_uid DESC)` order, matching the
`WITHOUT ROWID` clustered primary key that directly serves public pagination.
There is no redundant owner secondary index to rebuild. Small insert batches
cost more total import time but fail and retry at safe boundaries. Production
imports belong in fresh staging databases, never the currently active resources.

`archive_meta` is removed by each prepare shard and restored only by each final
shard. Both databases record the same `snapshot_id`, schema/importer versions,
source database digest, archive digest expectation/measurement status, and
relevant counts. API reads therefore see an unavailable or mismatched archive
rather than a half-loaded snapshot.

## Local verification

The verifier checks every artifact digest, applies the production schema and all
shards to scratch SQLite databases, runs integrity/count/aggregate checks, and
confirms that owner pagination uses the clustered primary key:

```sh
node tools/archive-import/verify.mjs \
  --input /absolute/path/to/import-reports/2026-07-02-v1
```

For the full snapshot this requires substantial temporary disk space. Scratch
databases are deleted after a successful or failed verification.

Run the small deterministic fixture test without adding project dependencies:

```sh
node --test tools/archive-import/test/*.test.mjs
```

## Remote D1 loading

The complete snapshot requires the Workers Paid plan. Its holdings database and
write volume exceed the D1 Free limits; do not start the production import on a
Free account. Create fresh, snapshot-scoped staging D1 databases and apply the
checked-in migrations before running the loader.

The loader identifies each remote database by both its name and UUID. It does
not use `CATALOG_DB` or `HOLDINGS_DB` bindings, and refuses to continue when
`wrangler d1 info` does not return the exact requested identity. Run the four
phases from the project root:

```sh
node tools/archive-import/d1-loader.mjs preflight \
  --input /absolute/path/to/import-output \
  --catalog-name poapin-cat-20260702-v1 \
  --catalog-id <catalog-d1-uuid> \
  --holdings-name poapin-hold-20260702-v1 \
  --holdings-id <holdings-d1-uuid>

node tools/archive-import/d1-loader.mjs load \
  --input /absolute/path/to/import-output \
  --catalog-name poapin-cat-20260702-v1 \
  --catalog-id <catalog-d1-uuid> \
  --holdings-name poapin-hold-20260702-v1 \
  --holdings-id <holdings-d1-uuid>

node tools/archive-import/d1-loader.mjs verify \
  --input /absolute/path/to/import-output \
  --catalog-name poapin-cat-20260702-v1 \
  --catalog-id <catalog-d1-uuid> \
  --holdings-name poapin-hold-20260702-v1 \
  --holdings-id <holdings-d1-uuid>

node tools/archive-import/d1-loader.mjs activate \
  --input /absolute/path/to/import-output \
  --catalog-name poapin-cat-20260702-v1 \
  --catalog-id <catalog-d1-uuid> \
  --holdings-name poapin-hold-20260702-v1 \
  --holdings-id <holdings-d1-uuid> \
  --r2-report /absolute/path/to/r2-upload-report.json \
  --r2-bucket poapin-archive
```

`load` applies prepare and data shards only; it deliberately excludes both
`999999_finalize.sql` files. Each data shard and its `import_shards` completion
marker commit in the same D1 import transaction. Resume checks those remote
markers, rather than trusting a local checkpoint alone, and stops at the first
failed shard. `verify` compares the remote state with `report.json`. `activate`
is the only phase allowed to apply finalizers, and requires the successful R2
upload report in addition to the completed D1 verification.

The D1 UUIDs currently present in `wrangler.jsonc` are configured Worker
targets. Using either of them for an initial, still-empty import requires both
explicit acknowledgements on every loader command:

```text
--allow-configured-empty-target --confirm-worker-not-activated
```

The first flag does not permit replacing a populated database; the second is an
operator assertion that no deployed Worker version is serving the target. If
either statement is untrue, create new staging databases instead. Generated
prepare shards are non-destructive, but they are not a way to sanitize or reuse
an existing database.
