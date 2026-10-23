/**
 * GraphQL documents for the Shopify Admin API (version pinned by SHOPIFY_API_VERSION).
 * Step 1 (connection layer): shop identity and locations. Later steps add orders,
 * fulfillment orders, products and inventory documents here.
 */

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query V3plShopInfo {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      plan { displayName partnerDevelopment shopifyPlus }
    }
  }
`;

export type ShopInfo = {
  shop: {
    id: string;
    name: string;
    myshopifyDomain: string;
    currencyCode: string;
    ianaTimezone: string;
    plan: { displayName: string; partnerDevelopment: boolean; shopifyPlus: boolean } | null;
  };
};

export const LOCATIONS_QUERY = /* GraphQL */ `
  query V3plLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: false) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
        shipsInventory
        address { city country }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type LocationNode = {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  shipsInventory: boolean;
  address: { city: string | null; country: string | null } | null;
};

export type LocationsPage = {
  locations: { nodes: LocationNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

// ---------------------------------------------------------------------------
// Step 2 — catalog (products / variants). read_products scope. No inventory quantities.
// ---------------------------------------------------------------------------

export const VARIANT_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment V3plVariantFields on ProductVariant {
    id
    sku
    title
    barcode
    price
    updatedAt
    inventoryItem { id tracked }
    product { id title status }
  }
`;

export const PRODUCT_VARIANTS_COUNT_QUERY = /* GraphQL */ `
  query V3plProductVariantsCount { productVariantsCount { count } }
`;
export type ProductVariantsCount = { productVariantsCount: { count: number } | null };

export const PRODUCT_VARIANTS_QUERY = /* GraphQL */ `
  query V3plProductVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after, sortKey: ID) {
      nodes { ...V3plVariantFields }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${VARIANT_FIELDS_FRAGMENT}
`;

export const PRODUCT_WITH_VARIANTS_QUERY = /* GraphQL */ `
  query V3plProductWithVariants($id: ID!) {
    product(id: $id) {
      id
      title
      status
      variants(first: 250) { nodes { ...V3plVariantFields inventoryQuantity } }
    }
  }
  ${VARIANT_FIELDS_FRAGMENT}
`;

/** Bulk operation document: top-level connection only; nested objects are inlined per line. */
export const BULK_VARIANTS_DOCUMENT = /* GraphQL */ `
  { productVariants { edges { node { id sku title barcode price updatedAt inventoryItem { id tracked } product { id title status } } } } }
`;

export const BULK_RUN_MUTATION = /* GraphQL */ `
  mutation V3plBulkRun($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export const BULK_STATUS_QUERY = /* GraphQL */ `
  query V3plBulkStatus($id: ID!) {
    node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } }
  }
`;

export type VariantNode = {
  id: string;
  sku: string | null;
  title: string | null;
  barcode: string | null;
  price: string | null;
  updatedAt: string;
  inventoryItem: { id: string; tracked: boolean } | null;
  product: { id: string; title: string; status: string };
};
export type ProductVariantsPage = { productVariants: { nodes: VariantNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
/** Import preview only: `inventoryQuantity` (Shopify's total sellable quantity) is shown as a reference for the initial stock, never written to V3PL by itself (D-067). */
export type ProductWithVariants = { product: { id: string; title: string; status: string; variants: { nodes: (VariantNode & { inventoryQuantity?: number | null })[] } } | null };
export type BulkRunPayload = { bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: { field: string[] | null; message: string }[] } };
export type BulkStatusPayload = { node: { id: string; status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELING" | "CANCELED" | "FAILED" | "EXPIRED"; errorCode: string | null; objectCount: string; url: string | null } | null };

// ---------------------------------------------------------------------------
// Step 3 — orders (inbound). read_orders scope. Ship-to fields only; no Customer object.
// ---------------------------------------------------------------------------

export const ORDER_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment V3plOrderFields on Order {
    id
    name
    createdAt
    updatedAt
    cancelledAt
    cancelReason
    closedAt
    test
    displayFinancialStatus
    displayFulfillmentStatus
    currencyCode
    note
    tags
    sourceName
    email
    phone
    currentSubtotalPriceSet { shopMoney { amount } }
    currentTotalDiscountsSet { shopMoney { amount } }
    currentTotalTaxSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    currentTotalPriceSet { shopMoney { amount } }
    shippingLines(first: 5) { nodes { title code } }
    shippingAddress { name firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone }
    customAttributes { key value }
    lineItems(first: 250) {
      nodes {
        id
        sku
        title
        variantTitle
        quantity
        currentQuantity
        requiresShipping
        variant { id }
        product { id }
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
        taxLines { priceSet { shopMoney { amount } } }
      }
    }
  }
`;

export const ORDER_QUERY = /* GraphQL */ `
  query V3plOrder($id: ID!) { order(id: $id) { ...V3plOrderFields } }
  ${ORDER_FIELDS_FRAGMENT}
`;

export const ORDERS_QUERY = /* GraphQL */ `
  query V3plOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes { ...V3plOrderFields }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${ORDER_FIELDS_FRAGMENT}
`;

type Money = { shopMoney: { amount: string } } | null;

export type OrderLineNode = {
  id: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  currentQuantity: number;
  requiresShipping: boolean;
  variant: { id: string } | null;
  product: { id: string } | null;
  originalUnitPriceSet: Money;
  totalDiscountSet: Money;
  taxLines: { priceSet: Money }[];
};

export type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  closedAt: string | null;
  test: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  currencyCode: string;
  note: string | null;
  tags: string[];
  sourceName: string | null;
  email: string | null;
  phone: string | null;
  currentSubtotalPriceSet: Money;
  currentTotalDiscountsSet: Money;
  currentTotalTaxSet: Money;
  totalShippingPriceSet: Money;
  currentTotalPriceSet: Money;
  shippingLines: { nodes: { title: string; code: string | null }[] };
  /** Order "Additional details"; V3PL-created orders carry `v3pl_idempotency_key` (D-062). Optional for older fixtures. */
  customAttributes?: { key: string; value: string | null }[];
  shippingAddress: {
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCodeV2: string | null;
    phone: string | null;
  } | null;
  lineItems: { nodes: OrderLineNode[] };
};

export type OrderPayload = { order: OrderNode | null };
export type OrdersPage = { orders: { nodes: OrderNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };

// ---------------------------------------------------------------------------
// Step 4 — fulfillment (write_merchant_managed_fulfillment_orders, read_fulfillments) and
// inventory publishing (write_inventory). One-way: V3PL → Shopify for quantities.
// ---------------------------------------------------------------------------

export const ORDER_FULFILLMENT_CONTEXT_QUERY = /* GraphQL */ `
  query V3plOrderFulfillmentContext($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 25) {
        nodes {
          id
          status
          assignedLocation { location { id name } }
          lineItems(first: 100) { nodes { id remainingQuantity totalQuantity lineItem { id sku variant { id } } } }
        }
      }
      fulfillments(first: 25) {
        id
        status
        displayStatus
        trackingInfo { company number url }
        fulfillmentLineItems(first: 100) { nodes { quantity lineItem { id } } }
      }
    }
  }
`;

export type FulfillmentOrderNode = {
  id: string;
  status: string;
  assignedLocation: { location: { id: string; name: string } | null } | null;
  lineItems: { nodes: { id: string; remainingQuantity: number; totalQuantity: number; lineItem: { id: string; sku?: string | null; variant?: { id: string } | null } | null }[] };
};
export type FulfillmentNode = {
  id: string;
  status: string;
  displayStatus: string | null;
  trackingInfo: { company: string | null; number: string | null; url: string | null }[];
  fulfillmentLineItems: { nodes: { quantity: number; lineItem: { id: string } | null }[] };
};
export type OrderFulfillmentContext = { order: { id: string; fulfillmentOrders: { nodes: FulfillmentOrderNode[] }; fulfillments: FulfillmentNode[] } | null };

export const FULFILLMENT_ORDER_MOVE_MUTATION = /* GraphQL */ `
  mutation V3plFulfillmentOrderMove($id: ID!, $newLocationId: ID!) {
    fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
      movedFulfillmentOrder { id assignedLocation { location { id } } }
      remainingFulfillmentOrder { id }
      userErrors { field message }
    }
  }
`;
export type FulfillmentOrderMovePayload = { fulfillmentOrderMove: { movedFulfillmentOrder: { id: string } | null; remainingFulfillmentOrder: { id: string } | null; userErrors: { field: string[] | null; message: string }[] } };

export const FULFILLMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation V3plFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status displayStatus trackingInfo { company number url } }
      userErrors { field message }
    }
  }
`;
export type FulfillmentCreatePayload = { fulfillmentCreate: { fulfillment: { id: string; status: string; displayStatus: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] } | null; userErrors: { field: string[] | null; message: string }[] } };

export const FULFILLMENT_TRACKING_UPDATE_MUTATION = /* GraphQL */ `
  mutation V3plFulfillmentTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id trackingInfo { company number url } }
      userErrors { field message }
    }
  }
`;
export type FulfillmentTrackingUpdatePayload = { fulfillmentTrackingInfoUpdate: { fulfillment: { id: string } | null; userErrors: { field: string[] | null; message: string }[] } };

export const FULFILLMENT_QUERY = /* GraphQL */ `
  query V3plFulfillment($id: ID!) {
    fulfillment(id: $id) {
      id
      status
      displayStatus
      createdAt
      updatedAt
      trackingInfo { company number url }
      order { id }
      fulfillmentLineItems(first: 100) { nodes { quantity lineItem { id } } }
    }
  }
`;
export type FulfillmentPayload = { fulfillment: (FulfillmentNode & { createdAt: string; updatedAt: string; order: { id: string } | null }) | null };

export const INVENTORY_LEVEL_QUERY = /* GraphQL */ `
  query V3plInventoryLevel($itemId: ID!, $locationId: ID!) {
    inventoryItem(id: $itemId) {
      id
      tracked
      inventoryLevel(locationId: $locationId) { id quantities(names: ["available"]) { name quantity } }
    }
  }
`;
export type InventoryLevelPayload = { inventoryItem: { id: string; tracked: boolean; inventoryLevel: { id: string; quantities: { name: string; quantity: number }[] } | null } | null };

// Admin API 2026-04+ requires the @idempotent directive on inventory mutations. The key is a
// per-execution UUID (see inventory-publish.ts chooseIdempotencyKey): Shopify executes a given
// key once and replays the stored result for repeats, so a retry after a lost response is safe.
export const INVENTORY_ACTIVATE_MUTATION = /* GraphQL */ `
  mutation V3plInventoryActivate($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
      inventoryLevel { id quantities(names: ["available"]) { name quantity } }
      userErrors { field message }
    }
  }
`;
export type InventoryActivatePayload = { inventoryActivate: { inventoryLevel: { id: string; quantities: { name: string; quantity: number }[] } | null; userErrors: { field: string[] | null; message: string }[] } };

export const INVENTORY_SET_QUANTITIES_MUTATION = /* GraphQL */ `
  mutation V3plInventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id changes { name delta quantityAfterChange } }
      userErrors { field message code }
    }
  }
`;
export type InventorySetPayload = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: string; changes: { name: string; delta: number; quantityAfterChange: number }[] } | null; userErrors: { field: string[] | null; message: string; code: string | null }[] } };

// ---------------------------------------------------------------------------
// Manual V3PL order → Shopify order (write_orders, D-061 / D-062). One orderCreate per V3PL order;
// adoption searches by the V3PL marker tag before ever creating.
// ---------------------------------------------------------------------------

export const ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation V3plOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name displayFinancialStatus tags customAttributes { key value } lineItems(first: 100) { nodes { id sku quantity variant { id } } } }
      userErrors { field message code }
    }
  }
`;
export type OrderCreatePayload = {
  orderCreate: {
    order: { id: string; name: string; displayFinancialStatus: string | null; tags: string[]; customAttributes: { key: string; value: string | null }[]; lineItems: { nodes: { id: string; sku: string | null; quantity: number; variant: { id: string } | null }[] } } | null;
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
};

/** Adoption lookup: orders carrying a V3PL marker tag (any status), newest first. */
export const ORDERS_BY_TAG_QUERY = /* GraphQL */ `
  query V3plOrdersByTag($query: String!) {
    orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes { id name createdAt cancelledAt tags customAttributes { key value } }
    }
  }
`;
export type OrdersByTagPayload = { orders: { nodes: { id: string; name: string; createdAt: string; cancelledAt: string | null; tags: string[]; customAttributes: { key: string; value: string | null }[] }[] } };

// ---------------------------------------------------------------------------
// Customer directory sync (read_customers, D-065). Data minimisation: identity, name, default e-mail /
// phone and the default address only — no tags, notes, marketing state, spend or order history.
// `Customer.email` / `Customer.phone` are deprecated in 2026-07; the default* objects replace them.
// ---------------------------------------------------------------------------

export const CUSTOMER_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment V3plCustomerFields on Customer {
    id
    firstName
    lastName
    displayName
    updatedAt
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
    defaultAddress { name firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone }
  }
`;

export const CUSTOMERS_QUERY = /* GraphQL */ `
  query V3plCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: ID) {
      nodes { ...V3plCustomerFields }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${CUSTOMER_FIELDS_FRAGMENT}
`;

/** The customer attached to a Shopify order (only queried when the store granted read_customers). */
export const ORDER_CUSTOMER_QUERY = /* GraphQL */ `
  query V3plOrderCustomer($id: ID!) { order(id: $id) { id customer { ...V3plCustomerFields } } }
  ${CUSTOMER_FIELDS_FRAGMENT}
`;

export type CustomerAddressNode = { name?: string | null; firstName?: string | null; lastName?: string | null; company?: string | null; address1?: string | null; address2?: string | null; city?: string | null; province?: string | null; provinceCode?: string | null; zip?: string | null; country?: string | null; countryCodeV2?: string | null; phone?: string | null };
export type CustomerNode = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  updatedAt: string;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  defaultAddress?: CustomerAddressNode | null;
};
export type CustomersPage = { customers: { nodes: CustomerNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
export type OrderCustomerPayload = { order: { id: string; customer: CustomerNode | null } | null };
