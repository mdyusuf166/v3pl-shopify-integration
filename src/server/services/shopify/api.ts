import { prisma } from "@/lib/prisma";
import { ShopifyApiError, graphqlRequest, type GraphqlOptions } from "./client";
import { getAccessToken, markNeedsReauth } from "./oauth";
import { LOCATIONS_QUERY, SHOP_INFO_QUERY, type LocationNode, type LocationsPage, type ShopInfo } from "./queries";

/**
 * Store-aware Admin GraphQL access: resolves (and refreshes) the store's token, executes the
 * document, and flags the store NEEDS_REAUTH when Shopify rejects the token.
 */
export async function storeGraphql<T>(storeId: string, query: string, variables?: Record<string, unknown>, opts?: GraphqlOptions): Promise<T> {
  const target = await getAccessToken(storeId);
  try {
    return (await graphqlRequest<T>(target, query, variables, opts)).data;
  } catch (err) {
    if (err instanceof ShopifyApiError && err.code === "UNAUTHORIZED") await markNeedsReauth(storeId, err.message);
    throw err;
  }
}

export async function fetchShopInfo(storeId: string): Promise<ShopInfo["shop"]> {
  return (await storeGraphql<ShopInfo>(storeId, SHOP_INFO_QUERY)).shop;
}

export async function fetchAllLocations(storeId: string): Promise<LocationNode[]> {
  const out: LocationNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: LocationsPage = await storeGraphql<LocationsPage>(storeId, LOCATIONS_QUERY, { first: 50, after });
    out.push(...data.locations.nodes);
    if (!data.locations.pageInfo.hasNextPage) break;
    after = data.locations.pageInfo.endCursor;
  }
  return out;
}

/**
 * Loads shop identity and locations from Shopify and stores the snapshot. When the store has
 * exactly one location and none is configured yet, it becomes the publish/fulfil location.
 * Used right after install/reconnect and by “Test connection”.
 */
export async function refreshShopMetadata(storeId: string): Promise<{ shop: ShopInfo["shop"]; locations: LocationNode[] }> {
  const [shop, locations] = await Promise.all([fetchShopInfo(storeId), fetchAllLocations(storeId)]);
  const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: storeId }, select: { publishLocationId: true, fulfilLocationId: true } });
  const byId = new Map(locations.map((l) => [l.id, l]));
  const only = locations.length === 1 ? locations[0] : null;
  const publishLocationId = store.publishLocationId ?? only?.id ?? null;
  const fulfilLocationId = store.fulfilLocationId ?? only?.id ?? null;
  await prisma.shopifyStore.update({
    where: { id: storeId },
    data: {
      shopGid: shop.id,
      shopName: shop.name,
      currencyCode: shop.currencyCode,
      timezone: shop.ianaTimezone,
      publishLocationId,
      publishLocationName: publishLocationId ? (byId.get(publishLocationId)?.name ?? undefined) : null,
      fulfilLocationId,
      fulfilLocationName: fulfilLocationId ? (byId.get(fulfilLocationId)?.name ?? undefined) : null,
      lastError: null,
      lastErrorAt: null,
    },
  });
  return { shop, locations };
}
