# Shopify Integration Design

Status: **Design finalized 2026-09-02. Steps 1–3 implemented and production-verified on the development
store (2026-09-06/07); Step 4 built and verified on the Neon test branch (2026-09-07), production
verification pending; Step 5 (manual V3PL order → Shopify order, D-062) built and verified on the Neon test
branch (2026-09-15), dev-store verification pending; Step 6 (Shopify customers → V3PL customer directory, D-065) built and verified on the Neon test branch (2026-09-22), dev-store verification pending.** Supersedes the Phase 0 draft of this document.

Implementation status:

| Step | Scope | State |
|---|---|---|
| 1 | Prisma models + migration `20260906120000_shopify_connection`, env, AES-256-GCM token store, OAuth install/reconnect/refresh, GraphQL transport, webhook receiver/processor (`app/uninstalled`, compliance), outbound job queue + core hooks, daily maintenance route, `Settings → Shopify Stores` UI | **built + verified**: unit 35/35, e2e 58/58 (Neon test branch), typecheck/lint/build clean |
| 2 | Catalog sync (paged / bulk), exact-SKU matching (MATCHED / UNMATCHED / CONFLICT / IGNORED), Product mapping tab (search, filters, manual map, unmap, ignore, unmatched CSV), `products/update` handler, daily catalog sync, preview-based import of unmatched Shopify products with explicit owner per Shopify product, unique (store, internal variant) constraint | **built + verified** 2026-09-07: unit 51/51, e2e 49/49 (+ Step 1 regression 58/58) on the Neon test branch; production verification pending deploy |
| 3 | Inbound orders: `orders/create`, `orders/updated`, `orders/edited`, `orders/cancelled`, `refunds/create` handlers → one `syncShopifyOrder()` calling the core contracts only; exact-SKU line resolution via mappings; multi-owner orders; reservation regardless of payment at the store's default warehouse; non-shipping lines noted, never reserved (Option A, D-050); unknown SKU → no order + Retry; state-based edits/refunds; cancellation release; per-store `Import test orders` + `Import orders created since`; backfill; daily reconciliation; Orders tab | **built + verified** 2026-09-07: unit 58/58, e2e 39/39 (+ Step 1 58/58, Step 2 49/49 regressions) on the Neon test branch; **production-verified 2026-09-07** with dev-store order `#1002` |
| 4 | Fulfillment push (V3PL → Shopify: `FULFILLMENT_CREATE` / `TRACKING_UPDATE` runners, fulfillment-order move, adoption by tracking number, link via core R-1), pull (Shopify → V3PL: `fulfillments/create|update` mirrored once via `recordExternalShipment`, delivery status → shipment status, cancellation → attention), inventory publishing (compare-and-set, activation, initial publish on enable, Force publish, daily verify sweep), `after()` near-immediate push, Publishing tab | **built + verified** 2026-09-07: unit 63/63, e2e 35/35 (+ Step 1 58/58, Step 2 49/49, Step 3 39/39 regressions) on the Neon test branch; no new migration; rebased on core `2610588` (R-1/R-2 live) → e2e 42/42; **production verification pending** |
| 5 | Manual V3PL order → Shopify order: `ORDER_CREATE` runner (`order-out.ts`), `orderCreate` with `BYPASS` inventory + `PENDING` payment, V3PL retail prices, V3PL marker tags/note/attributes, adoption by tag + idempotency attribute, inbound link-not-import for V3PL-origin orders, fulfilment push widened to any Shopify-referenced order, variant-based line matching, `write_orders` scope | **built + verified** 2026-09-15 (D-062): `e2e:shopify-order-create` 39/39 (+ unit 80/80, core `e2e:shopify-order` 33/33, Step 1–4 regressions) on the Neon test branch; **dev-store verification pending** (needs the released app version with `write_orders`, `SHOPIFY_SCOPES` on Vercel, store reconnect) |
| 6 | Shopify customers → V3PL customer directory: `customers-sync.ts`, core `upsertShopifyCustomer`, `read_customers` scope, *Sync customers now*, order import links `Order.customerId` (§8.4), migration `20260922120000_shopify_customer_sync` | **built + verified** 2026-09-22 (D-065): `e2e:shopify-customers` 23/23 (+ unit 86/86, `e2e:customers`, `e2e:shopify3`, `e2e:shopify-order-create` regressions) on the Neon test branch; **dev-store verification pending** (new app version with `read_customers`, `SHOPIFY_SCOPES` on Vercel, production migration, store reconnect) |\n
Session ownership (D-027):

- **Core session** owns: users, owners (vendors / 3PL clients), products, variants, warehouses,
  inventory engine, orders, fulfillment, shipments, portals, reports, and the core Prisma schema.
- **Shopify session** owns: everything in `src/server/services/shopify/`, the Shopify API routes,
  the Shopify-specific Prisma models listed in §5.1, the `Settings → Shopify Stores` UI, and the
  Shopify documents (`docs/shopify-*.md`).
- The Shopify integration **calls** the core services (§6). It never writes inventory, order,
  fulfillment or shipment tables directly.

---

## 1. Model and non-negotiable rules

| Rule | Meaning in this design |
|---|---|
| Store ≠ vendor | A `ShopifyStore` is a sales channel. It never carries or implies an owner. |
| SKU is identity | Internal `ProductVariant.sku` is globally unique and belongs to one owner. Ownership is resolved **per order line** by SKU/variant mapping. |
| One SKU, many stores | The same internal variant can be mapped to a variant in every connected store (`ShopifyVariantMapping` is per store). |
| One Shopify order → one internal order | Lines keep their own owner. Never split by vendor. |
| Idempotent everywhere | Database constraints + application checks (§10). |
| Internal inventory is operational truth | Shopify events *cause* movements through core services; Shopify quantities never overwrite internal quantities. Publishing to Shopify is one-way, controlled and logged. |
| No guessing | Unknown SKU → sync FAILED / NEEDS_ATTENTION, exact SKU shown, nothing created, nothing deducted. Never match by title. |

```text
Shopify Store → Shopify Order → Line item (variant id + SKU)
  → ShopifyVariantMapping / internal SKU → ProductVariant → Product → Owner
  → OrderItem.ownerId → inventory reservation via core inventory service
```

## 2. Shopify app

| Item | Decision |
|---|---|
| App | One app, already created in the client's Dev Dashboard. **Public distribution** (permanent, D-021). |
| Embedded | **No.** V3PL is the UI; the app is an authorization + sync layer. |
| Auth | OAuth **authorization code grant**, started from V3PL (`Add Shopify Store`). Token exchange / managed installation is not used because the app is not embedded. |
| Tokens | **Expiring offline access tokens** (`expiring=1`): access token ≈ 24 h, refresh token ≈ 90 days. Mandatory for new public apps (D-022). Stored AES-256-GCM encrypted. |
| API | Admin **GraphQL** only, version pinned in env (`2026-07` at design time). No REST. |
| Webhooks | **App-specific subscriptions** configured in the Dev Dashboard (apply to every installing store, not deleted on failure). HMAC = app client secret. |
| Install order | Dev store first. Live stores only after the integration passes the test matrix (§17), app review, and protected-customer-data approval (D-026). |

Per-store client credentials are supported as an optional override on `ShopifyStore` (null = use
the app credentials from env). This keeps the door open for a custom-distribution app per store
if that is ever needed, without a code change.

## 3. Access scopes (final, verified against API 2026-07)

The V3PL warehouse fulfils from **merchant-managed** Shopify locations and the app does **not**
register as a Shopify fulfillment service. Therefore the fulfillment-order scope is the
merchant-managed one; `write_fulfillments` is *not* required. `write_orders` is used solely for `orderCreate` (§12.2).

| Scope | Used for | Why this and not something broader |
|---|---|---|
| `read_orders` | `orders/*`, `refunds/create` webhooks; `order`, `orders` queries incl. line items, shipping lines, shipping address, financial/fulfillment status, refunds | Reading only; V3PL never edits or cancels Shopify orders. |
| `write_orders` (added 2026-09-15, D-062) | `orderCreate` only — manual V3PL orders for mapped SKUs are created in their store (§12.2) | Required by `orderCreate`. Needs a new app version and a merchant re-authorisation of every connected store; the `ORDER_CREATE` runner refuses stores that have not granted it. Still no order edits/cancellations from V3PL. |
| `write_merchant_managed_fulfillment_orders` | `fulfillmentOrders` on an order, `fulfillmentCreate`, `fulfillmentTrackingInfoUpdate`, `fulfillmentOrderMove`; `fulfillment_orders/*` webhooks | The documented requirement for those mutations. Includes read. Not `assigned_*` (only for fulfillment-service apps) nor `third_party_*` (only for orders routed to other services). |
| `read_fulfillments` | `fulfillments/create`, `fulfillments/update` webhooks (tracking added/changed in Shopify Admin) | Read-only. Only needed for those two topics. |
| `read_products` | Catalog sync: product / variant / inventory item IDs and SKUs for mapping; `products/update` webhook | We never write products to Shopify → no `write_products`. |
| `write_inventory` | `inventorySetQuantities` to publish sellable quantity | Includes `read_inventory` for the current level. |
| `read_locations` | `locations` query to let Admin choose the publish/fulfil location per store | Read-only. |
| `read_customers` (added 2026-09-22, D-065) | `customers` connection (paged, `updated_at` filter) and `order { customer }` for the customer directory sync (§8.4) | Required by the `Customer` object. Read-only — V3PL never writes customers to Shopify, so no `write_customers`. Needs a new app version + merchant re-authorisation; the sync refuses stores that have not granted it and order import simply skips the directory link for them. |

Explicitly **not** requested: `write_products`, `write_customers`, `read_all_orders` (D-023; only if the business confirms history beyond 60 days
is needed), `read_returns` (returns are recorded in V3PL from physical receipt, not from Shopify),
`read_fulfillment_services`, any `*_marketplace_*`.

**Protected customer data** (name, address, email, phone) is a separate Dev Dashboard request.
It is required to receive the shipping address. Development stores get it once the form is
completed; live stores need approval (see [shopify-setup.md](shopify-setup.md)).

## 4. Store connection lifecycle

```text
PENDING_INSTALL ─(OAuth callback ok)─▶ CONNECTED ─(refresh fails / 401)─▶ NEEDS_REAUTH
      │                                    │  ▲                                │
      └─(abandoned, cron cleanup)          │  └──────(Reconnect)───────────────┘
                                           ├─(app/uninstalled webhook)─▶ UNINSTALLED (tokens deleted)
                                           └─(Admin: Disconnect)────────▶ DISCONNECTED (tokens deleted)
```

Connect flow (all server-side):

1. Admin enters `example.myshopify.com` → validate domain format → create/reuse `ShopifyStore`
   row → generate `state` nonce (stored, 10-min TTL) → 302 to
   `https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state`.
2. Callback: verify `hmac` (HMAC-SHA256 of sorted query with client secret, constant-time
   compare), verify `state`, verify `shop` matches the pending row.
3. `POST https://{shop}/admin/oauth/access_token` with `client_id, client_secret, code,
   expiring=1` → store encrypted access token, refresh token, both expiries, granted scopes.
4. Post-install: query `shop { id name myshopifyDomain currencyCode ianaTimezone }` and
   `locations` → mark CONNECTED → audit log.
5. Token refresh: before any API call if `accessTokenExpiresAt < now + 5 min`, and by daily cron
   for every CONNECTED store so refresh tokens never age out. A refresh failure sets NEEDS_REAUTH
   and surfaces in the UI.

Reconnect runs the same flow onto the existing row; all mappings and history are preserved.

## 5. Data model

### 5.1 Tables owned by the Shopify session

| Table | Fields (key ones) | Constraints |
|---|---|---|
| **ShopifyStore** | name, shopDomain, shopGid, shopName, currencyCode, timezone, status (§4), apiVersion, grantedScopes[], encAccessToken, encRefreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, installedAt, uninstalledAt, oauthState, oauthStateExpiresAt, clientIdOverride?, encClientSecretOverride?, **ordersImportEnabled** (default true), **publishEnabled** (default false), publishRule `ALL_AVAILABLE` (enum, extensible), publishLocationId (Shopify location GID), fulfilLocationId (usually same), lastOrderCheckpointAt, lastPublishSweepAt, lastWebhookAt, lastError, lastErrorAt | `shopDomain` unique |
| **ShopifyStoreWarehouse** | storeId, warehouseId | unique (storeId, warehouseId). Defines which internal warehouses feed the store's published quantity and which warehouse Shopify orders reserve from (v1: first by priority). |
| **ShopifyVariantMapping** | storeId, shopifyProductId, shopifyVariantId, shopifyInventoryItemId, shopifySku (snapshot), shopifyProductTitle, shopifyVariantTitle (display only), variantId (internal, nullable while UNMATCHED), status `MATCHED\|UNMATCHED\|CONFLICT\|IGNORED`, matchedBy `SKU_EXACT\|MANUAL`, lastPublishedAvailable, lastPublishedAt, lastSeenAt | unique (storeId, shopifyVariantId); index (variantId) |
| **ShopifyWebhookEvent** | storeId?, shopDomain (raw header), webhookId, eventId, topic, apiVersion, triggeredAt, receivedAt, status `RECEIVED\|PROCESSING\|PROCESSED\|FAILED\|SKIPPED_DUPLICATE\|SKIPPED_STALE\|IGNORED`, attempts, nextRetryAt, processedAt, error, payload (jsonb) | **unique (webhookId)**; index (status, nextRetryAt) |
| **ShopifySyncLog** | storeId, direction `INBOUND\|OUTBOUND`, entityType `ORDER\|FULFILLMENT\|INVENTORY\|PRODUCT\|STORE\|WEBHOOK`, externalId, internalId, operation, status `SUCCESS\|FAILED\|NEEDS_ATTENTION\|SKIPPED`, previousValue, newValue, message (human-readable), errorDetail, webhookEventId?, orderId?, retryCount, createdAt | index (storeId, createdAt), (status), (orderId) |
| **ShopifyOutboundJob** | storeId, type `FULFILLMENT_CREATE\|TRACKING_UPDATE\|INVENTORY_PUBLISH`, targetType/targetId (e.g. shipmentId), dedupeKey, status `PENDING\|RUNNING\|DONE\|FAILED\|NEEDS_ATTENTION`, attempts, nextRetryAt, lastError | **unique (dedupeKey)** — e.g. `fulfillment:{shipmentId}`; guarantees one push per shipment |

### 5.2 Columns the **core session** must include on core tables

These are requested from the core session and are the only touch points on core models.

| Core table | Column | Purpose |
|---|---|---|
| `Order` | `source` includes `SHOPIFY` | already planned |
| `Order` | `shopifyStoreId?` FK, `shopifyOrderId?` (numeric ID as string), `shopifyOrderName?` (e.g. `#1001`) | identity + display |
| `Order` | **UNIQUE (shopifyStoreId, shopifyOrderId)** | D-013 |
| `Order` | `shopifyFinancialStatus?`, `shopifyFulfillmentStatus?`, `shopifyUpdatedAt?`, `shopifyCancelledAt?` | informational + stale-event guard |
| `Order` | `needsAttention` bool, `needsAttentionReason?` | surfaced on dashboard (also useful for CSV imports) |
| `OrderItem` | `shopifyLineItemId?`, `shopifyVariantId?` | line identity for edits/refunds/fulfilment matching |
| `Fulfillment` | `shopifyFulfillmentId?`, `shopifyStoreId?`, **UNIQUE (shopifyStoreId, shopifyFulfillmentId)** | inbound/outbound de-dup |
| `Shipment` | `shopifySyncedAt?` | display: “Sent to Shopify” |
| `InventoryTransaction` | `externalEventId?` | already planned; set to the webhook `eventId` when a Shopify event causes a movement |

## 6. Core service contract (what the Shopify layer calls)

The Shopify session needs the following capabilities from core services. Names are indicative;
the core session decides the final signatures, but each capability must exist and be transactional.

| Capability | Used by |
|---|---|
| `orders.createExternal({ source:'SHOPIFY', storeId, externalId, customer/shipping snapshot, lines:[{variantId, qty, unitPrice, discount, tax, externalLineId}], reserve: boolean, warehouseId })` → creates order + lines (owner denormalized), reserves per line, returns order or `INSUFFICIENT_STOCK` detail | order import |
| `orders.syncExternalUpdate(orderId, patch)` — apply changed header fields only | orders/updated |
| `orders.adjustLineQuantity(orderId, orderItemId, newQty, reason, externalEventId)` — releases reservation for removed qty | orders/edited, refunds before shipment |
| `orders.cancel(orderId, reason, externalEventId)` — releases unshipped reservations | orders/cancelled |
| `orders.flagAttention(orderId, reason)` / `clearAttention` | unknown SKU after partial state, refunds after shipment |
| `fulfillment.recordExternalShipment(orderId, { lines:[{orderItemId, qty}], carrier, trackingNumber, trackingUrl, shippedAt, externalFulfillmentId, externalEventId })` — creates Fulfillment+Shipment, consumes reservation once | fulfillments/create from Shopify Admin |
| `fulfillment.updateShipmentTracking(shipmentId, tracking, externalEventId)` | fulfillments/update |
| `inventory.availableForVariants(variantIds, warehouseIds)` → `{variantId → available}` | publish |
| **Hook:** after `shipment.shipped` for an order with `source=SHOPIFY` → enqueue `ShopifyOutboundJob(FULFILLMENT_CREATE, shipmentId)` | outbound fulfillment |
| **Hook:** after any inventory transaction → enqueue `INVENTORY_PUBLISH` for affected variantIds (coalesced) | outbound inventory |

Hooks are plain function calls inside the core service (no queue infrastructure), guarded so a
Shopify failure never rolls back a warehouse action: the job row is written in the same
transaction; the actual API call happens afterwards (cron / `waitUntil`).

### 6.1 Requested core capabilities (Shopify session → core session) — canonical list in [core-requests.md](core-requests.md)

| Capability | Why | Used by |
|---|---|---|
| Honour `OrderItem.requiresShipping = false` in reservation, picking, quantity adjustment and status derivation | Would let mapped non-shipping Shopify items be real order lines (visible in reports/exports) without touching stock | Step 3 non-shipping lines (currently noted via `addOrderNote`) |
| Allow an external order with zero shippable lines (or a non-physical line type) | All-non-shipping Shopify orders currently create no V3PL order | Step 3 |
| `orders.addExternalLine(orderId, line, externalEventId)` | Lines added in Shopify after import are only flagged today | Step 3 order edits |
| `orders.redactCustomerData(storeId | orderIds)` | Compliance webhooks (`customers/redact`, `shop/redact`) are logged for manual handling | Step 1 compliance |

## 7. Webhooks

### 7.1 Topics (app-specific subscriptions, API 2026-07)

| Topic | Handler | Scope |
|---|---|---|
| `orders/create` | import order | read_orders |
| `orders/updated` | sync header (financial status, tags, note, address until shipped) | read_orders |
| `orders/edited` | line quantity / line add-remove sync | read_orders |
| `orders/cancelled` | cancel + release | read_orders |
| `refunds/create` | pre-shipment refund → reduce lines; post-shipment → record + NEEDS_ATTENTION | read_orders |
| `fulfillments/create` | mirror Shopify-side fulfillment (if not ours) | read_fulfillments |
| `fulfillments/update` | tracking / status changes | read_fulfillments |
| `products/update` | refresh variant mapping snapshots (SKU changed → re-match or CONFLICT) | read_products |
| `app/uninstalled` | mark UNINSTALLED, delete tokens | — |
| Compliance: `customers/data_request`, `customers/redact`, `shop/redact` | respond 200; redact stored customer snapshot fields for that store / order set | mandatory for public apps |

Not subscribed: `inventory_levels/update` (we never ingest Shopify quantities; drift is detected
by the publish compare-and-set, §9), `fulfillment_orders/*` (fulfillment orders are queried at
ship time; the routing-complete webhook has known payload issues and adds nothing for us).

### 7.2 Pipeline

```text
POST /api/webhooks/shopify
 1. Read raw body. Verify X-Shopify-Hmac-Sha256 with the app client secret (or the store's
    override secret, looked up by X-Shopify-Shop-Domain). Mismatch → 401, nothing stored.
 2. INSERT ShopifyWebhookEvent (webhookId UNIQUE, eventId, topic, shopDomain, payload).
    Unique violation → 200, done (duplicate delivery).
 3. Unknown shop domain → store event as IGNORED, 200 (we must not 5xx on stray events).
 4. Respond 200 within the 5 s budget, then process via `waitUntil` (Vercel).
 5. Processor: load event → PROCESSING → re-fetch entity by GraphQL (payload is a hint, not
    truth) → run the domain handler inside one DB transaction → PROCESSED + ShopifySyncLog,
    or FAILED (+error, attempts++, nextRetryAt backoff).
 6. Cron `shopify-retry` picks up RECEIVED (stuck) and FAILED events, max 5 attempts, then
    NEEDS_ATTENTION with a human-readable message and a Retry button in the UI.
```

Shopify retries undelivered webhooks 8 times over 4 hours; app-specific subscriptions are not
deleted on failure. The reconciliation poll (§12) is the safety net for anything missed.

## 8. Order sync

### 8.0 Implementation notes (Step 3, `orders-in.ts`, `order-webhooks.ts`)

- **Entry point:** `syncShopifyOrder(storeId, shopifyOrderId, ctx)` for all five topics, reconciliation, backfill and
  manual Retry. Always re-fetches the order (payload = hint). Core calls only: `createExternal`,
  `syncExternalUpdate`, `adjustLineQuantity`, `cancelOrder`, `flagAttention`, `addOrderNote`.
- **Line resolution:** mapping row (MATCHED) → internal variant; else exact SKU (trim + upper-case) against ACTIVE
  variants, remembering the match as a mapping. Any unresolved *shippable* line → no V3PL order, attention log with
  the exact reasons and a Retry action. Never by title.
- **Non-shipping lines (`requiresShipping=false`, Option A, D-050):** never passed to the core → no OrderItem, no
  reservation, no picking. Recorded on the order via `addOrderNote` and in the sync-log message. A SKU-less
  non-shipping line never fails the import. All-non-shipping order → **no V3PL order in v1** (core requires ≥ 1 line;
  logged as SKIPPED “no warehouse action required”; see §6.1).
- **Reservation:** `reserve: true` at the store's first warehouse regardless of payment (D-028); no warehouse →
  created unreserved + attention. Insufficient stock is handled by the core (short lines unreserved, attention).
- **Updates are state-based:** header via `syncExternalUpdate` (Shopify statuses raw, tags, ship-to while unshipped;
  stale `updatedAt` ignored; notes not overwritten after import); lines target Shopify `currentQuantity` via
  `adjustLineQuantity` (release on decrease, reserve on increase); below shipped/picked quantity → attention
  (“record a Return”). Lines added in Shopify → attention (v1). `cancelledAt` → `cancelOrder` (release);
  already-cancelled → no-op.
- **Idempotency keys:** Shopify event id (or webhook id) suffixed per write: `:create`, `:header`, `:line:<itemId>`,
  `:cancel`; reconciliation uses `reconcile:<orderId>:<updatedAt>`. Combined with `UNIQUE (storeId, shopifyOrderId)`,
  the core's replay guards and delta-only reservation, 5 concurrent deliveries yield one order and one set of movements.
- **Settings:** `importTestOrders` (default off), `ordersImportSince` (set at first connect; editable);
  `sourceRef = "<shop domain> <order name>"` keeps `UNIQUE (source, sourceRef)` distinct across stores.
- **Scheduling:** daily `reconcileOrders` (orders `updated_at:>checkpoint`), Admin “Sync orders now”, “Import orders
  since…” backfill (60-day window), per-row Retry on the Orders tab.

### 8.1 Import / update algorithm

```text
resolve store (status CONNECTED, ordersImportEnabled)
fetch order by id (GraphQL, §13 query) → skip `test` orders on non-dev stores
match: Order WHERE (shopifyStoreId, shopifyOrderId)
├─ EXISTS
│    if payload.updatedAt <= order.shopifyUpdatedAt → SKIPPED_STALE
│    apply header changes only (financial status, tags, note, shipping address if nothing shipped)
│    line changes only via orders/edited / refunds handlers; never re-create lines
│    preserve internal id, order number, line owners, inventory & fulfilment history
└─ NOT EXISTS
     for each line item:
       variantId → ShopifyVariantMapping(storeId, shopifyVariantId) MATCHED → internal variant
       else line.sku exact-match against ProductVariant.sku → internal variant
            (and upsert the mapping as SKU_EXACT — SKU is the defined key, this is not guessing)
       else (no variant / no sku / no match) → collect failure "SKU {sku} not found"
     any failure → ShopifySyncLog FAILED listing every unknown SKU; NO order, NO movement
     all resolved → orders.createExternal(..., reserve = policy(§8.2))
       insufficient stock on a line → order still created, needsAttention = true,
       reason lists SKU + short qty; no negative available (D-007)
     store identifiers, ShopifySyncLog SUCCESS
```

Matching uses only (store, Shopify order ID). Order name, customer, amount, dates are never
merge keys (D-013). Two stores can both have `#1001`; they are different orders.

### 8.2 Reservation policy (decided, D-028)

**Reserve on import for every non-cancelled order regardless of payment status, as long as
inventory is available.** Shopify already decrements its own available quantity when the order
is placed; if V3PL did not reserve, the next publish would push the stock back to Shopify and
oversell. Cancellation / void releases. Insufficient stock → order created, line left
unreserved, `needsAttention` with the SKU and short quantity; reservation is retried by the
Admin (*Reserve now*) or automatically when a receipt for that SKU is posted.

### 8.3 Data imported per order

Stored on the internal order: Shopify order id + name, created/updated/cancelled timestamps,
financial status, fulfillment status, currency, subtotal / discounts / tax / shipping / total,
shipping lines (title, code, price), shipping address + recipient name + phone + email
(fulfillment contact only), note, tags, source name, `test` flag. Per line: line item id,
variant id, product id, SKU, title/variant title snapshots, quantity, unit price, discount
allocations total, tax total, requires-shipping flag. Refunds: id, date, refunded line
quantities, restock flag. **Not** imported: customer account ids, marketing consent, payment
details, browser/IP data, billing address, order risk data.

### 8.4 Customer directory sync (Step 6, `customers-sync.ts`, D-065)

Shopify customers are **synchronised into** the existing V3PL customer directory (D-060); the directory stays the
operational record and Shopify only enriches it.

- **Identity** = (`Customer.shopifyStoreId`, `Customer.shopifyCustomerId` = numeric Shopify id), the unique pair
  reserved by D-060. E-mail is never the identity: the same e-mail in two stores gives two records.
- **Core contract** `upsertShopifyCustomer(ref, values, actorId)` in `services/customers.ts` (the Shopify layer
  never writes `Customer` itself): mapped → update, with Shopify values overwriting **only when non-empty** (notes,
  billing address, owner, source and any contact data Shopify does not know are never blanked); not mapped → an
  unmapped **company** customer (`ownerId` NULL) with the same e-mail is linked once (audit `customer.shopify_linked`)
  instead of duplicated, vendor / 3PL owner pools are never touched; otherwise a company customer is created with
  source `SHOPIFY`. Idempotent (same input → `unchanged`); a lost unique race falls back to update.
- **Fields synced (data minimisation):** name (`displayName` → first/last → address name → e-mail → "Shopify
  customer <id>"), default e-mail, default phone (fallback: address phone), default address → ship-to fields.
  Not read: tags, notes, marketing state, spend, order history, other addresses, metafields.
- **Run**: Admin action *Sync customers now* (store Overview) — no job, like the catalog sync. `customers(first: 100,
  after, query, sortKey: ID)` with `defaultEmailAddress` / `defaultPhoneNumber` (the 2026-07 replacements for the
  deprecated `email` / `phone`), cursor pagination inside a 120 s budget. First run reads everything; later runs
  filter `updated_at:>=` (last complete run − 10 min). `ShopifyStore.lastCustomerSyncAt` is stamped only after a
  complete run; a partial run says so and is simply re-run. One bad record → counted `failed`, logged
  `NEEDS_ATTENTION` (entity `CUSTOMER`, `externalId` = Shopify id), the page continues. The summary row
  (`customer_sync`, no `externalId`) feeds the Overview card.
- **Order relation**: when a store granted `read_customers`, importing a **new** Shopify order first resolves its
  customer through the same upsert (one `order { customer }` query) and sets `Order.customerId`; the order keeps its
  own ship-to snapshot. Failures are logged (`order_customer`) and never block the import; stores without the
  scope import exactly as before. No backfill of orders imported earlier.
- Not built (deliberate): `customers/create|update` webhooks, scheduled customer sync, writing customers to
  Shopify, per-owner assignment of store customers (all store customers are company customers), `customers/redact`
  automation (still CUS-06).

## 9. Catalog / variant mapping (implemented in Step 2 — rules approved 2026-09-07, D-049)

Implementation notes (`catalog.ts`, `catalog-match.ts`, `mapping.ts`, `catalog-import.ts`, `catalog-webhook.ts`):

- **Pull:** `productVariants` paged at 250 (id, sku, title, barcode, price, inventoryItem.id, product id/title/status);
  `productVariantsCount` decides `paged` vs `bulk` (threshold 2 000); bulk = `bulkOperationRunQuery` → poll
  `node(id)` → JSONL download. Inventory quantities are never read.
- **Match (pure, unit-tested):** normalisation = trim + upper-case only. MATCHED `SKU_EXACT` when exactly one ACTIVE
  internal variant (of an ACTIVE product) carries the SKU; CONFLICT when the SKU appears on 2+ Shopify variants of the
  store or the internal variant is mapped MANUALLY to another Shopify variant; UNMATCHED for no SKU / no match /
  archived. MANUAL rows are never changed by sync. IGNORED is sticky until the Shopify SKU changes (a variant with no
  SKU that later gets one is released). Titles are never consulted.
- **Prune after a full sync:** vanished UNMATCHED/CONFLICT/IGNORED rows deleted; vanished SKU_EXACT rows deleted +
  attention log; vanished MANUAL rows kept and flagged once.
- **Database guard:** unique `(storeId, variantId)` — one internal SKU ↔ at most one Shopify variant per store
  (migration `20260907090000_shopify_mapping_unique_variant`).
- **Import (explicit only):** select UNMATCHED variants → owner → preview grouped per Shopify product (owner editable
  per product, live barcode/price, row errors incl. “SKU already belongs to …”) → confirm → core `createProduct` →
  mappings MATCHED. Stateless; nothing is created without confirmation; inventory untouched.
- **Webhook `products/update`:** re-fetches the product's variants, upserts snapshots, prunes removed variants,
  re-matches the store. **Daily:** `syncCatalog` per connected store inside the maintenance run.

Original design text follows.

- **Catalog sync** (Admin: *Sync products*, also nightly): pull all products/variants for the
  store (`products` connection with `variants { id sku inventoryItem { id } }`; **bulk operation**
  automatically when the store exceeds ~2,000 variants). For each variant: exact SKU match →
  `MATCHED (SKU_EXACT)`; no SKU or no match → `UNMATCHED`; same SKU seen on two variants in one
  store → `CONFLICT`. Nothing is created in V3PL by this step.
- **Mapping review screen**: filter UNMATCHED / CONFLICT, search, and either *Map to internal
  SKU* (manual, audited) or *Ignore*. Title is displayed to help the human, never used to match.
- **Import unmatched products into V3PL** (optional, uses the core CSV-style flow):
  Preview → Admin assigns **owner per row** (a store never implies an owner) → validate SKU
  uniqueness → confirm → core `products.create` → mapping becomes MATCHED. Only fields the
  business uses are mapped (title, SKU, variant options, price, barcode, image URL).
  **Initial stock destination (D-067, 2026-09-22):** the preview shows Shopify's sellable quantity per
  variant as a reference; the Admin may enter an initial quantity per SKU and must then choose the V3PL
  destination (active warehouse + active location of that warehouse, default = the store's default
  reservation warehouse / its default location). Quantities are booked through the core initial-stock
  contract (one receipt "Initial stock" per product); no quantities = the unchanged data-only import.
  A Shopify location is never a V3PL warehouse; nothing maps Shopify locations to warehouses.
- Export: product/mapping/inventory CSV from the same screen (core export engine).

## 10. Idempotency (four layers)

| Layer | Guarantee |
|---|---|
| `UNIQUE (shopifyStoreId, shopifyOrderId)` on Order | one internal order per Shopify order |
| `UNIQUE (webhookId)` on ShopifyWebhookEvent + stale check on `updatedAt` | each delivery processed once, out-of-order updates ignored |
| `InventoryTransaction.externalEventId` + core checks | a Shopify event moves stock at most once |
| `UNIQUE (shopifyStoreId, shopifyFulfillmentId)` + `ShopifyOutboundJob.dedupeKey` | one Shopify fulfillment per shipment, one internal shipment per Shopify fulfillment |

All application checks execute inside the same DB transaction as the insert that carries the
constraint, so concurrent duplicates fail at the database, not in code.

## 11. Inventory publish (platform → Shopify, one-way)

- Per store: `publishEnabled` (default **off**), `publishLocationId`, warehouses via
  `ShopifyStoreWarehouse`, `publishRule = ALL_AVAILABLE` (v1: published = Σ available across
  mapped warehouses). Rule is an enum so a future split (per-store pool / percentage) is a value,
  not a migration.
- Trigger: `INVENTORY_PUBLISH` jobs from the core hook (coalesced per variant), plus a periodic
  sweep and a manual *Publish now*.
- Execution per store: for each MATCHED mapping of the affected variants → compute available →
  if equal to `lastPublishedAvailable` skip → `inventorySetQuantities { name:"available",
  reason:"correction", quantities:[{inventoryItemId, locationId, quantity,
  changeFromQuantity: lastPublishedAvailable}] }` (first publish uses the read current value; field
  named `compareQuantity` before Admin API 2026-07).
  Compare mismatch = someone changed Shopify manually → log `NEEDS_ATTENTION` with both values;
  Admin resolves with *Force publish*. Never publish for UNMATCHED / CONFLICT mappings.
- Every push logs previous value, new value, result in `ShopifySyncLog`.
- Because Shopify decrements available on sale and V3PL reserves on import, the two stay in
  step (**both sides equal is never a conflict**, D-066 — see 11.1);
  step; publishing simply corrects drift and pushes receipts/adjustments out.

### 11.1 Implementation notes (Step 4, `inventory-publish.ts`, D-052; conflict rule corrected by D-066)

- **Conflict rule (D-066, 2026-09-22):** after reading Shopify, `publishVariant` first checks whether Shopify
  already shows what V3PL would publish. If so the SKU is **in sync** whatever was published last: the baseline
  (`lastPublishedAvailable`) is re-anchored and nothing is written. This is the normal state after a
  Shopify-originated sale (Shopify decremented at checkout, V3PL reserved the same quantity on import) and after a
  publish whose response was lost. Only when Shopify differs from **both** the last published value **and** V3PL's
  available is it a conflict ("changed in Shopify by hand? Not overwritten"). Before this rule every Shopify sale
  produced a permanent conflict, which then also blocked the publish that carries V3PL-created orders (§12.2).
- **Publish location change (D-066):** the baseline belongs to the location it was written to, so
  `updateStoreSettings` clears `lastPublishedAvailable` / `lastPublishedAt` for every mapping of the store when the
  publish location changes; the next publish of each SKU anchors on the new location's current value
  (first-publish semantics). Production had been in a permanent conflict since 2026-09-15 because 281 was
  published to "My Custom Location" and the store was then switched to "Shop location" (≈192).

- `publishVariant(storeId, variantId, { force?, verify? })` is the single write path; jobs, *Publish
  all now*, *Force publish*, the sweep and the initial publish all call it.
- **Fast path:** if V3PL available equals `lastPublishedAvailable` the variant is skipped without any
  Shopify call (hooks fire on every ledger write, so most runs end here). The **daily sweep passes
  `verify`** which skips that shortcut and reads Shopify for every matched SKU, so a manual edit in
  Shopify is surfaced as a conflict within a day even when V3PL never changed.
- **Compare baseline:** `changeFromQuantity = lastPublishedAvailable ?? Shopify current` — the first
  publish after enabling adopts whatever Shopify shows as the baseline (approved decision #6). Two
  conflict signals, both → `NEEDS_ATTENTION` log with both values and a `NonRetryableJobError`
  (job goes straight to *Needs attention*, no retries): Shopify read ≠ last published (“changed in
  Shopify by hand”), or Shopify rejects the compare because the value moved between our read and
  our write (“changed while publishing”). Neither path ever overwrites; *Force publish* sends
  `changeFromQuantity: null` (2026-07: null skips the compare-and-set; `ignoreCompareQuantity` no
  longer exists) and is confirmed in a dialog. A stale compare comes back as user error
  `CHANGE_FROM_QUANTITY_STALE`; idempotency user errors are handled too (`IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED`
  / `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` → one retry with a fresh key; `IDEMPOTENCY_CONCURRENT_REQUEST` →
  retryable job failure).
- **Activation (decision #5):** an inventory item not stocked at the publish location is
  `inventoryActivate`d there (logged as `inventory_activate`), then treated as current = 0.
- **`@idempotent` (Admin API 2026-04+, verified on 2026-07):** both inventory mutations are written
  as `mutation (…, $idempotencyKey: String!) { inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { … } }`
  (same for `inventoryActivate`); without the field-level directive the API answers
  “The @idempotent directive is required for this mutation but was not provided”. The key is a
  random UUID per execution (`chooseIdempotencyKey`), scoped to the exact write intent
  (item, location, quantity, compare, force). An `INVENTORY_PUBLISH` job stores `{ key, intent }` in
  `job.result.idem` *before* calling Shopify; a retry with the identical intent reuses the key (Shopify
  replays the stored result — one mutation, never two) and, if the read already shows our target
  quantity, the retry recognises its own applied write instead of raising a false “changed by hand”
  conflict. Any change of intent gets a new key; a DONE job clears its keys. Direct calls (Force
  publish, sweep, Publish all) use a fresh key each time — compare-and-set keeps them safe.
  `inventoryAdjustQuantities` is not used anywhere (state-based `set` only).
- **Publishing off** (default): the inventory hook enqueues nothing for the store (no backlog to
  flush later); the runner and the sweep return `skipped_disabled`. Flipping the switch on runs
  `enqueuePublishAll` + drain (initial publish) from the settings action.
- Shopify quantities are never written into V3PL; the read is only used for compare.

## 12. Fulfillment and tracking sync

### Outbound (warehouse ships in V3PL)

```text
shipment shipped (core) → ShopifyOutboundJob(FULFILLMENT_CREATE, dedupeKey fulfillment:{shipmentId})
job runner:
  lock job (PENDING→RUNNING)
  order.fulfillmentOrders(status OPEN/IN_PROGRESS) with lineItems { id lineItem { id } remainingQuantity }
  match shipment lines → fulfillment order line items by shopifyLineItemId
  if FO assignedLocation ≠ store.fulfilLocationId → fulfillmentOrderMove(newLocationId)
  guard: order.fulfillments already contains one with the same tracking number → adopt its id
  fulfillmentCreate({ lineItemsByFulfillmentOrder:[…], trackingInfo:{company, number, url},
                      notifyCustomer: true })   // D-029: Shopify sends its normal shipping e-mail
  store shopifyFulfillmentId on Fulfillment, Shipment.shopifySyncedAt, log SUCCESS
  → DONE   (failure → attempts++, backoff, NEEDS_ATTENTION after 5)
tracking edited later → TRACKING_UPDATE job → fulfillmentTrackingInfoUpdate
```

Partial shipments map naturally: each internal shipment becomes one Shopify fulfillment with only
its lines and quantities. The order is never marked fully fulfilled by us; Shopify derives it.

### Inbound (fulfillment created or changed in Shopify Admin)

- `fulfillments/create` (D-032, mirror automatically): if `shopifyFulfillmentId` already known
  → PROCESSED (it is ours). Otherwise → `fulfillment.recordExternalShipment` (lines by
  `shopifyLineItemId`, carrier, tracking, date, `externalFulfillmentId`, `externalEventId`) →
  internal Fulfillment + Shipment created once (unique `(storeId, shopifyFulfillmentId)`),
  reservation consumed once (`externalEventId` on the ledger rows). A line that was never
  reserved (insufficient stock at import) is shipped from on-hand if available, otherwise the
  order is flagged `needsAttention` (“shipped in Shopify but no internal stock”) and no
  negative stock is created.
- `fulfillments/update`: match by `shopifyFulfillmentId` → update tracking / shipment status
  (`in_transit`, `delivered`, `failure` → internal shipment status) in place. Never a new shipment.

### 12.1 Implementation notes (Step 4, `fulfillment-out.ts`, `fulfillment-in.ts`, `core-bridge.ts`, D-052)

- **Outbound runner** (`runFulfillmentCreateJob`): skips EXTERNAL (mirrored) fulfilments and already
  linked ones; reuses a Shopify fulfillment id remembered in `job.result` from an earlier attempt;
  adopts an existing Shopify fulfillment with the same tracking number (lost response / created in
  Admin) instead of creating another; allocates shipped quantities to open fulfillment-order line
  items by `shopifyLineItemId`; moves fulfillment orders assigned elsewhere to
  `store.fulfilLocationId` (approved decision #2) — a refused move is `NonRetryable` → attention with
  the Shopify reason; “nothing left to fulfil” (already fulfilled in Shopify / lines changed) is
  attention, never a duplicate; `fulfillmentCreate` sends carrier text + tracking number + URL and
  `notifyCustomer: true` (D-029, decision #4).
- **Linking** the V3PL fulfilment to the Shopify id goes through the core contract
  `fulfillment.recordExternalReference(fulfillmentId, { shopifyStoreId, shopifyFulfillmentId }, actorId)`
  (**R-1**, core commit `2610588`, D-051). `{ updated: false }` = the same reference was already
  recorded → treated as a successful idempotent replay. `BAD_STATUS` (linked to another Shopify id,
  store mismatch, unshipped, or the Shopify id already linked to another V3PL fulfilment),
  `INVALID_REFERENCE` and `NOT_FOUND` cannot be fixed by retrying: the Shopify id is kept in
  `job.result` (so a later Retry adopts, never re-creates) and the job goes straight to
  `NEEDS_ATTENTION` with the core's reason. The Shopify layer never writes `Fulfillment` /
  `Shipment` rows. The created job also remembers `sentTracking` (what Shopify was given).
- **Tracking updates** (`runTrackingUpdateJob`): enqueued by the shipment hook on
  `ShipmentEvent.kind === "TRACKING_UPDATED"` (**R-2**; the core fires it once per real change and
  not at all when the saved tracking is identical). `fulfillmentTrackingInfoUpdate` on the linked
  id. Not linked yet with the push job still PENDING/FAILED → done without a call (the push reads
  the shipment when it runs and carries the latest tracking); not linked and no push pending →
  attention (“push the fulfilment first”). If the tracking equals what was last sent (by the push
  or a previous tracking job, from `job.result.sentTracking`) the mutation and its customer e-mail
  are skipped.
- **No loop-back:** the hook ignores every event with `external: true` — mirrored (EXTERNAL)
  fulfilments and any update driven by an external event id (inbound webhooks pass
  `<eventId>:tracking` / `<eventId>:status`). So a fulfillment or tracking change that started in
  Shopify is never pushed back to Shopify.
- **Inbound** (`fulfillmentWebhookHandlers`): the fulfillment is re-fetched by id (payload never
  trusted). Known id → `updateShipmentTracking` / `updateShipmentStatus` with per-event idempotency
  suffixes (`:tracking`, `:status`); status mapping `shipmentStatusFor`: DELIVERED / PICKED_UP →
  DELIVERED, IN_TRANSIT / OUT_FOR_DELIVERY / ATTEMPTED_DELIVERY → IN_TRANSIT, CANCELLED / FAILURE /
  NOT_DELIVERED → **attention only**, shipment and stock untouched (decision #3). Unknown id →
  `recordExternalShipment(... externalEventId "<eventId>:mirror")`, which the core guards by
  `UNIQUE(shopifyStoreId, shopifyFulfillmentId)` and the event id — redelivery is a no-op and the
  reservation is consumed exactly once. A cancelled fulfillment that was never mirrored is ignored.
- **Scheduling (decision #7):** both hooks call `scheduleAfterResponse(storeId)`, which uses Next’s
  `after()` to drain the store’s jobs right after the shipping / receiving request responds; outside
  a request scope it is a no-op and the drain / daily run picks the jobs up.

### 12.2 Outbound orders — manual V3PL order → Shopify order (`order-out.ts`, D-061 core / D-062 Shopify)

- **Trigger:** core `requestShopifyOrder` (order page "Send to Shopify", order form "send after creating")
  queues one `ORDER_CREATE` job per order (`order:{orderId}`); the action then calls
  `scheduleAfterResponse(storeId)` so the job runs right after the response. Drain, daily cron and Retry
  are the fallbacks. Nothing here calls Shopify from the browser or picks a store — core resolves it.
- **Runner order of operations** (`runOrderCreateJob`): (1) the V3PL order already has a
  `shopifyOrderId` → done (the inbound webhook or an earlier run recorded it); (2) `buildShopifyOrderRequest`
  (typed core errors → attention); (3) store must be `CONNECTED` and `grantedScopes` must include
  `write_orders`, else attention "Reconnect the store"; (4) id remembered in `job.result` from an
  earlier attempt → link only; (5) **adoption**: `orders(query: "tag:'V3PL-<orderNumber>' status:any")`
  filtered on `v3pl_idempotency_key = order:<id>` and not cancelled → link only; (6) `orderCreate`.
  After (6) the id is written to `job.result` **before** `recordShopifyOrderReference`, so a crash or
  a refused link (`BAD_STATUS` → attention, id kept) can never lead to a second `orderCreate`. A DONE
  `ORDER_CREATE` job is never re-armed by `enqueueJob`.
- **Mutation:** `orderCreate(order: OrderCreateOrderInput!, options: OrderCreateOptionsInput)` returning
  `order { id name … } userErrors { field message code }`. No `@idempotent` directive exists for it
  (2026-07); idempotency is the adoption + remembered-id chain above.
- **Order input:** `currency` (V3PL order currency), `financialStatus: PENDING` (V3PL knows no payment;
  the merchant records it in Shopify), `processedAt` = V3PL `placedAt`, `lineItems[{ variantId (from the
  mapping in the contract), quantity, requiresShipping: true, priceSet: V3PL unitPrice in the order
  currency }]` — the **V3PL retail price is the price of record**; `priceSet` is omitted only when V3PL has
  no price (Shopify then uses the catalog price). `email` / `phone` from the contract customer; **no
  `customer` object** (no customer scopes); `shippingAddress` / `billingAddress` as `MailingAddressInput`
  (name split first/rest, `provinceCode`/`countryCode` when V3PL holds codes, `province`/`country` text
  otherwise); one `shippingLines` entry `{ title: shippingMethod ?? "Shipping", priceSet: shippingTotal }`
  when either is set; taxes and discounts are not sent (v1).
- **V3PL-origin marker (exact wording):** tags `V3PL` and `V3PL-<orderNumber>` (V3PL order tags appended);
  note `Created from V3PL order <orderNumber>.` followed by the V3PL notes on a new paragraph when present;
  custom attributes `V3PL order` = `<orderNumber>` and `v3pl_idempotency_key` = `order:<v3plOrderId>`.
- **Options:** `inventoryBehaviour: BYPASS`, `sendReceipt: false`, `sendFulfillmentReceipt: false`.
- **Inventory — how double deduction is prevented:** (a) `BYPASS` makes Shopify neither claim nor
  decrement stock for the order; Shopify quantities keep coming exclusively from V3PL publishing (§11) —
  the reservation made with the V3PL order re-arms the SKU's `INVENTORY_PUBLISH` job, and that publish is what
  lowers Shopify's available by the ordered quantity (verified on the dev store 2026-09-22, D-066). `DECREMENT_*`
  was rejected again in D-066: the publish job is created inside the order transaction and drains **before**
  `ORDER_CREATE`, so Shopify's own claim would land on top of the already-published reservation (double deduction);
  so a compare-and-set publish after the reservation lands cleanly instead of colliding with a Shopify-side
  decrement; (b) the V3PL reservation made when the manual order was created is the only stock effect —
  the runner performs no inventory or order writes; (c) the `orders/create` webhook for the new Shopify
  order is recognised by `v3pl_idempotency_key` and **linked, never imported** (`orders-in.ts`
  `linkV3plOriginOrder`), so `createExternal` and a second reservation never run; a second Shopify order
  claiming an already-linked V3PL order is refused with attention.
- **Webhook race:** `orders/create` may arrive before the runner has recorded the reference. Both paths
  call `recordShopifyOrderReference` with the same `(store, shopifyOrderId)`: the first wins, the second
  gets `{ updated: false }`; the runner then reports "already created" and finishes DONE without calling
  Shopify. Verified in `e2e:shopify-order-create` (18a–18c).
- **Fulfilment compatibility:** the shipment hook now enqueues `FULFILLMENT_CREATE` / `TRACKING_UPDATE`
  for any non-external shipment whose order carries `shopifyOrderId` (Shopify-originated orders always
  do; manual orders once created). Because V3PL-created orders have no `OrderItem.shopifyLineItemId`,
  `fulfillment-out.ts` allocates fulfillment-order lines by Shopify line id when known, else by the
  store's variant mapping, else exact SKU; `orders-in.ts` `matchLines` does the same for inbound edits
  and leaves an unmatched V3PL line untouched (never target 0). A shipment made **before** the Shopify
  order existed is not pushed retroactively (known limitation, v1).
- **Errors:** Shopify `userErrors` (validation) → `NEEDS_ATTENTION` immediately with field/message/code;
  `UNAUTHORIZED` / `NOT_CONNECTED` / missing scope → attention (reconnect); transport / 5xx / throttling
  → `FAILED` with `jobs.ts` backoff (max 5 attempts); every failure also calls `markShopifyOrderFailed`
  so the order page shows the reason (no-op once a reference exists). Sync log entity `ORDER`,
  operation `order_create` (outbound) / `order_link` (inbound link).

## 13. Reconciliation, retry, scheduling — free-tier design (D-031)

> **Runner registration is per module instance (fixed 2026-09-15).** The job registry in `jobs.ts` is
> module state. The production (Turbopack) server bundle contains several instances of `jobs.ts` /
> `runners.ts` / `register.ts` — instrumentation, route handlers, server actions, the cron route — and
> the former `globalThis` once-flags let only the first instance (instrumentation) register. Every
> instance that actually drains (webhook `after()`, "Run pending now", `after()` from the order action,
> cron) therefore saw an **empty registry**, `runDueJobs` filtered on `type in []`, and jobs stayed
> `PENDING` with 0 attempts (observed in production for `ORDER_CREATE`; reproduced locally for
> `FULFILLMENT_CREATE` too). Fix: module-local guards, and `jobs.ts` lazily imports `./runners` in
> `runJob` / `runDueJobs` (`ensureRunnersRegistered`) so the draining instance always has its runners.
> Proven through the built server by `npm run e2e:shopify-runner`. **Core side fixed the same day:** the core
> hook arrays (`fulfillment-hooks.ts`, `inventory-hooks.ts`) had the same exposure — `register.ts` registered
> into instrumentation's instance while a server action shipping an order ran its own instance's
> `runShipmentHandlers` with an empty array (V3PL 1586 shipped, Shopify #1010 stayed Unfulfilled). The hook
> runners now lazily `await import("@/server/services/shopify/register")` into their own instance before
> reading the registry (`ensureShipmentHandlersRegistered` / `ensureInventoryHandlersRegistered`; cycle-safe,
> idempotent, a failed import is logged and never blocks the warehouse action). Proven by `npm run e2e:hooks`
> (fresh processes + `shipFulfillmentAction` through the built server). A fresh V3PL shipment of a
> Shopify-linked order should now enqueue `FULFILLMENT_CREATE` and push; already-shipped orders (#1010) got no
> job and need the shipment re-pushed manually or a new test order.

Hosting is GitHub → Vercel **Hobby**: crons at most once per day (±59 min precision), functions
up to 300 s, `waitUntil` available. Nothing in this design requires a paid Vercel feature.

**Layer 1 — real time: webhooks.** Primary sync mechanism. Each event is recorded, acknowledged,
and processed in the same invocation via `waitUntil`. Shopify itself retries failed deliveries
8 times over 4 hours, so transient V3PL failures are covered by Shopify, not by our cron.

**Layer 2 — immediate outbound.** Fulfillment pushes and inventory publishes are enqueued as
`ShopifyOutboundJob` rows inside the core transaction and executed right after the response via
`waitUntil`. No waiting for a scheduler.

**Layer 3 — piggyback tick.** Every webhook processing run and every load of the
`Settings → Shopify Stores` pages ends with `drainPending(storeId, budget)`: retry up to N
due jobs/events for that store within a small time budget (e.g. 10 items / 20 s). Active stores
therefore self-heal continuously without any scheduler.

**Layer 4 — daily cron.** One Vercel cron, `/api/cron/shopify-daily` (e.g. `0 3 * * *`),
protected by `CRON_SECRET`, runs per store in sequence with checkpoints so it stays under 300 s
and resumes where it left off if cut short:

1. refresh access tokens (keeps refresh tokens alive, D-022);
2. retry everything due (events + jobs) that layers 1–3 did not clear;
3. reconcile orders `updated_at > checkpoint` through the normal import/update path;
4. publish sweep for publish-enabled stores (drift correction);
5. catalog sync (SKU changes → mapping status);
6. clean up abandoned `PENDING_INSTALL` rows; write a `ShopifySyncLog STORE HEALTH` row
   (webhook silence > 24 h with orders present in reconcile = alert on the dashboard).

**Layer 5 — manual.** *Sync orders now*, *Retry*, *Publish now*, *Sync products*, *Test
connection* buttons run the same code paths on demand.

Token refresh also happens on demand before any API call (5-minute margin), so the 24-hour
access-token lifetime never depends on cron precision.

**Optional, needs approval before adding (D-031):** a GitHub Actions scheduled workflow in this
repository calling `/api/cron/shopify-tick` with the secret every 30 minutes would upgrade
layers 3–4 to a 30-minute worst case. It uses ≈1,440 Actions minutes/month, inside the free
allowance for private repositories, and adds no new service. Not included until approved.

Not used: Vercel Pro crons, Vercel Queues/Workflows, Render or any other host, Redis, external
queue services.

## 14. GraphQL client

- Base URL `https://{shop}/admin/api/{SHOPIFY_API_VERSION}/graphql.json`, header
  `X-Shopify-Access-Token`. Version pinned by env; upgrade is a deliberate task each quarter.
- Handles `THROTTLED` (cost-based) with backoff using `extensions.cost.throttleStatus`, retries
  idempotent reads, never blindly retries `fulfillmentCreate` (goes through the job guard).
- Query documents live in `services/shopify/queries/` (order by id, orders since, products page,
  fulfillment orders for order, shop + locations, mutations above). Bulk operations
  (`bulkOperationRunQuery` + JSONL download) only for catalog sync on large stores and for
  historical/large exports.

## 15. Security

- Client secret, tokens, encryption key: server env / encrypted DB columns only. Never sent to
  the browser; the UI receives store status, masked domain, timestamps and logs only.
- Webhooks verified before any DB write; compliance endpoints return 401 on bad HMAC.
- All Shopify admin routes: Firebase-verified session + role `ADMIN` (server-side).
- Store data isolation: every query filtered by `storeId`; there is no cross-store operation.
- Vendor/3PL portals never see Shopify credentials or logs; they see orders/fulfilment only
  through the core ownership filter.
- `.env.example` documents variables; real values only in `.env.local` / Vercel.

## 16. Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `SHOPIFY_API_KEY` | `.env.local`, Vercel (all envs) | App **Client ID** from Dev Dashboard → Settings |
| `SHOPIFY_API_SECRET` | `.env.local`, Vercel (sensitive) | App **Client secret**; OAuth + webhook HMAC |
| `SHOPIFY_API_VERSION` | both | `2026-07` |
| `SHOPIFY_SCOPES` | both | comma list from §3 |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | `.env.local`, Vercel (sensitive) | 32-byte base64 key for AES-256-GCM |
| `CRON_SECRET` | Vercel (sensitive) | protects `/api/cron/shopify-*` routes (Vercel Cron sends it automatically as the bearer token) |
| `NEXT_PUBLIC_APP_URL` | both | real deployment URL; used to build `redirect_uri` |

## 17. Admin UI (`/admin/settings/shopify`)

- **Stores list**: card per store — name, domain, status badge, last order sync, last publish,
  last webhook, open attention count; `+ Add Shopify Store`.
- **Store detail** tabs: *Overview* (Test connection, Sync orders now, Sync products, Sync customers now
  with last complete sync + counts, Publish now, Reconnect, Disconnect), *Settings* (import on/off, publish on/off, location, warehouses,
  reservation policy, notify customer), *Product mapping* (§9), *Sync log* (filters, Retry,
  human-readable messages), *Webhooks* (recent events + status).
- Dashboard widget: “Shopify needs attention: N” linking to the filtered log.
- Technical terms hidden where possible (“Connected”, “Needs reconnect”, “SKU not found”), never
  raw GraphQL errors as the primary message.

## 18. Test matrix (gate before any live store)

1. Store A + Vendor A order → one order, correct owner, reservation.
2. Store A order with SKUs of Vendors A, B, C → one order, three owners on lines.
3. Stores A and B connected → same order name `#1001` in both stays two orders; no cross-talk.
4. Same webhook re-delivered 5× and same order re-fetched by reconcile → one order, one set of
   movements.
5. Unknown SKU → FAILED with the exact SKU; no order, no movement; fix SKU → Retry → imported.
6. Partial shipment in V3PL (A+B, then C) → two Shopify fulfillments with correct lines; retry of
   the job creates nothing new.
7. Tracking edited in V3PL → Shopify updated. Tracking added in Shopify Admin → internal shipment
   updated in place.
8. Fulfillment created in Shopify Admin → mirrored internally once, reservation consumed once.
9. Cancel after reservation → released. Refund before shipment → line reduced, released. Refund
   after shipment → NEEDS_ATTENTION, no automatic restock.
10. Publish: receipt of +10 → Shopify available +10; manual change in Shopify → conflict logged,
    not overwritten; `publishEnabled=false` → nothing pushed.
11. Token refresh across the 24 h boundary; uninstall → UNINSTALLED and tokens gone.
12. Vendor portal shows the Shopify order line for its SKU only; no store credentials visible.

## 19. Business decisions (resolved 2026-09-02)

| Topic | Decision | Record |
|---|---|---|
| Reservation policy | Reserve on import regardless of payment, unless cancelled; only when stock is available | D-028 |
| Customer notification | `notifyCustomer: true` on outbound fulfillment | D-029 |
| Historical orders | Not required initially; no `read_all_orders` | D-023 / D-030 |
| Hosting | GitHub → Vercel Hobby under the developer's accounts; webhooks primary, daily cron + piggyback for the rest | D-031 |
| Shopify-created fulfillments | Mirror automatically, consume reservation exactly once | D-032 |

## 20. Hosting constraints and known risks

- **Vercel Hobby fair-use terms** restrict the plan to non-commercial, personal use. The V3PL
  platform is a business system. Running it on Hobby is the developer's explicit choice for the
  build phase; a plan or account change before commercial go-live is recommended and is a
  configuration change only (same repo, same URLs if a custom domain is used).
- **Neon free tier** suspends compute when idle; the first webhook after a quiet period pays a
  cold start (typically well under the 5 s Shopify budget because the receiver only inserts one
  row before responding).
- **Daily cron precision** is ±59 minutes; nothing time-critical depends on it (§13).
- **Runtime logs** on Hobby are retained for a short window; `ShopifySyncLog` and
  `ShopifyWebhookEvent` in the database are the durable audit trail.
