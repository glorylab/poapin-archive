import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { once } from "node:events";

import {
  DEFAULT_PAGE_SIZE,
  ENTITY_CONFIGS,
  HARD_PAGE_LIMIT,
  MEDIA_BODY_CAPTURED,
  SNAPSHOT_FORMAT_VERSION,
} from "./config.mjs";
import {
  GraphqlClient,
  INTROSPECTION_QUERY,
  compareCursors,
  cursorFromRow,
  cursorVariables,
  makeCountQuery,
  makePageQuery,
  makeUpperBoundQuery,
  operationName,
} from "./graphql.mjs";
import {
  exists,
  readGzipJson,
  readJson,
  sha256,
  sha256File,
  writeGzipJsonAtomic,
  writeJsonAtomic,
  writeTextAtomic,
} from "./files.mjs";

export async function captureMomentsSnapshot({
  output,
  endpoint,
  delayMs = 250,
  pageSize = DEFAULT_PAGE_SIZE,
  resume = false,
  acknowledgeBulkCapture = false,
  client = null,
  now = () => new Date().toISOString(),
  onProgress = () => {},
}) {
  if (!output) throw new Error("captureMomentsSnapshot requires output.");
  if (!endpoint) throw new Error("captureMomentsSnapshot requires endpoint.");
  if (acknowledgeBulkCapture !== true) {
    throw new Error(
      "Bulk capture is disabled by default; pass --acknowledge-bulk-capture to run snapshot.",
    );
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > HARD_PAGE_LIMIT) {
    throw new Error(`pageSize must be between 1 and ${HARD_PAGE_LIMIT}.`);
  }

  const root = resolve(output);
  await prepareOutput(root, { endpoint, resume, now });
  const marker = await readJson(resolve(root, "source.json"));
  const graphql =
    client ?? new GraphqlClient({ endpoint, delayMs, onRequest: (event) => onProgress(event) });

  const schema = await captureSchema({ root, client: graphql, endpoint, now });
  validateConfiguredSchema(schema.body.data.__schema);
  const queries = await writeQueries(root);

  const entities = {};
  for (const config of ENTITY_CONFIGS) {
    entities[config.name] = await captureEntity({
      root,
      client: graphql,
      endpoint,
      schemaSha256: schema.sha256,
      config,
      pageSize,
      now,
      onProgress,
    });
  }

  const normalized = await normalizeAll({ root });
  const finishedAt = now();
  const manifest = {
    version: SNAPSHOT_FORMAT_VERSION,
    dataset: "poap-compass-moments",
    endpoint,
    startedAt: marker.initializedAt,
    finishedAt,
    schema: {
      path: "schema/introspection.json",
      sha256: schema.sha256,
      byteLength: schema.byteLength,
      querySha256: sha256(INTROSPECTION_QUERY),
    },
    queries,
    pagination: {
      method: "bounded-keyset",
      pageSize,
      hardLimit: HARD_PAGE_LIMIT,
      nestedRelationPolicy:
        "Moments drops are requested with limit 100; a result at that limit aborts instead of silently truncating.",
    },
    entities,
    normalized,
    media: {
      bodiesCaptured: MEDIA_BODY_CAPTURED,
      note: "Gateway URLs and metadata are archived; this command never fetches media bodies.",
    },
    knownGaps: [
      {
        code: "NO_TRANSACTIONAL_SNAPSHOT",
        detail:
          "Compass exposes independent GraphQL queries, not a transactionally consistent multi-query snapshot.",
      },
      {
        code: "NO_DELETION_TOMBSTONES",
        detail: "The anonymous schema exposes neither deletion tombstones nor a change stream.",
      },
      {
        code: "PUBLIC_STATE_ONLY",
        detail: "The snapshot contains only rows visible to the configured GraphQL endpoint.",
      },
    ],
  };
  await writeJsonAtomic(resolve(root, "manifest.json"), manifest);
  const manifestMetadata = await sha256File(resolve(root, "manifest.json"));
  await writeTextAtomic(
    resolve(root, "manifest.sha256"),
    `${manifestMetadata.sha256}  manifest.json\n`,
  );
  return { ...manifest, manifestSha256: manifestMetadata.sha256 };
}

async function prepareOutput(root, { endpoint, resume, now }) {
  const markerPath = resolve(root, "source.json");
  if (await exists(markerPath)) {
    const marker = await readJson(markerPath);
    if (!resume) {
      throw new Error(`Snapshot output already exists at ${root}; pass --resume to continue.`);
    }
    if (
      marker.version !== SNAPSHOT_FORMAT_VERSION ||
      marker.dataset !== "poap-compass-moments" ||
      marker.endpoint !== endpoint
    ) {
      throw new Error("Existing source marker does not match this exporter or endpoint.");
    }
    return;
  }
  if (await exists(root)) {
    const entries = await readdir(root);
    if (entries.length > 0) throw new Error(`Refusing to initialize non-empty directory ${root}.`);
  }
  await mkdir(root, { recursive: true });
  await writeJsonAtomic(markerPath, {
    version: SNAPSHOT_FORMAT_VERSION,
    dataset: "poap-compass-moments",
    endpoint,
    initializedAt: now(),
  });
}

async function captureSchema({ root, client, endpoint, now }) {
  const path = resolve(root, "schema/introspection.json");
  if (await exists(path)) {
    const body = await readJson(path);
    return { body, ...(await sha256File(path)) };
  }
  const response = await client.request({
    query: INTROSPECTION_QUERY,
    operationName: "POAPinMomentsIntrospection",
  });
  await writeJsonAtomic(path, response.body);
  await writeJsonAtomic(resolve(root, "schema/response.json"), {
    endpoint,
    fetchedAt: now(),
    status: response.status,
    headers: response.headers,
  });
  return { body: response.body, ...(await sha256File(path)) };
}

async function writeQueries(root) {
  const entries = new Map([["introspection.graphql", INTROSPECTION_QUERY]]);
  for (const config of ENTITY_CONFIGS) {
    entries.set(`${config.name}-upper.graphql`, makeUpperBoundQuery(config));
    entries.set(`${config.name}-page.graphql`, makePageQuery(config));
    const count = makeCountQuery(config);
    if (count) entries.set(`${config.name}-count.graphql`, count);
  }
  const artifacts = [];
  for (const [name, query] of entries) {
    const path = resolve(root, "queries", name);
    const contents = `${query.trim()}\n`;
    if (await exists(path)) {
      if ((await readFile(path, "utf8")) !== contents) {
        throw new Error(`Stored query ${name} differs from the current exporter.`);
      }
    } else {
      await writeTextAtomic(path, contents);
    }
    artifacts.push({ path: `queries/${name}`, ...(await sha256File(path)) });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function captureEntity({
  root,
  client,
  endpoint,
  schemaSha256,
  config,
  pageSize,
  now,
  onProgress,
}) {
  const statePath = resolve(root, "state", `${config.name}.json`);
  const pageQuery = makePageQuery(config);
  const querySha256 = sha256(pageQuery);
  let state = (await exists(statePath)) ? await readJson(statePath) : null;

  if (state) {
    assertState(state, { endpoint, schemaSha256, config, querySha256 });
    await verifyStateArtifacts(root, state);
    if (state.complete) return stateReport(state);
  } else {
    const upperResponse = await client.request({
      query: makeUpperBoundQuery(config),
      operationName: operationName(config.name, "UpperBound"),
    });
    const upperRows = rowsFrom(upperResponse, config.root);
    if (upperRows.length > 1) throw new Error(`${config.name}: upper-bound query returned >1 row.`);
    const upperBound = upperRows[0] ? cursorFromRow(config, upperRows[0]) : null;
    let expectedCount = upperBound ? null : 0;
    if (upperBound && config.aggregateRoot) {
      const countResponse = await client.request({
        query: makeCountQuery(config),
        variables: cursorVariables("upper", upperBound),
        operationName: operationName(config.name, "Count"),
      });
      expectedCount = countResponse.body.data[config.aggregateRoot]?.aggregate?.count;
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new Error(`${config.name}: aggregate count is not a safe non-negative integer.`);
      }
    }
    state = {
      version: SNAPSHOT_FORMAT_VERSION,
      entity: config.name,
      root: config.root,
      endpoint,
      schemaSha256,
      querySha256,
      upperBound,
      expectedCount,
      cursor: config.cursor.map((field) => field.initial),
      pageSize,
      pages: 0,
      rows: 0,
      rawArtifacts: [],
      complete: upperBound === null,
      startedAt: now(),
      finishedAt: upperBound === null ? now() : null,
    };
    await writeJsonAtomic(statePath, state);
  }

  while (!state.complete) {
    const variables = {
      limit: pageSize,
      ...cursorVariables("cursor", state.cursor),
      ...cursorVariables("upper", state.upperBound),
    };
    const response = await client.request({
      query: pageQuery,
      variables,
      operationName: operationName(config.name, "Page"),
    });
    const rows = rowsFrom(response, config.root);
    if (rows.length > pageSize) {
      throw new Error(`${config.name}: server exceeded requested page size ${pageSize}.`);
    }
    validatePage(config, rows, state.cursor, state.upperBound);
    validateNestedRelations(config, rows);

    if (rows.length === 0) {
      if (compareCursors(config, state.cursor, state.upperBound) !== 0) {
        const error = new Error(
          `${config.name}: pagination ended before the frozen upper bound; source rows changed during capture.`,
        );
        error.code = "UPPER_BOUND_UNREACHABLE";
        throw error;
      }
      state.complete = true;
      state.finishedAt = now();
      assertExpectedCount(state);
      await writeJsonAtomic(statePath, state);
      break;
    }

    const page = state.pages + 1;
    const path = resolve(root, "raw", config.name, `${String(page).padStart(6, "0")}.json.gz`);
    const artifact = await writeGzipJsonAtomic(path, {
      version: SNAPSHOT_FORMAT_VERSION,
      entity: config.name,
      page,
      fetchedAt: now(),
      querySha256,
      variables,
      status: response.status,
      headers: response.headers,
      response: response.body,
    });
    state.cursor = cursorFromRow(config, rows.at(-1));
    state.pages = page;
    state.rows += rows.length;
    state.rawArtifacts.push({
      path: snapshotPath(root, path),
      rows: rows.length,
      ...artifact,
    });
    if (compareCursors(config, state.cursor, state.upperBound) === 0) {
      state.complete = true;
      state.finishedAt = now();
      assertExpectedCount(state);
    }
    await writeJsonAtomic(statePath, state);
    onProgress({ entity: config.name, pages: state.pages, rows: state.rows });
  }
  return stateReport(state);
}

function rowsFrom(response, root) {
  const rows = response?.body?.data?.[root];
  if (!Array.isArray(rows)) throw new Error(`${root}: response root is not an array.`);
  return rows;
}

function validatePage(config, rows, cursor, upperBound) {
  let prior = cursor;
  for (const row of rows) {
    const next = cursorFromRow(config, row);
    if (compareCursors(config, next, prior) <= 0) {
      throw new Error(`${config.name}: page is not strictly ordered after its cursor.`);
    }
    if (compareCursors(config, next, upperBound) > 0) {
      throw new Error(`${config.name}: row exceeded the frozen upper bound.`);
    }
    prior = next;
  }
}

function validateNestedRelations(config, rows) {
  for (const nested of config.nestedSelections) {
    for (const row of rows) {
      const relations = row[nested.field];
      if (!Array.isArray(relations)) {
        throw new Error(`${config.name}.${nested.field}: nested relation is not an array.`);
      }
      if (relations.length >= nested.limit) {
        const error = new Error(
          `${config.name}.${nested.field}: row reached nested limit ${nested.limit}; refusing a potentially truncated snapshot.`,
        );
        error.code = "NESTED_RELATION_LIMIT";
        throw error;
      }
    }
  }
}

async function normalizeAll({ root }) {
  const artifacts = [];
  let momentDrops = null;
  for (const config of ENTITY_CONFIGS) {
    const state = await readJson(resolve(root, "state", `${config.name}.json`));
    if (!state.complete) throw new Error(`${config.name}: cannot normalize incomplete capture.`);
    const result = await normalizeEntity({ root, config, state });
    artifacts.push(result.entity);
    if (result.momentDrops) momentDrops = result.momentDrops;
  }
  if (!momentDrops) throw new Error("Moment/drop relation artifact was not generated.");
  artifacts.push(momentDrops);
  return {
    artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
    generatedAt: new Date().toISOString(),
  };
}

async function normalizeEntity({ root, config, state }) {
  const path = resolve(root, "normalized", `${config.name}.ndjson`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  const output = createWriteStream(temporary, { mode: 0o600 });
  let relationOutput = null;
  let relationTemporary = null;
  let relationPath = null;
  let relationRows = 0;
  const relationKeys = new Set();
  if (config.name === "moments") {
    relationPath = resolve(root, "normalized/moment_drops.ndjson");
    relationTemporary = `${relationPath}.tmp-${process.pid}-${Date.now()}`;
    relationOutput = createWriteStream(relationTemporary, { mode: 0o600 });
  }
  let rows = 0;
  for (const artifact of state.rawArtifacts) {
    const envelope = await readGzipJson(resolve(root, artifact.path));
    const pageRows = envelope?.response?.data?.[config.root];
    if (!Array.isArray(pageRows) || pageRows.length !== artifact.rows) {
      throw new Error(`${artifact.path}: raw row count does not match state.`);
    }
    for (const row of pageRows) {
      await writeLine(output, JSON.stringify(row));
      rows += 1;
      if (relationOutput) {
        for (const relation of row.drops) {
          if (String(relation.moment_id).toLowerCase() !== String(row.id).toLowerCase()) {
            throw new Error(`moments ${row.id}: nested drop relation points to another moment.`);
          }
          const key = `${String(relation.moment_id).toLowerCase()}\0${relation.drop_id}`;
          if (relationKeys.has(key)) throw new Error(`Duplicate moment/drop relation ${key}.`);
          relationKeys.add(key);
          await writeLine(
            relationOutput,
            JSON.stringify({
              moment_id: String(relation.moment_id).toLowerCase(),
              drop_id: relation.drop_id,
            }),
          );
          relationRows += 1;
        }
      }
    }
  }
  await endStream(output);
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
  if (rows !== state.rows)
    throw new Error(`${config.name}: normalized ${rows}, expected ${state.rows}.`);
  const result = {
    entity: { path: snapshotPath(root, path), rows, ...(await sha256File(path)) },
    momentDrops: null,
  };
  if (relationOutput) {
    await endStream(relationOutput);
    await import("node:fs/promises").then(({ rename }) => rename(relationTemporary, relationPath));
    result.momentDrops = {
      path: snapshotPath(root, relationPath),
      rows: relationRows,
      ...(await sha256File(relationPath)),
    };
  }
  return result;
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

async function endStream(stream) {
  stream.end();
  await once(stream, "finish");
}

function assertExpectedCount(state) {
  if (state.expectedCount !== null && state.rows !== state.expectedCount) {
    throw new Error(
      `${state.entity}: captured ${state.rows} rows, but frozen aggregate reported ${state.expectedCount}.`,
    );
  }
}

function assertState(state, { endpoint, schemaSha256, config, querySha256 }) {
  if (
    state.version !== SNAPSHOT_FORMAT_VERSION ||
    state.entity !== config.name ||
    state.root !== config.root ||
    state.endpoint !== endpoint ||
    state.schemaSha256 !== schemaSha256 ||
    state.querySha256 !== querySha256
  ) {
    throw new Error(`${config.name}: existing resume state does not match this capture.`);
  }
}

async function verifyStateArtifacts(root, state) {
  if (!Array.isArray(state.rawArtifacts) || state.rawArtifacts.length !== state.pages) {
    throw new Error(`${state.entity}: resume state has an invalid raw artifact list.`);
  }
  for (const artifact of state.rawArtifacts) {
    const metadata = await sha256File(resolve(root, artifact.path));
    if (metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.byteLength) {
      throw new Error(`${artifact.path}: resume artifact checksum mismatch.`);
    }
  }
}

function stateReport(state) {
  return {
    root: state.root,
    complete: state.complete,
    upperBound: state.upperBound,
    expectedCount: state.expectedCount,
    rows: state.rows,
    pages: state.pages,
    pageSize: state.pageSize,
    querySha256: state.querySha256,
    rawArtifacts: state.rawArtifacts,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

function validateConfiguredSchema(schema) {
  const types = new Map((schema?.types ?? []).map((type) => [type.name, type]));
  const queryRoot = types.get(schema?.queryType?.name ?? "query_root");
  if (!queryRoot) throw new Error("Introspection does not contain the query root type.");
  const rootFields = new Set((queryRoot.fields ?? []).map((field) => field.name));
  for (const config of ENTITY_CONFIGS) {
    if (!rootFields.has(config.root)) throw new Error(`Schema is missing root ${config.root}.`);
    if (config.aggregateRoot && !rootFields.has(config.aggregateRoot)) {
      throw new Error(`Schema is missing aggregate root ${config.aggregateRoot}.`);
    }
    const object = types.get(config.objectType);
    if (!object) throw new Error(`Schema is missing object type ${config.objectType}.`);
    const fields = new Set((object.fields ?? []).map((field) => field.name));
    for (const field of [
      ...config.scalarFields,
      ...config.nestedSelections.map((nested) => nested.field),
    ]) {
      if (!fields.has(field)) throw new Error(`Schema is missing ${config.objectType}.${field}.`);
    }
    for (const nested of config.nestedSelections) {
      const nestedType = types.get(nested.objectType);
      const nestedFields = new Set((nestedType?.fields ?? []).map((field) => field.name));
      for (const field of nested.scalarFields) {
        if (!nestedFields.has(field)) {
          throw new Error(`Schema is missing ${nested.objectType}.${field}.`);
        }
      }
    }
  }
}

function snapshotPath(root, path) {
  return relative(root, path).split("\\").join("/");
}
