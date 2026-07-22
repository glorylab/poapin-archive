#!/usr/bin/env node

import { resolve } from "node:path";

import { DEFAULT_ENDPOINT, DEFAULT_PAGE_SIZE } from "./lib/config.mjs";
import { compareCollectionsSnapshots } from "./lib/compare.mjs";
import { buildCollectionsD1 } from "./lib/d1.mjs";
import { captureReferencedDropSupplement } from "./lib/drop-supplement.mjs";
import { captureCollectionMedia } from "./lib/media.mjs";
import { packageCollectionsSnapshot } from "./lib/package.mjs";
import { captureCollectionsSnapshot } from "./lib/snapshot.mjs";
import { verifyCollectionsSnapshot } from "./lib/verify.mjs";

const [command, ...argv] = process.argv.slice(2);

try {
  if (command === "snapshot") {
    const options = parseOptions(argv, {
      output: null,
      endpoint: DEFAULT_ENDPOINT,
      "delay-ms": "250",
      "page-size": String(DEFAULT_PAGE_SIZE),
      resume: false,
    });
    if (!options.output) usageError("snapshot requires --output <directory>.");
    const delayMs = boundedInteger(options["delay-ms"], "--delay-ms", 0, 60_000);
    const pageSize = boundedInteger(options["page-size"], "--page-size", 1, 100);
    const output = resolve(options.output);
    const manifest = await captureCollectionsSnapshot({
      output,
      endpoint: validEndpoint(options.endpoint),
      delayMs,
      pageSize,
      resume: options.resume,
      onProgress: progress,
    });
    process.stderr.write("\n");
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          output,
          schemaSha256: manifest.schema.sha256,
          entities: Object.fromEntries(
            Object.entries(manifest.entities).map(([name, entity]) => [name, entity.rows]),
          ),
          referencedDrops: manifest.referencedDrops,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === "media") {
    const options = parseOptions(argv, {
      input: null,
      concurrency: "3",
      "max-bytes": String(50 * 1024 * 1024),
      "retry-failures": false,
    });
    if (!options.input) usageError("media requires --input <snapshot-directory>.");
    const input = resolve(options.input);
    const report = await captureCollectionMedia({
      input,
      concurrency: boundedInteger(options.concurrency, "--concurrency", 1, 8),
      maximumBytes: boundedInteger(options["max-bytes"], "--max-bytes", 1024, 250 * 1024 * 1024),
      retryFailures: options["retry-failures"],
      onProgress: progress,
    });
    process.stderr.write("\n");
    process.stdout.write(`${JSON.stringify({ ok: report.complete, input, ...report }, null, 2)}\n`);
  } else if (command === "enrich-drops") {
    const options = parseOptions(argv, {
      input: null,
      "delay-ms": "250",
      "page-size": "100",
      concurrency: "3",
      "max-bytes": String(50 * 1024 * 1024),
      "retry-failures": false,
      "archive-catalog-sqlite": null,
      "archive-media-manifest": null,
      "archive-upload-report": null,
      "archive-upload-checkpoint": null,
      "archive-snapshot-id": null,
    });
    if (!options.input) usageError("enrich-drops requires --input <snapshot-directory>.");
    const input = resolve(options.input);
    const report = await captureReferencedDropSupplement({
      input,
      delayMs: boundedInteger(options["delay-ms"], "--delay-ms", 0, 60_000),
      pageSize: boundedInteger(options["page-size"], "--page-size", 1, 100),
      concurrency: boundedInteger(options.concurrency, "--concurrency", 1, 8),
      maximumBytes: boundedInteger(options["max-bytes"], "--max-bytes", 1024, 250 * 1024 * 1024),
      retryFailures: options["retry-failures"],
      archiveCatalogSqlite: options["archive-catalog-sqlite"],
      archiveMediaManifest: options["archive-media-manifest"],
      archiveUploadReport: options["archive-upload-report"],
      archiveUploadCheckpoint: options["archive-upload-checkpoint"],
      archiveSnapshotId: options["archive-snapshot-id"],
      onProgress: progress,
    });
    process.stderr.write("\n");
    process.stdout.write(`${JSON.stringify({ ok: report.complete, input, ...report }, null, 2)}\n`);
    if (!report.complete) process.exitCode = 1;
  } else if (command === "compare") {
    const options = parseOptions(argv, { primary: null, secondary: null });
    if (!options.primary || !options.secondary) {
      usageError("compare requires --primary <directory> and --secondary <directory>.");
    }
    const report = await compareCollectionsSnapshots({
      primary: options.primary,
      secondary: options.secondary,
    });
    process.stdout.write(`${JSON.stringify({ ok: report.stable, ...report }, null, 2)}\n`);
    if (!report.stable) process.exitCode = 1;
  } else if (command === "verify") {
    const options = parseOptions(argv, { input: null, "online-schema": false });
    if (!options.input) usageError("verify requires --input <snapshot-directory>.");
    const input = resolve(options.input);
    const report = await verifyCollectionsSnapshot({
      input,
      onlineSchema: options["online-schema"],
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: report.verified,
          input,
          normalizedArtifacts: report.normalized.checked,
          media: report.media,
          checksums: report.checksums,
          issues: report.issues,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === "build-d1") {
    const options = parseOptions(argv, { input: null, "snapshot-id": null });
    if (!options.input || !options["snapshot-id"]) {
      usageError("build-d1 requires --input <directory> and --snapshot-id <id>.");
    }
    const input = resolve(options.input);
    const report = await buildCollectionsD1({ input, snapshotId: options["snapshot-id"] });
    process.stdout.write(`${JSON.stringify({ ok: true, input, ...report }, null, 2)}\n`);
  } else if (command === "package") {
    const options = parseOptions(argv, { input: null, output: null });
    if (!options.input) usageError("package requires --input <snapshot-directory>.");
    const report = await packageCollectionsSnapshot({
      input: options.input,
      output: options.output,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
  } else if (["--help", "-h", "help", undefined].includes(command)) {
    process.stdout.write(help());
  } else {
    usageError(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`\ncollections-backup: ${error.message}\n`);
  if (process.env.DEBUG && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}

function parseOptions(args, defaults) {
  const options = { ...defaults };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) usageError(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!(name in defaults)) usageError(`Unknown option: --${name}`);
    if (typeof defaults[name] === "boolean") {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usageError(`--${name} requires a value.`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usageError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function validEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") usageError("--endpoint must use HTTPS.");
  if (url.username || url.password || url.hash) {
    usageError("--endpoint must not contain credentials or a hash.");
  }
  return url.toString();
}

function progress(event) {
  if (!event.entity) return;
  process.stderr.write(`\r${event.entity}: ${event.rows ?? 0} rows in ${event.pages ?? 0} pages`);
}

function usageError(message) {
  const error = new Error(`${message}\n\n${help()}`);
  error.code = "USAGE";
  throw error;
}

function help() {
  return `POAPin Collections backup\n\nUsage:\n  node tools/collections-backup/cli.mjs snapshot --output <directory> [options]\n  node tools/collections-backup/cli.mjs media --input <snapshot-directory> [options]\n  node tools/collections-backup/cli.mjs enrich-drops --input <snapshot-directory> [options]\n  node tools/collections-backup/cli.mjs compare --primary <directory> --secondary <directory>\n  node tools/collections-backup/cli.mjs verify --input <snapshot-directory> [--online-schema]\n  node tools/collections-backup/cli.mjs build-d1 --input <snapshot-directory> --snapshot-id <id>\n  node tools/collections-backup/cli.mjs package --input <snapshot-directory> [--output <archive>]\n\nSnapshot options:\n  --endpoint <https-url>  Compass GraphQL endpoint\n  --delay-ms <number>     Minimum delay between requests (default: 250)\n  --page-size <1-100>     Root page size (default: 100)\n  --resume                Continue a matching interrupted snapshot\n\nMedia/enrich options:\n  --concurrency <1-8>              Concurrent downloads (default: 3)\n  --max-bytes <1024-262144000>     Maximum bytes per object (default: 52428800)\n  --retry-failures                 Retry prior failed and missing references\n\nEnrich-drops options:\n  --delay-ms <number>                 GraphQL request delay (default: 250)\n  --page-size <1-100>                 Referenced drops per request (default: 100)\n  --archive-snapshot-id <id>          Existing archive snapshot identity\n  --archive-media-manifest <path>     Verified artwork manifest NDJSON\n  --archive-upload-report <path>      Complete artwork upload report JSON\n  --archive-upload-checkpoint <path>  Per-object R2 upload proof JSONL\n  --archive-catalog-sqlite <path>     Optional read-only token-count fallback\n\nVerify options:\n  --online-schema         Re-introspect Compass and require the schema hash to match\n`;
}
