import { resolve } from "node:path";

import { readJson, writeJsonAtomic } from "./files.mjs";

export async function compareCollectionsSnapshots({ primary, secondary }) {
  const primaryRoot = resolve(primary);
  const secondaryRoot = resolve(secondary);
  const left = await readJson(resolve(primaryRoot, "manifest.json"));
  const right = await readJson(resolve(secondaryRoot, "manifest.json"));
  const mismatches = [];

  if (left.endpoint !== right.endpoint) {
    mismatches.push({
      code: "ENDPOINT_MISMATCH",
      primary: left.endpoint,
      secondary: right.endpoint,
    });
  }
  if (left.schema.sha256 !== right.schema.sha256) {
    mismatches.push({
      code: "SCHEMA_MISMATCH",
      primary: left.schema.sha256,
      secondary: right.schema.sha256,
    });
  }

  const leftArtifacts = artifactMap(left);
  const rightArtifacts = artifactMap(right);
  for (const path of [...new Set([...leftArtifacts.keys(), ...rightArtifacts.keys()])].sort()) {
    const a = leftArtifacts.get(path);
    const b = rightArtifacts.get(path);
    if (!a || !b || a.sha256 !== b.sha256 || a.rows !== b.rows) {
      mismatches.push({
        code: "CANONICAL_ARTIFACT_MISMATCH",
        path,
        primary: a ?? null,
        secondary: b ?? null,
      });
    }
  }

  const stable = mismatches.length === 0;
  const report = {
    version: 1,
    comparedAt: new Date().toISOString(),
    stable,
    consistency: stable ? "stable-two-pass" : "unstable-two-pass",
    primary: {
      path: primaryRoot,
      startedAt: left.startedAt,
      finishedAt: left.finishedAt,
      schemaSha256: left.schema.sha256,
    },
    secondary: {
      path: secondaryRoot,
      startedAt: right.startedAt,
      finishedAt: right.finishedAt,
      schemaSha256: right.schema.sha256,
    },
    artifactsCompared: Math.max(leftArtifacts.size, rightArtifacts.size),
    mismatches,
  };
  await writeJsonAtomic(resolve(primaryRoot, "validation/stability.json"), report);
  left.consistency = {
    status: report.consistency,
    comparedAt: report.comparedAt,
    secondaryStartedAt: right.startedAt,
    secondaryFinishedAt: right.finishedAt,
    report: "validation/stability.json",
  };
  await writeJsonAtomic(resolve(primaryRoot, "manifest.json"), left);
  return report;
}

function artifactMap(manifest) {
  return new Map(
    manifest.normalized.artifacts.map((artifact) => [
      artifact.path,
      {
        rows: artifact.rows,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
      },
    ]),
  );
}
