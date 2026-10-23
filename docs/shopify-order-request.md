# Manual V3PL order → Shopify order — core contract (D-061)

Status: **core side implemented 2026-09-15; Shopify runner implemented 2026-09-15 (D-062, `src/server/services/shopify/order-out.ts`);
dev-store verification pending the released app version with `write_orders` + store reconnect.** Owner of this document: core
session. Consumer: Shopify session (`src/server/services/shopify/**`).

Core owns everything up to and including the queued job; the Shopify session owns the `ORDER_CREATE` runner that
talks to the Admin API. No core code calls Shopify, and the browser never chooses a store.

## 1. What core does

| Step | Where | Behaviour |
|---|---|---|
| Store resolution | `resolveShopifyStoreForVariants(variantIds)` in `src/server/services/shopify-order-request.ts` | Every variant needs **exactly one** `ShopifyVariantMapping` with `status = MATCHED` in a store with `status = CONNECTED`. Missing → `NO_MAPPING` (names the SKUs); matched in several connected stores → `AMBIGUOUS_MAPPING` (never guessed); lines resolving to different stores → `MIXED_STORES`. UNMATCHED / IGNORED / CONFLICT rows and non-connected stores never count. |
| Eligibility | `shopifyOrderEligibility(orderId)` | `source = MANUAL` only (Shopify-sourced, portal and CSV orders are refused with `NOT_ELIGIBLE`), not `CANCELLED`, at least one active shippable line (`quantity − cancelledQty > 0`), store resolution ok, and the order is not already linked to a different store. Read-only. |
| Request | `requestShopifyOrder(orderId, actorId)` | Validates everything first (nothing is created on failure). Creates **one** `ShopifyOutboundJob` — `type = ORDER_CREATE`, `targetType = "Order"`, `targetId = orderId`, `dedupeKey = order:{orderId}`, `status = PENDING`, `storeId` = resolved store — and sets `Order.shopifyStoreId`, `Order.shopifyOutboundStatus = PENDING`, event `shopify_order_requested`, audit `order.shopify_requested`. Repeats reuse the same job (also under concurrency, via the unique `dedupeKey`). `FAILED` / `NEEDS_ATTENTION` jobs are re-armed to `PENDING` (event `shopify_order_retry`); a `DONE` job or a recorded reference is **never** re-armed. Inventory, order status and order lines are untouched. |
| Contract | `buildShopifyOrderRequest(orderId)` | Builds the payload below fresh from the order + mappings at run time (the job row only carries ids). Throws the same typed errors when the order is no longer eligible, so the runner never gets a partial payload. |
| Result: created | `recordShopifyOrderReference(orderId, { shopifyStoreId, shopifyOrderId, shopifyOrderName }, actorId)` | Sets `Order.shopifyStoreId/shopifyOrderId/shopifyOrderName`, `shopifyOutboundStatus = CREATED`, clears the error, stores `{ shopifyOrderId, shopifyOrderName }` in the job `result`, event `shopify_order_created`, audit `order.shopify_created`. Idempotent: the same reference again → `{ updated: false }`. A different Shopify order for an order that already has one, a store other than the one queued, or a Shopify order already linked to another V3PL order (`UNIQUE(shopifyStoreId, shopifyOrderId)`) → `ShopifyOrderRequestError("BAD_STATUS")`. Blank ids → `INVALID_REFERENCE`. |
| Result: failed | `markShopifyOrderFailed(orderId, message, actorId)` | `shopifyOutboundStatus = FAILED`, `shopifyOutboundError = message`, event `shopify_order_failed`. No-op when a reference is already recorded. The job row keeps `attempts / nextRetryAt / lastError / NEEDS_ATTENTION` exactly as `jobs.ts` manages them today. |
| UI state | `shopifyOutboundSummary(orderId)` → `NOT_SENT · PENDING · CREATED · RETRYABLE · FAILED` | Order page "Shopify" card (staff): badge, reason (missing / ambiguous / mixed mapping), Shopify order name when created, **Send to Shopify** / **Retry** (ADMIN, SALES). Manual order form (admin): server-resolved hint "all lines map to store X" / reason, plus "Send this order to X after creating it". The V3PL order is always created first; a Shopify problem only surfaces as a message. |

Schema (migration `20260915150000_shopify_outbound_order`): `Order.shopifyOutboundStatus ShopifyOutboundStatus?`
(`PENDING | CREATED | FAILED`; NULL = never requested), `Order.shopifyOutboundError String?`, and `ORDER_CREATE`
added to `ShopifyJobType`. The existing `shopifyStoreId / shopifyOrderId / shopifyOrderName` columns are reused for
the reference, so the inbound pipeline needs no change (see §3).

## 2. Payload the runner receives (`ShopifyOrderRequest`, version 1)

```ts
{
  version: 1,
  idempotencyKey: "order:<v3plOrderId>",   // = job.dedupeKey; use as the Shopify-side idempotency reference too
  origin: "V3PL_MANUAL",
  order: { id, orderNumber, source: "MANUAL", placedAt (ISO), currency, shippingMethod, notes, tags,
           subtotal, discountTotal, taxTotal, shippingTotal, total },           // decimals as strings or null
  store: { id, shopDomain, name },                                             // the resolved CONNECTED store
  customer: { customerId /* Customer.id or null */, name, email, phone },
  shippingAddress: { name, company, address1, address2, city, province, zip, country, phone },
  billingAddress: { name, company, address1, address2, city, province, zip, country } | null, // from the linked Customer's bill* fields
  lines: [{ orderItemId, variantId, sku, title, variantTitle, quantity /* active */, unitPrice,
            shopifyVariantId, shopifyProductId, shopifyInventoryItemId }]
}
```

Only active lines are included (fully cancelled lines are dropped; partially cancelled lines carry the remaining
quantity). Every line carries the store's own Shopify ids, so the runner never has to look a SKU up.

## 3. What the Shopify session built (2026-09-15, D-062) — the original list with what was done

Implementation: `order-out.ts` (`runOrderCreateJob`, registered in `runners.ts`), `queries.ts` (`ORDER_CREATE_MUTATION`,
`ORDERS_BY_TAG_QUERY`, `customAttributes` on the order fragment), `orders-in.ts` (link V3PL-origin orders instead of
importing; variant-based line matching), `register.ts` (fulfilment push for any order with a Shopify reference),
`fulfillment-out.ts` (allocation by variant when items carry no Shopify line id), one additive line in
`src/server/actions/shopify-order.ts` (`scheduleAfterResponse` so the job runs right after the request responds).
Test: `npm run e2e:shopify-order-create` (39). Details in shopify-integration.md §12.2.

| Item below | Outcome |
|---|---|
| 1 runner registration | `ORDER_CREATE` registered in the existing registry; jobs run via `after()`, piggyback drain, daily cron, Retry. |
| 2 runner behaviour | recorded reference → remembered id → adoption by tag `V3PL-<orderNumber>` + `v3pl_idempotency_key` → `orderCreate` with `inventoryBehaviour: BYPASS`, `financialStatus: PENDING`; id persisted on the job **before** `recordShopifyOrderReference`; `markShopifyOrderFailed` on every failure; Shopify `userErrors` → `NEEDS_ATTENTION` verbatim. |
| 3 scope | `write_orders` added to `shopify.app.toml`, `SHOPIFY_DEFAULT_SCOPES`, `.env.example`; new app version required; runner refuses stores whose `grantedScopes` lack it ("Reconnect the store"). |
| 4 tags / notes | tags `V3PL`, `V3PL-<orderNumber>` (+ V3PL tags); note `Created from V3PL order <orderNumber>.` (+ V3PL notes); attributes `V3PL order` = number, `v3pl_idempotency_key` = `order:<id>`. |
| 5 inbound dedupe / race | `orders/create` for a Shopify order carrying `v3pl_idempotency_key` **links** the manual order through `recordShopifyOrderReference` and never imports it — whichever side arrives first records the same reference, the other gets `{ updated: false }`. A second Shopify order claiming an already-linked V3PL order is refused with attention (never imported). `BAD_STATUS` in the runner → attention with the Shopify id kept on the job, no second create. |
| 6 fulfilment push | hook condition is now "order carries `shopifyOrderId`" (was `source === SHOPIFY`); V3PL-created orders have no `OrderItem.shopifyLineItemId`, so fulfilment allocation and inbound line sync match through the store's variant mapping (exact SKU as last resort) — an unmatched V3PL line is left alone, never zeroed. |
| 7 inbound edits | flow through Step 3 with the matching above. Note: the header sync copies Shopify's tags (incl. the `V3PL…` markers) and ship-to formatting back onto the manual order; lines never change unless edited in Shopify. |

Original request list:

1. **Runner registration** for `ORDER_CREATE` in the job registry (`register.ts` / `jobs.ts`). Until it exists the
   jobs simply stay `PENDING` — the core suite asserts exactly that.
2. **Runner behaviour:** `const req = await buildShopifyOrderRequest(job.targetId)` → create the order in
   `req.store` (Admin API `orderCreate` or draft order + complete — Shopify session's call; **inventory behaviour
   must not deduct again**, the warehouse reservation already exists in V3PL) → **immediately**
   `recordShopifyOrderReference(job.targetId, { shopifyStoreId: req.store.id, shopifyOrderId, shopifyOrderName })`
   → mark the job `DONE`. On any failure call `markShopifyOrderFailed(orderId, message)` and let `jobs.ts` schedule
   the retry / attention state. Before creating, the runner should **adopt** an order Shopify already holds for
   `idempotencyKey` (search by the idempotency reference / note attribute) instead of creating a second one — the
   same adoption pattern as `FULFILLMENT_CREATE`.
3. **Scope:** `write_orders` is currently *not* granted (shopify-integration.md §3). Adding it needs a new app
   version and a merchant re-authorisation; core did not touch scopes.
4. **Tags / notes** ("created from V3PL", order number) are the runner's responsibility; core passes
   `order.orderNumber`, `order.notes`, `order.tags` and `origin` in the payload and deliberately does not decide the
   Shopify-side wording.
5. **Inbound dedupe (already works):** the `orders/create` webhook for the new Shopify order hits
   `orders.createOrder` with `shopify: { storeId, orderId }`; `findExisting` matches the recorded reference and
   returns the existing MANUAL order (`created: false`) — no duplicate, no second reservation. Verified in
   `e2e:shopify-order`. **Race to note:** if the webhook arrives before `recordShopifyOrderReference` has run, the
   import would create a second order. Record the reference *inside* the runner right after the API call, before
   marking the job `DONE`, and treat a `BAD_STATUS` ("already linked to another V3PL order") as the signal that the
   webhook won — then reconcile (cancel/merge) explicitly rather than silently.
6. **Fulfilment push:** the shipment hook in `register.ts` only enqueues `FULFILLMENT_CREATE` for
   `orderSource === "SHOPIFY"`. A MANUAL order that now carries a `shopifyOrderId` will *not* push its fulfilment to
   Shopify until that condition is widened to "has a Shopify reference"; decide that together with the runner.
7. **Inbound edits/cancellations** from Shopify for such an order flow through the existing Step 3 pipeline because
   the order carries the reference; nothing further needed on the core side.

## 4. Errors (`ShopifyOrderRequestError.code`)

`NOT_FOUND · NOT_ELIGIBLE · NO_MAPPING · AMBIGUOUS_MAPPING · MIXED_STORES · ALREADY_CREATED · INVALID_REFERENCE ·
BAD_STATUS`. Messages are user-facing (they name the SKUs / stores involved) and are what the order page shows.

## 5. Tests

`npm run e2e:shopify-order -- http://localhost:3100 vendor3pl@gmail.com` (33 checks) — resolution rules, one job
per order, idempotent repeats and concurrency, contract payload (incl. billing address from the directory),
reference recorded once / mismatches / duplicate Shopify order, inbound dedupe, ineligible sources / cancelled /
cancelled lines, failure → retry → re-arm state machine, HTTP card states, action via HTTP (ADMIN ok, WAREHOUSE
refused), jobs remain `PENDING` without a runner. Uses test `ShopifyStore` rows (`CONNECTED`) and hand-made
mappings; never calls Shopify.
