import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readFile } from "node:fs/promises";

const catalogMigrations = await readD1Migrations("migrations/catalog");
const holdingsMigrations = await readD1Migrations("migrations/holdings");
const collectionsMigrations = await readD1Migrations("migrations/collections");
const catalogFixture = await readFile("fixtures/catalog.sql", "utf8");
const holdingsFixture = await readFile("fixtures/holdings.sql", "utf8");
const collectionsFixture = await readFile("fixtures/collections.sql", "utf8");

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    poolOptions: {
      workers: {
        miniflare: {
          bindings: {
            TEST_CATALOG_FIXTURE: catalogFixture,
            TEST_CATALOG_MIGRATIONS: catalogMigrations,
            TEST_HOLDINGS_FIXTURE: holdingsFixture,
            TEST_HOLDINGS_MIGRATIONS: holdingsMigrations,
            TEST_COLLECTIONS_FIXTURE: collectionsFixture,
            TEST_COLLECTIONS_MIGRATIONS: collectionsMigrations,
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
