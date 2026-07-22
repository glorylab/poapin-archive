import { Hono } from "hono";
import { withSnapshotCache } from "./cache";
import { createExportResponse, MAX_SYNC_EXPORT_RECORDS } from "./exports";
import {
  fetchDrop,
  fetchDrops,
  fetchMeta,
  fetchOwner,
  fetchOwnerTotal,
  fetchSnapshotAt,
} from "./repository";
import type { AppEnv } from "./types";
import {
  ApiError,
  assertNoQuery,
  normalizeAddress,
  parseDropId,
  parseDropsQuery,
  parseOwnerQuery,
} from "./validation";

export const app = new Hono<AppEnv>();

app.use("/api/*", async (context, next) => {
  await next();
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Robots-Tag", "noindex, nofollow");
  if (context.res.status >= 400) context.header("Cache-Control", "private, no-store");
});

app.get("/api/meta", async (context) => {
  const url = new URL(context.req.url);
  assertNoQuery(url);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/meta",
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: context.env.API_CACHE_VERSION,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.CATALOG_DB.withSession("first-primary");
      return context.json(await fetchMeta(db, context.env.SNAPSHOT_ID));
    },
  );
});

app.get("/api/drops", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseDropsQuery(new URL(context.req.url), context.env.SNAPSHOT_ID);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/drops",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: context.env.API_CACHE_VERSION,
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.CATALOG_DB.withSession("first-primary");
      return context.json(
        await fetchDrops(db, query, context.env.SNAPSHOT_ID, context.env.MEDIA_BASE_URL),
      );
    },
  );
});

app.get("/api/drops/:id", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const url = new URL(context.req.url);
  assertNoQuery(url);
  const dropId = parseDropId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/drops/${dropId}`,
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: context.env.API_CACHE_VERSION,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.CATALOG_DB.withSession("first-primary");
      const drop = await fetchDrop(db, dropId, context.env.MEDIA_BASE_URL, context.env.SNAPSHOT_ID);
      if (!drop) throw new ApiError(404, "Drop was not found in this snapshot.", "drop_not_found");
      return context.json(drop);
    },
  );
});

app.get("/api/owners/:address", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseOwnerQuery(
    new URL(context.req.url),
    context.req.param("address"),
    context.env.SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/owners/${query.address}`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: context.env.API_CACHE_VERSION,
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
      return context.json(
        await fetchOwner(
          holdingsDb,
          catalogDb,
          query,
          context.env.SNAPSHOT_ID,
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

for (const format of ["csv", "json"] as const) {
  app.get(`/api/owners/:address/export.${format}`, async (context) => {
    const limited = await enforceRateLimit(context.env.EXPORT_RATE_LIMITER, context.req.raw);
    if (limited) return limited;
    assertNoQuery(new URL(context.req.url));
    const address = normalizeAddress(context.req.param("address"));
    const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
    const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
    const [total, snapshotAt] = await Promise.all([
      fetchOwnerTotal(holdingsDb, address, context.env.SNAPSHOT_ID),
      fetchSnapshotAt(catalogDb, context.env.SNAPSHOT_ID),
    ]);
    if (total > MAX_SYNC_EXPORT_RECORDS) {
      throw new ApiError(
        413,
        `This address has ${total} records; synchronous exports are limited to ${MAX_SYNC_EXPORT_RECORDS}.`,
        "export_too_large",
      );
    }
    const response = createExportResponse({
      format,
      address,
      total,
      snapshotId: context.env.SNAPSHOT_ID,
      snapshotAt,
      holdingsDb,
      catalogDb,
      mediaBaseUrl: context.env.MEDIA_BASE_URL,
    });
    response.headers.set("X-Archive-Snapshot", context.env.SNAPSHOT_ID);
    response.headers.set("X-Archive-API-Version", context.env.API_CACHE_VERSION);
    return response;
  });
}

app.notFound((context) => context.json({ error: "Not found.", code: "not_found" }, 404));

app.onError((error, context) => {
  if (error instanceof ApiError) {
    return context.json({ error: error.message, code: error.code }, error.status);
  }
  console.error("Archive API request failed", { name: error.name });
  return context.json(
    { error: "The archive is temporarily unavailable.", code: "archive_unavailable" },
    503,
  );
});

async function enforceRateLimit(limiter: RateLimit, request: Request): Promise<Response | null> {
  const actor = request.headers.get("CF-Connecting-IP") ?? "local-or-unknown";
  const { success } = await limiter.limit({ key: actor });
  if (success) return null;
  return Response.json(
    { error: "Too many requests. Try again in a minute.", code: "rate_limited" },
    {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": "60",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export default app;
