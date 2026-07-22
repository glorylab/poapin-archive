import { setTimeout as delay } from "node:timers/promises";

const USER_AGENT = "POAPin-Archive-Collections-Backup/0.1 (+https://poap.in)";

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

        const bodyText = await response.text();
        let body;
        try {
          body = JSON.parse(bodyText);
        } catch {
          throw new GraphqlError("Compass returned a non-JSON response.", {
            code: "INVALID_JSON",
            status: response.status,
            details: bodyText.slice(0, 500),
          });
        }

        if (!response.ok || (Array.isArray(body.errors) && body.errors.length > 0)) {
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
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          throw Object.assign(error, { retryAfter });
        }
        if (!body.data || typeof body.data !== "object") {
          throw new GraphqlError("Compass response did not contain a data object.", {
            code: "MISSING_DATA",
            status: response.status,
            details: body,
          });
        }
        return {
          body,
          bodyText,
          status: response.status,
          headers: Object.fromEntries(
            ["cache-control", "content-type", "date", "etag", "last-modified", "x-request-id"]
              .map((name) => [name, response.headers.get(name)])
              .filter(([, value]) => value !== null),
          ),
        };
      } catch (error) {
        lastError = normalizeFetchError(error);
        if (attempt >= this.retries || !isRetryable(lastError)) throw lastError;
        const waitMs =
          lastError.retryAfter ??
          Math.min(30_000, 750 * 2 ** attempt + Math.floor(Math.random() * 250));
        await delay(waitMs);
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

function normalizeFetchError(error) {
  if (error instanceof GraphqlError) return error;
  if (error?.name === "AbortError") {
    return new GraphqlError("Compass request timed out.", { code: "REQUEST_TIMEOUT" });
  }
  return new GraphqlError(error?.message || "Compass request failed.", {
    code: "NETWORK_ERROR",
  });
}

function isRetryable(error) {
  return ["NETWORK_ERROR", "REQUEST_TIMEOUT", "RETRYABLE_RESPONSE"].includes(error?.code);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export const INTROSPECTION_QUERY = `
query POAPinCollectionsIntrospection {
  __schema {
    description
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      ...FullType
    }
    directives {
      name
      description
      isRepeatable
      locations
      args(includeDeprecated: true) {
        ...InputValue
      }
    }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  specifiedByURL
  fields(includeDeprecated: true) {
    name
    description
    args(includeDeprecated: true) { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields(includeDeprecated: true) { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes { ...TypeRef }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
  isDeprecated
  deprecationReason
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }
    }
  }
}
`;

export function makeUpperBoundQuery(config) {
  return `
    query ${operationName(config.name, "UpperBound")} {
      ${config.root}(limit: 1, order_by: ${orderBy(config.cursor, "desc")}) {
        ${config.cursor.map((field) => field.name).join("\n        ")}
      }
    }
  `;
}

export function makePageQuery(config) {
  const variables = [
    "$limit: Int!",
    ...variablesFor(config.cursor, "cursor"),
    ...variablesFor(config.cursor, "upper"),
  ];
  const selections = [
    ...config.scalarFields,
    ...config.nestedSelections.map((entry) => entry.selection),
  ].join("\n        ");
  return `
    query ${operationName(config.name, "Page")}(${variables.join(", ")}) {
      ${config.root}(
        limit: $limit
        order_by: ${orderBy(config.cursor, "asc")}
        where: ${boundedWhere(config.cursor)}
      ) {
        ${selections}
      }
    }
  `;
}

export function makeCountQuery(config) {
  if (!config.aggregateRoot) return null;
  const variables = variablesFor(config.cursor, "upper");
  return `
    query ${operationName(config.name, "Count")}(${variables.join(", ")}) {
      ${config.aggregateRoot}(where: ${upperWhere(config.cursor)}) {
        aggregate { count }
      }
    }
  `;
}

function variablesFor(cursor, prefix) {
  return cursor.map((field, index) => `$${prefix}${index}: ${field.type}!`);
}

function orderBy(cursor, direction) {
  if (cursor.length === 1) return `{ ${cursor[0].name}: ${direction} }`;
  return `[${cursor.map((field) => `{ ${field.name}: ${direction} }`).join(", ")}]`;
}

function boundedWhere(cursor) {
  return `{ _and: [${lowerWhere(cursor)}, ${upperWhere(cursor)}] }`;
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

function operationName(name, suffix) {
  return `${name
    .split("_")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")}${suffix}`;
}
