/**
 * Low-level Shopify Admin GraphQL transport. No database access; the caller supplies the
 * shop, API version and a valid access token (see api.ts for the store-aware wrapper).
 *
 * - Cost-based throttling: on THROTTLED the call waits for the bucket to refill and retries
 *   (bounded). Reads are safe to retry; mutations are only retried on THROTTLED, never after
 *   an ambiguous transport failure (callers handle idempotency, shopify-integration.md §10).
 * - 401/403 → UNAUTHORIZED so the store can be marked NEEDS_REAUTH by the caller.
 * - `fetch` is injectable for tests (no real Shopify needed).
 */

export type ShopifyApiErrorCode = "NETWORK" | "HTTP" | "UNAUTHORIZED" | "THROTTLED" | "GRAPHQL" | "NOT_CONFIGURED" | "NOT_CONNECTED";

export class ShopifyApiError extends Error {
  constructor(
    public readonly code: ShopifyApiErrorCode,
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
  ) {
    super(message);
  }
}

export type GraphqlErrors = { message: string; extensions?: { code?: string; [k: string]: unknown }; path?: (string | number)[] }[];

export type GraphqlEnvelope<T> = {
  data?: T;
  errors?: GraphqlErrors;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number | null;
      throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
    };
  };
};

export type ShopifyTarget = { shopDomain: string; apiVersion: string; accessToken: string };

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);

/** Test seam: replace the transport (e.g. to simulate Shopify without network). */
export function __setShopifyFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

export function shopifyFetch(): FetchLike {
  return fetchImpl;
}

export function graphqlEndpoint(shopDomain: string, apiVersion: string): string {
  return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type GraphqlOptions = { maxThrottleRetries?: number; timeoutMs?: number };

/**
 * Execute one GraphQL document. Returns `data` or throws ShopifyApiError.
 * GraphQL `userErrors` inside mutation payloads are NOT thrown here — they are business
 * results the caller must read.
 */
export async function graphqlRequest<T>(target: ShopifyTarget, query: string, variables?: Record<string, unknown>, opts: GraphqlOptions = {}): Promise<{ data: T; cost?: GraphqlEnvelope<T>["extensions"] }> {
  const maxRetries = opts.maxThrottleRetries ?? 3;
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetchImpl(graphqlEndpoint(target.shopDomain, target.apiVersion), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": target.accessToken },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      });
    } catch (err) {
      throw new ShopifyApiError("NETWORK", `Could not reach ${target.shopDomain}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyApiError("UNAUTHORIZED", `Shopify rejected the access token for ${target.shopDomain} (HTTP ${res.status}).`, res.status);
    }
    if (res.status === 429 && attempt < maxRetries) {
      attempt++;
      const retryAfter = Number(res.headers.get("retry-after")) || 2;
      await sleep(Math.min(retryAfter, 10) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ShopifyApiError("HTTP", `Shopify returned HTTP ${res.status} for ${target.shopDomain}.`, res.status, text.slice(0, 500));
    }

    let body: GraphqlEnvelope<T>;
    try {
      body = (await res.json()) as GraphqlEnvelope<T>;
    } catch {
      throw new ShopifyApiError("HTTP", "Shopify returned a non-JSON response.", res.status);
    }

    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < maxRetries) {
        attempt++;
        const cost = body.extensions?.cost;
        const need = cost ? Math.max(0, cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) : 50;
        const rate = cost?.throttleStatus.restoreRate || 50;
        await sleep(Math.min(Math.ceil(need / rate), 5) * 1000 + 200);
        continue;
      }
      if (throttled) throw new ShopifyApiError("THROTTLED", "Shopify API rate limit reached; try again shortly.", res.status, body.errors);
      const msg = body.errors.map((e) => e.message).join("; ");
      throw new ShopifyApiError("GRAPHQL", `Shopify GraphQL error: ${msg}`, res.status, body.errors);
    }
    if (!body.data) throw new ShopifyApiError("GRAPHQL", "Shopify returned no data.", res.status, body);
    return { data: body.data, cost: body.extensions };
  }
}

/** First user error message from a mutation payload, or null. */
export function firstUserError(payload: { userErrors?: { field?: (string | null)[] | null; message: string }[] } | null | undefined): string | null {
  const e = payload?.userErrors?.[0];
  return e ? `${e.field?.filter(Boolean).join(".") ?? ""}${e.field?.length ? ": " : ""}${e.message}` : null;
}

/** Numeric id from a GID like gid://shopify/Order/123 → "123". */
export function gidToId(gid: string): string {
  const i = gid.lastIndexOf("/");
  return i >= 0 ? gid.slice(i + 1).split("?")[0] : gid;
}

export function toGid(type: string, id: string | number): string {
  return String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`;
}
