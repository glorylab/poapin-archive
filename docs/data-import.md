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
6. **Load staging resources** in bounded transactions with all required indexes.
7. **Upload media** to immutable
   `snapshots/<snapshot-id>/artwork/<drop_id>.webp` R2 keys and verify size and
   digest after upload.
8. **Validate** counts, uniqueness, foreign references, date ranges, address
   normalization, media coverage, query plans, and representative exports.
9. **Publish** snapshot metadata and activate the snapshot only after every
   required artifact exists.
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
