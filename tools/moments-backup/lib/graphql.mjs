import { setTimeout as delay } from "node:timers/promises";

const USER_AGENT = "POAPin-Archive-Moments-Backup/0.1 (+https://poap.in)";

export class GraphqlError extends Error {
  constructor(message, { code = "GRAPHQL_ERROR", status = null, details = null } = {}) {
    super(message);
    this.name = "GraphqlError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class GraphqlClient {
  constructor({ endpoint, delayMs = 250, retries = 5, timeoutMs = 30_000, onRequest = () => {} }) {
    this.endpoint = endpoint;
    this.delayMs = delayMs;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.onRequest = onRequest;
    this.lastRequestAt = 0;
  }

  async request({ query, variables = {}, operationName = null }) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        await this.#throttle();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
          this.onRequest({ operationName, attempt });
          response = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "user-agent": USER_AGENT,
            },
            body: JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new GraphqlError("Compass returned a non-JSON response.", {
            code: "INVALID_JSON",
            status: response.status,
            details: text.slice(0, 500),
          });
        }
        if (!response.ok || body.errors?.length) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new GraphqlError(
            body.errors?.map((entry) => entry.message).join("; ") ||
              `Compass returned HTTP ${response.status}.`,
            {
              code: retryable ? "RETRYABLE_RESPONSE" : "QUERY_REJECTED",
              status: response.status,
              details: body.errors ?? body,
            },
          );
          if (!retryable) throw error;
          throw error;
        }
        if (!body.data || typeof body.data !== "object") {
          throw new GraphqlError("Compass response did not contain data.", {
            code: "MISSING_DATA",
            status: response.status,
          });
        }
        return {
          body,
          status: response.status,
          headers: Object.fromEntries(
            ["cache-control", "content-type", "date", "etag", "last-modified", "x-request-id"]
              .map((name) => [name, response.headers.get(name)])
              .filter(([, value]) => value !== null),
          ),
        };
      } catch (error) {
        lastError = normalizeError(error);
        if (attempt >= this.retries || !isRetryable(lastError)) throw lastError;
        await delay(Math.min(30_000, 750 * 2 ** attempt + Math.floor(Math.random() * 250)));
      }
    }
    throw lastError;
  }

  async #throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.delayMs) await delay(this.delayMs - elapsed);
    this.lastRequestAt = Date.now();
  }
}

function normalizeError(error) {
  if (error instanceof GraphqlError) return error;
  if (error?.name === "AbortError") {
    return new GraphqlError("Compass request timed out.", { code: "REQUEST_TIMEOUT" });
  }
  return new GraphqlError(error?.message || "Compass request failed.", { code: "NETWORK_ERROR" });
}

function isRetryable(error) {
  return ["NETWORK_ERROR", "REQUEST_TIMEOUT", "RETRYABLE_RESPONSE"].includes(error?.code);
}

export const INTROSPECTION_QUERY = `
query POAPinMomentsIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        args(includeDeprecated: true) { name type { ...TypeRef } }
        type { ...TypeRef }
        isDeprecated
        deprecationReason
      }
      inputFields(includeDeprecated: true) { name type { ...TypeRef } defaultValue }
      enumValues(includeDeprecated: true) { name isDeprecated deprecationReason }
      possibleTypes { ...TypeRef }
    }
  }
}
fragment TypeRef on __Type {
  kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
}
`;

export function makeUpperBoundQuery(config) {
  return `
query ${operationName(config.name, "UpperBound")} {
  ${config.root}(limit: 1, order_by: ${orderBy(config.cursor, "desc")}) {
    ${config.cursor.map((field) => field.name).join("\n    ")}
  }
}`;
}

export function makeCountQuery(config) {
  if (!config.aggregateRoot) return null;
  return `
query ${operationName(config.name, "Count")}(${variablesFor(config.cursor, "upper").join(", ")}) {
  ${config.aggregateRoot}(where: ${upperWhere(config.cursor)}) { aggregate { count } }
}`;
}

export function makePageQuery(config) {
  const variables = [
    "$limit: Int!",
    ...variablesFor(config.cursor, "cursor"),
    ...variablesFor(config.cursor, "upper"),
  ];
  const selections = [
    ...config.scalarFields,
    ...config.nestedSelections.map((item) => item.selection),
  ];
  return `
query ${operationName(config.name, "Page")}(${variables.join(", ")}) {
  ${config.root}(
    limit: $limit
    order_by: ${orderBy(config.cursor, "asc")}
    where: { _and: [${lowerWhere(config.cursor)}, ${upperWhere(config.cursor)}] }
  ) {
    ${selections.join("\n    ")}
  }
}`;
}

export function operationName(name, suffix) {
  return `${name
    .split(/[^A-Za-z0-9]+/)
    .map(capitalize)
    .join("")}${suffix}`;
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

function variablesFor(cursor, prefix) {
  return cursor.map((field, index) => `$${prefix}${index}: ${field.type}!`);
}

function orderBy(cursor, direction) {
  if (cursor.length === 1) return `{ ${cursor[0].name}: ${direction} }`;
  return `[${cursor.map((field) => `{ ${field.name}: ${direction} }`).join(", ")}]`;
}

function lowerWhere(cursor) {
  return tupleComparison(cursor, "cursor", "_gt", "_gt");
}

function upperWhere(cursor) {
  return tupleComparison(cursor, "upper", "_lt", "_lte");
}

function tupleComparison(cursor, prefix, precedingOperator, finalOperator) {
  if (cursor.length === 1) {
    return `{ ${cursor[0].name}: { ${finalOperator}: $${prefix}0 } }`;
  }
  const alternatives = cursor.map((field, index) => {
    const equals = cursor
      .slice(0, index)
      .map((prior, priorIndex) => `${prior.name}: { _eq: $${prefix}${priorIndex} }`);
    const operator = index === cursor.length - 1 ? finalOperator : precedingOperator;
    return `{ ${[...equals, `${field.name}: { ${operator}: $${prefix}${index} }`].join(", ")} }`;
  });
  return `{ _or: [${alternatives.join(", ")}] }`;
}

export function cursorFromRow(config, row) {
  return config.cursor.map((field) => {
    const value = row?.[field.name];
    if (value === null || value === undefined) {
      throw new Error(`${config.name}: cursor field ${field.name} is null or missing.`);
    }
    return value;
  });
}

export function cursorVariables(prefix, cursor) {
  return Object.fromEntries(cursor.map((value, index) => [`${prefix}${index}`, value]));
}

export function compareCursors(config, left, right) {
  for (let index = 0; index < config.cursor.length; index += 1) {
    const type = config.cursor[index].type;
    const comparison = compareScalar(type, left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareScalar(type, left, right) {
  if (["bigint", "Int"].includes(type)) {
    const a = BigInt(String(left));
    const b = BigInt(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return String(left).localeCompare(String(right));
}
