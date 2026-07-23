# Moments original-media preservation

This operator tool turns a verified `tools/moments-backup` snapshot into a
bounded, resumable original-media capture. It does not follow arbitrary URLs:
the plan accepts only the canonical `https://cdn.media.poap.tech/<media-key>`
gateway for each normalized `moment_media` row.

The public/private decision is fail-closed. A processed media row is public
only when its Moment exists, has at least one Drop relationship, and none of
those Drops appears in the Moments-specific hidden-Drop set. The generic Drops
hidden namespace is preserved but is not reinterpreted as a Moments rule.
Everything else is routed to the private bucket. A type mismatch on an
otherwise public row is also quarantined privately.

## Why this is a separate job

Workers serve only precomputed D1 rows and immutable R2 objects. Downloads,
hashing, byte inspection, and retry state stay in this Node.js operator job so
they do not consume request CPU. Capture concurrency defaults to three, each
object has a 100,000,000-byte ceiling, and temporary files are removed as soon
as their checkpoint record is durable.

`declaredByteLength` is source metadata, not a total-size measurement. Some
media classes, notably original videos with HLS gateways, have no declared
size. Cost and completeness reports must sum verified checkpoint `byteLength`
values (plus separately completed multipart originals) rather than treating
missing declarations as zero.

## Runbook

Build the relational snapshot first, then create the deterministic media plan:

```sh
npm run moments:media -- plan \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1
```

Create the private R2 bucket once. Copy `bridge/wrangler.example.jsonc` to the
gitignored `bridge/wrangler.local.jsonc`, fill in the exact snapshot and bucket
names and the single-request/multipart byte ceilings, generate a 32-byte
base64url secret, deploy the temporary Worker, and set its
`MOMENTS_R2_BRIDGE_SECRET` secret.

Bridge protocol v2 can only perform authenticated metadata HEAD, conditional
put-if-absent, and bounded multipart create/upload-part/complete/abort
operations within this snapshot's content-addressed Moments prefixes. Every
operation binds the method, route, snapshot, logical target, exact bucket,
object key, total length, object SHA-256, content type, upload ID, part number,
part length, request-body SHA-256, and timestamp into the HMAC as applicable.
The Worker verifies each multipart part digest before forwarding it to R2.
Multipart create and abort use an explicit, canonical `Content-Length: 0`;
Cloudflare may still expose an empty request stream, so the Worker validates
the normalized length and rejects nonzero or chunked requests instead of
inferring emptiness from `request.body`.

There is no object-body read, bucket list, completed-object delete, arbitrary
key, or general overwrite route. A multipart abort can discard only the exact
incomplete upload ID signed for its content-addressed key. Create and complete
both fail closed when a pre-existing key has different immutable metadata; an
identical completed object is reused. Originals written by bridge v1 may omit
the `fidelity`, `derivativeKind`, and `immutable` fields and remain reusable
only when all three are absent and every other immutable field matches. This
compatibility never applies to derivatives, partial omissions, or any explicit
`immutable` value other than the v2 value `"true"`.
For an authenticated HEAD conflict, the bridge returns only a fixed list of
conflicting field names in `X-POAPin-Conflict-Fields`. It never returns stored
sizes, digests, content types, cache values, or custom-metadata values; the
client attaches the validated names to `error.conflictFields` and its printable
error message.

```sh
export MOMENTS_R2_BRIDGE_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
npx wrangler deploy --config tools/moments-media/bridge/wrangler.local.jsonc
printf %s "$MOMENTS_R2_BRIDGE_SECRET" | npx wrangler secret put \
  MOMENTS_R2_BRIDGE_SECRET \
  --config tools/moments-media/bridge/wrangler.local.jsonc

npm run moments:media -- capture \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1 \
  --bridge-url https://TEMPORARY-BRIDGE.workers.dev \
  --public-bucket poapin-archive \
  --private-bucket poapin-moments-backups

npm run moments:media -- recovery-plan \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1

npm run moments:media -- recover \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1 \
  --bridge-url https://TEMPORARY-BRIDGE.workers.dev \
  --public-bucket poapin-archive \
  --private-bucket poapin-moments-backups

npm run moments:media -- verify \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1 \
  --bridge-url https://TEMPORARY-BRIDGE.workers.dev \
  --public-bucket poapin-archive \
  --private-bucket poapin-moments-backups \
  --report data/moments/moments-YYYY-MM-DD-v1/media/verify-report-pass1.json

npm run moments:media -- verify \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1 \
  --bridge-url https://TEMPORARY-BRIDGE.workers.dev \
  --public-bucket poapin-archive \
  --private-bucket poapin-moments-backups \
  --previous-verification-report \
    data/moments/moments-YYYY-MM-DD-v1/media/verify-report-pass1.json \
  --report data/moments/moments-YYYY-MM-DD-v1/media/verify-report-pass2.json
```

The public and private names must resolve to two different physical R2
buckets. A private key prefix inside the public bucket is not a privacy
boundary and is rejected by the client, bridge, capture, recovery, verifier,
D1 builder, and loader.

`recovery-plan` is offline and does not change the append-only checkpoint. It
deduplicates checkpoint history by media key and classifies unresolved rows
into narrowly allowlisted strategies: retrying the canonical source after a
bridge failure, downloading a same-SHA-256 canonical alias, multipart capture
for originals above the one-request bridge limit, legacy normalized originals,
and private thumbnail/HLS derivatives when an original cannot be recovered.
Non-public rows without a fixed candidate remain explicitly metadata-only;
public rows instead receive a nonterminal `public_original_required`
placeholder and can never plan metadata-only preservation. Any hash-alias
download must match the normalized 64-character SHA-256 before it is stored;
matching MIME type or declared size alone is never treated as identity.
`publicEligible: true` always requires a public original even when an older
media plan has `target: null` because no canonical source was available. New
recovery plans normalize that target to public; the executor safely accepts
the exact older outer-private shape without treating its private result as
terminal.
Failures that are not deterministic absence outcomes, including 401, 425, and
other generalized 4xx responses, remain retry work. With a canonical source
they plan `retry_primary`; without one they receive the nonterminal
`private_recovery_required` placeholder rather than metadata-only completion.
When an alias with that SHA-256 is already present in the checkpoint, the plan
records its immutable R2 object as already preserved instead of pretending the
failed source must be downloaded again.

`recover` consumes only that fixed plan. It never edits
`capture-checkpoint.ndjson`; it writes `recovery-checkpoint.ndjson` as an
append-only journal bound to both plan digests, the capture-checkpoint digest,
the normalized `moment_media.ndjson` digest and row count, both bucket names,
and all byte ceilings. Preflight requires the media plan to cover the normalized
media keys exactly once; an empty, duplicate, missing, or extra plan row cannot
be finalized. The recovery plan must also exactly cover the latest capture
rows requiring recovery. Every row is bound to the latest capture status,
error, and HTTP status, its normalized SHA-256, and the same required digest on
each original strategy; a stale or hand-edited plan is rejected. A missing
pass-one checkpoint row remains `unattempted`, even when its source URL is
null. Successful multipart creation, every uploaded part, completion,
derivative object, strategy failure, and terminal media result is made durable
before the next state transition. Re-running the same command HEAD-checks
completed objects, resumes an active upload ID and its recorded parts, and
does not redownload terminal rows.

The normal bridge deliberately accepts at most 100,000,000 bytes in one
request. Larger originals use fixed-size multipart parts (16 MiB by default)
and are not silently replaced by their HLS representation. The whole source is
downloaded once into a permission-restricted temporary file and hashed before
any multipart upload is created. Preflight rejects a byte ceiling that could
require more than 10,000 parts, and the per-object limit is checked before
creating an upload ID. Hash aliases must match the exact normalized SHA-256.
Public type mismatches are quarantined to the private original prefix.

Derived thumbnails and HLS resources always use private
`private/derivative/...` keys. HLS traversal accepts only fixed, relative,
query-free resources under the selected media UUID's exact S3 prefix, with
resource-count and byte ceilings. Derivatives are labeled as such in the
checkpoint and never become an original or a public D1 URL. A
`derivative_stored` or `metadata_only` result is an explicit preservation
terminal state only for a non-public row, not evidence that the original bytes
were recovered. For a public row these states preserve a fallback but remain
pending until a non-quarantined, public-target `original_stored` result is
durable. A type-incompatible original preserved in the private bucket remains
resumable for the same reason. When every fixed strategy for a non-public row
has been exhausted without preserving an original or derivative, `recover`
writes a terminal `metadata_only` record with reason
`all_recovery_candidates_exhausted` and retains the ordered per-strategy
failure audit in `attempts`. The journal validator accepts this fallback only
for an explicitly non-public, private-target recovery plan with no planned
`metadata_only` strategy. Public rows never receive this fallback and remain
unresolved, including when an older frozen plan contains an explicit
`metadata_only` placeholder. Network-transient, disk, bridge authentication,
R2 upload, and multipart failures remain `failed` and resumable; only
allowlisted source or content outcomes that establish candidate exhaustion can
produce the automatic fallback. Source HTTP exhaustion is limited to a
source-fetch error explicitly identified as `SOURCE_HTTP_ERROR` with 403, 404,
or 410; the same status from Bridge, WAF, R2, or another subsystem is not a
source outcome. Authentication, policy, conflict, rate-limit, and other
generalized 4xx responses do not qualify. The reviewed retired legacy origin
`cdn.registry.poap.tech` has a separate fail-closed rule: the plan must contain
only one non-public/private `legacy_original` strategy, every retry of every
candidate must report the exact direct `getaddrinfo ENOTFOUND` cause for that
hostname, and the checkpoint records validated candidate and attempt counts.
Any mixed DNS, HTTP, network, strategy, or public outcome remains failed.

After each recovery run, the finalizer rebuilds
`d1-media-manifest.ndjson`, `d1-media-manifest.json`, and
`capture-report.json` from the two immutable journals. It emits a public
object key only for a verified `public_stored` original. Private originals,
quarantined originals, thumbnails, HLS resources, and metadata-only rows never
enter a public URL field. The proof remains incomplete until every recovery
row is terminal and every `publicEligible` plan row has a public original.
The D1 builder therefore continues to reject a partial or mismatched recovery.
Operate `recover` and `recovery-finalize` with a single writer for a snapshot;
the evaluator parses and hashes each immutable NDJSON input from the same
fixed-size file descriptor snapshot, then rechecks every input after writing
the outputs. A concurrent append is rejected.
The adjacent proof identifies this path as
`checkpointMode: "recovery-finalized"` and binds the normalized-media and
capture-checkpoint digests both at top level and inside the recovery binding.

Finalization is offline and can be repeated independently:

```sh
npm run moments:media -- recovery-finalize \
  --input data/moments/moments-YYYY-MM-DD-v1 \
  --snapshot-id moments-YYYY-MM-DD-v1
```

Run recovery again to prove that its append-only checkpoint resumes without
re-uploading completed objects. Before the temporary bridge is deleted,
`verify` must complete the two commands shown above. Pass 1 has no predecessor.
Pass 2 names the exact pass-1 file, stores the SHA-256 of its raw bytes, starts
strictly after pass 1 finishes, and uses a different 128-bit OS-CSPRNG run ID.
Changing only a timestamp, copying a report, reusing a run ID, or selecting a
different predecessor does not create an acceptable second pass.

Each pass uses the fixed `poapin-r2-head-all-v1` algorithm: it runs the same
pure semantic evaluator used by finalization, requires the current manifest
and proof to be its exact output, and HEAD-checks every object reconstructed
from the journals. Stored-object identity contains only `target`, `objectKey`,
`byteLength`, `sha256`, and `contentType`; objects are deduplicated by target
and key, sorted by code-unit order, serialized one canonical JSON object per
line, and hashed after the domain
`POAPIN-MOMENTS-STORED-OBJECT-SET/1\n`. The report records the concurrency,
attempt count, single-object limit, multipart limit, and part size used by the
selected checkpoint. All immutable inputs are evaluated again after the HEAD
pass so an intervening append cannot be attested.

A `capture-only` proof is valid only when every public-eligible row is
`public_stored` and no non-public row remains failed, oversize, or
unattempted. An explicit non-public `source_missing` row is an allowed
metadata-only terminal. Every other case must use `recovery-finalized`, whose
recovery plan covers exactly the rows requiring recovery. Proofs written
before checkpoint mode and both bucket names became explicit are intentionally
rejected and must be finalized again.

These reports are local operator audit evidence. Their hash chain makes
accidental substitution, stale inputs, and packaging mistakes visible; it is
not a third-party signature and does not make evidence unforgeable to a
malicious local operator who controls both this source code and the bridge
secret.

The generated `media/d1-media-manifest.ndjson` is the only media input accepted
by the D1 builder. Its adjacent proof also binds normalized media,
capture-checkpoint, recovery-plan, and recovery-checkpoint SHA-256 digests.

Originals are stored under:

```text
snapshots/<snapshot>/moments/original/sha256/<prefix>/<sha256>.<ext>
snapshots/<snapshot>/moments/private/original/sha256/<prefix>/<sha256>.<ext>
snapshots/<snapshot>/moments/private/derivative/thumbnail/sha256/<prefix>/<sha256>.webp
snapshots/<snapshot>/moments/private/derivative/hls-playlist/sha256/<prefix>/<sha256>.m3u8
snapshots/<snapshot>/moments/private/derivative/hls-segment/sha256/<prefix>/<sha256>.<ext>
```

The initial serving release uses these originals directly. Thumbnail
derivatives can be produced later as a separate reproducible offline job.
