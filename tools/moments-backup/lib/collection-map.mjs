import { createReadStream } from "node:fs";
import { resolve, basename, dirname, extname, sep } from "node:path";
import { createInterface } from "node:readline";

import { readJson, sha256File, writeJsonAtomic, writeTextAtomic } from "./files.mjs";
import { verifyMomentsSnapshot } from "./verify.mjs";

const MOMENTS_DATASET = "poap-compass-moments";
const COLLECTIONS_DATASET = "poap-compass-collections";
const MOMENT_DROPS_PATH = "normalized/moment_drops.ndjson";
const COLLECTIONS_PATH = "normalized/collections.ndjson";
const COLLECTION_DROP_IDS_PATH = "normalized/collection_drop_ids.ndjson";
const DEFAULT_OUTPUT_PATH = "derived/moment_collections.ndjson";

export async function buildMomentsCollectionMap({ input, collectionsInput, output = null }) {
  if (!input) throw new Error("buildMomentsCollectionMap requires input.");
  if (!collectionsInput) {
    throw new Error("buildMomentsCollectionMap requires collectionsInput.");
  }

  const momentsRoot = resolve(input);
  const collectionsRoot = resolve(collectionsInput);
  const outputPath = resolve(output ?? resolve(momentsRoot, DEFAULT_OUTPUT_PATH));
  if (extname(outputPath) !== ".ndjson") {
    throw new Error("Collection map output must use the .ndjson extension.");
  }
  assertSafeOutput({ momentsRoot, collectionsRoot, outputPath });

  await verifyMomentsSnapshot({ input: momentsRoot });
  const momentsManifestPath = resolve(momentsRoot, "manifest.json");
  const momentsManifest = await readJson(momentsManifestPath);
  if (momentsManifest.dataset !== MOMENTS_DATASET) {
    throw new Error(`Moments manifest dataset must be ${MOMENTS_DATASET}.`);
  }
  const momentDropsArtifact = requiredArtifact(momentsManifest, MOMENT_DROPS_PATH, "Moments");
  const momentDropsPath = resolve(momentsRoot, MOMENT_DROPS_PATH);
  const momentDropsMetadata = await verifyArtifactMetadata(
    momentDropsPath,
    momentDropsArtifact,
    "Moments moment_drops",
  );

  const collections = await readCollectionsSnapshot(collectionsRoot);
  const momentDrops = await readMomentDrops(momentDropsPath);
  if (momentDrops.rows !== momentDropsArtifact.rows) {
    throw new Error(
      `Moments moment_drops row count mismatch: expected ${momentDropsArtifact.rows}, got ${momentDrops.rows}.`,
    );
  }

  const pairsByKey = new Map();
  const mappedMomentIds = new Set();
  const mappedCollectionIds = new Set();
  let matchedMomentDropRelations = 0;
  for (const relation of momentDrops.values) {
    const collectionIds = collections.collectionIdsByDrop.get(relation.dropId);
    if (!collectionIds) continue;
    matchedMomentDropRelations += 1;
    for (const collectionId of collectionIds) {
      const key = `${relation.momentId}\0${collectionId}`;
      if (!pairsByKey.has(key)) {
        pairsByKey.set(key, { momentId: relation.momentId, collectionId });
        mappedMomentIds.add(relation.momentId);
        mappedCollectionIds.add(collectionId);
      }
    }
  }
  const pairs = [...pairsByKey.values()].sort(comparePair);
  const contents = pairs.length ? `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeTextAtomic(outputPath, contents);
  const outputMetadata = await sha256File(outputPath);

  const [momentsManifestMetadata, collectionsManifestMetadata] = await Promise.all([
    sha256File(momentsManifestPath),
    sha256File(collections.manifestPath),
  ]);
  const reportPath = outputPath.slice(0, -".ndjson".length) + ".report.json";
  const report = {
    version: 1,
    dataset: "poapin-moments-collection-map",
    sources: {
      moments: {
        dataset: momentsManifest.dataset,
        version: momentsManifest.version,
        startedAt: momentsManifest.startedAt,
        finishedAt: momentsManifest.finishedAt,
        manifest: { path: "manifest.json", ...momentsManifestMetadata },
        momentDrops: {
          path: MOMENT_DROPS_PATH,
          rows: momentDrops.rows,
          ...momentDropsMetadata,
        },
      },
      collections: {
        dataset: collections.manifest.dataset,
        version: collections.manifest.version,
        startedAt: collections.manifest.startedAt,
        finishedAt: collections.manifest.finishedAt,
        manifest: { path: "manifest.json", ...collectionsManifestMetadata },
        collections: collections.artifacts.collections,
        collectionDropIds: collections.artifacts.collectionDropIds,
      },
    },
    artifact: {
      path: basename(outputPath),
      rows: pairs.length,
      ...outputMetadata,
    },
    counts: {
      collections: collections.collectionIds.size,
      collectionsWithDropIds: collections.collectionDropRows,
      collectionDropReferences: collections.collectionDropReferences,
      uniqueCollectionDrops: collections.collectionIdsByDrop.size,
      momentDropRelations: momentDrops.rows,
      momentsWithDropRelations: momentDrops.momentIds.size,
      matchedMomentDropRelations,
      unmatchedMomentDropRelations: momentDrops.rows - matchedMomentDropRelations,
      mappedMoments: mappedMomentIds.size,
      mappedCollections: mappedCollectionIds.size,
      momentCollectionPairs: pairs.length,
    },
  };
  await writeJsonAtomic(reportPath, report);

  return { output: outputPath, reportPath, ...report };
}

async function readCollectionsSnapshot(root) {
  const manifestPath = resolve(root, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (manifest.dataset !== COLLECTIONS_DATASET) {
    throw new Error(`Collections manifest dataset must be ${COLLECTIONS_DATASET}.`);
  }
  if (manifest.version !== 1) {
    throw new Error(
      `Unsupported Collections manifest version ${JSON.stringify(manifest.version)}.`,
    );
  }

  const collectionsArtifact = requiredArtifact(manifest, COLLECTIONS_PATH, "Collections");
  const collectionDropIdsArtifact = requiredArtifact(
    manifest,
    COLLECTION_DROP_IDS_PATH,
    "Collections",
  );
  const collectionsPath = resolve(root, COLLECTIONS_PATH);
  const collectionDropIdsPath = resolve(root, COLLECTION_DROP_IDS_PATH);
  const [collectionsMetadata, collectionDropIdsMetadata] = await Promise.all([
    verifyArtifactMetadata(collectionsPath, collectionsArtifact, "Collections collections"),
    verifyArtifactMetadata(
      collectionDropIdsPath,
      collectionDropIdsArtifact,
      "Collections collection_drop_ids",
    ),
  ]);

  const collectionIds = new Set();
  let collectionRows = 0;
  for await (const { value, lineNumber } of iterateNdjson(collectionsPath)) {
    const collectionId = positiveInteger(value?.id, `collections line ${lineNumber} id`);
    if (collectionIds.has(collectionId)) {
      throw new Error(`Collections collections contains duplicate id ${collectionId}.`);
    }
    collectionIds.add(collectionId);
    collectionRows += 1;
  }
  if (collectionRows !== collectionsArtifact.rows) {
    throw new Error(
      `Collections collections row count mismatch: expected ${collectionsArtifact.rows}, got ${collectionRows}.`,
    );
  }

  const collectionIdsByDrop = new Map();
  const seenCollectionRows = new Set();
  let collectionDropRows = 0;
  let collectionDropReferences = 0;
  for await (const { value, lineNumber } of iterateNdjson(collectionDropIdsPath)) {
    const collectionId = positiveInteger(
      value?.collection_id,
      `collection_drop_ids line ${lineNumber} collection_id`,
    );
    if (!collectionIds.has(collectionId)) {
      throw new Error(`collection_drop_ids references unknown collection ${collectionId}.`);
    }
    if (seenCollectionRows.has(collectionId)) {
      throw new Error(`collection_drop_ids contains duplicate collection ${collectionId}.`);
    }
    seenCollectionRows.add(collectionId);
    if (!Array.isArray(value?.drop_ids)) {
      throw new Error(`collection_drop_ids line ${lineNumber} drop_ids must be an array.`);
    }
    const dropsInCollection = new Set();
    for (const rawDropId of value.drop_ids) {
      const dropId = positiveInteger(rawDropId, `collection_drop_ids line ${lineNumber} drop_id`);
      if (dropsInCollection.has(dropId)) {
        throw new Error(`Collection ${collectionId} contains duplicate drop ${dropId}.`);
      }
      dropsInCollection.add(dropId);
      const ids = collectionIdsByDrop.get(dropId) ?? [];
      ids.push(collectionId);
      collectionIdsByDrop.set(dropId, ids);
      collectionDropReferences += 1;
    }
    collectionDropRows += 1;
  }
  if (collectionDropRows !== collectionDropIdsArtifact.rows) {
    throw new Error(
      `Collections collection_drop_ids row count mismatch: expected ${collectionDropIdsArtifact.rows}, got ${collectionDropRows}.`,
    );
  }
  for (const ids of collectionIdsByDrop.values()) ids.sort(compareInteger);

  return {
    manifest,
    manifestPath,
    collectionIds,
    collectionIdsByDrop,
    collectionDropRows,
    collectionDropReferences,
    artifacts: {
      collections: {
        path: COLLECTIONS_PATH,
        rows: collectionRows,
        ...collectionsMetadata,
      },
      collectionDropIds: {
        path: COLLECTION_DROP_IDS_PATH,
        rows: collectionDropRows,
        ...collectionDropIdsMetadata,
      },
    },
  };
}

async function readMomentDrops(path) {
  const values = [];
  const seen = new Set();
  const momentIds = new Set();
  for await (const { value, lineNumber } of iterateNdjson(path)) {
    const momentId = uuid(value?.moment_id, `moment_drops line ${lineNumber} moment_id`);
    const dropId = positiveInteger(value?.drop_id, `moment_drops line ${lineNumber} drop_id`);
    const key = `${momentId}\0${dropId}`;
    if (seen.has(key)) throw new Error(`moment_drops contains duplicate relation ${key}.`);
    seen.add(key);
    momentIds.add(momentId);
    values.push({ momentId, dropId });
  }
  return { values, rows: values.length, momentIds };
}

async function verifyArtifactMetadata(path, artifact, label) {
  const metadata = await sha256File(path);
  if (metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.byteLength) {
    throw new Error(`${label} artifact checksum or byte length does not match its manifest.`);
  }
  return metadata;
}

function requiredArtifact(manifest, path, label) {
  const artifacts = manifest.normalized?.artifacts;
  if (!Array.isArray(artifacts)) {
    throw new Error(`${label} manifest normalized artifact list is missing.`);
  }
  const matches = artifacts.filter((artifact) => artifact?.path === path);
  if (matches.length !== 1) {
    throw new Error(`${label} manifest must list ${path} exactly once.`);
  }
  const artifact = matches[0];
  if (
    !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 0 ||
    !Number.isSafeInteger(artifact.rows) ||
    artifact.rows < 0
  ) {
    throw new Error(`${label} manifest metadata for ${path} is invalid.`);
  }
  return artifact;
}

async function* iterateNdjson(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) throw new Error(`${path} contains a blank NDJSON line ${lineNumber}.`);
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${path} contains invalid JSON on line ${lineNumber}: ${error.message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} line ${lineNumber} must be a JSON object.`);
    }
    yield { value, lineNumber };
  }
}

function positiveInteger(value, label) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function uuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function comparePair(left, right) {
  return (
    compareText(left.momentId, right.momentId) ||
    compareInteger(left.collectionId, right.collectionId)
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareInteger(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeOutput({ momentsRoot, collectionsRoot, outputPath }) {
  if (isWithin(collectionsRoot, outputPath)) {
    throw new Error("Collection map output must not modify the Collections snapshot.");
  }
  for (const directory of ["normalized", "raw", "schema", "queries", "state"]) {
    if (isWithin(resolve(momentsRoot, directory), outputPath)) {
      throw new Error(`Collection map output must not modify Moments ${directory}/ source data.`);
    }
  }
  for (const file of ["manifest.json", "manifest.sha256", "source.json"]) {
    if (outputPath === resolve(momentsRoot, file)) {
      throw new Error(`Collection map output must not replace Moments ${file}.`);
    }
  }
  const reportPath = outputPath.slice(0, -".ndjson".length) + ".report.json";
  if (reportPath === outputPath || dirname(reportPath) !== dirname(outputPath)) {
    throw new Error("Collection map report path is invalid.");
  }
}

function isWithin(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}
