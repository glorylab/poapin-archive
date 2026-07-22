#!/usr/bin/env node

import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { OFFICIAL_ARCHIVE_POLICY, inventoryRemoteArchive } from "./lib/archive-inventory.mjs";
import { toErrorMessage } from "./lib/util.mjs";

const HELP = `Usage:
  node tools/archive-import/inventory.mjs --output <inventory.json>

Reads only the pinned POAP Archive ZIP tail and ZIP64 central directory through
strict HTTP Range requests. It does not download artwork or claim to have
measured the whole-archive SHA-256.
`;

export async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--output") throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--output requires a value.");
    outputPath = resolve(value);
    index += 1;
  }
  if (!outputPath) throw new Error("--output is required.");
  const majorNodeVersion = Number(process.versions.node.split(".")[0]);
  if (majorNodeVersion < 22) {
    throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
  }
  process.stderr.write(`[archive-inventory] Reading ${OFFICIAL_ARCHIVE_POLICY.archiveUrl}\n`);
  const inventory = await inventoryRemoteArchive();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${outputPath}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[archive-inventory] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
