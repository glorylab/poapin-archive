import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { SqlShardWriter, writeStaticArtifact } from "../../archive-import/lib/sql-shards.mjs";
import {
  MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA,
  MOMENTS_MEDIA_VERIFICATION_CHAIN_SCHEMA,
  canonicalMomentsBridgeOrigin,
  isSha256,
  momentsMediaVerificationBindingSha256,
  momentsMediaVerificationChainSha256,
  validateMomentsBucketPair,
} from "../../moments-media/lib/verification.mjs";
import { evaluateMomentsMediaCapture } from "../../moments-media/lib/capture.mjs";
import { evaluateMomentsMediaRecovery } from "../../moments-media/lib/recovery-executor.mjs";
import { exists, writeJsonAtomic } from "./files.mjs";
import { verifyMomentsSnapshot } from "./verify.mjs";

const MAX_SHARD_BYTES = 4 * 1024 * 1024;
const MAX_STATEMENT_BYTES = 90 * 1024;
const ROWS_PER_STATEMENT = 100;
const MEDIA_STATUSES = new Set([
  "pending",
  "public_stored",
  "private_stored",
  "missing",
  "quarantined",
  "failed",
]);
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERIFICATION_RUN_ID = /^[0-9a-f]{32}$/;
const VERIFICATION_ALGORITHM = "poapin-r2-head-all-v1";
const VERIFICATION_RUN_ID_ALGORITHM = "os-csprng-128-bit-hex-v1";
const NORMALIZED_INPUTS = Object.freeze([
  "moments",
  "moment_drops",
  "moment_media",
  "links",
  "user_tags",
  "capsules",
  "capsule_moments",
  "moments_hidden_drops",
  "drops_hidden_drops",
]);
const IMMUTABLE_TABLES = Object.freeze([
  "moments",
  "moment_visibility",
  "moment_drops",
  "moment_hidden_drops",
  "moment_media",
  "moment_links",
  "moment_user_tags",
  "capsules",
  "capsule_visibility",
  "capsule_moments",
  "moment_collections",
]);

export async function buildMomentsD1({
  input,
  output = null,
  snapshotId,
  mediaManifest = null,
  mediaVerificationReports = [],
  mediaCaptureCheckpoint = null,
  mediaRecoveryPlan = null,
  mediaRecoveryCheckpoint = null,
  collectionMap = null,
}) {
  if (!input) throw new Error("buildMomentsD1 requires input.");
  if (!SNAPSHOT_PATTERN.test(snapshotId ?? "")) {
    throw new Error("snapshotId must use the canonical lowercase snapshot format.");
  }
  const root = resolve(input);
  await verifyMomentsSnapshot({ input: root });
  const sourceManifestInput = await readBoundJson(
    resolve(root, "manifest.json"),
    "Moments source manifest",
  );
  const sourceManifest = sourceManifestInput.value;
  const sourceMetadata = sourceManifestInput.metadata;
  const destination = resolve(output ?? resolve(root, "d1"));
  if (await exists(destination)) {
    throw new Error(`D1 output already exists at ${destination}.`);
  }

  const normalizedInputs = new Map(
    await Promise.all(
      NORMALIZED_INPUTS.map(async (name) => {
        const relativePath = `normalized/${name}.ndjson`;
        const bound = await readBoundNdjson(resolve(root, relativePath));
        assertNormalizedArtifact(sourceManifest, relativePath, bound);
        return [name, bound];
      }),
    ),
  );
  const rows = (name) => normalizedInputs.get(name).rows;
  const moments = rows("moments");
  const momentDrops = rows("moment_drops");
  const momentMedia = rows("moment_media");
  const links = rows("links");
  const userTags = rows("user_tags");
  const capsules = rows("capsules");
  const capsuleMoments = rows("capsule_moments");
  const momentsHidden = rows("moments_hidden_drops");
  const dropsHidden = rows("drops_hidden_drops");

  const momentIds = uniqueValues(moments, (row) => uuid(row.id, "moments.id"), "moment");
  const capsuleIds = uniqueValues(
    capsules,
    (row) => positiveInteger(row.id, "capsules.id"),
    "capsule",
  );
  const dropsByMoment = groupMomentDrops(momentDrops, momentIds);
  // Moments Explore uses its dedicated hidden-Drop namespace. The much larger
  // generic Drops hidden table is preserved in the source snapshot, but it is
  // not silently reinterpreted as a Moments publication rule.
  const hiddenDrops = mergeHiddenDrops(momentsHidden, []);
  const publicMomentIds = new Set(
    [...momentIds].filter((momentId) => {
      const dropIds = dropsByMoment.get(momentId) ?? [];
      return dropIds.length > 0 && dropIds.every((dropId) => !hiddenDrops.has(dropId));
    }),
  );
  const resolvedMediaManifest = mediaManifest ? resolve(mediaManifest) : null;
  const mediaInput = resolvedMediaManifest ? await readMediaManifest(resolvedMediaManifest) : null;
  const mediaResults = mediaInput?.rows ?? null;
  const mediaProof = resolvedMediaManifest
    ? await readMediaProof(
        resolvedMediaManifest,
        snapshotId,
        mediaInput.metadata,
        mediaResults.size,
      )
    : null;
  const mediaEvidence = resolvedMediaManifest
    ? await evaluateBoundMediaEvidence({
        root,
        snapshotId,
        manifestPath: resolvedMediaManifest,
        mediaInput,
        mediaProof,
        mediaCaptureCheckpoint,
        mediaRecoveryPlan,
        mediaRecoveryCheckpoint,
      })
    : rejectUnexpectedMediaEvidencePaths({
        mediaCaptureCheckpoint,
        mediaRecoveryPlan,
        mediaRecoveryCheckpoint,
      });
  const mediaVerification = resolvedMediaManifest
    ? await readMediaVerificationReports({
        paths: mediaVerificationReports,
        snapshotId,
        mediaProof,
        mediaEvidence,
      })
    : rejectUnexpectedMediaVerificationReports(mediaVerificationReports);
  const resolvedCollectionMap = collectionMap ? resolve(collectionMap) : null;
  const collectionInput = resolvedCollectionMap
    ? await readCollectionMap(resolvedCollectionMap, momentIds)
    : null;
  const collectionRows = collectionInput?.rows ?? [];
  const validationMetadata = (await readBoundBytes(resolve(root, "validation/report.json")))
    .metadata;
  const stabilityDescriptor = await readStabilityProof(root, sourceManifest, sourceMetadata);
  const mediaDescriptor = mediaManifest
    ? {
        path: basename(resolvedMediaManifest),
        rows: mediaResults.size,
        statuses: countMediaManifestStatuses(mediaResults),
        ...mediaInput.metadata,
        proof: describeMediaProof(mediaProof),
      }
    : null;
  const collectionDescriptor = collectionMap
    ? {
        path: basename(resolvedCollectionMap),
        rows: collectionRows.length,
        ...collectionInput.metadata,
        proof: await readCollectionMapProof({
          path: resolvedCollectionMap,
          rows: collectionRows.length,
          mapMetadata: collectionInput.metadata,
          sourceManifest,
          sourceMetadata,
        }),
      }
    : null;
  const sourceDatabaseSha256 = digestJson({
    version: 2,
    snapshotId,
    sourceManifest: sourceMetadata,
    stability: {
      sha256: stabilityDescriptor.sha256,
      byteLength: stabilityDescriptor.byteLength,
      secondaryManifestSha256: stabilityDescriptor.secondary.manifestSha256,
    },
    mediaManifest: mediaDescriptor
      ? {
          sha256: mediaDescriptor.sha256,
          byteLength: mediaDescriptor.byteLength,
          rows: mediaDescriptor.rows,
          proofSha256: mediaDescriptor.proof.sha256,
        }
      : null,
    mediaVerification: mediaVerification
      ? {
          chainSha256: mediaVerification.chainSha256,
          bindingSha256: mediaVerification.bindingSha256,
          stored: mediaVerification.binding.stored,
          storedObjectSetSha256: mediaVerification.binding.storedObjectSetSha256,
          reports: mediaVerification.reports.map((report) => ({
            sha256: report.sha256,
            byteLength: report.byteLength,
            verifiedAt: report.verifiedAt,
          })),
        }
      : null,
    collectionMap: collectionDescriptor
      ? {
          sha256: collectionDescriptor.sha256,
          byteLength: collectionDescriptor.byteLength,
          rows: collectionDescriptor.rows,
          proofSha256: collectionDescriptor.proof.sha256,
        }
      : null,
  });
  const tableCounts = emptyTableCounts();
  const artifacts = [];
  const emitter = {
    destination,
    snapshotId,
    sourceDatabaseSha256,
    artifacts,
    tableIndex: 0,
  };

  await mkdir(destination, { recursive: true });
  try {
    if (mediaVerification) {
      for (let index = 0; index < mediaVerification.reports.length; index += 1) {
        const expected = mediaVerification.reports[index];
        const copied = await writeStaticArtifact(
          destination,
          expected.path,
          await readFile(resolve(mediaVerificationReports[index])),
          { kind: "moments-media-verification-evidence" },
        );
        if (copied.sha256 !== expected.sha256 || copied.byteLength !== expected.byteLength) {
          throw new Error(
            `Remote verification pass ${index + 1} changed before evidence packaging.`,
          );
        }
      }
    }
    const migrationRoot = resolve(import.meta.dirname, "../../../migrations/moments");
    artifacts.push(
      await writeStaticArtifact(
        destination,
        "prepare/000001_schema.sql",
        await readFile(resolve(migrationRoot, "0001_schema.sql"), "utf8"),
        { kind: "d1-sql", phase: "prepare", database: "moments" },
      ),
      await writeStaticArtifact(
        destination,
        "prepare/000002_import_shards.sql",
        await readFile(resolve(migrationRoot, "0002_import_shards.sql"), "utf8"),
        { kind: "d1-sql", phase: "prepare", database: "moments" },
      ),
      await writeStaticArtifact(
        destination,
        "prepare/000003_import_guards.sql",
        await readFile(resolve(migrationRoot, "0003_import_guards.sql"), "utf8"),
        { kind: "d1-sql", phase: "prepare", database: "moments" },
      ),
    );
    const importPlan = {
      moments: moments.length,
      moment_visibility: moments.length,
      moment_drops: momentDrops.length,
      moment_hidden_drops: hiddenDrops.size,
      moment_media: momentMedia.length,
      moment_links: links.length,
      moment_user_tags: userTags.length,
      capsules: capsules.length,
      capsule_visibility: capsules.length,
      capsule_moments: capsuleMoments.length,
      moment_collections: collectionRows.length,
    };
    await emitRows(
      emitter,
      "moments_import_plan",
      ["table_name", "expected_rows"],
      IMMUTABLE_TABLES.map((table) => [table, importPlan[table]]),
      tableCounts,
    );
    await emitRows(
      emitter,
      "moments",
      [
        "moment_id",
        "display_id",
        "author",
        "author_address_norm",
        "description",
        "cid",
        "token_id",
        "legacy_drop_id",
        "created_on",
        "updated_on",
        "updated",
      ],
      moments.map(mapMoment),
      tableCounts,
    );
    await emitRows(
      emitter,
      "moment_visibility",
      ["moment_id", "is_public", "source_scope", "evaluated_on"],
      moments.map((row) => {
        const momentId = uuid(row.id, "moments.id");
        const linked = dropsByMoment.get(momentId) ?? [];
        const hidden = linked.some((dropId) => hiddenDrops.has(dropId));
        return [
          momentId,
          publicMomentIds.has(momentId) ? 1 : 0,
          hidden ? "hidden_drop" : linked.length ? "drop_linked" : "without_drop",
          sourceManifest.finishedAt,
        ];
      }),
      tableCounts,
    );
    await emitRows(
      emitter,
      "moment_drops",
      ["moment_id", "drop_id", "position"],
      positioned(momentDrops, (row) => uuid(row.moment_id, "moment_drops.moment_id")).map(
        ({ row, position }) => [
          uuid(row.moment_id, "moment_drops.moment_id"),
          positiveInteger(row.drop_id, "moment_drops.drop_id"),
          position,
        ],
      ),
      tableCounts,
    );
    await emitRows(
      emitter,
      "moment_hidden_drops",
      ["drop_id", "hidden_on", "source"],
      [...hiddenDrops.values()]
        .sort((left, right) => compareIntegerText(left.dropId, right.dropId))
        .map((row) => [row.dropId, row.hiddenOn, row.source]),
      tableCounts,
    );

    const consumedMedia = new Set();
    const positionedMedia = positioned(momentMedia, (row) =>
      row.moment_id === null ? "__orphan__" : uuid(row.moment_id, "moment_media.moment_id"),
    );
    const mediaRows = positionedMedia.map(({ row, position }) => {
      const mediaKey = required(row.key, "moment_media.key");
      const archived = mediaResults?.get(mediaKey) ?? null;
      if (mediaResults && !archived) {
        throw new Error(`Media manifest is missing mediaKey ${mediaKey}.`);
      }
      consumedMedia.add(mediaKey);
      return mapMedia(row, archived, position, snapshotId);
    });
    if (mediaResults) {
      const extras = [...mediaResults.keys()].filter((key) => !consumedMedia.has(key));
      if (extras.length) {
        throw new Error(
          `Media manifest contains ${extras.length} key(s) absent from moment_media; first: ${extras[0]}.`,
        );
      }
    }
    await emitRows(
      emitter,
      "moment_media",
      [
        "media_key",
        "moment_id",
        "media_kind",
        "mime_type",
        "source_hash",
        "source_status",
        "source_status_reason",
        "object_key",
        "archive_sha256",
        "archive_byte_length",
        "archive_content_type",
        "archive_status",
        "width",
        "height",
        "duration_ms",
        "position",
        "created_at",
        "updated_at",
      ],
      mediaRows,
      tableCounts,
    );

    await emitRows(
      emitter,
      "moment_links",
      [
        "link_id",
        "moment_id",
        "title",
        "description",
        "url",
        "image_object_key",
        "image_sha256",
        "image_mime_type",
        "image_archive_status",
        "created_on",
        "position",
      ],
      positioned(links, (row) => uuid(row.moment_id, "links.moment_id")).map(
        ({ row, position }) => [
          uuid(row.id, "links.id"),
          uuid(row.moment_id, "links.moment_id"),
          nullable(row.title),
          nullable(row.description),
          nullable(row.url),
          null,
          null,
          null,
          "pending",
          nullable(row.created_at),
          position,
        ],
      ),
      tableCounts,
    );
    await emitRows(
      emitter,
      "moment_user_tags",
      [
        "tag_id",
        "moment_id",
        "address",
        "address_norm",
        "ens",
        "created_by",
        "x",
        "y",
        "created_on",
        "position",
      ],
      positioned(userTags, (row) => uuid(row.moment_id, "user_tags.moment_id")).map(
        ({ row, position }) => [
          uuid(row.id, "user_tags.id"),
          uuid(row.moment_id, "user_tags.moment_id"),
          nullableTrimmed(row.address),
          normalizedAddress(row.address),
          nullableTrimmed(row.ens),
          nullableTrimmed(row.created_by),
          integerOrNull(row.x, "user_tags.x"),
          integerOrNull(row.y, "user_tags.y"),
          nullable(row.created_on),
          position,
        ],
      ),
      tableCounts,
    );

    await emitRows(
      emitter,
      "capsules",
      [
        "capsule_id",
        "external_id",
        "owner",
        "owner_address_norm",
        "title",
        "description",
        "url",
        "image_object_key",
        "image_sha256",
        "image_mime_type",
        "image_archive_status",
        "created_on",
      ],
      capsules.map((row) => [
        positiveInteger(row.id, "capsules.id"),
        nullable(row.id_external),
        nullableTrimmed(row.owner),
        normalizedAddress(row.owner),
        nullable(row.title),
        nullable(row.description),
        nullable(row.url),
        null,
        null,
        null,
        "pending",
        required(row.created_on, "capsules.created_on"),
      ]),
      tableCounts,
    );
    const capsuleMomentIds = new Map();
    for (const row of capsuleMoments) {
      const capsuleId = positiveInteger(row.capsule_id, "capsule_moments.capsule_id");
      if (!capsuleIds.has(capsuleId)) throw new Error(`Unknown capsule ${capsuleId}.`);
      const momentId = uuid(row.moment_id, "capsule_moments.moment_id");
      const values = capsuleMomentIds.get(capsuleId) ?? [];
      values.push(momentId);
      capsuleMomentIds.set(capsuleId, values);
    }
    const publicCapsuleIds = new Set(
      capsules
        .map((row) => positiveInteger(row.id, "capsules.id"))
        .filter((capsuleId) =>
          (capsuleMomentIds.get(capsuleId) ?? []).some((momentId) => publicMomentIds.has(momentId)),
        ),
    );
    await emitRows(
      emitter,
      "capsule_visibility",
      ["capsule_id", "is_public", "source_scope", "evaluated_on"],
      capsules.map((row) => {
        const capsuleId = positiveInteger(row.id, "capsules.id");
        const isPublic = publicCapsuleIds.has(capsuleId);
        return [
          capsuleId,
          isPublic ? 1 : 0,
          isPublic ? "linked_public_moment" : "without_public_moment",
          sourceManifest.finishedAt,
        ];
      }),
      tableCounts,
    );
    await emitRows(
      emitter,
      "capsule_moments",
      ["capsule_id", "moment_id", "created_on", "created_by", "position"],
      positioned(capsuleMoments, (row) =>
        positiveInteger(row.capsule_id, "capsule_moments.capsule_id"),
      ).map(({ row, position }) => [
        positiveInteger(row.capsule_id, "capsule_moments.capsule_id"),
        uuid(row.moment_id, "capsule_moments.moment_id"),
        nullable(row.created_at),
        nullableTrimmed(row.created_by),
        position,
      ]),
      tableCounts,
    );
    await emitRows(
      emitter,
      "moment_collections",
      ["moment_id", "collection_id"],
      collectionRows,
      tableCounts,
    );

    const mediaStatuses = countD1MediaStatuses(mediaRows);
    await emitRows(
      emitter,
      "moments_meta",
      ["key", "value"],
      [
        ["snapshot_id", snapshotId],
        ["dataset", sourceManifest.dataset],
        ["source_manifest_sha256", sourceMetadata.sha256],
        ["source_database_sha256", sourceDatabaseSha256],
        ["source_started_at", sourceManifest.startedAt],
        ["source_finished_at", sourceManifest.finishedAt],
        ["ready", "0"],
        ["snapshot_at", sourceManifest.finishedAt],
        ["source_moments_count", String(moments.length)],
        ["public_moments_count", String(publicMomentIds.size)],
        ["media_count", String(mediaRows.length)],
        ["media_mode", mediaManifest ? "media-bound" : "metadata-only"],
        ...Object.entries(mediaStatuses).map(([status, count]) => [
          `media_status_${status}`,
          String(count),
        ]),
        ["capsules_count", String(capsules.length)],
        ["public_capsules_count", String(publicCapsuleIds.size)],
        ["media_manifest", mediaManifest ? basename(resolve(mediaManifest)) : ""],
        ["collection_map", collectionMap ? basename(resolve(collectionMap)) : ""],
      ],
      tableCounts,
    );
    if (mediaEvidence) {
      await revalidateBoundMediaEvidence({
        mediaEvidence,
        mediaInput,
        mediaProof,
      });
    }
    const buildManifest = {
      version: 2,
      dataset: "poapin-moments-d1-import",
      snapshotId,
      builtAt: new Date().toISOString(),
      sourceDatabaseSha256,
      source: {
        snapshotDirectory: basename(root),
        manifest: { path: "manifest.json", ...sourceMetadata },
        validation: { path: "validation/report.json", ...validationMetadata },
        stability: stabilityDescriptor,
        schemaSha256: sourceManifest.schema.sha256,
      },
      mediaManifest: mediaDescriptor,
      mediaVerification,
      media: {
        mode: mediaManifest ? "media-bound" : "metadata-only",
        ready: Boolean(mediaManifest),
        rows: mediaRows.length,
        statuses: mediaStatuses,
      },
      collectionMap: collectionDescriptor,
      tables: tableCounts,
      projection: {
        publicMoments: publicMomentIds.size,
        publicCapsules: publicCapsuleIds.size,
        momentsHiddenDrops: hiddenDrops.size,
      },
      excludedFromD1: {
        gateways: sourceManifest.entities.gateways.rows,
        genericDropHiddenRows: dropsHidden.length,
        featuredDropRows:
          sourceManifest.entities.moments_featured_drops.rows +
          sourceManifest.entities.drops_featured_drops.rows,
        note: "These rows remain in the verified raw and normalized snapshot; gateway URLs/metadata are intentionally not in the public D1 schema.",
      },
      artifacts,
      settings: {
        maxShardBytes: MAX_SHARD_BYTES,
        maxStatementBytes: MAX_STATEMENT_BYTES,
        rowsPerStatement: ROWS_PER_STATEMENT,
        explicitTransactions: false,
      },
    };
    await writeJsonAtomic(resolve(destination, "manifest.json"), buildManifest);
    return { output: destination, ...buildManifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function mapMoment(row) {
  const author = nullableTrimmed(row.author);
  return [
    uuid(row.id, "moments.id"),
    nullable(row.display_id),
    author,
    normalizedAddress(author),
    nullable(row.description),
    nullable(row.cid),
    nullable(row.token_id),
    integerOrNull(row.drop_id, "moments.drop_id"),
    required(row.created_on, "moments.created_on"),
    nullable(row.updated_on),
    row.updated === true ? 1 : 0,
  ];
}

function mapMedia(row, archived, position, snapshotId) {
  const status = normalizeMediaStatus(archived?.status ?? "pending");
  const sha = archived?.sha256 ? sha256(archived.sha256, "mediaManifest.sha256") : null;
  let objectKey = status === "public_stored" ? nullable(archived?.objectKey) : null;
  if (status === "public_stored") {
    if (
      !objectKey ||
      !sha ||
      !archived?.contentType ||
      archived?.byteLength === null ||
      archived?.byteLength === undefined
    ) {
      throw new Error(
        `${row.key}: public_stored media requires objectKey, sha256, byteLength, and contentType.`,
      );
    }
    const prefix = `snapshots/${snapshotId}/moments/original/sha256/${sha.slice(0, 2)}/${sha}.`;
    if (!objectKey.startsWith(prefix) || !/^[a-z0-9]+$/i.test(objectKey.slice(prefix.length))) {
      throw new Error(`${row.key}: public objectKey does not match the content-addressed layout.`);
    }
  }
  const sourceMime = nullable(row.mime_type);
  const archiveContentType = nullable(archived?.contentType);
  return [
    required(row.key, "moment_media.key"),
    row.moment_id === null ? null : uuid(row.moment_id, "moment_media.moment_id"),
    mediaKind(archiveContentType ?? sourceMime),
    sourceMime,
    nullable(row.hash),
    required(row.status, "moment_media.status"),
    nullable(row.status_reason),
    objectKey,
    sha,
    nonNegativeIntegerOrNull(archived?.byteLength, "mediaManifest.byteLength"),
    archiveContentType,
    status,
    positiveIntegerOrNull(archived?.width, "mediaManifest.width"),
    positiveIntegerOrNull(archived?.height, "mediaManifest.height"),
    nonNegativeIntegerOrNull(archived?.durationMs, "mediaManifest.durationMs"),
    position,
    nullable(row.created_at),
    nullable(row.updated_at),
  ];
}

async function readMediaManifest(path) {
  const input = await readBoundNdjson(path);
  const rows = new Map();
  for (const row of input.rows) {
    const key = required(row.mediaKey, "mediaManifest.mediaKey");
    if (rows.has(key)) throw new Error(`Media manifest contains duplicate mediaKey ${key}.`);
    rows.set(key, {
      objectKey: nullable(row.objectKey),
      sha256: row.sha256 ? sha256(row.sha256, "mediaManifest.sha256") : null,
      byteLength: row.byteLength ?? null,
      contentType: nullable(row.contentType),
      status: normalizeMediaStatus(row.status),
      rawStatus: required(row.status, "mediaManifest.status"),
      width: row.width ?? null,
      height: row.height ?? null,
      durationMs: row.durationMs ?? null,
    });
  }
  return { rows, rawRows: input.rows, metadata: input.metadata };
}

async function readMediaProof(manifestPath, snapshotId, manifestMetadata, manifestRows) {
  if (!manifestPath.endsWith(".ndjson")) {
    throw new Error("Media manifest path must end with .ndjson.");
  }
  const proofPath = resolve(dirname(manifestPath), `${basename(manifestPath, ".ndjson")}.json`);
  const proofInput = await readBoundJson(proofPath, "Media proof");
  const proof = proofInput.value;
  if (
    proof?.schemaVersion !== "poapin-moments-d1-media-proof-v1" ||
    proof.snapshotId !== snapshotId ||
    !/^[0-9a-f]{64}$/.test(proof.planSha256 ?? "") ||
    proof.manifestSha256 !== manifestMetadata.sha256 ||
    proof.manifestRows !== manifestRows ||
    proof.complete !== true ||
    proof.publicProjectionReady !== true
  ) {
    throw new Error("Media proof does not bind a complete public-ready capture to this snapshot.");
  }
  validateMomentsBucketPair(proof.publicBucket, proof.privateBucket);
  let checkpointMode;
  let normalizedMediaSha256;
  let captureCheckpointSha256;
  let recovery;
  if (
    proof.checkpointMode === "capture-only" &&
    proof.recovery === null &&
    isSha256(proof.normalizedMediaSha256) &&
    isSha256(proof.captureCheckpointSha256)
  ) {
    checkpointMode = "capture-only";
    normalizedMediaSha256 = proof.normalizedMediaSha256;
    captureCheckpointSha256 = proof.captureCheckpointSha256;
    recovery = null;
  } else if (
    proof.checkpointMode === "recovery-finalized" &&
    isSha256(proof.recovery?.planSha256) &&
    isSha256(proof.recovery?.normalizedMediaSha256) &&
    isSha256(proof.recovery?.captureCheckpointSha256) &&
    isSha256(proof.recovery?.checkpointSha256) &&
    (proof.normalizedMediaSha256 === undefined ||
      proof.normalizedMediaSha256 === proof.recovery.normalizedMediaSha256) &&
    (proof.captureCheckpointSha256 === undefined ||
      proof.captureCheckpointSha256 === proof.recovery.captureCheckpointSha256)
  ) {
    checkpointMode = "recovery-finalized";
    normalizedMediaSha256 = proof.recovery.normalizedMediaSha256;
    captureCheckpointSha256 = proof.recovery.captureCheckpointSha256;
    recovery = {
      planSha256: proof.recovery.planSha256,
      checkpointSha256: proof.recovery.checkpointSha256,
    };
  } else {
    throw new Error("Media proof does not declare a valid checkpoint mode.");
  }
  return {
    path: proofPath,
    rawProof: proof,
    ...proofInput.metadata,
    schemaVersion: proof.schemaVersion,
    planSha256: proof.planSha256,
    manifestSha256: proof.manifestSha256,
    manifestRows: proof.manifestRows,
    complete: true,
    publicProjectionReady: true,
    checkpointMode,
    publicBucket: proof.publicBucket,
    privateBucket: proof.privateBucket,
    normalizedMediaSha256,
    captureCheckpointSha256,
    recovery,
  };
}

function describeMediaProof(mediaProof) {
  const descriptor = { ...mediaProof, path: basename(mediaProof.path) };
  delete descriptor.rawProof;
  return descriptor;
}

async function evaluateBoundMediaEvidence({
  root,
  snapshotId,
  manifestPath,
  mediaInput,
  mediaProof,
  mediaCaptureCheckpoint,
  mediaRecoveryPlan,
  mediaRecoveryCheckpoint,
}) {
  if (
    mediaProof.checkpointMode === "capture-only" &&
    (mediaRecoveryPlan !== null || mediaRecoveryCheckpoint !== null)
  ) {
    throw new Error("Capture-only media proof cannot be built with recovery journal overrides.");
  }
  const selection =
    mediaProof.checkpointMode === "capture-only"
      ? {
          checkpointMode: "capture-only",
          options: {
            input: root,
            snapshotId,
            publicBucket: mediaProof.publicBucket,
            privateBucket: mediaProof.privateBucket,
            checkpointPath: resolve(
              mediaCaptureCheckpoint ?? resolve(root, "media/capture-checkpoint.ndjson"),
            ),
            manifestPath,
            reportPath: resolve(root, "media/capture-report.json"),
          },
        }
      : {
          checkpointMode: "recovery-finalized",
          options: {
            input: root,
            snapshotId,
            captureCheckpointPath: resolve(
              mediaCaptureCheckpoint ?? resolve(root, "media/capture-checkpoint.ndjson"),
            ),
            recoveryPlanPath: resolve(
              mediaRecoveryPlan ?? resolve(root, "media/recovery-plan.ndjson"),
            ),
            checkpointPath: resolve(
              mediaRecoveryCheckpoint ?? resolve(root, "media/recovery-checkpoint.ndjson"),
            ),
            manifestPath,
            reportPath: resolve(root, "media/recovery-report.json"),
          },
        };
  const evaluation = await runMediaEvidenceEvaluation(selection);
  validateBoundMediaEvaluation({
    evaluation,
    mediaInput,
    mediaProof,
    manifestPath,
  });
  return { ...evaluation, selection };
}

async function revalidateBoundMediaEvidence({ mediaEvidence, mediaInput, mediaProof }) {
  const [evaluation, currentManifest] = await Promise.all([
    runMediaEvidenceEvaluation(mediaEvidence.selection),
    readMediaManifest(mediaEvidence.selection.options.manifestPath),
  ]);
  const currentProof = await readMediaProof(
    mediaEvidence.selection.options.manifestPath,
    mediaEvidence.snapshotId,
    currentManifest.metadata,
    currentManifest.rows.size,
  );
  validateBoundMediaEvaluation({
    evaluation,
    mediaInput: currentManifest,
    mediaProof: currentProof,
    manifestPath: mediaEvidence.selection.options.manifestPath,
  });
  if (
    currentManifest.metadata.sha256 !== mediaInput.metadata.sha256 ||
    currentProof.sha256 !== mediaProof.sha256 ||
    JSON.stringify(evaluation.binding) !== JSON.stringify(mediaEvidence.binding) ||
    JSON.stringify(evaluation.storedObjectSet) !== JSON.stringify(mediaEvidence.storedObjectSet)
  ) {
    throw new Error("Media recovery evidence changed while the D1 build was running.");
  }
}

function runMediaEvidenceEvaluation(selection) {
  return selection.checkpointMode === "capture-only"
    ? evaluateMomentsMediaCapture(selection.options)
    : evaluateMomentsMediaRecovery(selection.options);
}

function validateBoundMediaEvaluation({ evaluation, mediaInput, mediaProof, manifestPath }) {
  const expectedProof = {
    schemaVersion: evaluation.proof.schemaVersion,
    snapshotId: evaluation.proof.snapshotId,
    generatedAt: mediaProof.rawProof?.generatedAt,
    planSha256: evaluation.proof.planSha256,
    manifestSha256: evaluation.proof.manifestSha256,
    manifestRows: evaluation.proof.manifestRows,
    complete: evaluation.proof.complete,
    publicProjectionReady: evaluation.proof.publicProjectionReady,
    checkpointMode: evaluation.proof.checkpointMode,
    publicBucket: evaluation.proof.publicBucket,
    privateBucket: evaluation.proof.privateBucket,
    normalizedMediaSha256: evaluation.proof.normalizedMediaSha256,
    captureCheckpointSha256: evaluation.proof.captureCheckpointSha256,
    recovery: evaluation.proof.recovery,
  };
  if (
    evaluation.complete !== true ||
    evaluation.publicProjectionReady !== true ||
    resolve(evaluation.paths.manifest) !== resolve(manifestPath) ||
    resolve(evaluation.paths.proof) !== resolve(mediaProof.path) ||
    evaluation.manifestSha256 !== mediaInput.metadata.sha256 ||
    evaluation.manifest.length !== mediaInput.rows.size ||
    JSON.stringify(evaluation.manifest) !== JSON.stringify(mediaInput.rawRows) ||
    !isCanonicalInstant(mediaProof.rawProof?.generatedAt) ||
    JSON.stringify(mediaProof.rawProof) !== JSON.stringify(expectedProof) ||
    evaluation.proof.checkpointMode !== mediaProof.checkpointMode ||
    evaluation.proof.publicBucket !== mediaProof.publicBucket ||
    evaluation.proof.privateBucket !== mediaProof.privateBucket ||
    evaluation.binding.mediaPlanSha256 !== mediaProof.planSha256 ||
    evaluation.binding.mediaManifestSha256 !== mediaProof.manifestSha256 ||
    evaluation.binding.normalizedMediaSha256 !== mediaProof.normalizedMediaSha256 ||
    evaluation.binding.captureCheckpointSha256 !== mediaProof.captureCheckpointSha256 ||
    evaluation.binding.recoveryPlanSha256 !== (mediaProof.recovery?.planSha256 ?? null) ||
    evaluation.binding.recoveryCheckpointSha256 !==
      (mediaProof.recovery?.checkpointSha256 ?? null) ||
    evaluation.binding.stored !== evaluation.storedObjectSet.stored ||
    evaluation.binding.storedObjectSetSha256 !== evaluation.storedObjectSet.sha256
  ) {
    throw new Error(
      "Media manifest and proof are not the exact output of the selected immutable journals.",
    );
  }
  validateMomentsBucketPair(evaluation.binding.publicBucket, evaluation.binding.privateBucket);
}

function rejectUnexpectedMediaEvidencePaths({
  mediaCaptureCheckpoint,
  mediaRecoveryPlan,
  mediaRecoveryCheckpoint,
}) {
  if (
    mediaCaptureCheckpoint !== null ||
    mediaRecoveryPlan !== null ||
    mediaRecoveryCheckpoint !== null
  ) {
    throw new Error("Metadata-only Moments D1 builds cannot select media journal inputs.");
  }
  return null;
}

async function readMediaVerificationReports({ paths, snapshotId, mediaProof, mediaEvidence }) {
  if (!Array.isArray(paths) || paths.length !== 2) {
    throw new Error(
      "Media-bound Moments D1 builds require exactly two remote verification reports.",
    );
  }
  const resolved = paths.map((path) => resolve(path));
  if (new Set(resolved).size !== 2) {
    throw new Error("Remote verification reports must be two distinct files.");
  }
  const inputs = await Promise.all(
    resolved.map((path) => readBoundJson(path, "Remote media verification report")),
  );
  if (new Set(inputs.map((input) => input.metadata.sha256)).size !== 2) {
    throw new Error("Remote verification reports must have distinct file digests.");
  }

  const reports = inputs.map((input, index) => {
    const report = input.value;
    if (
      report?.schemaVersion !== MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA ||
      report.snapshotId !== snapshotId ||
      report.pass !== index + 1 ||
      !VERIFICATION_RUN_ID.test(report.runId ?? "") ||
      report.runIdAlgorithm !== VERIFICATION_RUN_ID_ALGORITHM ||
      report.algorithm !== VERIFICATION_ALGORITHM ||
      !isCanonicalInstant(report.startedAt) ||
      report.complete !== true ||
      !isCanonicalInstant(report.verifiedAt) ||
      Date.parse(report.startedAt) > Date.parse(report.verifiedAt) ||
      !Number.isSafeInteger(report.counts?.stored) ||
      report.counts.stored < 0 ||
      report.counts.verified !== report.counts.stored ||
      report.counts.failed !== 0 ||
      !Array.isArray(report.failures) ||
      report.failures.length !== 0
    ) {
      throw new Error("Remote media verification report is incomplete or invalid.");
    }
    const limits = canonicalVerificationLimits(report.limits);
    if (JSON.stringify(report.limits) !== JSON.stringify(limits)) {
      throw new Error("Remote media verification report has non-canonical limits.");
    }
    const binding = canonicalMediaVerificationBinding(report.binding, {
      snapshotId,
      mediaProof,
      mediaEvidence,
    });
    if (
      JSON.stringify(report.binding) !== JSON.stringify(binding) ||
      binding.stored !== report.counts.stored
    ) {
      throw new Error("Remote media verification report has a non-canonical binding.");
    }
    const canonicalReport = {
      schemaVersion: MOMENTS_MEDIA_REMOTE_VERIFICATION_SCHEMA,
      snapshotId,
      pass: index + 1,
      runId: report.runId,
      runIdAlgorithm: VERIFICATION_RUN_ID_ALGORITHM,
      algorithm: VERIFICATION_ALGORITHM,
      startedAt: report.startedAt,
      verifiedAt: report.verifiedAt,
      previousReportSha256: report.previousReportSha256,
      complete: true,
      binding,
      limits,
      counts: {
        stored: binding.stored,
        verified: binding.stored,
        failed: 0,
      },
      failures: [],
    };
    if (JSON.stringify(report) !== JSON.stringify(canonicalReport)) {
      throw new Error("Remote media verification report is not canonical.");
    }
    return {
      sequence: index + 1,
      path: `evidence/media-verification/pass${index + 1}-` + `${input.metadata.sha256}.json`,
      ...input.metadata,
      pass: report.pass,
      runId: report.runId,
      runIdAlgorithm: report.runIdAlgorithm,
      algorithm: report.algorithm,
      startedAt: report.startedAt,
      verifiedAt: report.verifiedAt,
      previousReportSha256: report.previousReportSha256,
      limits,
      binding,
    };
  });
  if (JSON.stringify(reports[0].binding) !== JSON.stringify(reports[1].binding)) {
    throw new Error("Remote verification reports do not bind the same stored object set.");
  }
  if (
    reports[0].previousReportSha256 !== null ||
    reports[1].previousReportSha256 !== reports[0].sha256
  ) {
    throw new Error("Remote verification reports do not form an exact pass1/pass2 hash chain.");
  }
  if (reports[0].runId === reports[1].runId) {
    throw new Error("Remote verification reports must use different CSPRNG run IDs.");
  }
  if (Date.parse(reports[0].verifiedAt) >= Date.parse(reports[1].startedAt)) {
    throw new Error("Remote verification passes must be strictly ordered and non-overlapping.");
  }
  const binding = reports[0].binding;
  const chainReports = reports.map(({ binding: ignored, ...report }) => report);
  const bindingSha256 = momentsMediaVerificationBindingSha256(binding);
  return {
    schemaVersion: MOMENTS_MEDIA_VERIFICATION_CHAIN_SCHEMA,
    binding,
    bindingSha256,
    chainSha256: momentsMediaVerificationChainSha256(bindingSha256, chainReports),
    reports: chainReports,
  };
}

function canonicalVerificationLimits(value) {
  const limits = {
    concurrency: value?.concurrency,
    attempts: value?.attempts,
    maximumObjectBytes: value?.maximumObjectBytes,
    maximumMultipartObjectBytes: value?.maximumMultipartObjectBytes,
    multipartPartBytes: value?.multipartPartBytes,
  };
  if (
    !Number.isSafeInteger(limits.concurrency) ||
    limits.concurrency < 1 ||
    limits.concurrency > 12 ||
    !Number.isSafeInteger(limits.attempts) ||
    limits.attempts < 1 ||
    limits.attempts > 10 ||
    !Number.isSafeInteger(limits.maximumObjectBytes) ||
    limits.maximumObjectBytes < 1 ||
    limits.maximumObjectBytes > 100_000_000 ||
    !(
      (limits.maximumMultipartObjectBytes === null && limits.multipartPartBytes === null) ||
      (Number.isSafeInteger(limits.maximumMultipartObjectBytes) &&
        limits.maximumMultipartObjectBytes >= limits.maximumObjectBytes &&
        limits.maximumMultipartObjectBytes <= 5_000_000_000_000 &&
        Number.isSafeInteger(limits.multipartPartBytes) &&
        limits.multipartPartBytes >= 5_242_880 &&
        limits.multipartPartBytes <= limits.maximumObjectBytes &&
        Math.ceil(limits.maximumMultipartObjectBytes / limits.multipartPartBytes) <= 10_000)
    )
  ) {
    throw new Error("Remote media verification limits are invalid.");
  }
  return limits;
}

function canonicalMediaVerificationBinding(value, { snapshotId, mediaProof, mediaEvidence }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Remote media verification binding is invalid.");
  }
  const binding = {
    snapshotId: value.snapshotId,
    checkpointMode: value.checkpointMode,
    publicBucket: value.publicBucket,
    privateBucket: value.privateBucket,
    bridgeOrigin: value.bridgeOrigin,
    mediaPlanSha256: value.mediaPlanSha256,
    mediaManifestSha256: value.mediaManifestSha256,
    mediaProofSha256: value.mediaProofSha256,
    normalizedMediaSha256: value.normalizedMediaSha256,
    captureCheckpointSha256: value.captureCheckpointSha256,
    recoveryPlanSha256: value.recoveryPlanSha256,
    recoveryCheckpointSha256: value.recoveryCheckpointSha256,
    stored: value.stored,
    storedObjectSetSha256: value.storedObjectSetSha256,
  };
  validateMomentsBucketPair(binding.publicBucket, binding.privateBucket);
  if (
    binding.snapshotId !== snapshotId ||
    canonicalMomentsBridgeOrigin(binding.bridgeOrigin) !== binding.bridgeOrigin ||
    binding.mediaPlanSha256 !== mediaProof.planSha256 ||
    binding.mediaManifestSha256 !== mediaProof.manifestSha256 ||
    binding.mediaProofSha256 !== mediaProof.sha256 ||
    binding.checkpointMode !== mediaProof.checkpointMode ||
    binding.publicBucket !== mediaProof.publicBucket ||
    binding.privateBucket !== mediaProof.privateBucket ||
    binding.normalizedMediaSha256 !== mediaProof.normalizedMediaSha256 ||
    binding.captureCheckpointSha256 !== mediaProof.captureCheckpointSha256 ||
    binding.recoveryPlanSha256 !== (mediaProof.recovery?.planSha256 ?? null) ||
    binding.recoveryCheckpointSha256 !== (mediaProof.recovery?.checkpointSha256 ?? null) ||
    binding.stored !== mediaEvidence.binding.stored ||
    binding.storedObjectSetSha256 !== mediaEvidence.binding.storedObjectSetSha256 ||
    !Number.isSafeInteger(binding.stored) ||
    binding.stored < 0 ||
    !isSha256(binding.storedObjectSetSha256)
  ) {
    throw new Error("Remote media verification report is not bound to the finalized media proof.");
  }
  return binding;
}

function rejectUnexpectedMediaVerificationReports(paths) {
  if (!Array.isArray(paths) || paths.length !== 0) {
    throw new Error("Metadata-only Moments D1 builds cannot claim media verification reports.");
  }
  return null;
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  );
}

async function readStabilityProof(root, sourceManifest, sourceMetadata) {
  const path = resolve(root, "validation/stability.json");
  if (!(await exists(path))) {
    throw new Error(
      "Moments D1 build requires validation/stability.json from a distinct stable second capture.",
    );
  }
  const input = await readBoundJson(path, "Moments stability proof");
  const report = input.value;
  const primaryArtifacts = new Map(
    (sourceManifest.normalized?.artifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  const reportArtifacts = report?.normalized?.artifacts;
  if (
    report?.version !== 1 ||
    report.dataset !== "poapin-moments-stability" ||
    report.sourceDataset !== sourceManifest.dataset ||
    report.stable !== true ||
    report.normalized?.stable !== true ||
    !Array.isArray(reportArtifacts) ||
    !Array.isArray(report.differences) ||
    report.differences.length !== 0 ||
    report.primary?.manifestSha256 !== sourceMetadata.sha256 ||
    report.primary?.manifestByteLength !== sourceMetadata.byteLength ||
    report.primary?.startedAt !== sourceManifest.startedAt ||
    report.primary?.finishedAt !== sourceManifest.finishedAt ||
    !validCaptureWindow(report.primary) ||
    !validCaptureWindow(report.secondary) ||
    !/^[0-9a-f]{64}$/.test(report.secondary?.manifestSha256 ?? "") ||
    report.secondary.manifestSha256 === sourceMetadata.sha256 ||
    !Number.isSafeInteger(report.secondary?.manifestByteLength) ||
    report.secondary.manifestByteLength <= 0 ||
    Date.parse(report.primary.finishedAt) > Date.parse(report.secondary.startedAt) ||
    reportArtifacts.length !== primaryArtifacts.size
  ) {
    throw new Error("Moments D1 build requires a complete stable two-pass report.");
  }
  const seen = new Set();
  for (const artifact of reportArtifacts) {
    const primary = primaryArtifacts.get(artifact?.path);
    if (
      !primary ||
      seen.has(artifact.path) ||
      artifact.stable !== true ||
      artifact.primary?.rows !== primary.rows ||
      artifact.primary?.byteLength !== primary.byteLength ||
      artifact.primary?.sha256 !== primary.sha256 ||
      artifact.secondary?.rows !== primary.rows ||
      artifact.secondary?.byteLength !== primary.byteLength ||
      artifact.secondary?.sha256 !== primary.sha256
    ) {
      throw new Error(`Moments stability proof is invalid for ${artifact?.path ?? "<missing>"}.`);
    }
    seen.add(artifact.path);
  }
  return {
    path: "validation/stability.json",
    ...input.metadata,
    stable: true,
    primary: report.primary,
    secondary: report.secondary,
    normalizedArtifacts: reportArtifacts.length,
  };
}

function validCaptureWindow(value) {
  return (
    typeof value?.startedAt === "string" &&
    typeof value?.finishedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    Number.isFinite(Date.parse(value.finishedAt)) &&
    Date.parse(value.startedAt) <= Date.parse(value.finishedAt)
  );
}

async function readCollectionMap(path, momentIds) {
  const input = await readBoundNdjson(path);
  const rows = [];
  const seen = new Set();
  for (const row of input.rows) {
    const momentId = uuid(row.momentId ?? row.moment_id, "collectionMap.momentId");
    const collectionId = positiveInteger(
      row.collectionId ?? row.collection_id,
      "collectionMap.collectionId",
    );
    if (!momentIds.has(momentId)) throw new Error(`Collection map references unknown ${momentId}.`);
    const key = `${momentId}\0${collectionId}`;
    if (seen.has(key)) throw new Error(`Collection map duplicates ${key}.`);
    seen.add(key);
    rows.push([momentId, collectionId]);
  }
  rows.sort(
    (left, right) => left[0].localeCompare(right[0]) || compareIntegerText(left[1], right[1]),
  );
  return { rows, metadata: input.metadata };
}

async function readCollectionMapProof({ path, rows, mapMetadata, sourceManifest, sourceMetadata }) {
  if (!path.endsWith(".ndjson")) {
    throw new Error("Collection map path must end with .ndjson.");
  }
  const reportPath = resolve(dirname(path), `${basename(path, ".ndjson")}.report.json`);
  const reportInput = await readBoundJson(reportPath, "Moment collection map proof");
  const report = reportInput.value;
  const momentDrops = (sourceManifest.normalized?.artifacts ?? []).filter(
    (artifact) => artifact.path === "normalized/moment_drops.ndjson",
  );
  const collections = report?.sources?.collections;
  if (
    report?.version !== 1 ||
    report.dataset !== "poapin-moments-collection-map" ||
    report.artifact?.path !== basename(path) ||
    report.artifact?.rows !== rows ||
    report.artifact?.sha256 !== mapMetadata.sha256 ||
    report.artifact?.byteLength !== mapMetadata.byteLength ||
    report.counts?.momentCollectionPairs !== rows ||
    report.sources?.moments?.dataset !== sourceManifest.dataset ||
    report.sources.moments.version !== sourceManifest.version ||
    report.sources.moments.startedAt !== sourceManifest.startedAt ||
    report.sources.moments.finishedAt !== sourceManifest.finishedAt ||
    report.sources.moments.manifest?.sha256 !== sourceMetadata.sha256 ||
    report.sources.moments.manifest?.byteLength !== sourceMetadata.byteLength ||
    momentDrops.length !== 1 ||
    report.sources.moments.momentDrops?.path !== momentDrops[0].path ||
    report.sources.moments.momentDrops?.rows !== momentDrops[0].rows ||
    report.sources.moments.momentDrops?.sha256 !== momentDrops[0].sha256 ||
    report.sources.moments.momentDrops?.byteLength !== momentDrops[0].byteLength ||
    collections?.dataset !== "poap-compass-collections" ||
    !validProofArtifact(collections.manifest) ||
    !validProofArtifact(collections.collections, { requireRows: true }) ||
    !validProofArtifact(collections.collectionDropIds, { requireRows: true })
  ) {
    throw new Error("Collection map proof is not bound to the current source snapshots.");
  }
  return {
    path: basename(reportPath),
    ...reportInput.metadata,
    momentsManifestSha256: sourceMetadata.sha256,
    collectionsManifestSha256: collections.manifest.sha256,
  };
}

function validProofArtifact(value, { requireRows = false } = {}) {
  return (
    typeof value?.path === "string" &&
    value.path.length > 0 &&
    /^[0-9a-f]{64}$/.test(value.sha256 ?? "") &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    (!requireRows || (Number.isSafeInteger(value.rows) && value.rows >= 0))
  );
}

function groupMomentDrops(rows, momentIds) {
  const result = new Map();
  const seen = new Set();
  for (const row of rows) {
    const momentId = uuid(row.moment_id, "moment_drops.moment_id");
    if (!momentIds.has(momentId)) throw new Error(`Unknown moment ${momentId}.`);
    const dropId = positiveInteger(row.drop_id, "moment_drops.drop_id");
    const key = `${momentId}\0${dropId}`;
    if (seen.has(key)) throw new Error(`Duplicate moment/drop ${key}.`);
    seen.add(key);
    const values = result.get(momentId) ?? [];
    values.push(dropId);
    result.set(momentId, values);
  }
  return result;
}

function mergeHiddenDrops(momentsRows, dropsRows) {
  const result = new Map();
  for (const [source, rows] of [
    ["moments", momentsRows],
    ["drops", dropsRows],
  ]) {
    for (const row of rows) {
      const dropId = positiveInteger(row.drop_id, `${source}_hidden_drops.drop_id`);
      const prior = result.get(dropId);
      result.set(dropId, {
        dropId,
        hiddenOn: earliestTimestamp(prior?.hiddenOn, nullable(row.hidden_on)),
        source: prior && prior.source !== source ? "moments+drops" : (prior?.source ?? source),
      });
    }
  }
  return result;
}

function earliestTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) <= 0 ? left : right;
}

function positioned(rows, group) {
  const positions = new Map();
  return rows.map((row) => {
    const key = group(row);
    const position = positions.get(key) ?? 0;
    positions.set(key, position + 1);
    return { row, position };
  });
}

function uniqueValues(rows, extract, label) {
  const values = new Set();
  for (const row of rows) {
    const value = extract(row);
    if (values.has(value)) throw new Error(`Duplicate ${label} ${value}.`);
    values.add(value);
  }
  return values;
}

async function readBoundBytes(path) {
  const bytes = await readFile(path);
  return { bytes, metadata: metadataForBytes(bytes) };
}

async function readBoundJson(path, label = path) {
  const input = await readBoundBytes(path);
  try {
    return { value: JSON.parse(input.bytes.toString("utf8")), metadata: input.metadata };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function readBoundNdjson(path) {
  const input = await readBoundBytes(path);
  const text = input.bytes.toString("utf8");
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const rows = lines.map((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) throw new Error(`${path}:${lineNumber}: blank NDJSON line.`);
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${lineNumber}: ${error.message}`);
    }
  });
  return { rows, metadata: input.metadata };
}

function metadataForBytes(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function assertNormalizedArtifact(sourceManifest, path, input) {
  const artifacts = (sourceManifest.normalized?.artifacts ?? []).filter(
    (artifact) => artifact?.path === path,
  );
  if (
    artifacts.length !== 1 ||
    artifacts[0].rows !== input.rows.length ||
    artifacts[0].sha256 !== input.metadata.sha256 ||
    artifacts[0].byteLength !== input.metadata.byteLength
  ) {
    throw new Error(`${path} does not exactly match the bound source manifest artifact.`);
  }
}

async function emitRows(emitter, table, columns, rows, counts) {
  counts[table] = rows.length;
  const sequenceStart = emitter.tableIndex * 1_000 + 1;
  emitter.tableIndex += 1;
  if (rows.length === 0) return;
  const writer = new SqlShardWriter({
    outputRoot: emitter.destination,
    relativeDirectory: "load",
    sequenceStart,
    label: table,
    table,
    columns,
    maxShardBytes: MAX_SHARD_BYTES,
    maxStatementBytes: MAX_STATEMENT_BYTES,
    rowsPerStatement: ROWS_PER_STATEMENT,
    database: "moments",
    journal: {
      snapshotId: emitter.snapshotId,
      sourceDatabaseSha256: emitter.sourceDatabaseSha256,
    },
  });
  for (const row of rows) await writer.add(row);
  emitter.artifacts.push(...(await writer.close()));
}

function required(value, label) {
  if (value === null || value === undefined || String(value).length === 0) {
    throw new Error(`${label} is required.`);
  }
  return String(value);
}

function nullable(value) {
  return value === null || value === undefined ? null : String(value);
}

function nullableTrimmed(value) {
  return value === null || value === undefined ? null : String(value).trim() || null;
}

function uuid(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`${label} is not a UUID.`);
  }
  return normalized;
}

function normalizedAddress(value) {
  const normalized = nullableTrimmed(value)?.toLowerCase() ?? null;
  return /^0x[0-9a-f]{40}$/.test(normalized ?? "") ? normalized : null;
}

function positiveInteger(value, label) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} must be a positive integer.`);
  return text;
}

function integerOrNull(value, label) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error(`${label} must be an integer.`);
  return text;
}

function positiveIntegerOrNull(value, label) {
  return value === null || value === undefined ? null : positiveInteger(value, label);
}

function nonNegativeIntegerOrNull(value, label) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer.`);
  return text;
}

function sha256(value, label) {
  const normalized = String(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is not SHA-256.`);
  return normalized;
}

export function normalizeMediaStatus(value) {
  const aliases = {
    isolated: "private_stored",
    private: "private_stored",
    public: "public_stored",
    not_found: "missing",
    error: "failed",
    quarantined_stored: "quarantined",
    source_missing: "missing",
    oversize: "failed",
    unattempted: "pending",
  };
  const status = aliases[value] ?? value;
  if (!MEDIA_STATUSES.has(status)) throw new Error(`Unsupported media status ${value}.`);
  return status;
}

function countMediaManifestStatuses(rows) {
  const counts = {};
  for (const row of rows.values()) counts[row.rawStatus] = (counts[row.rawStatus] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countD1MediaStatuses(rows) {
  const counts = Object.fromEntries([...MEDIA_STATUSES].sort().map((status) => [status, 0]));
  for (const row of rows) counts[row[11]] += 1;
  return counts;
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mediaKind(contentType) {
  const value = String(contentType ?? "").toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "audio";
  return "other";
}

function compareIntegerText(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyTableCounts() {
  return Object.fromEntries(
    [
      "moments_meta",
      "moments_import_plan",
      "moments",
      "moment_visibility",
      "moment_drops",
      "moment_hidden_drops",
      "moment_suppressions",
      "moment_media",
      "moment_links",
      "moment_user_tags",
      "capsules",
      "capsule_visibility",
      "capsule_suppressions",
      "capsule_moments",
      "moment_collections",
    ].map((name) => [name, 0]),
  );
}
