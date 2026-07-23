import { resolve } from "node:path";

import { readJson, sha256File, writeJsonAtomic } from "./files.mjs";

export async function compareMomentsSnapshots({ primary, secondary, output = null }) {
  if (!primary || !secondary) throw new Error("compare requires primary and secondary snapshots.");
  const primaryRoot = resolve(primary);
  const secondaryRoot = resolve(secondary);
  const primaryManifestPath = resolve(primaryRoot, "manifest.json");
  const secondaryManifestPath = resolve(secondaryRoot, "manifest.json");
  const [left, right, leftManifestMetadata, rightManifestMetadata] = await Promise.all([
    readJson(primaryManifestPath),
    readJson(secondaryManifestPath),
    sha256File(primaryManifestPath),
    sha256File(secondaryManifestPath),
  ]);
  const differences = [];
  compareValue(differences, "dataset", left.dataset, right.dataset);
  compareValue(differences, "endpoint", left.endpoint, right.endpoint);
  compareValue(differences, "schema.sha256", left.schema?.sha256, right.schema?.sha256);

  const entityNames = new Set([
    ...Object.keys(left.entities ?? {}),
    ...Object.keys(right.entities ?? {}),
  ]);
  for (const name of [...entityNames].sort()) {
    for (const field of ["rows", "expectedCount", "upperBound", "querySha256", "complete"]) {
      compareValue(
        differences,
        `entities.${name}.${field}`,
        left.entities?.[name]?.[field],
        right.entities?.[name]?.[field],
      );
    }
  }
  const leftArtifacts = new Map(
    (left.normalized?.artifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  const rightArtifacts = new Map(
    (right.normalized?.artifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  const paths = new Set([...leftArtifacts.keys(), ...rightArtifacts.keys()]);
  const normalizedArtifacts = [];
  for (const path of [...paths].sort()) {
    const primaryArtifact = normalizedArtifact(leftArtifacts.get(path));
    const secondaryArtifact = normalizedArtifact(rightArtifacts.get(path));
    normalizedArtifacts.push({
      path,
      stable: JSON.stringify(primaryArtifact) === JSON.stringify(secondaryArtifact),
      primary: primaryArtifact,
      secondary: secondaryArtifact,
    });
    for (const field of ["rows", "byteLength", "sha256"]) {
      compareValue(
        differences,
        `normalized.${path}.${field}`,
        leftArtifacts.get(path)?.[field],
        rightArtifacts.get(path)?.[field],
      );
    }
  }
  const stable = differences.length === 0;
  const stabilityReport = {
    version: 1,
    dataset: "poapin-moments-stability",
    sourceDataset: left.dataset ?? null,
    stable,
    primary: {
      manifestSha256: leftManifestMetadata.sha256,
      manifestByteLength: leftManifestMetadata.byteLength,
      startedAt: left.startedAt ?? null,
      finishedAt: left.finishedAt ?? null,
    },
    secondary: {
      manifestSha256: rightManifestMetadata.sha256,
      manifestByteLength: rightManifestMetadata.byteLength,
      startedAt: right.startedAt ?? null,
      finishedAt: right.finishedAt ?? null,
    },
    normalized: {
      stable: normalizedArtifacts.every((artifact) => artifact.stable),
      artifacts: normalizedArtifacts,
    },
    differences,
  };
  if (output) await writeJsonAtomic(resolve(output), stabilityReport);
  return {
    ...stabilityReport,
    primaryPath: primaryRoot,
    secondaryPath: secondaryRoot,
    output: output ? resolve(output) : null,
  };
}

function normalizedArtifact(artifact) {
  return artifact
    ? {
        rows: artifact.rows ?? null,
        byteLength: artifact.byteLength ?? null,
        sha256: artifact.sha256 ?? null,
      }
    : null;
}

function compareValue(differences, field, primary, secondary) {
  if (JSON.stringify(primary) !== JSON.stringify(secondary)) {
    differences.push({ field, primary: primary ?? null, secondary: secondary ?? null });
  }
}
