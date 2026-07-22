export const DEFAULT_ENDPOINT = "https://public.compass.poap.tech/v1/graphql";
export const DEFAULT_PAGE_SIZE = 100;

const bigint = (name) => ({ name, type: "bigint", initial: "0" });
const uuid = (name) => ({
  name,
  type: "uuid",
  initial: "00000000-0000-0000-0000-000000000000",
});

export const ENTITY_CONFIGS = [
  {
    name: "collections",
    root: "collections",
    aggregateRoot: "collections_aggregate",
    objectType: "collections",
    cursor: [bigint("id")],
    scalarFields: [
      "banner_image_url",
      "created_by",
      "created_on",
      "description",
      "external_url",
      "id",
      "logo_image_url",
      "owner_address",
      "slug",
      "title",
      "type",
      "type_rank",
      "updated_on",
      "year",
    ],
    nestedSelections: [
      {
        field: "urls",
        objectType: "collections_collection_urls",
        scalarFields: ["collection_id", "id", "url"],
        selection: "urls(limit: 100, order_by: { id: asc }) { collection_id id url }",
      },
    ],
  },
  {
    name: "collection_ui_settings",
    root: "collection_ui_settings",
    aggregateRoot: null,
    objectType: "collection_ui_settings",
    cursor: [bigint("collection_id")],
    scalarFields: [
      "collection_id",
      "dark_color",
      "grey_color",
      "highlight_color",
      "is_visible_in_recent_list",
      "primary_color",
      "toggle_poap_elements",
      "white_color",
    ],
    nestedSelections: [],
  },
  {
    name: "artists",
    root: "collections_artists",
    aggregateRoot: "collections_artists_aggregate",
    objectType: "collections_artists",
    cursor: [uuid("id")],
    scalarFields: ["collection_id", "created_at", "ens", "id", "name", "slug"],
    nestedSelections: [],
  },
  {
    name: "artist_drops",
    root: "collections_artists_drops",
    aggregateRoot: "collections_artists_drops_aggregate",
    objectType: "collections_artists_drops",
    cursor: [uuid("artist_id"), bigint("drop_id")],
    scalarFields: ["artist_id", "drop_id"],
    nestedSelections: [],
  },
  {
    name: "organizations",
    root: "collections_organizations",
    aggregateRoot: "collections_organizations_aggregate",
    objectType: "collections_organizations",
    cursor: [bigint("id")],
    scalarFields: ["collection_id", "created_on", "id", "name", "slug"],
    nestedSelections: [],
  },
  {
    name: "verified_collections",
    root: "collections_verified_collections",
    aggregateRoot: "collections_verified_collections_aggregate",
    objectType: "collections_verified_collections",
    cursor: [bigint("collection_id")],
    scalarFields: ["collection_id", "verified_by", "verified_on"],
    nestedSelections: [],
  },
  {
    name: "featured_collections",
    root: "featured_collections",
    aggregateRoot: "featured_collections_aggregate",
    objectType: "featured_collections",
    cursor: [bigint("collection_id")],
    scalarFields: ["collection_id", "featured_on"],
    nestedSelections: [],
  },
  {
    name: "items",
    root: "items",
    aggregateRoot: "items_aggregate",
    objectType: "items",
    cursor: [bigint("id")],
    scalarFields: ["collection_id", "created_on", "drop_id", "id"],
    nestedSelections: [],
  },
  {
    name: "sections",
    root: "sections",
    aggregateRoot: null,
    objectType: "sections",
    cursor: [uuid("id")],
    scalarFields: ["collection_id", "id", "name", "position"],
    nestedSelections: [],
  },
  {
    name: "item_sections",
    root: "items_sections",
    aggregateRoot: "items_sections_aggregate",
    objectType: "items_sections",
    cursor: [bigint("item_id"), uuid("section_id")],
    scalarFields: ["item_id", "position", "section_id"],
    nestedSelections: [],
  },
  {
    name: "suggested_drops",
    root: "suggested_drops",
    aggregateRoot: "suggested_drops_aggregate",
    objectType: "suggested_drops",
    cursor: [bigint("id")],
    scalarFields: [
      "collection_id",
      "created_on",
      "curation_status",
      "drop_id",
      "id",
      "reviewed_on",
      "suggested_by",
    ],
    nestedSelections: [],
  },
  {
    name: "collection_drop_ids",
    root: "collections_collection_drop_ids",
    aggregateRoot: null,
    objectType: "collections_collection_drop_ids",
    cursor: [bigint("collection_id")],
    scalarFields: ["collection_id", "drop_ids"],
    nestedSelections: [],
  },
];

export const DROP_SCALAR_FIELDS = [
  "animation_url",
  "channel",
  "city",
  "country",
  "created_date",
  "description",
  "drop_url",
  "end_date",
  "expiry_date",
  "fancy_id",
  "id",
  "image_url",
  "integrator_id",
  "location_type",
  "name",
  "platform",
  "private",
  "start_date",
  "timezone",
  "virtual",
  "year",
];

export const DROP_IMAGE_SCALAR_FIELDS = [
  "created_date",
  "drop_id",
  "filename",
  "id",
  "mime_type",
  "public_id",
];

export const DROP_IMAGE_GATEWAY_SCALAR_FIELDS = [
  "filename",
  "id",
  "image_id",
  "mime_type",
  "type",
  "url",
];

export const HIDDEN_DROP_SCALAR_FIELDS = ["drop_id", "hidden_on"];

export const DROP_SELECTION = `
  ${DROP_SCALAR_FIELDS.join("\n  ")}
  hidden_drop { ${HIDDEN_DROP_SCALAR_FIELDS.join(" ")} }
  drop_image {
    ${DROP_IMAGE_SCALAR_FIELDS.join("\n    ")}
    gateways(order_by: { id: asc }) {
      ${DROP_IMAGE_GATEWAY_SCALAR_FIELDS.join("\n      ")}
    }
  }
`;

export const TRUSTED_MEDIA_HOSTS = new Set([
  "assets.poap.xyz",
  "collections-media-production.s3.us-east-2.amazonaws.com",
]);

export const DEAD_COLLECTIONS_MEDIA_HOST = "collections-assets.poap.xyz";
export const RECOVERED_COLLECTIONS_MEDIA_HOST =
  "collections-media-production.s3.us-east-2.amazonaws.com";
