export const DEFAULT_ENDPOINT = "https://public.compass.poap.tech/v1/graphql";
export const DEFAULT_PAGE_SIZE = 100;
export const HARD_PAGE_LIMIT = 100;
export const SNAPSHOT_FORMAT_VERSION = 1;

const bigint = (name) => ({ name, type: "bigint", initial: "0" });
const integer = (name) => ({ name, type: "Int", initial: 0 });
const uuid = (name) => ({
  name,
  type: "uuid",
  initial: "00000000-0000-0000-0000-000000000000",
});
const string = (name) => ({ name, type: "String", initial: "" });

export const ENTITY_CONFIGS = Object.freeze([
  {
    name: "moments",
    root: "moments",
    aggregateRoot: "moments_aggregate",
    objectType: "moments",
    cursor: [uuid("id")],
    scalarFields: [
      "author",
      "cid",
      "created_on",
      "description",
      "display_id",
      "drop_id",
      "id",
      "token_id",
      "updated",
      "updated_on",
    ],
    nestedSelections: [
      {
        field: "drops",
        objectType: "moments_moment_drops",
        limit: HARD_PAGE_LIMIT,
        scalarFields: ["drop_id", "moment_id"],
        selection: `drops(limit: ${HARD_PAGE_LIMIT}, order_by: [{ drop_id: asc }, { moment_id: asc }]) { drop_id moment_id }`,
      },
    ],
  },
  {
    name: "moment_media",
    root: "moment_media",
    aggregateRoot: "moment_media_aggregate",
    objectType: "moment_media",
    cursor: [string("key")],
    scalarFields: [
      "created_at",
      "hash",
      "key",
      "mime_type",
      "moment_id",
      "status",
      "status_reason",
      "updated_at",
    ],
    nestedSelections: [],
  },
  {
    name: "gateways",
    root: "gateways",
    aggregateRoot: "gateways_aggregate",
    objectType: "gateways",
    cursor: [uuid("id")],
    scalarFields: ["id", "metadata", "moment_media_id", "type", "url"],
    nestedSelections: [],
  },
  {
    name: "links",
    root: "moments_links",
    aggregateRoot: null,
    objectType: "moments_links",
    cursor: [uuid("id")],
    scalarFields: ["created_at", "description", "id", "image_url", "moment_id", "title", "url"],
    nestedSelections: [],
  },
  {
    name: "user_tags",
    root: "moments_user_tags",
    aggregateRoot: "moments_user_tags_aggregate",
    objectType: "moments_user_tags",
    cursor: [uuid("id")],
    scalarFields: ["address", "created_by", "created_on", "ens", "id", "moment_id", "x", "y"],
    nestedSelections: [],
  },
  {
    name: "capsules",
    root: "moments_capsules",
    aggregateRoot: "moments_capsules_aggregate",
    objectType: "moments_capsules",
    cursor: [bigint("id")],
    scalarFields: [
      "created_on",
      "description",
      "id",
      "id_external",
      "image_url",
      "owner",
      "title",
      "url",
    ],
    nestedSelections: [],
  },
  {
    name: "capsule_moments",
    root: "moments_capsule_moments",
    aggregateRoot: "moments_capsule_moments_aggregate",
    objectType: "moments_capsule_moments",
    cursor: [bigint("capsule_id"), uuid("moment_id")],
    scalarFields: ["capsule_id", "created_at", "created_by", "moment_id"],
    nestedSelections: [],
  },
  {
    name: "moments_hidden_drops",
    root: "moments_hidden_drops",
    aggregateRoot: null,
    objectType: "moments_hidden_drops",
    cursor: [bigint("drop_id")],
    scalarFields: ["drop_id", "hidden_on"],
    nestedSelections: [],
  },
  {
    name: "moments_featured_drops",
    root: "moments_featured_drops",
    aggregateRoot: null,
    objectType: "moments_featured_drops",
    cursor: [bigint("drop_id")],
    scalarFields: ["created_at", "drop_id"],
    nestedSelections: [],
  },
  {
    name: "drops_hidden_drops",
    root: "drops_hidden_drops",
    aggregateRoot: null,
    objectType: "drops_hidden_drops",
    cursor: [bigint("drop_id")],
    scalarFields: ["drop_id", "hidden_on"],
    nestedSelections: [],
  },
  {
    name: "drops_featured_drops",
    root: "drops_featured_drops",
    aggregateRoot: null,
    objectType: "drops_featured_drops",
    cursor: [bigint("drop_id")],
    scalarFields: ["drop_id", "featured_on"],
    nestedSelections: [],
  },
]);

export const ENTITY_BY_NAME = new Map(ENTITY_CONFIGS.map((config) => [config.name, config]));

// These are relational metadata only. The exporter intentionally never follows
// gateway URLs and never downloads media bodies.
export const MEDIA_BODY_CAPTURED = false;
