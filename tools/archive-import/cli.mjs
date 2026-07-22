#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { importArchive } from "./lib/importer.mjs";
import { assertSha256, parsePositiveInteger, toErrorMessage } from "./lib/util.mjs";

const HELP = `POAP.in archive importer

Usage:
  node tools/archive-import/cli.mjs \\
    --database /path/to/poap.sqlite \\
    --artwork-inventory /path/to/artwork-inventory.json \\
    --output /path/to/import-reports/2026-07-02-v1 \\
    --expected-database-sha256 <sha256> \\
    --expected-archive-sha256 <sha256> \\
    --retrieved-at 2026-07-22T00:00:00Z

Artwork input (choose one):
  --archive <zip>               Inventory artwork entries in the source ZIP.
  --artwork-inventory <json>    Use a verified HTTP Range inventory JSON.
  --artwork-directory <dir>     Inventory extracted .webp files and hash them.
  --allow-missing-artwork       Deliberate metadata-only run (blocking by default).

Options:
  --database <file>             Source poap.sqlite (required).
  --output <directory>          New or empty output directory (required).
  --snapshot-id <id>            Defaults to <snapshot-date>-v<schema-version>.
  --source-url <url>            Exact URL used to acquire the input.
  --retrieved-at <timestamp>    Stable ISO-8601 acquisition timestamp.
  --media-base-url <url>        Defaults to https://media.poap.in.
  --expected-database-sha256    Verify the extracted SQLite file.
  --expected-archive-sha256     Verify a local ZIP, or pin an inventory expectation.
  --skip-artwork-hashes         Skip per-file SHA-256 for an extracted directory.
  --max-shard-mib <integer>     SQL shard ceiling; default 8 MiB.
  --max-statement-kib <integer> SQL statement ceiling; default 90 KiB, max 96.
  --rows-per-statement <int>    Multi-row INSERT batch size; default 100.
  --help                        Show this message.

The command exits 2 after writing report.json when publish-blocking quality
issues remain. It never uploads, mutates Cloudflare resources, or overwrites a
non-empty output directory.
`;

export async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const values = parseArguments(argv);
  const majorNodeVersion = Number(process.versions.node.split(".")[0]);
  if (majorNodeVersion < 22)
    throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);

  const { report, reportPath } = await importArchive({
    ...values,
    onProgress(message) {
      process.stderr.write(`[archive-import] ${message}\n`);
    },
  });
  process.stdout.write(`${reportPath}\n`);
  if (report.quality.blockingIssues.length > 0) {
    process.stderr.write("[archive-import] Publish-blocking quality issues:\n");
    for (const issue of report.quality.blockingIssues) process.stderr.write(`  - ${issue}\n`);
    return 2;
  }
  return 0;
}

function parseArguments(argv) {
  const options = {};
  const valueOptions = new Map([
    ["--database", "databasePath"],
    ["--output", "outputDirectory"],
    ["--archive", "archivePath"],
    ["--artwork-inventory", "artworkInventoryPath"],
    ["--artwork-directory", "artworkDirectory"],
    ["--snapshot-id", "snapshotId"],
    ["--source-url", "sourceUrl"],
    ["--retrieved-at", "retrievedAt"],
    ["--media-base-url", "mediaBaseUrl"],
    ["--expected-database-sha256", "expectedDatabaseSha256"],
    ["--expected-archive-sha256", "expectedArchiveSha256"],
    ["--max-shard-mib", "maxShardMib"],
    ["--max-statement-kib", "maxStatementKib"],
    ["--rows-per-statement", "rowsPerStatement"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-missing-artwork") {
      options.allowMissingArtwork = true;
      continue;
    }
    if (argument === "--skip-artwork-hashes") {
      options.hashArtworkFiles = false;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${argument} requires a value.`);
    options[key] = value;
    index += 1;
  }

  if (!options.databasePath) throw new Error("--database is required.");
  if (!options.outputDirectory) throw new Error("--output is required.");
  const artworkChoices =
    Number(Boolean(options.archivePath)) +
    Number(Boolean(options.artworkInventoryPath)) +
    Number(Boolean(options.artworkDirectory)) +
    Number(Boolean(options.allowMissingArtwork));
  if (artworkChoices !== 1) {
    throw new Error(
      "Choose exactly one of --archive, --artwork-inventory, --artwork-directory, or --allow-missing-artwork.",
    );
  }
  if (options.expectedArchiveSha256)
    assertSha256(options.expectedArchiveSha256, "--expected-archive-sha256");
  if (options.expectedDatabaseSha256)
    assertSha256(options.expectedDatabaseSha256, "--expected-database-sha256");
  if (options.maxShardMib) {
    options.maxShardBytes =
      parsePositiveInteger(options.maxShardMib, "--max-shard-mib") * 1024 * 1024;
    delete options.maxShardMib;
  }
  if (options.maxStatementKib) {
    options.maxStatementBytes =
      parsePositiveInteger(options.maxStatementKib, "--max-statement-kib") * 1024;
    delete options.maxStatementKib;
  }
  if (options.rowsPerStatement) {
    options.rowsPerStatement = parsePositiveInteger(
      options.rowsPerStatement,
      "--rows-per-statement",
    );
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[archive-import] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
