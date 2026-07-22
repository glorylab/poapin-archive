#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { verifyImportOutput } from "./lib/verifier.mjs";
import { toErrorMessage } from "./lib/util.mjs";

const DEFAULT_MIGRATIONS_ROOT = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `Usage: node tools/archive-import/verify.mjs --input <import-output> [--migrations <dir>]\n`,
    );
    return 0;
  }
  let inputDirectory = null;
  let migrationsRoot = DEFAULT_MIGRATIONS_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--input") inputDirectory = resolve(value);
    else if (argument === "--migrations") migrationsRoot = resolve(value);
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!inputDirectory) throw new Error("--input is required.");
  const result = await verifyImportOutput({ inputDirectory, migrationsRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[archive-verify] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
