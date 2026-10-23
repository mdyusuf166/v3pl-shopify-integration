# Core capability requests (Shopify session → Core session)

Per D-027 the Shopify integration never writes core tables directly. When it needs a new
capability it is requested here; the Core session implements it in `src/server/services/*` and
records it in `progress.md`. Requests are ordered by urgency.

---

## R-1 · `fulfillment.recordExternalReference` — **required for Step 4 (outbound fulfillment)**

**Requested 2026-09-07 · approved by client (Step 4 decision #1). ✅ Implemented by Core 2026-09-07 (D-051), `npm run e2e:core-requests`.**
Implemented contract: `recordExternalReference(fulfillmentId, { shopifyStoreId, shopifyFulfillmentId }, actorId): Promise<{ updated: boolean }>` with the semantics below plus: blank/missing inputs → `INVALID_REFERENCE`; the fulfilment's order must belong to `shopifyStoreId` and the fulfilment must be SHIPPED → otherwise `BAD_STATUS`; a null actor is attributed to the system admin for the audit row.

When V3PL pushes a shipment to Shopify (`fulfillmentCreate`), the Shopify layer must store
Shopify's fulfillment id on the V3PL fulfilment so that (a) a repeat push is a no-op, (b) the
inbound `fulfillments/create|update` webhooks recognise the fulfilment as ours, and (c) the
`UNIQUE (shopifyStoreId, shopifyFulfillmentId)` constraint protects against duplicates. The columns
exist since Step 1 (`Fulfillment.shopifyStoreId`, `Fulfillment.shopifyFulfillmentId`,
`Shipment.shopifySyncedAt`); no service sets them.

```ts
// src/server/services/fulfillment.ts
export async function recordExternalReference(
  fulfillmentId: string,
  ref: { shopifyStoreId: string; shopifyFulfillmentId: string },
  actorId: string | null,
): Promise<{ updated: boolean }>;
```

Semantics:

- Load the fulfilment (with its shipment). `NOT_FOUND` → `FulfillmentServiceError("NOT_FOUND")`.
- If `shopifyFulfillmentId` already equals `ref.shopifyFulfillmentId` → return `{ updated: false }` (idempotent).
- If it is set to a *different* id → throw `FulfillmentServiceError("BAD_STATUS", "Fulfilment is already linked to another Shopify fulfillment")`.
- Otherwise, in one transaction: set `Fulfillment.shopifyStoreId`, `Fulfillment.shopifyFulfillmentId`,
  `Shipment.shopifySyncedAt = now()`, add an order event `"shopify_synced"` (“Fulfilment sent to Shopify
  (<id>)”), `recordAudit("shipment.shopify_synced")`. A unique violation on
  `(shopifyStoreId, shopifyFulfillmentId)` should surface as `FulfillmentServiceError("BAD_STATUS")`.
- No stock movement, no status change.

Expected e2e (core): link once → `{updated:true}`; link again same id → `{updated:false}`; link a
different id → BAD_STATUS; linking the same Shopify id to a second fulfilment → BAD_STATUS.

## R-2 · Shipment hook on tracking updates — **required for Step 4 (tracking push)**

**Requested 2026-09-07. ✅ Implemented by Core 2026-09-07 (D-051).** `ShipmentEvent.kind: "SHIPPED" | "TRACKING_UPDATED"` (required); TRACKING_UPDATED events carry `tracking`, `previousTracking`, `externalEventId` and `external` (= fulfilment type EXTERNAL **or** the update came from an external event id). `updateShipmentTracking` now returns `{ changed }`, is a no-op (no event/audit/hook) when nothing meaningful changed, and fires exactly one hook per real change. Handlers in both registries run inside savepoints, so a handler that fails at the SQL level cannot abort the core transaction. `updateShipmentTracking()` updates the shipment but does not call
`runShipmentHandlers`, so a tracking number added/edited in V3PL after shipping cannot be pushed to
Shopify. Request: extend `ShipmentEvent` with `kind: "SHIPPED" | "TRACKING_UPDATED"` (default
`"SHIPPED"` for the existing call sites in `shipFulfillment` / `recordExternalShipment`) and call
`runShipmentHandlers(tx, { ..., kind: "TRACKING_UPDATED", external: fulfillment.type === "EXTERNAL" })`
at the end of `updateShipmentTracking`. Handlers already ignore failures and never call the network.

Consumed by the Shopify session 2026-09-07: `register.ts` branches on `kind` (SHIPPED → `FULFILLMENT_CREATE`,
TRACKING_UPDATED → `TRACKING_UPDATE`) and ignores `external: true`; `fulfillment-out.ts` calls
`recordExternalReference` directly (`core-bridge.ts` removed).

## R-3 · Honour `OrderItem.requiresShipping = false` (non-blocking, Step 3 follow-up)

Reservation (`reserveRemaining`), picking (`pickableQuantities`), quantity adjustment and status
derivation (`order-status.ts`) should skip lines with `requiresShipping = false`. Would let mapped
non-shipping Shopify items be real order lines (visible in reports) without touching stock. Today
they are recorded as an order note (D-050, Option A).

## R-4 · External orders with zero shippable lines (non-blocking, Step 3 follow-up)

`createOrder` requires ≥ 1 line. An all-non-shipping Shopify order therefore creates no V3PL
order (logged as SKIPPED). Either allow zero-line external orders or a non-physical line type.

## R-5 · `orders.addExternalLine(orderId, line, externalEventId)` (non-blocking, Step 3 follow-up)

Lines added in Shopify after import are only flagged for manual handling today.

## R-6 · `orders.redactCustomerData(...)` (non-blocking, compliance)

`customers/redact` / `shop/redact` webhooks are acknowledged and logged for manual handling; a
service that nulls the ship-to/contact snapshot on the affected orders would automate it.

---

## C-1 · Core → Shopify: manual order → Shopify order (core side shipped 2026-09-15, D-061)

Direction reversed: this is a contract **core provides** for the Shopify session. `ORDER_CREATE` jobs
(`dedupeKey = order:{orderId}`) are queued by core; the Shopify session implements the runner using
`buildShopifyOrderRequest`, `recordShopifyOrderReference` and `markShopifyOrderFailed` from
`src/server/services/shopify-order-request.ts`. Full contract, payload, runner requirements, the webhook-before-
reference race and the `register.ts` fulfilment-push note: [shopify-order-request.md](shopify-order-request.md).
