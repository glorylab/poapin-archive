#!/usr/bin/env node

import { resolve } from "node:path";

import { buildMomentsCollectionMap } from "./lib/collection-map.mjs";
import { compareMomentsSnapshots } from "./lib/compare.mjs";
import { DEFAULT_ENDPOINT, DEFAULT_PAGE_SIZE, HARD_PAGE_LIMIT } from "./lib/config.mjs";
import { buildMomentsD1 } from "./lib/d1.mjs";
import { captureMomentsSnapshot } from "./lib/snapshot.mjs";
import { verifyMomentsSnapshot } from "./lib/verify.mjs";

const [command, ...argv] = process.argv.slice(2);

try {
  if (command === "snapshot") {
    const options = parseOptions(argv, {
      output: null,
      endpoint: DEFAULT_ENDPOINT,
      "delay-ms": "250",
      "page-size": String(DEFAULT_PAGE_SIZE),
      resume: false,
      "acknowledge-bulk-capture": false,
    });
    if (!options.output) usageError("snapshot requires --output <directory>.");
    if (!options["acknowledge-bulk-capture"]) {
      usageError("snapshot requires the operational safety flag --acknowledge-bulk-capture.");
    }
    const output = resolve(options.output);
    const manifest = await captureMomentsSnapshot({
      output,
      endpoint: validEndpoint(options.endpoint),
      delayMs: boundedInteger(options["delay-ms"], "--delay-ms", 0, 60_000),
      pageSize: boundedInteger(options["page-size"], "--page-size", 1, HARD_PAGE_LIMIT),
      resume: options.resume,
      acknowledgeBulkCapture: true,
      onProgress: progress,
    });
    process.stderr.write("\n");
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          output,
          manifestSha256: manifest.manifestSha256,
          entities: Object.fromEntries(
            Object.entries(manifest.entities).map(([name, entity]) => [name, entity.rows]),
          ),
          momentDrops: manifest.normalized.artifacts.find(
            (artifact) => artifact.path === "normalized/moment_drops.ndjson",
          )?.rows,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === "compare") {
    const options = parseOptions(argv, { primary: null, secondary: null, output: null });
    if (!options.primary || !options.secondary) {
      usageError("compare requires --primary <directory> and --secondary <directory>.");
    }
    const report = await compareMomentsSnapshots({
      primary: resolve(options.primary),
      secondary: resolve(options.secondary),
      output: options.output ? resolve(options.output) : null,
    });
    process.stdout.write(`${JSON.stringify({ ok: report.stable, ...report }, null, 2)}\n`);
    if (!report.stable) process.exitCode = 1;
  } else if (command === "verify") {
    const options = parseOptions(argv, { input: null });
    if (!options.input) usageError("verify requires --input <directory>.");
    const input = resolve(options.input);
    const report = await verifyMomentsSnapshot({ input });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: report.verified,
          input,
          raw: report.raw,
          normalized: report.normalized,
          relationships: report.relationships,
          issues: report.issues,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === "build-d1") {
    const options = parseOptions(argv, {
      input: null,
      output: null,
      "snapshot-id": null,
      "media-manifest": null,
      "media-verification-report": [],
      "media-capture-checkpoint": null,
      "media-recovery-plan": null,
      "media-recovery-checkpoint": null,
      "collection-map": null,
    });
    if (!options.input || !options["snapshot-id"]) {
      usageError("build-d1 requires --input <directory> and --snapshot-id <id>.");
    }
    const report = await buildMomentsD1({
      input: resolve(options.input),
      output: options.output ? resolve(options.output) : null,
      snapshotId: options["snapshot-id"],
      mediaManifest: options["media-manifest"] ? resolve(options["media-manifest"]) : null,
      mediaVerificationReports: options["media-verification-report"].map((path) => resolve(path)),
      mediaCaptureCheckpoint: options["media-capture-checkpoint"]
        ? resolve(options["media-capture-checkpoint"])
        : null,
      mediaRecoveryPlan: options["media-recovery-plan"]
        ? resolve(options["media-recovery-plan"])
        : null,
      mediaRecoveryCheckpoint: options["media-recovery-checkpoint"]
        ? resolve(options["media-recovery-checkpoint"])
        : null,
      collectionMap: options["collection-map"] ? resolve(options["collection-map"]) : null,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
  } else if (command === "build-collection-map") {
    const options = parseOptions(argv, {
      input: null,
      "collections-input": null,
      output: null,
    });
    if (!options.input || !options["collections-input"]) {
      usageError(
        "build-collection-map requires --input <directory> and --collections-input <directory>.",
      );
    }
    const report = await buildMomentsCollectionMap({
      input: resolve(options.input),
      collectionsInput: resolve(options["collections-input"]),
      output: options.output ? resolve(options.output) : null,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
  } else if ([undefined, "help", "--help", "-h"].includes(command)) {
    process.stdout.write(help());
  } else {
    usageError(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`\nmoments-backup: ${error.message}\n`);
  if (process.env.DEBUG && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}

function parseOptions(args, defaults) {
  const options = Object.fromEntries(
    Object.entries(defaults).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
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
    if (Array.isArray(defaults[name])) options[name].push(value);
    else options[name] = value;
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
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:") usageError("--endpoint must use HTTPS.");
  if (endpoint.username || endpoint.password || endpoint.hash) {
    usageError("--endpoint must not contain credentials or a hash.");
  }
  return endpoint.toString();
}

function progress(event) {
  if (event.entity) {
    process.stderr.write(`\r${event.entity}: ${event.rows ?? 0} rows / ${event.pages ?? 0} pages`);
  }
}

function usageError(message) {
  throw new Error(`${message}\n\n${help()}`);
}

function help() {
  return `POAPin Moments metadata backup

Usage:
  node tools/moments-backup/cli.mjs snapshot --output <directory> --acknowledge-bulk-capture [options]
  node tools/moments-backup/cli.mjs compare --primary <directory> --secondary <directory> [--output <json>]
  node tools/moments-backup/cli.mjs verify --input <directory>
  node tools/moments-backup/cli.mjs build-collection-map --input <directory> --collections-input <directory> [--output <ndjson>]
  node tools/moments-backup/cli.mjs build-d1 --input <directory> --snapshot-id <id> [options]

Snapshot options:
  --endpoint <https-url>          Compass GraphQL endpoint
  --delay-ms <0-60000>           Delay between requests (default: 250)
  --page-size <1-100>            Root keyset page size (default: 100)
  --resume                       Resume a matching interrupted snapshot
  --acknowledge-bulk-capture     Required guard against accidental network capture

compare options:
  --output <json>                Optional atomic stability report

build-collection-map options:
  --output <ndjson>              Output file (default: <input>/derived/moment_collections.ndjson)

build-d1 options:
  --output <directory>           Output directory (default: <input>/d1)
  --media-manifest <ndjson>      Optional archive media result keyed by mediaKey
  --media-verification-report <json>
                                 Repeat exactly twice in pass-1, pass-2 hash-
                                 chain order for a media-bound build
  --media-capture-checkpoint <ndjson>
                                 Override the bound capture checkpoint
  --media-recovery-plan <ndjson> Override the bound recovery plan
  --media-recovery-checkpoint <ndjson>
                                 Override the bound recovery checkpoint
  --collection-map <ndjson>      Optional Moment/Collection materialized mapping
`;
}
