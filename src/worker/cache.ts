interface CacheOptions {
  requestUrl: string;
  canonicalPath: string;
  canonicalSearch?: string;
  snapshotId: string;
  apiVersion: string;
  edgeTtlSeconds: number;
  browserTtlSeconds?: number;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Cache immutable snapshot reads under a synthetic, snapshot-versioned GET key.
 * Cache failures are deliberately non-fatal: D1 remains the source of truth.
 */
export async function withSnapshotCache(
  options: CacheOptions,
  load: () => Promise<Response>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = makeCacheKey(options);

  try {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeader(hit, "X-Archive-Cache", "HIT");
  } catch {
    // Local runtimes and transient cache errors must not take the API down.
  }

  const generated = await load();
  if (!generated.ok || generated.headers.has("Set-Cookie")) return generated;

  const headers = new Headers(generated.headers);
  headers.set(
    "Cache-Control",
    `public, max-age=${options.browserTtlSeconds ?? 60}, s-maxage=${options.edgeTtlSeconds}`,
  );
  headers.set("X-Archive-Snapshot", options.snapshotId);
  headers.set("X-Archive-API-Version", options.apiVersion);
  const response = new Response(generated.body, {
    status: generated.status,
    statusText: generated.statusText,
    headers,
  });

  const cacheCopy = response.clone();
  options.executionCtx.waitUntil(cache.put(cacheKey, cacheCopy).catch(() => undefined));
  return withHeader(response, "X-Archive-Cache", "MISS");
}

function makeCacheKey(options: CacheOptions): Request {
  const url = new URL(options.requestUrl);
  url.pathname = options.canonicalPath;
  url.search = options.canonicalSearch ?? "";
  url.searchParams.set("__archive_snapshot", options.snapshotId);
  url.searchParams.set("__archive_api", options.apiVersion);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
