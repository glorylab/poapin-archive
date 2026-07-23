import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { auditD1Sql, loadContext } from "../d1-loader.mjs";
import { compareMomentsSnapshots } from "../lib/compare.mjs";
import { buildMomentsD1, normalizeMediaStatus } from "../lib/d1.mjs";
import { sha256File } from "../lib/files.mjs";
import { captureMomentsSnapshot } from "../lib/snapshot.mjs";
import { verifyMomentsSnapshot } from "../lib/verify.mjs";
import { captureMomentsMedia, verifyMomentsMedia } from "../../moments-media/lib/capture.mjs";
import { buildMomentsMediaPlan } from "../../moments-media/lib/plan.mjs";
import { buildMomentsMediaRecoveryPlan } from "../../moments-media/lib/recovery.mjs";
import { recoverMomentsMedia } from "../../moments-media/lib/recovery-executor.mjs";
import { MockGraphqlClient, syntheticRows, UUID } from "./helpers.mjs";

const ENDPOINT = "https://example.invalid/graphql";

test("snapshot requires an explicit bulk-capture acknowledgement before any request", async () => {
  const output = await temporary("guard");
  const client = new MockGraphqlClient();
  await assert.rejects(
    captureMomentsSnapshot({ output, endpoint: ENDPOINT, client }),
    /disabled by default/,
  );
  assert.equal(client.requests.length, 0);
});

test("synthetic capture, verify, compare, and D1 build stay offline and preserve relations", async () => {
  const output = await temporary("snapshot");
  const client = new MockGraphqlClient();
  const manifest = await captureMomentsSnapshot({
    output,
    endpoint: ENDPOINT,
    pageSize: 1,
    acknowledgeBulkCapture: true,
    client,
  });
  assert.equal(manifest.entities.moments.rows, 2);
  assert.deepEqual(manifest.entities.moments.upperBound, [UUID(2)]);
  assert.equal(
    manifest.normalized.artifacts.find(
      (artifact) => artifact.path === "normalized/moment_drops.ndjson",
    ).rows,
    1,
  );
  assert.equal(manifest.media.bodiesCaptured, false);
  assert.equal(
    client.requests.some((request) => request.operationName === "POAPinMomentsIntrospection"),
    true,
  );

  const verification = await verifyMomentsSnapshot({ input: output });
  assert.equal(verification.verified, true);
  assert.equal(verification.relationships.momentDrops, 1);

  const secondary = await temporary("snapshot-secondary");
  await captureMomentsSnapshot({
    output: secondary,
    endpoint: ENDPOINT,
    pageSize: 1,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  const comparison = await compareMomentsSnapshots({
    primary: output,
    secondary,
    output: resolve(output, "validation/stability.json"),
  });
  assert.equal(comparison.stable, true);
  assert.deepEqual(comparison.differences, []);

  await buildMomentsMediaPlan({ input: output, snapshotId: "synthetic-v1" });
  const stored = new Map();
  const bridge = {
    async verifyTargets() {},
    async head(object) {
      return stored.get(object.key) ?? null;
    },
    async uploadFile(object) {
      const result = { ...object, etag: `etag-${stored.size + 1}` };
      stored.set(object.key, result);
      return { disposition: "uploaded", etag: result.etag };
    },
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const mediaCapture = await captureMomentsMedia({
    input: output,
    snapshotId: "synthetic-v1",
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    concurrency: 1,
    bridge,
    fetchImpl: async (url) => {
      const bytes = String(url).endsWith(UUID(41)) ? png : mp4;
      const contentType = bytes === png ? "image/png" : "video/mp4";
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
      });
    },
  });
  assert.equal(mediaCapture.complete, true);
  assert.equal(mediaCapture.publicProjectionReady, true);
  const mediaManifest = resolve(output, "media", "d1-media-manifest.ndjson");
  const captureVerificationReport1 = resolve(output, "media", "verify-report-capture-pass1.json");
  const captureVerificationReport2 = resolve(output, "media", "verify-report-capture-pass2.json");
  const captureVerification1 = await verifyMomentsMedia({
    input: output,
    snapshotId: "synthetic-v1",
    bridgeUrl: "https://bridge.example",
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    concurrency: 1,
    bridge,
    reportPath: captureVerificationReport1,
    now: () => Date.parse("2026-07-23T04:00:00.000Z"),
  });
  const captureVerification2 = await verifyMomentsMedia({
    input: output,
    snapshotId: "synthetic-v1",
    bridgeUrl: "https://bridge.example",
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    concurrency: 1,
    bridge,
    reportPath: captureVerificationReport2,
    previousVerificationReportPath: captureVerificationReport1,
    now: () => Date.parse("2026-07-23T04:01:00.000Z"),
  });
  assert.equal(captureVerification1.binding.checkpointMode, "capture-only");
  assert.equal(captureVerification1.binding.recoveryPlanSha256, null);
  assert.equal(captureVerification1.binding.recoveryCheckpointSha256, null);
  assert.deepEqual(captureVerification2.binding, captureVerification1.binding);
  const captureOnlyD1 = await buildMomentsD1({
    input: output,
    output: resolve(output, "d1-capture-only"),
    snapshotId: "synthetic-v1",
    mediaManifest,
    mediaVerificationReports: [captureVerificationReport1, captureVerificationReport2],
  });
  assert.equal(captureOnlyD1.mediaManifest.proof.checkpointMode, "capture-only");
  assert.equal(captureOnlyD1.mediaManifest.proof.recovery, null);
  assert.equal(captureOnlyD1.mediaVerification.binding.checkpointMode, "capture-only");
  const captureOnlyLoaderContext = await loadContext({
    inputDirectory: captureOnlyD1.output,
    target: {
      name: "poapin-moments-capture-test",
      id: "22222222-2222-4222-8222-222222222222",
    },
    projectConfig: resolve(output, "missing-wrangler.jsonc"),
  });
  assert.equal(
    captureOnlyLoaderContext.manifest.mediaVerification.binding.checkpointMode,
    "capture-only",
  );
  const recoveryPlan = await buildMomentsMediaRecoveryPlan({
    input: output,
    snapshotId: "synthetic-v1",
  });
  assert.equal(recoveryPlan.report.counts.unresolved, 0);
  const recovery = await recoverMomentsMedia({
    input: output,
    snapshotId: "synthetic-v1",
    bridgeUrl: "https://bridge.example",
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    concurrency: 1,
    bridge,
  });
  assert.equal(recovery.complete, true);
  assert.equal(recovery.publicProjectionReady, true);
  const verificationReport1 = resolve(output, "media", "verify-report-pass1.json");
  const verificationReport2 = resolve(output, "media", "verify-report-pass2.json");
  const firstRemoteVerification = await verifyMomentsMedia({
    input: output,
    snapshotId: "synthetic-v1",
    bridgeUrl: "https://BRIDGE.example:443/",
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    concurrency: 1,
    bridge,
    reportPath: verificationReport1,
    now: () => Date.parse("2026-07-23T05:00:00.000Z"),
  });
  const secondRemoteVerification = await verifyMomentsMedia({
    input: output,
    snapshotId: "synthetic-v1",
    bridgeUrl: "https://bridge.example",
    publicBucket: "poapin-archive",
    privateBucket: "poapin-moments-backups",
    concurrency: 1,
    bridge,
    reportPath: verificationReport2,
    previousVerificationReportPath: verificationReport1,
    now: () => Date.parse("2026-07-23T05:01:00.000Z"),
  });
  assert.equal(firstRemoteVerification.complete, true);
  assert.deepEqual(secondRemoteVerification.binding, firstRemoteVerification.binding);
  assert.deepEqual(secondRemoteVerification.counts, {
    stored: 2,
    verified: 2,
    failed: 0,
  });
  const explicitRecoveryProofPath = resolve(output, "media", "d1-media-manifest.json");
  const explicitRecoveryProof = await readFile(explicitRecoveryProofPath, "utf8");
  const legacyRecoveryProof = JSON.parse(explicitRecoveryProof);
  delete legacyRecoveryProof.checkpointMode;
  await writeFile(explicitRecoveryProofPath, `${JSON.stringify(legacyRecoveryProof)}\n`);
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-legacy-recovery-proof"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, verificationReport2],
    }),
    /valid checkpoint mode/,
  );
  await writeFile(explicitRecoveryProofPath, explicitRecoveryProof);
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-missing-verification"),
      snapshotId: "synthetic-v1",
      mediaManifest,
    }),
    /exactly two remote verification reports/,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-repeated-verification"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, verificationReport1],
    }),
    /two distinct files/,
  );
  const copiedVerificationReport = resolve(output, "media", "verify-report-copied-pass1.json");
  await writeFile(copiedVerificationReport, await readFile(verificationReport1));
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-copied-verification"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, copiedVerificationReport],
    }),
    /distinct file digests/,
  );
  const timestampCloneReport = resolve(output, "media", "verify-report-timestamp-clone.json");
  await writeFile(
    timestampCloneReport,
    `${JSON.stringify({
      ...firstRemoteVerification,
      startedAt: "2026-07-23T05:00:30.000Z",
      verifiedAt: "2026-07-23T05:00:30.000Z",
    })}\n`,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-timestamp-clone"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, timestampCloneReport],
    }),
    /incomplete or invalid/,
  );
  const reusedRunIdReport = resolve(output, "media", "verify-report-reused-run-id.json");
  await writeFile(
    reusedRunIdReport,
    `${JSON.stringify({
      ...secondRemoteVerification,
      runId: firstRemoteVerification.runId,
    })}\n`,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-reused-run-id"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, reusedRunIdReport],
    }),
    /different CSPRNG run IDs/,
  );
  const wrongPreviousReport = resolve(output, "media", "verify-report-wrong-previous.json");
  await writeFile(
    wrongPreviousReport,
    `${JSON.stringify({
      ...secondRemoteVerification,
      previousReportSha256: "f".repeat(64),
    })}\n`,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-wrong-previous"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, wrongPreviousReport],
    }),
    /exact pass1\/pass2 hash chain/,
  );
  const forgedBinding = {
    ...firstRemoteVerification.binding,
    stored: 0,
    storedObjectSetSha256: "0".repeat(64),
  };
  const forgedPass1Path = resolve(output, "media", "verify-report-forged-empty-pass1.json");
  await writeFile(
    forgedPass1Path,
    `${JSON.stringify({
      ...firstRemoteVerification,
      binding: forgedBinding,
      counts: { stored: 0, verified: 0, failed: 0 },
    })}\n`,
  );
  const forgedPass2Path = resolve(output, "media", "verify-report-forged-empty-pass2.json");
  await writeFile(
    forgedPass2Path,
    `${JSON.stringify({
      ...secondRemoteVerification,
      binding: forgedBinding,
      previousReportSha256: (await sha256File(forgedPass1Path)).sha256,
      counts: { stored: 0, verified: 0, failed: 0 },
    })}\n`,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-forged-empty-object-set"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [forgedPass1Path, forgedPass2Path],
    }),
    /not bound to the finalized media proof/,
  );
  const reversedVerificationReport = resolve(output, "media", "verify-report-reversed-time.json");
  await writeFile(
    reversedVerificationReport,
    `${JSON.stringify({
      ...secondRemoteVerification,
      verifiedAt: "2026-07-23T04:59:00.000Z",
    })}\n`,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-verification-time"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, reversedVerificationReport],
    }),
    /incomplete or invalid|strictly ordered and non-overlapping/,
  );
  const tamperedVerificationReport = resolve(output, "media", "verify-report-tampered.json");
  await writeFile(
    tamperedVerificationReport,
    `${JSON.stringify({
      ...secondRemoteVerification,
      binding: {
        ...secondRemoteVerification.binding,
        recoveryCheckpointSha256: "f".repeat(64),
      },
    })}\n`,
  );
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-tampered-verification"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, tamperedVerificationReport],
    }),
    /not bound to the finalized media proof/,
  );
  const d1 = await buildMomentsD1({
    input: output,
    output: resolve(output, "d1-test"),
    snapshotId: "synthetic-v1",
    mediaManifest,
    mediaVerificationReports: [verificationReport1, verificationReport2],
  });
  assert.equal(d1.tables.moments, 2);
  assert.equal(d1.tables.moment_media, 2);
  assert.equal(d1.tables.moments_import_plan, 11);
  assert.deepEqual(d1.mediaManifest.statuses, { private_stored: 1, public_stored: 1 });
  assert.deepEqual(
    d1.artifacts
      .filter((artifact) => artifact.phase === "prepare")
      .map((artifact) => artifact.path),
    [
      "prepare/000001_schema.sql",
      "prepare/000002_import_shards.sql",
      "prepare/000003_import_guards.sql",
    ],
  );
  const schema = await readFile(resolve(d1.output, "prepare/000001_schema.sql"), "utf8");
  const loadArtifacts = d1.artifacts.filter((artifact) => artifact.phase === "load");
  assert.match(loadArtifacts[0].path, /^load\/000001_moments_import_plan\.sql$/);
  const data = (
    await Promise.all(
      loadArtifacts.map((artifact) => readFile(resolve(d1.output, artifact.path), "utf8")),
    )
  ).join("\n");
  assert.match(schema, /CREATE TABLE capsules/);
  assert.match(schema, /CREATE VIEW public_moments/);
  assert.match(schema, /source_hash TEXT/);
  assert.match(schema, /object_key TEXT/);
  assert.match(data, /snapshots\/synthetic-v1\/moments\/original\/sha256\/[0-9a-f]{2}/);
  assert.doesNotMatch(data, /must-not-leak/);
  assert.match(data, /private_stored/);
  assert.match(data, /'ready', '0'/);
  assert.match(data, /'public_moments_count', '1'/);
  assert.equal(d1.version, 2);
  assert.equal(d1.settings.explicitTransactions, false);
  assert.equal(d1.media.mode, "media-bound");
  assert.equal(d1.mediaVerification.schemaVersion, "poapin-moments-media-verification-chain-v2");
  assert.equal(d1.mediaVerification.binding.stored, 2);
  assert.deepEqual(
    d1.mediaVerification.reports.map((report) => report.pass),
    [1, 2],
  );
  for (const report of d1.mediaVerification.reports) {
    assert.match(
      report.path,
      new RegExp(`^evidence/media-verification/pass${report.pass}-[0-9a-f]{64}\\.json$`),
    );
    assert.deepEqual(
      {
        sha256: report.sha256,
        byteLength: report.byteLength,
      },
      await sha256File(resolve(d1.output, report.path)),
    );
  }
  assert.equal(new Set(d1.mediaVerification.reports.map((report) => report.sha256)).size, 2);
  assert.deepEqual(d1.source.manifest, {
    path: "manifest.json",
    ...(await sha256File(resolve(output, "manifest.json"))),
  });
  assert.deepEqual(
    {
      sha256: d1.mediaManifest.sha256,
      byteLength: d1.mediaManifest.byteLength,
    },
    await sha256File(mediaManifest),
  );
  assert.deepEqual(
    {
      sha256: d1.mediaManifest.proof.sha256,
      byteLength: d1.mediaManifest.proof.byteLength,
    },
    await sha256File(resolve(output, "media", "d1-media-manifest.json")),
  );
  for (const artifact of d1.artifacts) {
    const sql = await readFile(resolve(d1.output, artifact.path), "utf8");
    const audit = auditD1Sql(sql);
    assert.equal(audit.explicitTransactions.length, 0);
    assert.ok(audit.maxStatementBytes <= 100_000);
  }

  const database = new DatabaseSync(":memory:");
  try {
    for (const artifact of d1.artifacts) {
      database.exec(await readFile(resolve(d1.output, artifact.path), "utf8"));
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM moments;").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM public_moments;").get().count, 1);
    assert.equal(
      database.prepare("SELECT value FROM moments_meta WHERE key='ready';").get().value,
      "0",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM import_shards;").get().count,
      loadArtifacts.length,
    );
    assert.deepEqual(
      database
        .prepare("SELECT table_name, expected_rows FROM moments_import_plan ORDER BY table_name;")
        .all()
        .map((row) => ({ ...row })),
      [
        { table_name: "capsule_moments", expected_rows: 1 },
        { table_name: "capsule_visibility", expected_rows: 1 },
        { table_name: "capsules", expected_rows: 1 },
        { table_name: "moment_collections", expected_rows: 0 },
        { table_name: "moment_drops", expected_rows: 1 },
        { table_name: "moment_hidden_drops", expected_rows: 1 },
        { table_name: "moment_links", expected_rows: 1 },
        { table_name: "moment_media", expected_rows: 2 },
        { table_name: "moment_user_tags", expected_rows: 1 },
        { table_name: "moment_visibility", expected_rows: 2 },
        { table_name: "moments", expected_rows: 2 },
      ],
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM moments_import_plan WHERE loaded_rows = expected_rows;",
        )
        .get().count,
      11,
    );
    assert.throws(
      () =>
        database.exec(
          "UPDATE moments_import_plan SET loaded_rows = loaded_rows - 1 WHERE table_name = 'moments';",
        ),
      /monotonic/,
    );
    assert.throws(
      () => database.exec("UPDATE moments SET description = 'changed' WHERE 1;"),
      /immutable/,
    );
  } finally {
    database.close();
  }

  const repeated = await buildMomentsD1({
    input: output,
    output: resolve(output, "d1-repeat"),
    snapshotId: "synthetic-v1",
    mediaManifest,
    mediaVerificationReports: [verificationReport1, verificationReport2],
  });
  assert.equal(repeated.sourceDatabaseSha256, d1.sourceDatabaseSha256);
  assert.deepEqual(
    repeated.artifacts.map(({ path, sha256, payloadSha256 }) => ({
      path,
      sha256,
      payloadSha256: payloadSha256 ?? null,
    })),
    d1.artifacts.map(({ path, sha256, payloadSha256 }) => ({
      path,
      sha256,
      payloadSha256: payloadSha256 ?? null,
    })),
  );

  const loaderContext = await loadContext({
    inputDirectory: d1.output,
    target: {
      name: "poapin-moments-test",
      id: "11111111-1111-4111-8111-111111111111",
    },
    projectConfig: resolve(output, "missing-wrangler.jsonc"),
  });
  assert.equal(
    loaderContext.manifest.mediaVerification.bindingSha256,
    d1.mediaVerification.bindingSha256,
  );
  const d1ManifestPath = resolve(d1.output, "manifest.json");
  const originalD1Manifest = await readFile(d1ManifestPath, "utf8");
  const tamperedD1Manifest = JSON.parse(originalD1Manifest);
  tamperedD1Manifest.mediaVerification.reports[0].path = verificationReport1;
  await writeFile(d1ManifestPath, `${JSON.stringify(tamperedD1Manifest)}\n`);
  await assert.rejects(
    loadContext({
      inputDirectory: d1.output,
      target: loaderContext.target,
      projectConfig: loaderContext.projectConfig,
    }),
    /valid two-pass verification chain/,
  );
  await writeFile(d1ManifestPath, originalD1Manifest);
  const equalBucketD1Manifest = JSON.parse(originalD1Manifest);
  equalBucketD1Manifest.mediaVerification.binding.privateBucket =
    equalBucketD1Manifest.mediaVerification.binding.publicBucket;
  await writeFile(d1ManifestPath, `${JSON.stringify(equalBucketD1Manifest)}\n`);
  await assert.rejects(
    loadContext({
      inputDirectory: d1.output,
      target: loaderContext.target,
      projectConfig: loaderContext.projectConfig,
    }),
    /must be different/,
  );
  await writeFile(d1ManifestPath, originalD1Manifest);
  const packagedVerificationPath = resolve(d1.output, d1.mediaVerification.reports[0].path);
  const packagedVerification = await readFile(packagedVerificationPath);
  await writeFile(
    packagedVerificationPath,
    Buffer.concat([packagedVerification, Buffer.from("\n")]),
  );
  await assert.rejects(
    loadContext({
      inputDirectory: d1.output,
      target: loaderContext.target,
      projectConfig: loaderContext.projectConfig,
    }),
    /verification evidence checksum\/size mismatch/,
  );
  await writeFile(packagedVerificationPath, packagedVerification);

  const proofPath = resolve(output, "media", "d1-media-manifest.json");
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  proof.snapshotId = "wrong-snapshot";
  await writeFile(proofPath, `${JSON.stringify(proof)}\n`);
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-rejected-media-proof"),
      snapshotId: "synthetic-v1",
      mediaManifest,
      mediaVerificationReports: [verificationReport1, verificationReport2],
    }),
    /does not bind a complete public-ready capture/,
  );
});

test("media pipeline detail statuses map into the frozen D1 status enum", () => {
  assert.equal(normalizeMediaStatus("quarantined_stored"), "quarantined");
  assert.equal(normalizeMediaStatus("source_missing"), "missing");
  assert.equal(normalizeMediaStatus("oversize"), "failed");
  assert.equal(normalizeMediaStatus("unattempted"), "pending");
  assert.equal(normalizeMediaStatus("public_stored"), "public_stored");
  assert.throws(() => normalizeMediaStatus("invented"), /Unsupported media status/);
});

test("D1 build fails locally when one UTF-8 row cannot fit under the statement limit", async () => {
  const rows = syntheticRows();
  rows.moments[0].description = "界".repeat(31_000);
  const output = await temporary("oversized-d1-row");
  await captureMomentsSnapshot({
    output,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(rows),
  });
  await createStabilityReport(output, rows);
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "oversized-d1"),
      snapshotId: "oversized-v1",
    }),
    /one row needs .* SQL bytes/,
  );
});

test("D1 build requires a distinct, source-bound stable second capture", async () => {
  const output = await temporary("missing-stability");
  await captureMomentsSnapshot({
    output,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-without-stability"),
      snapshotId: "missing-stability-v1",
    }),
    /stability\.json/,
  );

  await createStabilityReport(output);
  const stabilityPath = resolve(output, "validation/stability.json");
  const stability = JSON.parse(await readFile(stabilityPath, "utf8"));
  stability.secondary.manifestSha256 = stability.primary.manifestSha256;
  await writeFile(stabilityPath, `${JSON.stringify(stability)}\n`);
  await assert.rejects(
    buildMomentsD1({
      input: output,
      output: resolve(output, "d1-reused-capture"),
      snapshotId: "missing-stability-v1",
    }),
    /complete stable two-pass report/,
  );
});

test("a nested relation at the hard limit aborts rather than silently truncating", async () => {
  const rows = syntheticRows();
  rows.moments[0].drops = Array.from({ length: 100 }, (_, index) => ({
    drop_id: index + 1,
    moment_id: UUID(1),
  }));
  const output = await temporary("nested-limit");
  await assert.rejects(
    captureMomentsSnapshot({
      output,
      endpoint: ENDPOINT,
      acknowledgeBulkCapture: true,
      client: new MockGraphqlClient(rows),
    }),
    (error) => error.code === "NESTED_RELATION_LIMIT",
  );
});

test("verification detects normalized artifact tampering", async () => {
  const output = await temporary("tamper");
  await captureMomentsSnapshot({
    output,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  const path = resolve(output, "normalized/moments.ndjson");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await assert.rejects(
    verifyMomentsSnapshot({ input: output }),
    (error) =>
      error.code === "MOMENTS_SNAPSHOT_INVALID" &&
      error.report.issues.some((issue) => issue.code === "NORMALIZED_CHECKSUM_MISMATCH"),
  );
});

test("D1 build rejects a normalized input changed after snapshot verification", async () => {
  const output = await temporary("post-verification-tamper");
  await captureMomentsSnapshot({
    output,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(),
  });
  await createStabilityReport(output);

  const momentsPath = resolve(output, "normalized/moments.ndjson");
  let mutated = false;
  const reportPath = resolve(output, "validation/report.json");
  const mutation = new Promise((resolveMutation, rejectMutation) => {
    const timeout = setTimeout(
      () => rejectMutation(new Error("Timed out waiting for snapshot verification.")),
      5_000,
    );
    const poll = () => {
      if (!existsSync(reportPath)) {
        setImmediate(poll);
        return;
      }
      try {
        const rows = readFileSync(momentsPath, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        rows[0].description = "changed after verification";
        writeFileSync(momentsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        mutated = true;
        clearTimeout(timeout);
        resolveMutation();
      } catch (error) {
        clearTimeout(timeout);
        rejectMutation(error);
      }
    };
    setImmediate(poll);
  });
  await Promise.all([
    assert.rejects(
      buildMomentsD1({
        input: output,
        output: resolve(output, "d1-post-verification-tamper"),
        snapshotId: "post-verification-tamper-v1",
      }),
      /normalized\/moments\.ndjson does not exactly match the bound source manifest artifact/,
    ),
    mutation,
  ]);
  assert.equal(mutated, true);
});

async function temporary(name) {
  return mkdtemp(resolve(tmpdir(), `poapin-moments-${name}-`));
}

async function createStabilityReport(primary, rows = syntheticRows()) {
  const secondary = await temporary("stability-secondary");
  await captureMomentsSnapshot({
    output: secondary,
    endpoint: ENDPOINT,
    acknowledgeBulkCapture: true,
    client: new MockGraphqlClient(rows),
  });
  return compareMomentsSnapshots({
    primary,
    secondary,
    output: resolve(primary, "validation/stability.json"),
  });
}
