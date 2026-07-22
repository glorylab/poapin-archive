# R2 media uploader

This operator tool streams the POAP Archive ZIP into immutable, snapshot-scoped
Cloudflare R2 objects. It never writes or extracts the complete 15.8 GB archive.
At most a bounded number of compressed and decoded artwork entries are held in
memory while uploads run concurrently.

Production object keys come exclusively from the importer's reviewed
`r2/artwork-manifest.ndjson`:

```text
snapshots/<snapshot-id>/artwork/<drop-id>.webp
```

Rows that are absent from the manifest or have `eligibleForPublish: false` are
not uploaded. The CLI verifies each eligible row's snapshot, key, media type,
cache policy, public URL, source size, and ZIP CRC-32 when those source fields
are available.

## Before uploading

Generate and review a complete import report and its artwork manifest first.
The uploader requires both `--snapshot-id` and `--manifest`; it does not guess a
release namespace. Keep the media custom domain unpublished, or keep the new
snapshot unreferenced by the application, until the final uploader report is
successful. The pinned whole-archive SHA-256 can only be confirmed after the
forward stream reaches the end.

Create a bucket-scoped R2 API token with only the object permissions needed for
this operation. Put credentials in the process environment, not in arguments,
repository files, shell scripts, or the checkpoint:

```bash
export R2_ACCOUNT_ID="<cloudflare-account-id>"
export R2_BUCKET="poapin-archive"
export R2_ACCESS_KEY_ID="<r2-access-key-id>"
export R2_SECRET_ACCESS_KEY="<r2-secret-access-key>"
# Required only for Cloudflare-issued temporary credentials:
export R2_SESSION_TOKEN="<r2-session-token>"
```

`R2_SESSION_TOKEN` is optional for long-lived R2 API token credentials and
required when the access key and secret were issued as temporary S3
credentials. The tool intentionally has no credential flags. It never writes
credentials to logs, reports, or checkpoints, and all three credential values
are redacted from surfaced SDK errors. Use a short-lived operator session or
secret manager where possible, then clear all credential environment variables
when the run is complete.

## Dry run

A dry run needs no R2 credentials. It parses ZIP local records, inflates only
manifest-eligible artwork, checks decompressed size, CRC-32, and RIFF/WEBP
signatures, and writes a report:

```bash
npm run media:upload -- \
  --snapshot-id 2026-07-02-v1 \
  --manifest import-reports/2026-07-02-v1/r2/artwork-manifest.ndjson \
  --source /path/to/archive.zip \
  --dry-run
```

Omit `--source` to stream the pinned archive directly from
`https://downloads.poaparchive.com/archive.zip`. A small `--limit 10` smoke test
stops intentionally before the whole-archive hash and count checks; its report
marks those checks as not performed. Because the source is forward-only, even a
remote smoke test must pass over the compressed `poap.sqlite` entry before the
first artwork.

## Upload and resume

```bash
npm run media:upload -- \
  --snapshot-id 2026-07-02-v1 \
  --manifest import-reports/2026-07-02-v1/r2/artwork-manifest.ndjson \
  --source /path/to/archive.zip \
  --concurrency 4
```

Defaults:

- checkpoint: `import-reports/r2-media-upload.checkpoint.jsonl`;
- report: `import-reports/r2-media-upload-report.json`;
- cache metadata: `public, max-age=31536000, immutable`;
- entry memory limit: 32 MiB compressed and decoded;
- attempts per object: four; and
- stop threshold: 25 object failures.

Both output paths are ignored by Git. The checkpoint header binds the archive
digest, manifest digest, R2 endpoint, bucket, snapshot, key prefix, and cache
policy. A resume with a different account endpoint or other context fails
instead of skipping the wrong objects.
Completed entries are drained from the ZIP without decompression or an R2 call.
For a remote source, resuming still transfers earlier archive bytes because the
ZIP is processed as one forward stream.

Every `PutObject` uses `If-None-Match: *`, `Content-MD5`, `image/webp`, immutable
cache metadata, and a SHA-256 object metadata field. If an object already
exists, a `HeadObject` is accepted only when its byte length, SHA-256, media
type, and cache policy all match. A mismatch is reported and is never
overwritten.

The final JSON report contains source and manifest digests, validation results,
object and byte counts, bounded error messages, and every failed key. `ok`
describes whether the requested run succeeded, so an intentional `--limit`
smoke test may be `ok` while still being partial. Do not publish the snapshot
unless `publishable` is `true` (which also requires a complete upload and all
pinned source checks), and the failure count is zero.

## Source verification policy

By default the CLI pins the inventoried snapshot's byte length, SHA-256, and
artwork count. `--allow-unverified-source` disables those three checks for
development fixtures only. It must not be used for a published import.

The forward parser supports stored and raw-deflate entries, ZIP64 local size
fields, bounded decompression, and standard ZIP CRC-32. It rejects encrypted
entries, unsafe paths, unsupported compression methods, and archives whose
local records rely on trailing data descriptors.

## Tests

```bash
npm run test:media-upload
```

The suite builds tiny ZIP fixtures in memory, including a deflated WebP with
ZIP64 local sizes, and uses mock S3 responses. It never contacts R2.
