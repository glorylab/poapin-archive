import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readFile } from "node:fs/promises";

const catalogMigrations = await readD1Migrations("migrations/catalog");
const holdingsMigrations = await readD1Migrations("migrations/holdings");
const catalogFixture = await readFile("fixtures/catalog.sql", "utf8");
const holdingsFixture = await readFile("fixtures/holdings.sql", "utf8");

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
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
