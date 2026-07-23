import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { ENTITY_BY_NAME, ENTITY_CONFIGS, HARD_PAGE_LIMIT } from "./config.mjs";
import {
  INTROSPECTION_QUERY,
  compareCursors,
  cursorFromRow,
  makeCountQuery,
  makePageQuery,
  makeUpperBoundQuery,
} from "./graphql.mjs";
import {
  exists,
  readGzipJson,
  readJson,
  sha256,
  sha256File,
  writeJsonAtomic,
  writeTextAtomic,
} from "./files.mjs";

export async function verifyMomentsSnapshot({ input }) {
  if (!input) throw new Error("verifyMomentsSnapshot requires input.");
  const root = resolve(input);
  const issues = [];
  const manifest = await readRequiredJson(root, "manifest.json", issues);
  const source = await readRequiredJson(root, "source.json", issues);
  const report = {
    version: 1,
    dataset: manifest?.dataset ?? source?.dataset ?? "poap-compass-moments",
    verified: false,
    startedAt: new Date().toISOString(),
    schema: { checked: false },
    queries: { checked: 0 },
    raw: { checked: 0, rows: 0 },
    normalized: { checked: 0, rows: 0, tables: {} },
    relationships: { checked: false },
    issues,
  };

  if (manifest && source) {
    if (manifest.dataset !== "poap-compass-moments" || source.dataset !== manifest.dataset) {
      issue(issues, "DATASET_MISMATCH", "Source and manifest dataset identifiers do not match.");
    }
    if (manifest.endpoint !== source.endpoint) {
      issue(issues, "ENDPOINT_MISMATCH", "Source and manifest endpoints do not match.");
    }
    await verifyManifestChecksum(root, issues);
    report.schema = await verifySchema(root, manifest, issues);
    report.queries = await verifyQueries(root, manifest.queries, issues);
    report.raw = await verifyRaw(root, manifest, issues);
    const normalized = await verifyNormalized(root, manifest, issues);
    report.normalized = normalized.report;
    report.relationships = verifyRelationships(normalized.rows, issues);
    if (manifest.media?.bodiesCaptured !== false) {
      issue(
        issues,
        "MEDIA_POLICY_INVALID",
        "Metadata snapshot must state that media bodies were not captured.",
      );
    }
    const codes = new Set((manifest.knownGaps ?? []).map((gap) => gap.code));
    for (const required of ["NO_TRANSACTIONAL_SNAPSHOT", "NO_DELETION_TOMBSTONES"]) {
      if (!codes.has(required)) issue(issues, "KNOWN_GAP_MISSING", `Manifest omits ${required}.`);
    }
  }

  report.verified = !issues.some((entry) => entry.severity === "error");
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, "validation"), { recursive: true });
  await writeJsonAtomic(resolve(root, "validation/report.json"), report);
  const metadata = await sha256File(resolve(root, "validation/report.json"));
  await writeTextAtomic(
    resolve(root, "validation/report.sha256"),
    `${metadata.sha256}  validation/report.json\n`,
  );
  if (!report.verified) {
    const error = new Error(
      `Moments snapshot verification failed with ${issues.filter((item) => item.severity === "error").length} error(s).`,
    );
    error.code = "MOMENTS_SNAPSHOT_INVALID";
    error.report = report;
    throw error;
  }
  return report;
}

async function verifyManifestChecksum(root, issues) {
  const checksumPath = resolve(root, "manifest.sha256");
  if (!(await exists(checksumPath))) {
    issue(issues, "MANIFEST_CHECKSUM_MISSING", "manifest.sha256 is missing.", "manifest.sha256");
    return;
  }
  const line = (await readFile(checksumPath, "utf8")).trim();
  const expected = line.match(/^([0-9a-f]{64})\s{2}manifest\.json$/)?.[1];
  const actual = await sha256File(resolve(root, "manifest.json"));
  if (!expected || expected !== actual.sha256) {
    issue(issues, "MANIFEST_CHECKSUM_MISMATCH", "manifest.json checksum does not match.");
  }
}

async function verifySchema(root, manifest, issues) {
  const path = manifest.schema?.path ?? "schema/introspection.json";
  const report = { checked: true, path };
  try {
    const metadata = await sha256File(resolve(root, path));
    Object.assign(report, metadata);
    if (
      metadata.sha256 !== manifest.schema?.sha256 ||
      metadata.byteLength !== manifest.schema?.byteLength
    ) {
      issue(issues, "SCHEMA_CHECKSUM_MISMATCH", "Captured schema metadata does not match.", path);
    }
    if (manifest.schema?.querySha256 !== sha256(INTROSPECTION_QUERY)) {
      issue(
        issues,
        "INTROSPECTION_QUERY_MISMATCH",
        "Manifest introspection query hash differs from this verifier.",
        path,
      );
    }
    const body = await readJson(resolve(root, path));
    if (!Array.isArray(body?.data?.__schema?.types)) {
      issue(issues, "SCHEMA_INVALID", "Captured introspection document is invalid.", path);
    }
  } catch (error) {
    issue(issues, "SCHEMA_UNREADABLE", error.message, path);
  }
  return report;
}

async function verifyArtifacts(root, artifacts, issues, prefix) {
  const report = { checked: 0, rows: 0 };
  if (!Array.isArray(artifacts)) {
    issue(issues, `${prefix}_LIST_MISSING`, `${prefix.toLowerCase()} artifact list is missing.`);
    return report;
  }
  for (const artifact of artifacts) {
    try {
      const metadata = await sha256File(resolve(root, artifact.path));
      report.checked += 1;
      if (metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.byteLength) {
        issue(issues, `${prefix}_CHECKSUM_MISMATCH`, "Artifact checksum mismatch.", artifact.path);
      }
    } catch (error) {
      issue(issues, `${prefix}_UNREADABLE`, error.message, artifact.path);
    }
  }
  return report;
}

async function verifyQueries(root, artifacts, issues) {
  const report = await verifyArtifacts(root, artifacts, issues, "QUERY");
  const expected = new Map([["queries/introspection.graphql", `${INTROSPECTION_QUERY.trim()}\n`]]);
  for (const config of ENTITY_CONFIGS) {
    expected.set(`queries/${config.name}-upper.graphql`, `${makeUpperBoundQuery(config).trim()}\n`);
    expected.set(`queries/${config.name}-page.graphql`, `${makePageQuery(config).trim()}\n`);
    const count = makeCountQuery(config);
    if (count) expected.set(`queries/${config.name}-count.graphql`, `${count.trim()}\n`);
  }
  const actual = new Map((artifacts ?? []).map((artifact) => [artifact.path, artifact]));
  if ([...expected.keys()].sort().join("\0") !== [...actual.keys()].sort().join("\0")) {
    issue(issues, "QUERY_SET_MISMATCH", "Stored query set differs from this exporter.");
  }
  for (const [path, contents] of expected) {
    if (actual.get(path)?.sha256 !== sha256(contents)) {
      issue(issues, "QUERY_SOURCE_MISMATCH", `${path} differs from this exporter.`, path);
    }
  }
  return report;
}

async function verifyRaw(root, manifest, issues) {
  const report = { checked: 0, rows: 0, entities: {} };
  const expectedNames = ENTITY_CONFIGS.map((config) => config.name).sort();
  const actualNames = Object.keys(manifest.entities ?? {}).sort();
  if (expectedNames.join("\0") !== actualNames.join("\0")) {
    issue(issues, "ENTITY_SET_MISMATCH", "Manifest entity set differs from the exporter.");
  }
  for (const config of ENTITY_CONFIGS) {
    const entity = manifest.entities?.[config.name];
    const entityReport = { checked: 0, rows: 0 };
    report.entities[config.name] = entityReport;
    if (!entity || entity.complete !== true) {
      issue(issues, "ENTITY_INCOMPLETE", `${config.name} is missing or incomplete.`);
      continue;
    }
    if (entity.querySha256 !== sha256(makePageQuery(config))) {
      issue(issues, "PAGE_QUERY_MISMATCH", `${config.name} page query hash differs.`);
    }
    if (!Array.isArray(entity.rawArtifacts) || entity.rawArtifacts.length !== entity.pages) {
      issue(issues, "RAW_PAGE_SET_INVALID", `${config.name} raw page list is invalid.`);
      continue;
    }
    let prior = config.cursor.map((field) => field.initial);
    for (let index = 0; index < entity.rawArtifacts.length; index += 1) {
      const artifact = entity.rawArtifacts[index];
      try {
        const metadata = await sha256File(resolve(root, artifact.path));
        if (metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.byteLength) {
          issue(issues, "RAW_CHECKSUM_MISMATCH", "Raw page checksum mismatch.", artifact.path);
        }
        const envelope = await readGzipJson(resolve(root, artifact.path));
        const rows = envelope?.response?.data?.[config.root];
        if (
          envelope.entity !== config.name ||
          envelope.page !== index + 1 ||
          envelope.querySha256 !== entity.querySha256 ||
          !Array.isArray(rows) ||
          rows.length !== artifact.rows
        ) {
          issue(
            issues,
            "RAW_ENVELOPE_INVALID",
            "Raw page envelope is inconsistent.",
            artifact.path,
          );
          continue;
        }
        for (const row of rows) {
          const cursor = cursorFromRow(config, row);
          if (compareCursors(config, cursor, prior) <= 0) {
            issue(
              issues,
              "RAW_ORDER_INVALID",
              `${config.name} is not strictly ordered.`,
              artifact.path,
            );
          }
          prior = cursor;
          for (const nested of config.nestedSelections) {
            if (!Array.isArray(row[nested.field]) || row[nested.field].length >= HARD_PAGE_LIMIT) {
              issue(
                issues,
                "NESTED_RELATION_UNSAFE",
                `${config.name}.${nested.field} is missing or reached the hard limit.`,
                artifact.path,
              );
            }
          }
        }
        entityReport.checked += 1;
        entityReport.rows += rows.length;
      } catch (error) {
        issue(issues, "RAW_UNREADABLE", error.message, artifact.path);
      }
    }
    report.checked += entityReport.checked;
    report.rows += entityReport.rows;
    if (entityReport.rows !== entity.rows) {
      issue(issues, "RAW_ROW_COUNT_MISMATCH", `${config.name} raw row count differs.`);
    }
    if (entity.expectedCount !== null && entity.expectedCount !== entityReport.rows) {
      issue(issues, "AGGREGATE_COUNT_MISMATCH", `${config.name} aggregate count differs.`);
    }
    if (entity.rows > 0 && compareCursors(config, prior, entity.upperBound) !== 0) {
      issue(
        issues,
        "UPPER_BOUND_MISMATCH",
        `${config.name} did not end at its frozen upper bound.`,
      );
    }
  }
  return report;
}

async function verifyNormalized(root, manifest, issues) {
  const artifactByPath = new Map(
    (manifest.normalized?.artifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  const rows = new Map();
  const report = { checked: 0, rows: 0, tables: {} };
  for (const name of [...ENTITY_CONFIGS.map((config) => config.name), "moment_drops"]) {
    const path = `normalized/${name}.ndjson`;
    const artifact = artifactByPath.get(path);
    if (!artifact) {
      issue(issues, "NORMALIZED_ARTIFACT_MISSING", `${path} is not listed.`, path);
      continue;
    }
    let values = [];
    try {
      const metadata = await sha256File(resolve(root, path));
      if (metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.byteLength) {
        issue(issues, "NORMALIZED_CHECKSUM_MISMATCH", "Checksum mismatch.", path);
      }
      values = await readNdjson(resolve(root, path));
      if (values.length !== artifact.rows) {
        issue(issues, "NORMALIZED_ROW_COUNT_MISMATCH", "Row count mismatch.", path);
      }
      const config = ENTITY_BY_NAME.get(name);
      if (config) {
        let prior = null;
        const keys = new Set();
        for (const row of values) {
          const cursor = cursorFromRow(config, row);
          const key = JSON.stringify(cursor);
          if (keys.has(key))
            issue(issues, "NORMALIZED_DUPLICATE_KEY", `Duplicate key ${key}.`, path);
          keys.add(key);
          if (prior && compareCursors(config, cursor, prior) <= 0) {
            issue(
              issues,
              "NORMALIZED_ORDER_INVALID",
              "Rows are not strictly keyset ordered.",
              path,
            );
          }
          prior = cursor;
        }
      }
      rows.set(name, values);
      report.checked += 1;
      report.rows += values.length;
      report.tables[name] = { path, rows: values.length, ...metadata };
      const entity = ENTITY_BY_NAME.get(name) ? manifest.entities?.[name] : null;
      if (entity && entity.rows !== values.length) {
        issue(
          issues,
          "NORMALIZED_ENTITY_COUNT_MISMATCH",
          `${name} normalized row count differs from its entity report.`,
          path,
        );
      }
    } catch (error) {
      issue(issues, "NORMALIZED_UNREADABLE", error.message, path);
    }
  }
  return { rows, report };
}

function verifyRelationships(rows, issues) {
  const momentIds = new Set((rows.get("moments") ?? []).map((row) => String(row.id).toLowerCase()));
  const mediaKeys = new Set((rows.get("moment_media") ?? []).map((row) => String(row.key)));
  const capsuleIds = new Set((rows.get("capsules") ?? []).map((row) => String(row.id)));
  const relationKeys = new Set();
  for (const relation of rows.get("moment_drops") ?? []) {
    const key = `${String(relation.moment_id).toLowerCase()}\0${relation.drop_id}`;
    if (relationKeys.has(key)) issue(issues, "MOMENT_DROP_DUPLICATE", `Duplicate ${key}.`);
    relationKeys.add(key);
    if (!momentIds.has(String(relation.moment_id).toLowerCase())) {
      issue(issues, "MOMENT_DROP_ORPHAN", `Unknown moment ${relation.moment_id}.`);
    }
  }
  const nestedKeys = new Set();
  for (const moment of rows.get("moments") ?? []) {
    for (const relation of moment.drops ?? []) {
      const key = `${String(relation.moment_id).toLowerCase()}\0${relation.drop_id}`;
      nestedKeys.add(key);
      if (!relationKeys.has(key))
        issue(issues, "MOMENT_DROP_DERIVATION_MISSING", `Missing ${key}.`);
    }
  }
  for (const key of relationKeys) {
    if (!nestedKeys.has(key)) {
      issue(issues, "MOMENT_DROP_DERIVATION_EXTRA", `Derived relation ${key} is not nested.`);
    }
  }
  for (const [name, field] of [
    ["links", "moment_id"],
    ["user_tags", "moment_id"],
  ]) {
    for (const row of rows.get(name) ?? []) {
      if (!momentIds.has(String(row[field]).toLowerCase())) {
        issue(issues, "MOMENT_RELATION_ORPHAN", `${name} references unknown moment ${row[field]}.`);
      }
    }
  }
  for (const media of rows.get("moment_media") ?? []) {
    if (media.moment_id && !momentIds.has(String(media.moment_id).toLowerCase())) {
      issue(issues, "MEDIA_MOMENT_ORPHAN", `Media ${media.key} references unknown moment.`);
    }
  }
  for (const gateway of rows.get("gateways") ?? []) {
    if (!mediaKeys.has(String(gateway.moment_media_id))) {
      issue(issues, "GATEWAY_MEDIA_ORPHAN", `Gateway ${gateway.id} references unknown media.`);
    }
  }
  for (const relation of rows.get("capsule_moments") ?? []) {
    if (!capsuleIds.has(String(relation.capsule_id))) {
      issue(issues, "CAPSULE_RELATION_ORPHAN", `Unknown capsule ${relation.capsule_id}.`);
    }
    if (!momentIds.has(String(relation.moment_id).toLowerCase())) {
      issue(issues, "CAPSULE_MOMENT_ORPHAN", `Unknown moment ${relation.moment_id}.`);
    }
  }
  return {
    checked: true,
    moments: momentIds.size,
    media: mediaKeys.size,
    capsules: capsuleIds.size,
    momentDrops: relationKeys.size,
  };
}

async function readNdjson(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) throw new Error(`Blank NDJSON line ${lineNumber}.`);
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function readRequiredJson(root, path, issues) {
  try {
    return await readJson(resolve(root, path));
  } catch (error) {
    issue(issues, "REQUIRED_JSON_UNREADABLE", error.message, path);
    return null;
  }
}

function issue(issues, code, message, path = null) {
  issues.push({ severity: "error", code, message, path });
}
