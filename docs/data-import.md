# Data Import

This document defines the safety and reproducibility contract for importing the
inventoried POAP Archive snapshot. See
[Source archive inventory](source-inventory.md) for the measured ZIP, SQLite,
row-count, and artwork findings.

## Current status

The initial ZIP and extracted SQLite database have been inventoried. The source
contains `poap.sqlite` plus `artwork/<drop_id>.webp`; target migrations encode
the verified schema and required query indexes. A complete target import and
remote size/query-plan report are still publication gates.

Do not publish a dataset merely because it can be parsed. Provenance, integrity,
privacy, and redistribution considerations are release gates.

## Immutable input record

For every source capture, record at minimum:

```json
{
  "snapshotId": "2026-07-02-v1",
  "sourceUrl": "https://downloads.poaparchive.com/archive.zip",
  "retrievedAt": "<operator-recorded UTC timestamp>",
  "sha256": "046850de3bd4b3c6aa75c33c4a1a589b4ab176aacdd5986c1a824df803c07633",
  "byteLength": 15839405768,
  "importerVersion": "<git commit>",
  "notes": "<source terms, notices, and known limitations>"
}
```

A generated manifest must describe the file actually obtained, including its
operator-recorded retrieval time. Store the source ZIP outside Git and keep a
read-only copy until the published snapshot has been independently verified.

## Proposed pipeline

1. **Acquire** the ZIP over HTTPS and record time, size, headers, and SHA-256.
2. **Quarantine and inventory** it without executing bundled files. Reject path
   traversal, absolute paths, links, unexpected executable types, and unsafe
   decompression ratios.
3. **Describe the source schema**: files, formats, columns, types, primary keys,
   relationships, row counts, encodings, and representative null/invalid cases.
4. **Document rights and provenance** for records and artwork separately.
5. **Normalize offline** into deterministic catalog, holdings, and media
   manifests. Preserve source identifiers alongside normalized values.
6. **Preflight and load staging resources** with the D1 loader on a Workers Paid
   account. Require exact database name/UUID matches, an empty target, and all
   required migrations before applying bounded shards.
7. **Upload media** to immutable
   `snapshots/<snapshot-id>/artwork/<drop_id>.webp` R2 keys and verify size and
   digest after upload.
8. **Validate** counts, uniqueness, foreign references, date ranges, address
   normalization, media coverage, query plans, and representative exports.
9. **Activate** with the D1 loader only after remote D1 verification and a
   successful R2 upload report. The load phase must not publish snapshot
   metadata or execute finalizer shards.
10. **Retain a report** containing input checksum, importer commit, record totals,
    rejected rows, validation results, and activation time.

Imports are operator jobs, not public Worker requests. Large parsing,
decompression, hashing, transformations, and integrity sweeps must not consume
request CPU.

## Target responsibilities

The target model intentionally separates concerns:

- `CATALOG_DB`: snapshot metadata, drops/events, normalized browse fields,
  aggregate counts, and media references;
- `HOLDINGS_DB`: normalized owner address, POAP/token identity, drop identity,
  network, and source ownership metadata; and
- `ARCHIVE_BUCKET`: original artwork plus a media manifest; later derivatives
  use distinct keys and record how they were produced.

The exact source columns and measured relationships are recorded in the source
inventory. Target tables and indexes live in numbered migrations.

## Normalization rules

Every transformation must be explicit and testable. In particular:

- retain the original identifier and raw value when a normalized value could be
  lossy;
- normalize hexadecimal addresses consistently and compare them
  case-insensitively unless a documented chain rule requires otherwise;
- parse dates with an explicit timezone assumption and preserve the source text
  when ambiguous;
- distinguish missing, unknown, empty, and zero where the source does;
- never silently invent location, creator, rights, or ownership facts; and
- quarantine invalid rows with a machine-readable reason instead of dropping
  them unnoticed.

The same input checksum and importer commit must produce the same logical
output. A retry may upsert identical staged data, but it must not duplicate
records or overwrite an active snapshot.

## Remote D1 loader contract

The full archive cannot be imported within D1 Free limits. A Workers Paid plan
is required before preflight: the holdings database exceeds the Free per-database
storage allowance, and the import writes millions of rows. See the current
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Use fresh, snapshot-scoped database names and retain their UUIDs in the import
record. The loader takes both values and verifies the pair remotely; it never
selects a target through the application's D1 bindings. From the project root,
run:

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

`preflight` verifies identity, schema, emptiness, plan integrity, and the absence
of published metadata. `load` executes prepare and data artifacts in reviewed
order but excludes `999999_finalize.sql`. Every shard writes its
`import_shards` marker in the same atomic D1 file import as its rows. A resumed
run treats those remote markers as the source of truth; a local journal alone
cannot distinguish a failed request from an import that committed before the
client disconnected. The loader must stop on the first unconfirmed shard.

`verify` is a read-only publication gate that compares the atomic remote shard
markers and snapshot identity with `report.json`; offline verification remains
responsible for full counts, integrity checks, and query plans. After the media
uploader has produced a complete, publishable report,
`activate --r2-report ... --r2-bucket ...` validates that report and applies the holdings and
catalog finalizers. No earlier phase may create the `archive_meta` readiness
marker.

The database IDs currently checked into `wrangler.jsonc` are already configured
as Worker targets. An initial import into either configured target is allowed
only while it is empty and no deployed Worker is serving it, and every loader
phase requires both acknowledgements:

```text
--allow-configured-empty-target --confirm-worker-not-activated
```

These flags are not a force option. They cannot authorize clearing a populated
database or replacing an active snapshot. Create new staging databases whenever
either condition cannot be proven.

## Media keys

The initial public URL contract is:

```text
snapshots/<snapshot-id>/artwork/<drop_id>.webp
```

Only numeric source filenames that correspond to a known drop may enter this
namespace. Validate detected content type rather than trusting the extension,
and record size and SHA-256 in the generated media manifest. Never overwrite an
active object in place.

The initial site serves original media. If derivatives are added, generate them
offline or asynchronously and record source digest, dimensions, format,
encoder, and encoder version.

## Required validation report

A publishable run should report:

- source files, bytes, and checksums;
- input, accepted, rejected, and duplicate rows by entity;
- unique drops, tokens, normalized owners, and media objects;
- orphaned holdings and missing artwork references;
- invalid addresses, identifiers, dates, and unsafe URLs;
- D1 database sizes, index coverage, and representative query plans;
- R2 uploaded, reused, missing, and failed objects; and
- sample JSON and CSV exports with the snapshot metadata attached.

Define numerical acceptance thresholds only after the first complete inventory.
Any exception must be written into the snapshot's public known-limitations
notes.

## Publication and rollback

Never mutate the active snapshot in place. Load a new snapshot namespace,
validate it, then switch the configured snapshot identifier in one reviewed
deployment. API cache keys include that identifier. A future media snapshot
must use a new prefix or base URL so old and new objects cannot share cached
responses.

Rollback means redeploying the previous snapshot identifier while its D1 rows
and R2 objects remain intact. Destructive cleanup is a separate, delayed,
reviewed operation.

## Remaining release decisions

- Measured target D1 sizes and operational headroom after the complete import.
- Search indexing strategy and locale behavior.
- The safe upper bound for synchronous address exports.
- Artwork redistribution, attribution, and takedown workflow.
- Retention period for source ZIPs, validation reports, and retired snapshots.
