# POAP Collections backup

This directory contains the offline operator tooling used to preserve the
Collections data exposed by the public POAP Compass GraphQL API. It captures
the source API response pages, produces canonical normalized files, preserves
eligible Collection branding and referenced-drop originals, verifies the
result, and derives a serving projection for Cloudflare D1.

The preserved GraphQL capture is the source of truth. The D1 database and SQL
files are derived artifacts that can be rebuilt when the serving schema
changes. Capture, verification, enrichment, build, and package commands do not
run in a Worker request or mutate Cloudflare. The separately invoked media
publisher is the sole exception: it uses a temporary, narrowly scoped Worker
bridge to publish the final D1 media proof to R2. Remote D1 changes remain an
explicit loader operation.

## What is preserved

The structured snapshot covers every scalar field currently exposed by these
collection-owned objects:

- `collections`, including the nested `urls` relation;
- `collection_ui_settings`;
- `collections_artists` and `collections_artists_drops`;
- `collections_organizations`;
- `collections_verified_collections`;
- `featured_collections`;
- `items`, `sections`, and `items_sections`;
- `suggested_drops`; and
- `collections_collection_drop_ids`, retained as a cross-check of collection
  membership.

The exporter also computes the exact union of every referenced `drop_id` and
captures a complete card for each referenced drop. A card contains every
currently exposed drop scalar plus its `hidden_drop`, `drop_image`, and image
gateway metadata. This is deliberate: D1 cannot join another bound D1
database, and some Collections drops may not exist in an older catalog
snapshot.

The enrichment phase also captures the bounded anonymous drop relations used
by Collections: per-chain POAP/transfer counts, aggregate email-claim counts,
featured dates, and uploaded-moment counts. Artwork already proven present in
the fixed POAP archive is reused by immutable R2 key. The remaining referenced
drop originals and a Collection's own `logo_image_url`/`banner_image_url` are
downloaded as original bytes; there is no thumbnail generation or image
transformation in this workflow.

Search results, leaderboards, and other request-dependent projections are not
treated as authoritative source tables. The capture also records known API
gaps in `manifest.json`, including the lack of a deletion feed and the lack of
a transaction spanning multiple GraphQL requests.

## Requirements

- Node.js 22 or newer;
- `tar`, for the optional packaging step;
- outbound HTTPS access to Compass and the reviewed media hosts; and
- enough disk space for two independent structured snapshots, one copy of the
  content-addressed media objects, the portable SQLite database, and the final
  archive.

Run commands from the repository root. Store captures under the ignored
`data/` tree or another path outside Git. The CLI has no authentication option
and must not be given cookies, bearer tokens, signed URLs, or credentials in
arguments or files.

```sh
node tools/collections-backup/cli.mjs --help
```

## Complete backup workflow

Compass does not expose a transactionally consistent database snapshot.
Completeness therefore requires two separate captures followed by an exact
comparison of their normalized artifacts.

### 1. Capture the primary structured snapshot

```sh
node tools/collections-backup/cli.mjs snapshot \
  --output data/collections/collections-2026-07-22-v1
```

Available options:

- `--output <directory>` is required. The directory must be absent or empty.
- `--endpoint <https-url>` defaults to
  `https://public.compass.poap.tech/v1/graphql`.
- `--delay-ms <0-60000>` sets the minimum delay between GraphQL requests and
  defaults to `250`.
- `--page-size <1-100>` sets the root query page size and defaults to `100`.
- `--resume` continues an interrupted snapshot only when the stored endpoint,
  format, schema, query hashes, and pagination state still match.

The snapshot command:

1. saves full GraphQL introspection and validates that each configured object
   selection exhausts the currently exposed scalar fields;
2. saves the exact GraphQL documents used for the capture;
3. freezes an upper key bound for each root and walks it with numeric, UUID, or
   composite keyset pagination;
4. records aggregate counts where Compass exposes an aggregate root;
5. stores every raw response page as gzip-compressed JSON together with its
   query hash, variables, response headers, and capture time;
6. writes primary-key-ordered normalized NDJSON; and
7. captures a full metadata card for the exact union of referenced drops.

GraphQL HTTP errors, a JSON `errors` response, cursor regression, a page that
crosses its frozen bound, aggregate-count disagreement, or a nested URL list
that reaches the fixed safety ceiling aborts the capture. If Compass adds or
removes a scalar field, the exhaustive schema check also aborts rather than
silently omitting it.

An interrupted run is resumed in the same directory:

```sh
node tools/collections-backup/cli.mjs snapshot \
  --output data/collections/collections-2026-07-22-v1 \
  --resume
```

The last committed raw page is checksum-verified before it is trusted.

### 2. Capture Collection logos and banners

```sh
node tools/collections-backup/cli.mjs media \
  --input data/collections/collections-2026-07-22-v1 \
  --max-bytes 100000000
```

Available options:

- `--input <snapshot-directory>` is required.
- `--concurrency <1-8>` defaults to `3`.
- `--max-bytes <1024-262144000>` limits each downloaded object and defaults to
  `52428800` bytes (50 MiB).
- `--retry-failures` retries references whose latest checkpoint state is
  `failed` or `missing`. Stored and quarantined references are not retried.

Media is a separate resumable phase. It builds an immutable reference plan,
appends results to `media/checkpoint.ndjson`, deduplicates identical bytes by
SHA-256, and writes objects beneath `media/objects/sha256/`. The last
checkpoint record for a reference ID is its effective state.

A media run is complete when every planned reference has a final record and
none remains `failed` or `missing`. A `quarantined` reference may be part of a
complete backup because the source database fact is preserved while the unsafe
or invalid bytes are explicitly excluded from publication. Only `stored`
records have `eligibleForPublish: true`.

The audited capture contains valid 99,330,474-byte GIF and 79,319,228-byte PNG
originals, so the release command above deliberately raises the limit to
100,000,000 bytes. If an earlier default-limit run recorded them as failed,
repeat it with both `--max-bytes 100000000` and `--retry-failures`.

### 2b. Enrich every referenced drop

Capture the remaining bounded drop statistics and attempt to preserve one
verified artwork original for every referenced drop:

```sh
node tools/collections-backup/cli.mjs enrich-drops \
  --input data/collections/collections-2026-07-22-v1 \
  --archive-snapshot-id 2026-07-02-v1 \
  --archive-media-manifest /private/tmp/poapin-import-reports/2026-07-02-v1/sql/r2/artwork-manifest.ndjson \
  --archive-upload-report /private/tmp/poapin-import-reports/2026-07-02-v1/r2-media-upload-report.json \
  --archive-upload-checkpoint /private/tmp/poapin-import-reports/2026-07-02-v1/r2-media-bridge.checkpoint.jsonl \
  --archive-catalog-sqlite /path/to/poaparchive-catalog.sqlite3 \
  --max-bytes 100000000
```

`--archive-catalog-sqlite` is optional provenance/cross-check input; D1 derives
`token_count` from the captured per-chain statistics first. Its `has_artwork`
flag is not proof of a reusable object. Reuse
requires the media manifest, final upload report, and per-object upload
checkpoint together. The command verifies their hashes and row counts, the
checkpoint header's archive/manifest/snapshot/bucket/prefix/cache bindings,
exactly one valid terminal SHA-256 and byte length for every eligible manifest
key, source-archive checks, complete upload accounting, and `publishable: true`.
It preserves each manifest `object.key` exactly and carries the proven
SHA-256, byte length, content type, and cache policy into each reused reference.
Supplying any archive input also requires `--archive-snapshot-id`.

After validation, the three proof inputs are copied byte-for-byte and atomically
into `drop-supplement/provenance/archive/`. Their canonical relative paths,
hashes, byte lengths, and row counts are bound in the supplement manifest, and
resume refuses any changed copy. The 15 GB source ZIP is not duplicated; the
preserved upload report and manifest retain its verified SHA-256 and exact byte
length. A packaged snapshot is therefore self-contained and does not depend on
the original `/private/tmp` paths.

The GraphQL phase requests at most 100 IDs at a time through one `drops` root.
Raw gzip pages retain the frozen query, variables, headers, and capture time;
canonical NDJSON covers `stats_by_chain`, `email_claims_stats`,
`featured_drop`, and `moments_stats`. A drop reaching the fixed 100-row
`stats_by_chain` ceiling aborts because its relation may be truncated.
`graphql.querySha256` binds the exact request string, while
`graphql.queryFileSha256` separately binds the canonical reviewed query file
(`trim()` plus one trailing newline). Raw pages retain the request hash; D1
verification requires both reviewed hashes and exact stored file bytes.

Artwork not covered by verified reuse tries an `ORIGINAL` gateway first and
`image_url` second, with an HTTPS host allowlist, redirect/DNS/private-address
checks, byte limits, and image-signature detection. Downloads are
content-addressed under `drop-supplement/artwork/objects/sha256/`. The default
per-object limit remains 50 MiB; `--max-bytes 100000000` raises it for the
audited retry without changing that default.

If an allowlisted host returns complete non-image bytes, those bytes are kept
under `drop-supplement/artwork/quarantine/sha256/` for the private backup and
are explicitly excluded from publication. An empty successful response keeps
its HTTP status, ETag, Last-Modified value, advertised type, zero byte length,
and empty-content digest as evidence. Unknown hosts and private-network targets
are rejected before download, so no bytes from them are saved.

Resume verifies all committed raw pages, stored images, and quarantined byte
objects. `quarantined` is terminal and is not retried; `--retry-failures`
retries only `failed` and `missing` records. Completeness and publishability
require one terminal record per referenced ID with no `pending`, `failed`, or
`missing` status. Quarantined records may be complete because
`quarantinedReferencesAreExcluded: true` prevents them from entering the public
media proof. All status counts remain explicit in
`drop-supplement/manifest.json`.

One migration exception repairs evidence produced by the earlier exporter: an
`UNSUPPORTED_MEDIA`, `CONTENT_TYPE_MISMATCH`, or `EMPTY_MEDIA` quarantine that
lacks its required byte/HTTP proof is fetched once only when its current source
plan contains an allowlisted host. Legacy unknown-host and private-network
quarantines remain terminal and are never fetched.

Do not edit `drop-supplement/` between resumes. If the bound snapshot or archive
inputs change, start in a fresh snapshot directory.

### 3. Capture an independent second pass

Use a different directory and the same endpoint, page size, and pacing policy:

```sh
node tools/collections-backup/cli.mjs snapshot \
  --output data/collections/collections-2026-07-22-v1-pass2
```

Media does not need to be downloaded for the second pass. Its purpose is to
test whether the structured API view remained stable across two full capture
windows.

### 4. Compare the two structured snapshots

```sh
node tools/collections-backup/cli.mjs compare \
  --primary data/collections/collections-2026-07-22-v1 \
  --secondary data/collections/collections-2026-07-22-v1-pass2
```

`compare` requires identical endpoints and captured schema hashes, then
compares every normalized artifact by row count and SHA-256. It writes
`validation/stability.json` into the primary snapshot and records either
`stable-two-pass` or `unstable-two-pass` in its manifest. A mismatch exits with
a non-zero status. It must be investigated or followed by a fresh pair of
captures; the tool does not merge two moving views.

### 5. Verify the primary snapshot

```sh
node tools/collections-backup/cli.mjs verify \
  --input data/collections/collections-2026-07-22-v1
```

To repeat introspection against the current endpoint and require an identical
schema document, add `--online-schema`:

```sh
node tools/collections-backup/cli.mjs verify \
  --input data/collections/collections-2026-07-22-v1 \
  --online-schema
```

Verification recomputes schema and artifact hashes, parses every normalized
row, checks primary keys and canonical ordering, validates aggregate counts,
and checks the Collection, item, section, artist, organization, verification,
feature, suggestion, and referenced-drop relationships. It also reconstructs
the referenced-drop union, cross-checks `collections_collection_drop_ids`, and
verifies every completed media object against its checkpoint digest and byte
length.

The command writes `validation/report.json`, its detached
`validation/report.sha256` sidecar, and `checksums.sha256`. Those are
verification outputs; it does not rewrite the captured raw or normalized
source data.

Collection slugs are intentionally **not unique** in the source. The numeric
`collection_id` is the durable identity used by the backup, D1 foreign keys,
and public routes.

### 6. Build the D1 serving projection

```sh
node tools/collections-backup/cli.mjs build-d1 \
  --input data/collections/collections-2026-07-22-v1 \
  --snapshot-id collections-2026-07-22-v1
```

`--snapshot-id` must be 1–64 lowercase letters, digits, dots, underscores, or
hyphens, beginning with a letter or digit. The command requires a successful
verification, `stable-two-pass` consistency, and complete publishable media,
then refuses to replace an existing `d1/` directory.

It creates:

- migration-compatible schema SQL in `d1/prepare/`;
- bounded, journaled data shards in `d1/load/`;
- a deterministic eligible-object plan in
  `d1/media/publication-plan.ndjson`;
- a readiness finalizer in `d1/finalize/`;
- `d1/report.json`; and
- `d1/collections.sqlite3`, built locally from those exact artifacts and
  checked with SQLite integrity and foreign-key checks.

The build re-hashes every normalized artifact, media manifest/plan/checkpoint,
referenced media object, stability report, and the validation report plus its
detached `validation/report.sha256` sidecar before and after generation. Any
post-verification input change removes the partial `d1/` output. Packaging
repeats those bindings before and after `tar` and deletes a partial archive when
they differ.

The projection preserves source IDs and contains collections, full referenced
drop cards, per-chain drop statistics, precomputed aggregate counts,
memberships, sections, ordered item-section relations, URLs, UI settings,
artists, artist drops, organizations, verification, featured collections,
suggestions, and media publication records. `private_value` is retained for
provenance while the additive `is_private` column defaults closed and is set
explicitly by new builds. The local Collection media path is converted to an
immutable target key of the form:

```text
snapshots/<snapshot-id>/collections/media/sha256/<prefix>/<sha256>.<extension>
```

New drop artwork uses a separate content-addressed prefix; proven archive
artwork retains its existing fixed-archive key. These keys are only a
publication plan: `build-d1` does not upload objects. Explicitly missing or
quarantined artwork receives no key and must never fall back to its source URL
in a public response.

The generated SQL stays below the adapter's safety envelope:

- at most 100 rows per `INSERT` statement;
- at most 90 KiB per SQL statement; and
- at most 4 MiB per data shard.

Each data shard records its `snapshot_id`, source digest, table, row count,
statement count, and payload digest in `import_shards` in the same SQL
transaction as its rows. These bounds are intentionally conservative relative
to D1's current import and SQL limits. D1 executes queries on a single thread,
so remote shards should be applied sequentially, not in parallel. Re-check the
official [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[import/export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
and [migration documentation](https://developers.cloudflare.com/d1/reference/migrations/)
before a production restore because Cloudflare limits can change.

The finalizer is one guarded `INSERT`. It compares the complete expected shard
set against `import_shards` in both directions (snapshot, source digest, path,
payload digest, table, row count, and statement count) and checks the exact row
count of every business table. A missing, extra, or mismatched row makes the
statement insert **zero** metadata keys, so `ready=1` cannot appear partially.

For a remote release, create a uniquely named snapshot-scoped database. Never
apply restore migrations through the repository's `COLLECTIONS_DB` binding: it
may point at the active or rollback database. The following reusable workflow
pins the Cloudflare account, refuses an existing name, captures one exact UUID,
and gives Wrangler a temporary configuration containing only that new target.
It requires `jq`, `rg`, Node 22, and an authenticated Wrangler session.

Set the account and snapshot paths. The database name includes the immutable
snapshot ID and a staging suffix; if that name already exists, stop and choose
a new suffix rather than reusing it.

```sh
set -euo pipefail

cd /absolute/path/to/poapin-archive

: "${CLOUDFLARE_ACCOUNT_ID:?set the exact target Cloudflare account ID}"
: "${D1_LOCATION_HINT:?set a reviewed D1 location hint such as apac or weur}"
export COLLECTIONS_INPUT="$PWD/data/collections/collections-2026-07-22-v1"
export COLLECTIONS_SNAPSHOT_ID="$(
  jq -er '.snapshotId' "$COLLECTIONS_INPUT/d1/report.json"
)"
export COLLECTIONS_DATABASE_NAME="poapin-archive-${COLLECTIONS_SNAPSHOT_ID}-staging-01"

umask 077
STAGING_CONFIG="$(mktemp "$PWD/.poapin-collections-staging.XXXXXX")"
cleanup_staging_config() {
  rm -f "$STAGING_CONFIG"
}
trap cleanup_staging_config EXIT INT TERM
```

The temporary file is created mode-private in the repository root so its
relative `migrations/collections` path resolves correctly. The trap removes it
on normal exit, failure, or interruption. It contains resource identifiers but
no API token; Wrangler continues to read credentials from its authenticated
profile or environment.

Create an account-pinned bootstrap configuration and prove that the proposed
name does not already exist:

```sh
jq -n \
  --arg account_id "$CLOUDFLARE_ACCOUNT_ID" \
  '{
    name: "poapin-collections-d1-bootstrap",
    compatibility_date: "2026-03-10",
    account_id: $account_id
  }' > "$STAGING_CONFIG"
chmod 600 "$STAGING_CONFIG"

EXISTING_COUNT="$(
  npx wrangler d1 list --config "$STAGING_CONFIG" --json |
    jq --arg name "$COLLECTIONS_DATABASE_NAME" \
      '[.[] | select(.name == $name)] | length'
)"
if [ "$EXISTING_COUNT" -ne 0 ]; then
  echo "Refusing existing D1 name: $COLLECTIONS_DATABASE_NAME" >&2
  exit 1
fi
```

Create the database. Choose the location hint deliberately before this command.
Deployments requiring a jurisdiction must replace `--location` with the
reviewed `--jurisdiction` option; never pass both.

```sh
npx wrangler d1 create "$COLLECTIONS_DATABASE_NAME" \
  --location "$D1_LOCATION_HINT" \
  --config "$STAGING_CONFIG"

export COLLECTIONS_DATABASE_ID="$(
  npx wrangler d1 list --config "$STAGING_CONFIG" --json |
    jq -er --arg name "$COLLECTIONS_DATABASE_NAME" '
      [.[] | select(.name == $name)] |
      if length == 1 then .[0].uuid else empty end
    '
)"

printf '%s\n' "$COLLECTIONS_DATABASE_ID" |
  rg -q '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

if rg -Fq "$COLLECTIONS_DATABASE_ID" "$PWD/wrangler.jsonc"; then
  echo "Refusing a D1 UUID already present in the Worker configuration" >&2
  exit 1
fi
```

Replace the bootstrap file with an isolated migration configuration. It has one
binding and cannot resolve the active `COLLECTIONS_DB` by name or UUID:

```sh
jq -n \
  --arg account_id "$CLOUDFLARE_ACCOUNT_ID" \
  --arg database_name "$COLLECTIONS_DATABASE_NAME" \
  --arg database_id "$COLLECTIONS_DATABASE_ID" \
  '{
    name: "poapin-collections-d1-staging",
    compatibility_date: "2026-03-10",
    account_id: $account_id,
    d1_databases: [
      {
        binding: "STAGING_COLLECTIONS_DB",
        database_name: $database_name,
        database_id: $database_id,
        migrations_dir: "migrations/collections"
      }
    ]
  }' > "$STAGING_CONFIG"
chmod 600 "$STAGING_CONFIG"

jq -e \
  --arg name "$COLLECTIONS_DATABASE_NAME" \
  --arg id "$COLLECTIONS_DATABASE_ID" '
    (.d1_databases | length) == 1 and
    .d1_databases[0].binding == "STAGING_COLLECTIONS_DB" and
    .d1_databases[0].database_name == $name and
    .d1_databases[0].database_id == $id
  ' "$STAGING_CONFIG"

npx wrangler d1 info STAGING_COLLECTIONS_DB \
  --config "$STAGING_CONFIG" --json |
  jq -e \
    --arg name "$COLLECTIONS_DATABASE_NAME" \
    --arg id "$COLLECTIONS_DATABASE_ID" \
    '.name == $name and .uuid == $id'
```

List the unapplied migrations. A fresh snapshot-scoped target must show exactly
`0001`, `0002`, `0003`, and `0004`; an intentionally retained verified target
that already has the first three must show only `0004_owner_lookup.sql`. Any
other state is a stop condition. Apply migrations only through the isolated
binding, then require the second list to report no unapplied migration:

```sh
npx wrangler d1 migrations list STAGING_COLLECTIONS_DB \
  --remote --config "$STAGING_CONFIG"

npx wrangler d1 migrations apply STAGING_COLLECTIONS_DB \
  --remote --config "$STAGING_CONFIG"

npx wrangler d1 migrations list STAGING_COLLECTIONS_DB \
  --remote --config "$STAGING_CONFIG"
```

`0004` is the repository's runtime owner-lookup index. It is not a fourth
generated `d1/prepare` data artifact, and applying that index does not require a
new capture, data reload, or media publication.

Use the fail-closed loader for staging. Keep `--project-config` pointed at the
real Worker configuration: its configured-ID gate is an additional fuse if an
operator accidentally substitutes an old database UUID. A genuinely new UUID
does not need either safety override; if the loader asks for
`--allow-configured-empty-target` and `--confirm-worker-not-activated`, stop and
investigate instead of passing them.

```sh
node tools/collections-backup/d1-loader.mjs preflight \
  --input "$COLLECTIONS_INPUT" \
  --database-name "$COLLECTIONS_DATABASE_NAME" \
  --database-id "$COLLECTIONS_DATABASE_ID" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --project-config "$PWD/wrangler.jsonc" \
  --wrangler-bin "$PWD/node_modules/wrangler/bin/wrangler.js"

node tools/collections-backup/d1-loader.mjs load \
  --input "$COLLECTIONS_INPUT" \
  --database-name "$COLLECTIONS_DATABASE_NAME" \
  --database-id "$COLLECTIONS_DATABASE_ID" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --project-config "$PWD/wrangler.jsonc" \
  --wrangler-bin "$PWD/node_modules/wrangler/bin/wrangler.js"

node tools/collections-backup/d1-loader.mjs verify \
  --input "$COLLECTIONS_INPUT" \
  --database-name "$COLLECTIONS_DATABASE_NAME" \
  --database-id "$COLLECTIONS_DATABASE_ID" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --project-config "$PWD/wrangler.jsonc" \
  --wrangler-bin "$PWD/node_modules/wrangler/bin/wrangler.js"
```

`preflight` requires an exact migrated but empty schema. `load` is sequential
and resumable from signed `import_shards` markers; after a partial failure,
rerun `load` against the same name, UUID, snapshot, and artifacts rather than
rerunning the empty-only preflight. `verify` requires exact table totals,
foreign keys, FTS integrity, reviewed query plans, and an empty
`collections_meta` table.

Make the unactivated state explicit. Both counts must be zero; the shard count
must equal the number of `phase == "load"` artifacts in `d1/report.json`:

```sh
EXPECTED_SHARDS="$(
  jq '[.artifacts[] | select(.phase == "load")] | length' \
    "$COLLECTIONS_INPUT/d1/report.json"
)"
printf 'Expected import shards: %s\n' "$EXPECTED_SHARDS"

npx wrangler d1 execute STAGING_COLLECTIONS_DB \
  --remote --yes --json --config "$STAGING_CONFIG" \
  --command "
    SELECT
      (SELECT COUNT(*) FROM collections_meta) AS meta_rows,
      (SELECT COUNT(*) FROM collections_meta
        WHERE key = 'ready' AND value = '1') AS ready_rows,
      (SELECT COUNT(*) FROM import_shards) AS shard_rows;
  "
```

Stop here during staging. Do not import `d1/finalize/999999_finalize.sql`, do not
run `d1-loader.mjs activate`, and do not update the Worker binding. The loader
resolves the exact name and UUID in its own isolated temporary config, validates
every artifact hash and exact migration SQL, and resumes only from matching
remote journal markers. Cloudflare D1 rejects `PRAGMA integrity_check`
remotely; the included portable SQLite database runs that check against the
exact SQL plan before any remote load.

After the staging checks pass, publish every object in the final D1 media proof,
then run the publisher a second time so every object is verified remotely by
HEAD. Activation is intentionally available only through the loader:

Copy the temporary bridge configuration, replace its exact bucket and snapshot
placeholders, and deploy it with a fresh 32-byte HMAC secret:

```sh
cp tools/collections-backup/bridge/wrangler.example.jsonc \
  tools/collections-backup/bridge/wrangler.local.jsonc

export COLLECTIONS_R2_BRIDGE_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
npx wrangler deploy \
  --config tools/collections-backup/bridge/wrangler.local.jsonc
printf %s "$COLLECTIONS_R2_BRIDGE_SECRET" | npx wrangler secret put \
  COLLECTIONS_R2_BRIDGE_SECRET \
  --config tools/collections-backup/bridge/wrangler.local.jsonc
```

The bridge configuration must use `OBJECT_PREFIX: "snapshots/"`, the new
Collections snapshot ID, the fixed archive snapshot ID, and the exact bucket
recorded by the preserved archive proof. It accepts at most 100,000,000 bytes
per object (decimal 100 MB). The route can only HEAD either canonical key
family and conditionally PUT new content-addressed Collection media; a reused
archive key is HEAD-only and must match its exact size, SHA-256, content type,
cache policy, ETag when recorded, and `source=poap-archive` metadata.

Run the publisher twice with the same checkpoint. The first pass uploads only
new Collection branding and downloaded drop artwork while verifying every old
archive reuse. The second pass performs HEAD for every proof object and must do
no PUT or reuse work:

```sh
export COLLECTIONS_BRIDGE_URL="https://THE-TEMPORARY-BRIDGE.workers.dev"

node tools/collections-backup/media-publish.mjs \
  --input data/collections/collections-2026-07-22-v1 \
  --snapshot-id collections-2026-07-22-v1 \
  --bucket poapin-archive \
  --bridge-url "$COLLECTIONS_BRIDGE_URL"

node tools/collections-backup/media-publish.mjs \
  --input data/collections/collections-2026-07-22-v1 \
  --snapshot-id collections-2026-07-22-v1 \
  --bucket poapin-archive \
  --bridge-url "$COLLECTIONS_BRIDGE_URL" \
  --report data/collections/collections-2026-07-22-v1/media/publish-verify-report.json

jq -e '
  .publishable == true and
  .counts.failed == 0 and
  .counts.uploaded == 0 and
  .counts.reused == 0 and
  .counts.proofVerified == .counts.uniqueObjects
' data/collections/collections-2026-07-22-v1/media/publish-verify-report.json
```

Only after that assertion succeeds may the report be supplied to activation:

```sh
node tools/collections-backup/d1-loader.mjs activate \
  --input data/collections/collections-2026-07-22-v1 \
  --database-name <exact-name> --database-id <exact-uuid> \
  --media-report data/collections/collections-2026-07-22-v1/media/publish-verify-report.json
```

`activate` repeats the complete remote verification, requires a zero-failure
second-pass media report whose proof digest/object total and D1-report digest
match the **final** `d1/report.json`, imports the guarded finalizer, and reads
back the complete exact metadata set. This generic media proof may cover more
than Collection logos and banners (for example enriched drop artwork); the D1
report, not a hard-coded object count or prefix, is authoritative.

After activation evidence is retained, delete the temporary bridge and clear
the local secret. The Worker exposes no object body read, list, overwrite, or
delete route:

```sh
npx wrangler delete \
  --config tools/collections-backup/bridge/wrangler.local.jsonc --force
unset COLLECTIONS_R2_BRIDGE_SECRET COLLECTIONS_BRIDGE_URL
rm tools/collections-backup/bridge/wrangler.local.jsonc
```

Do not execute `d1/finalize/999999_finalize.sql` directly. The public Worker
should use a separate `COLLECTIONS_SNAPSHOT_ID`, because the Collections and
fixed archive snapshots have independent lifecycles.

### 7. Package the verified backup

```sh
node tools/collections-backup/cli.mjs package \
  --input data/collections/collections-2026-07-22-v1 \
  --output /absolute/path/to/backups/collections-2026-07-22-v1.tar.gz
```

`--output` is optional and defaults to `<snapshot-directory>.tar.gz` beside
the snapshot directory. The output must be outside the snapshot, and the
command refuses to overwrite an existing file.

Packaging requires successful structured and media verification plus a D1
build report. It writes `package-manifest.json`, creates a gzip-compressed tar
archive, and writes a detached `<archive>.sha256` sidecar. The package is not
encrypted and the tar stream is **not claimed to be reproducible**: verify the
detached SHA-256 for the exact archive you store or transfer.

## Snapshot layout

The directory grows by phase. A fully processed primary snapshot looks like:

```text
<snapshot>/
├── source.json
├── manifest.json
├── schema/
│   ├── introspection.json
│   └── response.json
├── queries/
│   ├── introspection.graphql
│   ├── <entity>-upper.graphql
│   ├── <entity>-count.graphql
│   ├── <entity>-page.graphql
│   └── referenced-drops.graphql
├── state/
│   ├── <entity>.json
│   └── referenced_drops.json
├── raw/
│   ├── <entity>/000001.json.gz
│   └── referenced_drops/000001.json.gz
├── normalized/
│   ├── collections.ndjson
│   ├── collection_urls.ndjson
│   ├── collection_ui_settings.ndjson
│   ├── artists.ndjson
│   ├── artist_drops.ndjson
│   ├── organizations.ndjson
│   ├── verified_collections.ndjson
│   ├── featured_collections.ndjson
│   ├── items.ndjson
│   ├── sections.ndjson
│   ├── item_sections.ndjson
│   ├── suggested_drops.ndjson
│   ├── collection_drop_ids.ndjson
│   ├── referenced_drop_ids.txt
│   └── referenced_drops.ndjson
├── media/
│   ├── plan.ndjson
│   ├── checkpoint.ndjson
│   ├── manifest.json
│   ├── publish-checkpoint.ndjson
│   ├── publish-report.json
│   ├── publish-verify-report.json
│   └── objects/sha256/<prefix>/<sha256>.<extension>
├── drop-supplement/
│   ├── manifest.json
│   ├── raw/*.json.gz
│   ├── normalized/*.ndjson
│   ├── provenance/archive/
│   │   ├── artwork-manifest.ndjson
│   │   ├── upload-report.json
│   │   └── upload-checkpoint.jsonl
│   └── artwork/
│       ├── plan.ndjson
│       ├── checkpoint.ndjson
│       ├── references.ndjson
│       ├── objects/sha256/<prefix>/<sha256>.<extension>
│       └── quarantine/sha256/<prefix>/<sha256>.bin
├── validation/
│   ├── stability.json
│   ├── report.json
│   └── report.sha256
├── checksums.sha256
├── d1/
│   ├── prepare/*.sql
│   ├── load/*.sql
│   ├── media/publication-plan.ndjson
│   ├── finalize/999999_finalize.sql
│   ├── collections.sqlite3
│   └── report.json
└── package-manifest.json
```

`source.json` binds the output directory to the exporter format and endpoint.
Per-entity state files carry the frozen upper bound, last cursor, row and page
counts, schema/query hashes, and checksum metadata for the last committed raw
page. `manifest.json` summarizes the canonical artifacts and later gains media
and consistency status.

Raw gzip pages are retained for provenance and future re-normalization.
Normalized files are the canonical comparison and D1 input. Do not manually
edit either layer; create a new snapshot when capture settings or source data
change.

## Media security boundary

Collection media URLs are untrusted database values. The downloader applies
these controls before publication:

- credential-free HTTPS on the default port;
- exact hostname allowlisting rather than suffix matching;
- manual redirects with a maximum of five, with protocol, host, and network
  checks repeated for every target;
- DNS lookup rejection when a target resolves to a private or invalid address;
- early `Content-Length` rejection and a streaming byte limit;
- SHA-256 content addressing and deduplication;
- image signature detection for PNG, JPEG, GIF, WebP, and AVIF rather than
  trusting a filename extension; SVG and unknown formats fail closed; and
- rejection when an advertised non-generic `Content-Type` is not an image.

The dead `collections-assets.poap.xyz` host is never contacted directly. An
exact rewrite changes only its hostname to the audited
`collections-media-production.s3.us-east-2.amazonaws.com` bucket and records
the rule in the checkpoint. The other accepted source host is
`assets.poap.xyz`.

The DNS lookup is a validation preflight; the current Node `fetch` connection
is **not pinned** to the checked address. The downloader also does not yet
enforce a per-request wall-clock timeout. Run this operator job in an
egress-restricted environment when those threat models matter. Do not broaden
the allowlist merely to make an anomalous row succeed.

In the 2026-07-22 Collection-branding capture, two references were deliberately
quarantined separately from the three terminal exclusions in the referenced-drop
artwork pass:

- one banner pointed to an unapproved out-of-band testing host and was never
  fetched; and
- one allowlisted logo response contained HTML instead of image bytes and was
  rejected by signature detection.

These are expected safety outcomes, not missing backup facts: their original
URLs and failure reasons remain in the checkpoint, while neither is eligible
for the public media namespace.

## R2 separation

Use separate storage boundaries for preservation and delivery:

- The complete `.tar.gz` backup belongs in a **private backup bucket** with no
  public custom domain or `r2.dev` endpoint. It contains raw API pages,
  operational state, preservation evidence, and derived database files. Public
  owner and approved-suggestion addresses are retained in both the backup and
  the public D1 projection.
- Only eligible rows in `d1/media/publication-plan.ndjson` belong in the
  **public media bucket**. `upload` rows bind local original bytes to a new
  immutable key; `reuse` rows bind an already-published fixed-archive object
  and must still be verified remotely. Excluded terminal references never
  appear in this plan.

Review current [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
before bulk upload. The publisher does not create buckets or custom domains,
and it cannot list, read bodies, delete, or overwrite objects. Its temporary
bridge sets the fixed immutable cache policy, uploads only new eligible proof
objects with conditional PUT, and verifies every planned object by exact HEAD.

## Restore checklist

1. Verify the detached archive SHA-256 before extraction.
2. Extract into a new directory with a tar implementation or wrapper that
   rejects absolute paths, `..`, links, device files, and unsafe expansion.
3. Run `verify` against the extracted snapshot; use `--online-schema` only when
   a current-schema equality check is intended.
4. Keep the included D1 artifacts or delete `d1/` and rebuild them with the
   current reviewed adapter.
5. Create a fresh snapshot-scoped D1 database and confirm its exact name and
   UUID before applying SQL.
6. Apply the migrations and use `d1-loader.mjs` to load shards sequentially,
   then verify table counts, foreign keys, and every `import_shards` marker;
   use the portable SQLite result for the full integrity check.
7. Publish only eligible objects from the D1 media proof (including new drop
   originals), verify reused archive keys, then run the second-pass remote
   verification report required by activation.
8. Apply the finalizer and deploy the new D1 binding and
   `COLLECTIONS_SNAPSHOT_ID` only after both D1 and R2 are complete.

Never restore over the active database or overwrite an immutable media object.
Keeping the previous snapshot-scoped database, media prefix, and Worker
configuration intact makes rollback a binding/configuration change instead of
a destructive rewrite.
