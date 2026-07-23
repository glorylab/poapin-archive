import { ENTITY_CONFIGS } from "../lib/config.mjs";
import { compareCursors, cursorFromRow, operationName } from "../lib/graphql.mjs";

const UUID = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const T = "2026-07-23T00:00:00.000Z";

export function syntheticRows() {
  return {
    moments: [
      {
        author: "0x1111111111111111111111111111111111111111",
        cid: "bafy-moment-1",
        created_on: T,
        description: "First moment",
        display_id: "moment-one",
        drop_id: "101",
        id: UUID(1),
        token_id: "1001",
        updated: false,
        updated_on: null,
        drops: [{ drop_id: 101, moment_id: UUID(1) }],
      },
      {
        author: "0x2222222222222222222222222222222222222222",
        cid: null,
        created_on: "2026-07-23T00:01:00.000Z",
        description: null,
        display_id: "moment-two",
        drop_id: null,
        id: UUID(2),
        token_id: null,
        updated: true,
        updated_on: T,
        drops: [],
      },
    ],
    moment_media: [
      {
        created_at: T,
        hash: "source-hash",
        key: UUID(41),
        mime_type: "image/png",
        moment_id: UUID(1),
        status: "PROCESSED",
        status_reason: null,
        updated_at: T,
      },
      {
        created_at: T,
        hash: null,
        key: UUID(42),
        mime_type: "video/mp4",
        moment_id: null,
        status: "PROCESSED",
        status_reason: null,
        updated_at: T,
      },
    ],
    gateways: [
      {
        id: UUID(11),
        metadata: { size: 123 },
        moment_media_id: UUID(41),
        type: "image/png",
        url: `https://cdn.media.poap.tech/${UUID(41)}`,
      },
      {
        id: UUID(12),
        metadata: null,
        moment_media_id: UUID(42),
        type: "video/mp4",
        url: `https://cdn.media.poap.tech/${UUID(42)}`,
      },
    ],
    links: [
      {
        created_at: T,
        description: "Reference",
        id: UUID(21),
        image_url: null,
        moment_id: UUID(1),
        title: "A link",
        url: "https://example.invalid/link",
      },
    ],
    user_tags: [
      {
        address: "0x3333333333333333333333333333333333333333",
        created_by: "0x1111111111111111111111111111111111111111",
        created_on: T,
        ens: "friend.eth",
        id: UUID(31),
        moment_id: UUID(1),
        x: 10,
        y: 20,
      },
    ],
    capsules: [
      {
        created_on: T,
        description: "Capsule, not a Moment",
        id: "1",
        id_external: "capsule-one",
        image_url: null,
        owner: "0x1111111111111111111111111111111111111111",
        title: "Capsule one",
        url: "https://example.invalid/capsule",
      },
    ],
    capsule_moments: [
      {
        capsule_id: "1",
        created_at: T,
        created_by: "0x1111111111111111111111111111111111111111",
        moment_id: UUID(1),
      },
    ],
    moments_hidden_drops: [{ drop_id: "901", hidden_on: T }],
    moments_featured_drops: [{ created_at: T, drop_id: "902" }],
    drops_hidden_drops: [{ drop_id: "903", hidden_on: T }],
    drops_featured_drops: [{ drop_id: "904", featured_on: T }],
  };
}

export class MockGraphqlClient {
  constructor(rows = syntheticRows()) {
    this.rows = rows;
    this.requests = [];
  }

  async request(request) {
    this.requests.push(request);
    if (request.operationName === "POAPinMomentsIntrospection") {
      return response({ __schema: syntheticSchema() });
    }
    const match = ENTITY_CONFIGS.find((config) =>
      [
        operationName(config.name, "UpperBound"),
        operationName(config.name, "Count"),
        operationName(config.name, "Page"),
      ].includes(request.operationName),
    );
    if (!match) throw new Error(`Unexpected operation ${request.operationName}.`);
    const values = this.rows[match.name] ?? [];
    if (request.operationName.endsWith("UpperBound")) {
      return response({
        [match.root]: values.length ? [cursorObject(match, values.at(-1))] : [],
      });
    }
    if (request.operationName.endsWith("Count")) {
      return response({ [match.aggregateRoot]: { aggregate: { count: values.length } } });
    }
    const current = match.cursor.map((_, index) => request.variables[`cursor${index}`]);
    const upper = match.cursor.map((_, index) => request.variables[`upper${index}`]);
    const page = values
      .filter((row) => {
        const cursor = cursorFromRow(match, row);
        return (
          compareCursors(match, cursor, current) > 0 && compareCursors(match, cursor, upper) <= 0
        );
      })
      .slice(0, request.variables.limit);
    return response({ [match.root]: structuredClone(page) });
  }
}

function response(data) {
  return { body: { data }, status: 200, headers: { "content-type": "application/json" } };
}

function cursorObject(config, row) {
  return Object.fromEntries(config.cursor.map((field) => [field.name, row[field.name]]));
}

function syntheticSchema() {
  const queryFields = new Map();
  const objectTypes = new Map();
  for (const config of ENTITY_CONFIGS) {
    queryFields.set(config.root, { name: config.root });
    if (config.aggregateRoot) queryFields.set(config.aggregateRoot, { name: config.aggregateRoot });
    objectTypes.set(config.objectType, {
      kind: "OBJECT",
      name: config.objectType,
      fields: [
        ...new Set([
          ...config.scalarFields,
          ...config.cursor.map((field) => field.name),
          ...config.nestedSelections.map((nested) => nested.field),
        ]),
      ].map((name) => ({ name })),
    });
    for (const nested of config.nestedSelections) {
      objectTypes.set(nested.objectType, {
        kind: "OBJECT",
        name: nested.objectType,
        fields: nested.scalarFields.map((name) => ({ name })),
      });
    }
  }
  return {
    queryType: { name: "query_root" },
    mutationType: null,
    subscriptionType: null,
    types: [
      { kind: "OBJECT", name: "query_root", fields: [...queryFields.values()] },
      ...objectTypes.values(),
    ],
  };
}

export { UUID };
