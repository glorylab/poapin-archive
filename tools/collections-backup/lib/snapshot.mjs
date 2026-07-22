import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { once } from "node:events";

import {
  DEFAULT_PAGE_SIZE,
  DROP_IMAGE_GATEWAY_SCALAR_FIELDS,
  DROP_IMAGE_SCALAR_FIELDS,
  DROP_SCALAR_FIELDS,
  DROP_SELECTION,
  ENTITY_CONFIGS,
  HIDDEN_DROP_SCALAR_FIELDS,
} from "./config.mjs";
import {
  GraphqlClient,
  INTROSPECTION_QUERY,
  makeCountQuery,
  makePageQuery,
  makeUpperBoundQuery,
} from "./graphql.mjs";
import {
  exists,
  fileMetadata,
  readGzipJson,
  readJson,
  sha256,
  sha256File,
  writeGzipJsonAtomic,
  writeJsonAtomic,
} from "./files.mjs";

const SNAPSHOT_FORMAT_VERSION = 1;
const REFERENCED_DROPS_PAGE_SIZE = 100;

export async function captureCollectionsSnapshot({
  output,
  endpoint,
  delayMs = 250,
  pageSize = DEFAULT_PAGE_SIZE,
  resume = false,
  onProgress = () => {},
}) {
  const root = resolve(output);
  await prepareOutput(root, { endpoint, resume });
  const source = await readJson(resolve(root, "source.json"));
  const client = new GraphqlClient({ endpoint, delayMs, onRequest: onProgress });
  const startedAt = source.initializedAt;

  const schema = await captureSchema({ root, client, endpoint });
  validateConfiguredSelections(schema.body.data.__schema);
  await writeQueries(root);

  const entityReports = [];
  for (const config of ENTITY_CONFIGS) {
    const report = await captureEntity({
      root,
      client,
      config,
      pageSize,
      schema,
      endpoint,
      onProgress,
    });
    entityReports.push(report);
  }

  const normalized = await normalizeEntities(root);
  const referencedDrops = await captureReferencedDrops({
    root,
    client,
    endpoint,
    schema,
    dropIds: normalized.referencedDropIds,
    onProgress,
  });
  const dropArtifact = await normalizeReferencedDrops(root);

  const finishedAt = new Date().toISOString();
  const manifest = {
    version: SNAPSHOT_FORMAT_VERSION,
    dataset: "poap-compass-collections",
    endpoint,
    startedAt,
    finishedAt,
    schema: {
      sha256: schema.sha256,
      bytes: schema.byteLength,
      querySha256: sha256(INTROSPECTION_QUERY),
    },
    pagination: {
      method: "bounded-keyset",
      pageSize,
      referencedDropsPageSize: REFERENCED_DROPS_PAGE_SIZE,
    },
    entities: Object.fromEntries(entityReports.map((report) => [report.name, report])),
    referencedDrops,
    normalized: {
      artifacts: [...normalized.artifacts, dropArtifact],
      referencedDropIds: normalized.referencedDropIds.length,
      referencedDropIdsSha256: sha256(`${normalized.referencedDropIds.join("\n")}\n`),
    },
    knownGaps: [
      {
        code: "NO_TRANSACTIONAL_SNAPSHOT",
        detail:
          "The anonymous GraphQL API does not expose a transactionally consistent multi-query snapshot.",
      },
      {
        code: "UNREACHABLE_COLLECTION_TYPES",
        detail:
          "Introspection includes attributes/items_attributes types, but anonymous query_root exposes no root or reachable collection relation for them.",
      },
      {
        code: "NO_DELETION_FEED",
        detail: "The anonymous API does not expose deletion tombstones or a change stream.",
      },
    ],
    media: {
      captured: false,
      note: "Run the media command after structural verification; media status is tracked separately.",
    },
  };
  await writeJsonAtomic(resolve(root, "manifest.json"), manifest);
  return manifest;
}

async function prepareOutput(root, { endpoint, resume }) {
  const markerPath = resolve(root, "source.json");
  if (await exists(markerPath)) {
    const marker = await readJson(markerPath);
    if (!resume) {
      throw new Error(`Snapshot output already exists at ${root}; pass --resume to continue it.`);
    }
    if (marker.version !== SNAPSHOT_FORMAT_VERSION || marker.endpoint !== endpoint) {
      throw new Error(
        "Existing snapshot source marker does not match this endpoint or format version.",
      );
    }
    return;
  }
  if (await exists(root)) {
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw new Error(`Refusing to initialize non-empty output directory ${root}.`);
    }
  }
  await mkdir(root, { recursive: true });
  await writeJsonAtomic(markerPath, {
    version: SNAPSHOT_FORMAT_VERSION,
    dataset: "poap-compass-collections",
    endpoint,
    initializedAt: new Date().toISOString(),
  });
}

async function captureSchema({ root, client, endpoint }) {
  const schemaPath = resolve(root, "schema/introspection.json");
  const metadataPath = resolve(root, "schema/response.json");
  if (await exists(schemaPath)) {
    const body = await readJson(schemaPath);
    const metadata = await sha256File(schemaPath);
    return { body, ...metadata };
  }
  const response = await client.request({
    query: INTROSPECTION_QUERY,
    operationName: "POAPinCollectionsIntrospection",
  });
  await writeJsonAtomic(schemaPath, response.body);
  await writeJsonAtomic(metadataPath, {
    endpoint,
    fetchedAt: new Date().toISOString(),
    status: response.status,
    headers: response.headers,
  });
  const metadata = await sha256File(schemaPath);
  return { body: response.body, ...metadata };
}

async function writeQueries(root) {
  const directory = resolve(root, "queries");
  await mkdir(directory, { recursive: true });
  const queries = new Map([["introspection.graphql", INTROSPECTION_QUERY]]);
  for (const config of ENTITY_CONFIGS) {
    queries.set(`${config.name}-upper.graphql`, makeUpperBoundQuery(config));
    queries.set(`${config.name}-page.graphql`, makePageQuery(config));
    const count = makeCountQuery(config);
    if (count) queries.set(`${config.name}-count.graphql`, count);
  }
  queries.set("referenced-drops.graphql", referencedDropsQuery());
  for (const [name, query] of queries) {
    const path = resolve(directory, name);
    const contents = `${query.trim()}\n`;
    if (await exists(path)) {
      if ((await readFile(path, "utf8")) !== contents) {
        throw new Error(`Stored query ${name} does not match the current exporter.`);
      }
    } else {
      await writeFile(path, contents, { mode: 0o600 });
    }
  }
}

async function captureEntity({ root, client, config, pageSize, schema, endpoint, onProgress }) {
  const statePath = resolve(root, `state/${config.name}.json`);
  const query = makePageQuery(config);
  const querySha256 = sha256(query);
  let state = (await exists(statePath)) ? await readJson(statePath) : null;

  if (state) {
    assertStateContext(state, { config, endpoint, schemaSha256: schema.sha256, querySha256 });
    if (state.complete) return stateReport(state);
    await verifyLastCommittedPage(root, state);
  } else {
    const upperResponse = await client.request({
      query: makeUpperBoundQuery(config),
      operationName: operationName(config.name, "UpperBound"),
    });
    const upperRows = upperResponse.body.data[config.root];
    assertRows(upperRows, config.root);
    const upper = upperRows[0] ? cursorFromRow(config, upperRows[0]) : null;
    let expectedCount = 0;
    if (upper && config.aggregateRoot) {
      const countResponse = await client.request({
        query: makeCountQuery(config),
        variables: variablesFromCursor("upper", upper),
        operationName: operationName(config.name, "Count"),
      });
      expectedCount = countResponse.body.data[config.aggregateRoot]?.aggregate?.count;
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new Error(`${config.name}: aggregate count was not a safe non-negative integer.`);
      }
    } else if (!upper) {
      expectedCount = 0;
    } else {
      expectedCount = null;
    }
    state = {
      version: SNAPSHOT_FORMAT_VERSION,
      entity: config.name,
      root: config.root,
      endpoint,
      schemaSha256: schema.sha256,
      querySha256,
      upper,
      expectedCount,
      cursor: config.cursor.map((field) => field.initial),
      pages: 0,
      rows: 0,
      complete: upper === null,
      lastPage: null,
      startedAt: new Date().toISOString(),
      finishedAt: upper === null ? new Date().toISOString() : null,
    };
    await writeJsonAtomic(statePath, state);
  }

  while (!state.complete) {
    const variables = {
      limit: pageSize,
      ...variablesFromCursor("cursor", state.cursor),
      ...variablesFromCursor("upper", state.upper),
    };
    const response = await client.request({
      query,
      variables,
      operationName: operationName(config.name, "Page"),
    });
    const rows = response.body.data[config.root];
    assertRows(rows, config.root);
    if (rows.length > pageSize) {
      throw new Error(
        `${config.name}: Compass returned ${rows.length} rows for a ${pageSize}-row page.`,
      );
    }
    validatePage(config, rows, state.cursor, state.upper);

    if (rows.length === 0) {
      state.complete = true;
      state.finishedAt = new Date().toISOString();
      assertExpectedCount(state);
      await writeJsonAtomic(statePath, state);
      break;
    }

    const nextCursor = cursorFromRow(config, rows.at(-1));
    const pageNumber = state.pages + 1;
    const pagePath = resolve(
      root,
      `raw/${config.name}/${String(pageNumber).padStart(6, "0")}.json.gz`,
    );
    const pageArtifact = await writeGzipJsonAtomic(pagePath, {
      version: SNAPSHOT_FORMAT_VERSION,
      entity: config.name,
      page: pageNumber,
      fetchedAt: new Date().toISOString(),
      querySha256,
      variables,
      status: response.status,
      headers: response.headers,
      response: response.body,
    });
    state.cursor = nextCursor;
    state.pages = pageNumber;
    state.rows += rows.length;
    state.lastPage = {
      path: relativeSnapshotPath(root, pagePath),
      ...pageArtifact,
      rows: rows.length,
    };
    if (cursorEquals(nextCursor, state.upper)) {
      state.complete = true;
      state.finishedAt = new Date().toISOString();
      assertExpectedCount(state);
    }
    await writeJsonAtomic(statePath, state);
    onProgress({ entity: config.name, pages: state.pages, rows: state.rows });
  }
  return stateReport(state);
}

async function verifyLastCommittedPage(root, state) {
  if (!state.lastPage) return;
  const path = resolve(root, state.lastPage.path);
  if (!(await exists(path)))
    throw new Error(`${state.entity}: committed page is missing: ${state.lastPage.path}`);
  const metadata = await sha256File(path);
  if (
    metadata.sha256 !== state.lastPage.sha256 ||
    metadata.byteLength !== state.lastPage.byteLength
  ) {
    throw new Error(`${state.entity}: committed page checksum does not match state.`);
  }
}

function validatePage(config, rows, previousCursor, upper) {
  let prior = previousCursor;
  const seen = new Set();
  for (const row of rows) {
    if (config.name === "collections" && row.urls?.length >= 100) {
      throw new Error(
        `collections: collection ${row.id} returned 100 nested URLs and may be silently truncated.`,
      );
    }
    const cursor = cursorFromRow(config, row);
    if (compareCursor(config, cursor, prior) <= 0) {
      throw new Error(`${config.name}: page cursor was not strictly increasing.`);
    }
    if (compareCursor(config, cursor, upper) > 0) {
      throw new Error(`${config.name}: page crossed its frozen upper bound.`);
    }
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error(`${config.name}: duplicate cursor appeared in one page.`);
    seen.add(key);
    prior = cursor;
  }
}

function cursorFromRow(config, row) {
  return config.cursor.map((field) => {
    const value = row[field.name];
    if (value === null || value === undefined || value === "") {
      throw new Error(`${config.name}: cursor field ${field.name} was empty.`);
    }
    return String(value);
  });
}

function compareCursor(config, left, right) {
  for (let index = 0; index < config.cursor.length; index += 1) {
    const type = config.cursor[index].type;
    const comparison =
      type === "bigint"
        ? compareBigIntStrings(left[index], right[index])
        : String(left[index]).localeCompare(String(right[index]));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareBigIntStrings(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function variablesFromCursor(prefix, values) {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]));
}

function assertExpectedCount(state) {
  if (state.expectedCount !== null && state.rows !== state.expectedCount) {
    throw new Error(
      `${state.entity}: captured ${state.rows} rows, expected ${state.expectedCount}; snapshot remains incomplete.`,
    );
  }
}

function assertStateContext(state, { config, endpoint, schemaSha256, querySha256 }) {
  const expected = {
    version: SNAPSHOT_FORMAT_VERSION,
    entity: config.name,
    root: config.root,
    endpoint,
    schemaSha256,
    querySha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value)
      throw new Error(`${config.name}: resume state ${key} does not match.`);
  }
}

function stateReport(state) {
  return {
    name: state.entity,
    root: state.root,
    rows: state.rows,
    pages: state.pages,
    expectedCount: state.expectedCount,
    upper: state.upper,
    querySha256: state.querySha256,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    complete: state.complete,
  };
}

async function normalizeEntities(root) {
  const artifacts = [];
  const referencedDropIds = new Set();
  const urls = [];
  for (const config of ENTITY_CONFIGS) {
    const rows = await readEntityRows(root, config);
    const outputRows = [];
    for (const row of rows) {
      if (config.name === "collections") {
        const { urls: collectionUrls = [], ...collection } = row;
        outputRows.push(collection);
        urls.push(...collectionUrls);
      } else {
        outputRows.push(row);
      }
      collectDropIds(config.name, row, referencedDropIds);
    }
    artifacts.push(
      await writeNdjsonAtomic(resolve(root, `normalized/${config.name}.ndjson`), outputRows, root),
    );
  }
  urls.sort((left, right) => numericCompare(left.id, right.id));
  artifacts.push(
    await writeNdjsonAtomic(resolve(root, "normalized/collection_urls.ndjson"), urls, root),
  );
  const sortedDropIds = [...referencedDropIds].sort((left, right) => left - right);
  const dropIdsPath = resolve(root, "normalized/referenced_drop_ids.txt");
  await writeFile(dropIdsPath, `${sortedDropIds.join("\n")}\n`, { mode: 0o600 });
  artifacts.push({ ...(await fileMetadata(root, dropIdsPath)), rows: sortedDropIds.length });
  return { artifacts, referencedDropIds: sortedDropIds };
}

async function readEntityRows(root, config) {
  const directory = resolve(root, `raw/${config.name}`);
  if (!(await exists(directory))) return [];
  const names = (await readdir(directory)).filter((name) => /^\d{6}\.json\.gz$/.test(name)).sort();
  const rows = [];
  for (const name of names) {
    const page = await readGzipJson(resolve(directory, name));
    const pageRows = page.response?.data?.[config.root];
    assertRows(pageRows, `${config.root} in ${name}`);
    rows.push(...pageRows);
  }
  return rows;
}

function collectDropIds(entity, row, target) {
  if (["items", "artist_drops", "suggested_drops"].includes(entity)) {
    const id = Number(row.drop_id);
    if (Number.isSafeInteger(id) && id > 0) target.add(id);
  }
  if (entity === "collection_drop_ids" && Array.isArray(row.drop_ids)) {
    for (const value of row.drop_ids) {
      const id = Number(value);
      if (Number.isSafeInteger(id) && id > 0) target.add(id);
    }
  }
}

async function captureReferencedDrops({ root, client, endpoint, schema, dropIds, onProgress }) {
  const statePath = resolve(root, "state/referenced_drops.json");
  const query = referencedDropsQuery();
  const querySha256 = sha256(query);
  const idsSha256 = sha256(`${dropIds.join("\n")}\n`);
  let state = (await exists(statePath)) ? await readJson(statePath) : null;
  if (state) {
    const expected = { endpoint, schemaSha256: schema.sha256, querySha256, idsSha256 };
    for (const [key, value] of Object.entries(expected)) {
      if (state[key] !== value)
        throw new Error(`referenced_drops: resume state ${key} does not match.`);
    }
    await verifyLastCommittedPage(root, state);
  } else {
    state = {
      version: SNAPSHOT_FORMAT_VERSION,
      entity: "referenced_drops",
      root: "drops",
      endpoint,
      schemaSha256: schema.sha256,
      querySha256,
      idsSha256,
      requested: dropIds.length,
      cursor: 0,
      pages: 0,
      rows: 0,
      missing: [],
      complete: dropIds.length === 0,
      lastPage: null,
      startedAt: new Date().toISOString(),
      finishedAt: dropIds.length === 0 ? new Date().toISOString() : null,
    };
    await writeJsonAtomic(statePath, state);
  }

  while (!state.complete) {
    const ids = dropIds.slice(state.cursor, state.cursor + REFERENCED_DROPS_PAGE_SIZE);
    const response = await client.request({
      query,
      variables: { dropIds: ids },
      operationName: "ReferencedDropsPage",
    });
    const rows = response.body.data.drops;
    assertRows(rows, "drops");
    const returned = new Set(rows.map((row) => Number(row.id)));
    const missing = ids.filter((id) => !returned.has(id));
    const pageNumber = state.pages + 1;
    const pagePath = resolve(
      root,
      `raw/referenced_drops/${String(pageNumber).padStart(6, "0")}.json.gz`,
    );
    const pageArtifact = await writeGzipJsonAtomic(pagePath, {
      version: SNAPSHOT_FORMAT_VERSION,
      entity: "referenced_drops",
      page: pageNumber,
      fetchedAt: new Date().toISOString(),
      querySha256,
      variables: { dropIds: ids },
      status: response.status,
      headers: response.headers,
      response: response.body,
      missing,
    });
    state.cursor += ids.length;
    state.pages = pageNumber;
    state.rows += rows.length;
    state.missing.push(...missing);
    state.lastPage = {
      path: relativeSnapshotPath(root, pagePath),
      ...pageArtifact,
      rows: rows.length,
    };
    if (state.cursor >= dropIds.length) {
      state.complete = true;
      state.finishedAt = new Date().toISOString();
    }
    await writeJsonAtomic(statePath, state);
    onProgress({ entity: "referenced_drops", pages: state.pages, rows: state.rows });
  }
  return {
    requested: state.requested,
    captured: state.rows,
    missing: state.missing,
    pages: state.pages,
    querySha256,
    idsSha256,
    complete: state.complete,
  };
}

async function normalizeReferencedDrops(root) {
  const directory = resolve(root, "raw/referenced_drops");
  const rows = [];
  if (await exists(directory)) {
    const names = (await readdir(directory))
      .filter((name) => /^\d{6}\.json\.gz$/.test(name))
      .sort();
    for (const name of names) {
      const page = await readGzipJson(resolve(directory, name));
      assertRows(page.response?.data?.drops, `drops in ${name}`);
      rows.push(...page.response.data.drops);
    }
  }
  rows.sort((left, right) => numericCompare(left.id, right.id));
  return writeNdjsonAtomic(resolve(root, "normalized/referenced_drops.ndjson"), rows, root);
}

function referencedDropsQuery() {
  return `
    query ReferencedDropsPage($dropIds: [Int!]!) {
      drops(where: { id: { _in: $dropIds } }, order_by: { id: asc }, limit: 100) {
        ${DROP_SELECTION}
      }
    }
  `;
}

async function writeNdjsonAtomic(filePath, rows, root) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  try {
    for (const row of rows) {
      if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "close");
    if (await exists(filePath)) await rm(filePath);
    await rename(temporary, filePath);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return { ...(await fileMetadata(root, filePath)), rows: rows.length };
}

function validateConfiguredSelections(schema) {
  const types = new Map(schema.types.map((type) => [type.name, type]));
  for (const config of ENTITY_CONFIGS) {
    assertAllScalarFields(types, config.objectType, config.scalarFields);
    for (const nested of config.nestedSelections) {
      assertAllScalarFields(types, nested.objectType, nested.scalarFields);
    }
  }
  assertAllScalarFields(types, "drops", DROP_SCALAR_FIELDS);
  assertAllScalarFields(types, "drop_images", DROP_IMAGE_SCALAR_FIELDS);
  assertAllScalarFields(types, "drop_image_gateways", DROP_IMAGE_GATEWAY_SCALAR_FIELDS);
  assertAllScalarFields(types, "drops_hidden_drops", HIDDEN_DROP_SCALAR_FIELDS);
}

function assertAllScalarFields(types, typeName, configured) {
  const type = types.get(typeName);
  if (!type || !Array.isArray(type.fields))
    throw new Error(`Introspection is missing object type ${typeName}.`);
  const actual = type.fields
    .filter((field) => ["SCALAR", "ENUM"].includes(unwrapType(field.type)?.kind))
    .map((field) => field.name)
    .sort();
  const expected = [...configured].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = actual.filter((field) => !expected.includes(field));
    const unknown = expected.filter((field) => !actual.includes(field));
    throw new Error(
      `${typeName}: scalar selection is not exhaustive (unselected: ${missing.join(", ") || "none"}; missing upstream: ${unknown.join(", ") || "none"}).`,
    );
  }
}

function unwrapType(type) {
  let current = type;
  while (current?.ofType) current = current.ofType;
  return current;
}

function assertRows(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}: GraphQL response was not an array.`);
}

function operationName(name, suffix) {
  return `${name
    .split("_")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")}${suffix}`;
}

function cursorEquals(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function relativeSnapshotPath(root, filePath) {
  return filePath.slice(`${resolve(root)}/`.length);
}

function numericCompare(left, right) {
  return Number(left) - Number(right);
}
