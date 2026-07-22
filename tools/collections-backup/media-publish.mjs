#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { publishCollectionMedia } from "./media-publish-lib.mjs";

const HELP = `POAPin Archive — publish the final D1 media proof to immutable R2 keys

Usage:
  node tools/collections-backup/media-publish.mjs \\
    --input data/collections/2026-07-22-v1 \\
    --snapshot-id collections-2026-07-22-v1 \\
    --bucket poapin-archive \\
    --bridge-url https://YOUR-TEMPORARY-BRIDGE.workers.dev

Required:
  --input <directory>      Completed and verified Collections snapshot.
  --snapshot-id <id>       Must exactly match the D1 build and bridge snapshot.
  --bucket <name>          Exact R2 bucket name configured on the bridge.
  --bridge-url <origin>    Exact HTTPS origin of the temporary upload bridge.

Run control:
  --concurrency <1-8>      Concurrent HEAD/PUT operations (default: 3).
  --attempts <1-10>        Attempts for retryable bridge requests (default: 4).
  --checkpoint <path>      Resume journal (default: <input>/media/publish-checkpoint.ndjson).
  --report <path>          Result report (default: <input>/media/publish-report.json).
  --help                   Show this help.

The final d1/media/publication-plan.ndjson is authoritative. It combines
validated Collection branding, newly downloaded content-addressed drop art,
and exact HEAD-only reuse of the older archive artwork proof. Upload request
bodies are capped at 100000000 bytes, matching the Worker Free/Pro limit.

The HMAC secret is read only from COLLECTIONS_R2_BRIDGE_SECRET. It is never
accepted as a CLI flag or written to the checkpoint/report.

Temporary bridge setup (edit every REPLACE value and keep IDs/prefix exact):
  cp tools/collections-backup/bridge/wrangler.example.jsonc \\
    tools/collections-backup/bridge/wrangler.local.jsonc
  export COLLECTIONS_R2_BRIDGE_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\\n')"
  npx wrangler deploy --config tools/collections-backup/bridge/wrangler.local.jsonc
  printf %s "$COLLECTIONS_R2_BRIDGE_SECRET" | npx wrangler secret put \\
    COLLECTIONS_R2_BRIDGE_SECRET --config tools/collections-backup/bridge/wrangler.local.jsonc

Publish, then repeat the same run with a second report to HEAD-verify every
proof object remotely:
  export COLLECTIONS_BRIDGE_URL="https://THE-DEPLOYED-WORKERS-DEV-ORIGIN"
  node tools/collections-backup/media-publish.mjs --input data/collections/2026-07-22-v1 \\
    --snapshot-id collections-2026-07-22-v1 --bucket poapin-archive \\
    --bridge-url "$COLLECTIONS_BRIDGE_URL"
  node tools/collections-backup/media-publish.mjs --input data/collections/2026-07-22-v1 \\
    --snapshot-id collections-2026-07-22-v1 --bucket poapin-archive \\
    --bridge-url "$COLLECTIONS_BRIDGE_URL" \\
    --report data/collections/2026-07-22-v1/media/publish-verify-report.json
  jq -e '.publishable == true and .counts.failed == 0 and .counts.uploaded == 0 and .counts.reused == 0 and .counts.proofVerified == .counts.uniqueObjects' \\
    data/collections/2026-07-22-v1/media/publish-verify-report.json

Delete the temporary Worker and local secret/config only after that assertion:
  npx wrangler delete --config tools/collections-backup/bridge/wrangler.local.jsonc --force
  unset COLLECTIONS_R2_BRIDGE_SECRET COLLECTIONS_BRIDGE_URL
  rm tools/collections-backup/bridge/wrangler.local.jsonc

The bridge can only perform signed HEAD and immutable conditional PUT operations.
It has no object-body read, list, delete, or overwrite route.
`;

export function parseMediaPublishOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      "snapshot-id": { type: "string" },
      bucket: { type: "string" },
      "bridge-url": { type: "string" },
      concurrency: { type: "string", default: "3" },
      attempts: { type: "string", default: "4" },
      checkpoint: { type: "string" },
      report: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  for (const name of ["input", "snapshot-id", "bucket", "bridge-url"]) {
    if (!values[name]) throw optionError(`--${name} is required.`);
  }
  return {
    help: false,
    input: values.input,
    snapshotId: values["snapshot-id"],
    bucket: values.bucket,
    bridgeUrl: values["bridge-url"],
    concurrency: boundedInteger(values.concurrency, "--concurrency", 1, 8),
    attempts: boundedInteger(values.attempts, "--attempts", 1, 10),
    checkpointPath: values.checkpoint,
    reportPath: values.report,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseMediaPublishOptions(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("Run with --help for usage.");
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const controller = new AbortController();
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    console.error("Interrupt received; finishing active checkpoint writes…");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lastProgress = 0;
  try {
    console.error(
      `Validating Collections media snapshot ${options.snapshotId} before any R2 writes…`,
    );
    const report = await publishCollectionMedia({
      ...options,
      signal: controller.signal,
      onProgress({ settled, total, counts }) {
        if (settled !== total && settled - lastProgress < 25) return;
        lastProgress = settled;
        console.error(
          `Remote ${settled.toLocaleString("en-US")}/${total.toLocaleString("en-US")}: ` +
            `${counts.uploaded} uploaded, ${counts.reused} reused, ` +
            `${counts.proofVerified} proof-verified, ${counts.failed} failed.`,
        );
      },
    });
    console.error(
      `${report.publishable ? "Publishable" : "Incomplete"}: ${report.counts.uniqueObjects} unique objects; ` +
        `${report.counts.failed} failed. Report: ${options.reportPath ?? resolve(options.input, "media/publish-report.json")}`,
    );
    return interrupted ? 130 : report.publishable ? 0 : 1;
  } catch (error) {
    console.error(`Collections media publication stopped: ${error.message}`);
    return interrupted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw optionError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function optionError(message) {
  return Object.assign(new Error(message), { code: "INVALID_OPTION" });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = await main();
