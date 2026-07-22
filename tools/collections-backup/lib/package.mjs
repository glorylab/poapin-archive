import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { exists, readJson, sha256File, writeJsonAtomic } from "./files.mjs";
import { bindCollectionsSnapshotInputs } from "./d1.mjs";

export async function packageCollectionsSnapshot({ input, output = null }) {
  const root = resolve(input);
  const archivePath = resolve(output ?? resolve(dirname(root), `${basename(root)}.tar.gz`));
  if (archivePath === root || archivePath.startsWith(`${root}/`)) {
    throw new Error("Package output must be outside the snapshot directory.");
  }
  if (await exists(archivePath))
    throw new Error(`Package output already exists at ${archivePath}.`);

  const validation = await readJson(resolve(root, "validation/report.json"));
  const sourceManifest = await sha256File(resolve(root, "manifest.json"));
  if (validation.manifest?.sha256 !== sourceManifest.sha256) {
    throw new Error("Validation report is stale; run verify again before packaging.");
  }
  if (!validation.verified || validation.media?.complete !== true) {
    throw new Error("Snapshot must pass structured and media verification before packaging.");
  }
  const d1 = await readJson(resolve(root, "d1/report.json"));
  const sourceInputs = await bindCollectionsSnapshotInputs({ root, snapshotId: d1.snapshotId });
  assertD1SourceBinding(d1, sourceInputs);
  await verifyD1Artifacts(root, d1);
  const checksums = await sha256File(resolve(root, "checksums.sha256"));
  const d1Report = await sha256File(resolve(root, "d1/report.json"));
  const inventory = await inventoryFiles(root);
  const packageManifest = {
    version: 1,
    format: "poapin.collections.backup",
    createdAt: new Date().toISOString(),
    snapshotId: d1.snapshotId,
    sourceManifestSha256: sourceManifest.sha256,
    checksumsSha256: checksums.sha256,
    d1ReportSha256: d1Report.sha256,
    files: inventory.files,
    bytes: inventory.bytes,
  };
  await writeJsonAtomic(resolve(root, "package-manifest.json"), packageManifest);

  try {
    await run("tar", ["-czf", archivePath, "-C", dirname(root), basename(root)]);
    const reboundInputs = await bindCollectionsSnapshotInputs({
      root,
      snapshotId: d1.snapshotId,
    });
    if (reboundInputs.sha256 !== sourceInputs.sha256) {
      throw new Error("Collections snapshot inputs changed while packaging was running.");
    }
    await verifyD1Artifacts(root, d1);
    const archive = await sha256File(archivePath);
    const sidecarPath = `${archivePath}.sha256`;
    await writeFile(sidecarPath, `${archive.sha256}  ${basename(archivePath)}\n`, {
      mode: 0o600,
    });
    return {
      path: archivePath,
      ...archive,
      checksumPath: sidecarPath,
      snapshotId: d1.snapshotId,
    };
  } catch (error) {
    await rm(archivePath, { force: true });
    await rm(`${archivePath}.sha256`, { force: true });
    throw error;
  }
}

function assertD1SourceBinding(d1, current) {
  if (
    d1?.version !== 1 ||
    d1.sourceManifestSha256 !== current.manifest.sha256 ||
    d1.sourceValidationSha256 !== current.validation.sha256 ||
    d1.sourceInputsSha256 !== current.sha256 ||
    JSON.stringify(d1.sourceInputs) !== JSON.stringify(current)
  ) {
    throw new Error("D1 build report is not bound to the current verified snapshot inputs.");
  }
}

async function verifyD1Artifacts(root, d1) {
  const paths = new Set();
  for (const artifact of d1.artifacts ?? []) {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      !artifact.path.startsWith("d1/") ||
      paths.has(artifact.path) ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength <= 0
    ) {
      throw new Error(`D1 report contains an invalid artifact: ${artifact?.path ?? "<missing>"}.`);
    }
    paths.add(artifact.path);
    const actual = await sha256File(resolve(root, artifact.path));
    if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) {
      throw new Error(`D1 artifact changed after build: ${artifact.path}.`);
    }
  }
  if (!paths.has("d1/finalize/999999_finalize.sql")) {
    throw new Error("D1 report has no canonical activation finalizer.");
  }
  await verifyMediaProofPlan(root, d1.mediaProof);
  const portable = d1.portableDatabase;
  if (
    portable?.path !== "d1/collections.sqlite3" ||
    !/^[0-9a-f]{64}$/.test(portable.sha256 ?? "") ||
    !Number.isSafeInteger(portable.byteLength) ||
    portable.byteLength <= 0
  ) {
    throw new Error("D1 report has no valid portable database binding.");
  }
  const actualPortable = await sha256File(resolve(root, portable.path));
  if (
    actualPortable.sha256 !== portable.sha256 ||
    actualPortable.byteLength !== portable.byteLength
  ) {
    throw new Error("Portable Collections database changed after build.");
  }
}

async function verifyMediaProofPlan(root, mediaProof) {
  const descriptor = mediaProof?.manifest;
  if (
    mediaProof?.version !== 2 ||
    descriptor?.path !== "d1/media/publication-plan.ndjson" ||
    descriptor.sha256 !== mediaProof.sha256 ||
    !/^[0-9a-f]{64}$/.test(descriptor.sha256 ?? "") ||
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength <= 0 ||
    !Number.isSafeInteger(descriptor.rows) ||
    descriptor.rows < 0 ||
    descriptor.rows !== mediaProof.objects
  ) {
    throw new Error("D1 report has no valid media proof publication plan binding.");
  }
  const rootRealPath = await realpath(root);
  const absolutePath = resolve(root, descriptor.path);
  const relativePath = relative(root, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("D1 media proof publication plan escapes the snapshot directory.");
  }
  const fileStat = await lstat(absolutePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("D1 media proof publication plan is not a regular file.");
  }
  const planRealPath = await realpath(absolutePath);
  const realRelative = relative(rootRealPath, planRealPath);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error("D1 media proof publication plan resolves outside the snapshot directory.");
  }
  const actual = await sha256File(absolutePath);
  if (actual.sha256 !== descriptor.sha256 || actual.byteLength !== descriptor.byteLength) {
    throw new Error("D1 media proof publication plan changed after build.");
  }
  const rows = [];
  for (const [index, line] of (await readFile(absolutePath, "utf8")).split("\n").entries()) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`D1 media proof publication plan has invalid JSON on line ${index + 1}.`);
    }
  }
  if (rows.length !== descriptor.rows) {
    throw new Error("D1 media proof publication plan row count changed after build.");
  }
  let priorKey = null;
  const counts = {
    collectionMedia: 0,
    archiveDropArtwork: 0,
    collectionDropArtwork: 0,
    upload: 0,
    reuse: 0,
  };
  for (const row of rows) {
    if (
      typeof row.key !== "string" ||
      row.key.length === 0 ||
      (priorKey !== null && row.key.localeCompare(priorKey, "en") <= 0) ||
      !["upload", "reuse"].includes(row.disposition) ||
      !Number.isSafeInteger(row.byteLength) ||
      row.byteLength <= 0 ||
      !/^[0-9a-f]{64}$/.test(row.sha256 ?? "") ||
      typeof row.contentType !== "string" ||
      !row.contentType.startsWith("image/")
    ) {
      throw new Error("D1 media proof publication plan contains an invalid object descriptor.");
    }
    priorKey = row.key;
    if (row.kind === "collection-media") counts.collectionMedia += 1;
    else if (row.kind === "archive-drop-artwork") counts.archiveDropArtwork += 1;
    else if (row.kind === "collection-drop-artwork") counts.collectionDropArtwork += 1;
    else throw new Error(`D1 media proof publication plan contains unknown kind ${row.kind}.`);
    counts[row.disposition] += 1;
    if (row.disposition === "upload" && typeof row.sourcePath !== "string") {
      throw new Error(`D1 media proof upload object has no source path: ${row.key}.`);
    }
    if (
      row.disposition === "reuse" &&
      (row.kind !== "archive-drop-artwork" ||
        typeof row.cacheControl !== "string" ||
        row.cacheControl.length === 0 ||
        !Number.isSafeInteger(row.dropId) ||
        row.dropId <= 0 ||
        row.key !== `snapshots/${row.archiveSnapshotId}/artwork/${row.dropId}.webp`)
    ) {
      throw new Error(`D1 media proof reuse object is invalid: ${row.key}.`);
    }
  }
  if (Object.entries(counts).some(([name, count]) => mediaProof.counts?.[name] !== count)) {
    throw new Error("D1 media proof publication plan category counts changed after build.");
  }
}

async function inventoryFiles(root, directory = root) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await inventoryFiles(root, absolute);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile() && relative(root, absolute) !== "package-manifest.json") {
      files += 1;
      bytes += (await stat(absolute)).size;
    }
  }
  return { files, bytes };
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}.`),
        );
    });
  });
}
