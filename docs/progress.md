# Project Progress

Last updated: **2026-09-16**

## Current phase

**Pre-Phase-6 refinement pass (products, orders, global UI/UX): implemented and tested (2026-09-09).**
Next: Phase 6 (admin report polish, Excel/PDF exports, inventory import) after go-ahead; Shopify Step 4 production verification still pending (needs fresh unfulfilled dev-store orders).

## Completed

### Finance correction — two accounts, manual vendor payables, automatic 3PL product value (core session, 2026-09-16)

- [x] `LedgerEntry.account` + `effect` replace `direction`; `PRODUCT_VALUE` / `VENDOR_PAYABLE` types; `unitAmount`, `receivingItemId` (migration `20260916150000_finance_accounts`, converts existing rows) — D-064
- [x] Vendors: no automatic payable at receiving or shipping; Admin allocates received units into payables (never over the received quantity, row-locked); gross-margin report. 3PL: automatic product-value payable per shipped unit, charges on the separate receivable side; payments settle one side only; nothing netted anywhere in the UI
- [x] Tests: `npm run e2e:finance` rewritten (vendor allocation, 3PL sides, no netting)

### Operational charges + owner settlement ledger (core session, 2026-09-16)

- [x] `ChargeRule` / `Charge` / `LedgerEntry` + `Owner.chargesEnabled` (migration `20260916090000_charges_finance_ledger`) — D-063, [finance.md](finance.md)
- [x] Charges + wholesale valuation recorded at shipment (warehouse and Shopify-mirrored), immutable, idempotent; derived payable / receivable balance; manual payments / adjustments (admin, idempotent key)
- [x] UI: Settings → Operational charges, Admin → Finance (+ owner ledger, settlement form), balance cards on owner profiles / portal dashboards / admin dashboard, portal Finance tabs, owner form switch
- [x] Tests: `npm run e2e:finance`. Deferred: Shopify payment-status sync, invoices, returns reversal, storage periods

### Production fix — core hook registry per module instance (core session, 2026-09-15)

- [x] `fulfillment-hooks.ts` / `inventory-hooks.ts`: `ensureShipmentHandlersRegistered()` / `ensureInventoryHandlersRegistered()` lazily import `shopify/register.ts` into the executing module instance before running handlers (same pattern as `jobs.ts` runners). Root cause: instrumentation registered into a different Turbopack bundle instance than the shipping/receiving server actions, so production shipments of Shopify-linked orders enqueued no FULFILLMENT_CREATE (V3PL 1586 / Shopify #1010) and stock changes no INVENTORY_PUBLISH
- [x] Tests: `npm run e2e:hooks` (fresh processes + built-server action). No migration, no Shopify logic change, `inventoryBehaviour: BYPASS` untouched

### Manual V3PL order → Shopify order — Shopify side (Shopify session, 2026-09-15, D-062)

- [x] **Production fix 2026-09-15 (runner registry):** ORDER_CREATE jobs stayed PENDING / 0 attempts on Vercel — the
      per-module job registry was only populated in the instrumentation bundle instance (globalThis once-flag);
      request-handling instances drained with an empty registry. `jobs.ts` now lazily ensures runners per instance,
      guards are module-local. `npm run e2e:shopify-runner` proves discovery → claim → attempt 1 → runner through the
      built server (webhook `after()` drain + cron route). Same exposure exists for the core hook arrays → core follow-up.

- [x] `ORDER_CREATE` runner `src/server/services/shopify/order-out.ts` registered in the existing job registry; consumes
      `buildShopifyOrderRequest` as documented (no SKU lookup), `orderCreate` (2026-07) with `inventoryBehaviour: BYPASS`,
      `financialStatus: PENDING`, V3PL retail `priceSet`, email/phone/shipping/billing (no customer object), marker tags
      `V3PL` + `V3PL-<n>`, note `Created from V3PL order <n>.`, attributes `V3PL order` / `v3pl_idempotency_key`; result via
      `recordShopifyOrderReference` / `markShopifyOrderFailed` only
- [x] Idempotency: recorded reference → remembered id on the job → adoption (`orders` search by tag + attribute) → create;
      id persisted before the link; BAD_STATUS → attention with id kept; DONE never re-armed
- [x] Inbound: `orders/create` for a V3PL-origin Shopify order links the manual order instead of importing (webhook race
      safe, duplicate Shopify order refused with attention); `orders/updated` matches lines by variant mapping so
      V3PL-created orders (no Shopify line ids) are never zeroed
- [x] Fulfilment push eligibility = order has a Shopify reference; allocation by variant mapping / SKU fallback
- [x] Scope `write_orders` in `shopify.app.toml`, `SHOPIFY_DEFAULT_SCOPES`, `.env.example`; runner scope guard
- [x] One additive line in core action `requestShopifyOrderAction`: `scheduleAfterResponse(storeId)`
- [x] `npm run e2e:shopify-order-create` 39/39 (in-process, no server/Firebase); unit 80/80; regressions core
      `e2e:shopify-order` 33/33, `e2e:core-requests`, shopify1–4; typecheck/lint/build clean; no migration
- [x] Shopify app version **`v3plmxvs-platform-4`** ("write_orders scope for manual V3PL orders (D-062)") created from
      `shopify.app.toml` with `app deploy --no-release` on 2026-09-15 — **not released**
- [ ] User: **Release** `v3plmxvs-platform-4` in the Dev Dashboard, set Vercel `SHOPIFY_SCOPES` to the seven-scope list
      (or remove the variable so the code default applies), redeploy, then **Reconnect** `shakilxvs.myshopify.com`
      (currently NEEDS_REAUTH anyway) and confirm the store's granted scopes include `write_orders`
- [ ] Dev-store verification (17-step checklist, shopify-integration.md §12.2) — pending the above

### Manual V3PL order → Shopify order — core side (core session, 2026-09-15)

- [x] `Order.shopifyOutboundStatus/Error` + `ORDER_CREATE` job type (migration `20260915150000_shopify_outbound_order`) — D-061
- [x] `shopify-order-request.ts`: server-side store resolution from MATCHED mappings in CONNECTED stores (missing / ambiguous / mixed refused), eligibility, idempotent `ORDER_CREATE` job per order, `ShopifyOrderRequest` contract, `recordShopifyOrderReference` / `markShopifyOrderFailed` result contracts; order page "Shopify" card + manual order form hint / send-after-create
- [x] Tests: `npm run e2e:shopify-order`; contract for the Shopify session in [shopify-order-request.md](shopify-order-request.md). **Not done (Shopify session):** the runner, Admin API call, `write_orders` scope, tags/notes

### Customer directory + order customer workflow (core session, 2026-09-15)

- [x] `Customer` model (owner-scoped, shipping + billing, source, reserved Shopify fields) and `Order.customerId` (migration `20260915120000_customer_directory`) — D-060
- [x] Shared service/actions/UI: admin `/admin/customers` (list/search/detail/create/edit), portal Customers tabs (own scope), customer picker + "save as new customer" in manual and 3PL order forms, duplicate warnings, order snapshot independence
- [x] Tests: `npm run e2e:customers`; Shopify customer sync deferred

### Unique barcode per variant (core session, 2026-09-15)

- [x] `ProductVariant.barcode` globally unique (migration `20260915090000_variant_barcode_unique`); schema + service + DB guards; Barcode column in the product form; shown on detail and in the SKU picker; CSV uniqueness validation (D-059)
- [x] Tests: `npm run e2e:barcode`

### Initial inventory during product creation (core session, 2026-09-13)

- [x] Optional "Initial inventory" card on Add product: warehouse + location, quantity per generated SKU; booked as one receipt via the receiving service (D-058); all-or-nothing with compensation
- [x] Tests: `npm run e2e:initial-stock`

### Batch 2 — Product & SKU enhancements (core session, 2026-09-12)

- [x] Option/value builder generating variant combinations (1–3 options), preserving existing rows, safe renames, history-locked rows kept (D-057)
- [x] Retail (`price`) + wholesale (`wholesalePrice`) per variant; orders keep defaulting to retail
- [x] Optional weight (g) and dimensions (cm) per variant; shown on product detail; CSV columns
- [x] Shopify store SKU conflict warning on create/edit (read-only, mappings untouched)
- [x] Tests: `npm run e2e:batch2`; typecheck, lint, build

### Pre-Phase-6 refinement — product structure, CSV, deletion, status UX, layout, typography (core session, 2026-09-09)

- [x] Shopify-like products (D-053): `Product.options` / `ProductVariant.optionValues` (migration `20260909000000_product_options`, backfill of legacy variant names); derived variant labels; form with owner/title/status + "Has variants" (option names, one row per variant: values, SKU, price, inventory, status); title defaults to the SKU for simple products
- [x] Product list (Product · Status · Variants · Inventory · actions menu) and detail (variants under the product, per-variant inventory, totals, Delete)
- [x] Shopify-compatible product CSV import/export (`product-csv.ts`, `/api/products/export`, Imports page card, PRODUCTS import jobs with preview → confirm → results → failed rows) — [csv-products.md](csv-products.md)
- [x] Safe deletion (D-054): products, orders, warehouses, locations — hard delete only without history; dialogs list blockers and offer Archive / Cancel / Deactivate
- [x] Customer-facing order status (D-055): Unfulfilled / Partially fulfilled / Fulfilled / Delivered / Returned / Cancelled everywhere; warehouse stage as a hint; `view` filter
- [x] Sticky admin sidebar; Inter as the only font (D-056)
- [x] Tests: `npm run e2e:refinement` (55 checks) + all existing suites, typecheck, lint, production build

### Phase 0 — Preparation & architecture (2026-09-01)

- [x] Master prompt adopted as source of truth (`PROJECT_MASTER_PROMPT.md`)
- [x] Decisions D-001 … D-020 recorded; architecture, ERD plan, roadmap, setup checklist, backup plan documented

### Shopify Step 4 — fulfillment push/pull, tracking, inventory publishing (Shopify session, 2026-09-07, branch `shopify/integration`)

- [x] `fulfillment-out.ts`: `FULFILLMENT_CREATE` runner (line allocation by `shopifyLineItemId`, fulfillment-order move to the
      store's fulfil location, adoption by remembered id / tracking number, `fulfillmentCreate` with carrier + tracking + URL,
      `notifyCustomer`, link via core R-1 through `core-bridge.ts`), `TRACKING_UPDATE` runner; `NonRetryableJobError` → immediate
      *Needs attention* (refused move, nothing left to fulfil, R-1 pending, unlinked tracking)
- [x] `fulfillment-in.ts`: `fulfillments/create|update` → known id: tracking / status (`shipmentStatusFor`) / cancellation
      attention; unknown id: `recordExternalShipment` mirror (once, `<eventId>:mirror`)
- [x] `inventory-publish.ts`: `publishVariant` (fast path, compare-and-set, activation, conflict → attention, force),
      `INVENTORY_PUBLISH` runner, `enqueuePublishAll` (initial publish on enabling), `publishSweep` (verify mode) in the daily
      run, `publishingOverview`; `scheduleAfterResponse` (`after()`) from both hooks; Publishing tab with *Publish all now*,
      *Force publish* (per SKU, confirmed) and *Force publish all*; Outbound jobs tab lists the new job types
- [x] Verified: `test:shopify` 63/63, `e2e:shopify4` 35/35 (normal / partial / multiple shipments, tracking update, retry never
      duplicates, adoption, move + refusal, nothing-left, mirror once + replay no-op + reservation consumed once, IN_TRANSIT /
      DELIVERED, cancellation, publish disabled → no jobs, initial publish baseline, activation, equal skip, mismatch attention
      not overwritten, force, unchanged → no Shopify call, sweep flags manual edit, mid-flight compare rejection, switched off,
      Shopify never written into V3PL, pages), regressions `e2e:shopify1` 58/58, `e2e:shopify2` 49/49, `e2e:shopify3` 39/39;
      typecheck, lint (0 errors), build. No new migration.
- [x] Rebased on core `2610588` (R-1 `recordExternalReference`, R-2 `TRACKING_UPDATED` hook): real link call after
      `fulfillmentCreate` (`{ updated: false }` = idempotent replay; `BAD_STATUS` → attention with the Shopify id kept, no
      re-create), shipment hook branches on `ShipmentEvent.kind` and ignores `external: true`, tracking runner skips a
      redundant push when the fulfilment push already carried the tracking, `core-bridge.ts` removed; `e2e:shopify4`
      42/42 (R-1 reference persisted, replay `{updated:false}`, retry no duplicate, BAD_STATUS, tracking pushed via R-2,
      identical tracking = core no-op, edit-before-push, Shopify tracking change does not loop back, replay idempotent),
      regressions 58/58 · 49/49 · 39/39, unit 63/63, typecheck/lint/build clean, no migration
- [x] 2026-09-08 production run found publishing failing on the real 2026-07 store: “The @idempotent directive is
      required for this mutation”. Fixed: `inventoryActivate` / `inventorySetQuantities` carry
      `@idempotent(key: $idempotencyKey)` with a per-execution UUID remembered on the job for safe retries
      (`chooseIdempotencyKey`, `job.result.idem`); e2e mock now enforces the 2026-07 rule and replays by key;
      unit 70/70, e2e:shopify4 46/46, regressions 58/49/39, typecheck/lint/build clean, no migration
- [ ] Production verification on the dev store (auto-fulfilment OFF): ship from V3PL → Shopify fulfillment; Shopify-created
      fulfillment mirrored; enable publishing and verify quantity — **NOT PASS on 2026-09-08** (publishing blocked by the
      directive above; fulfilment cases need fresh unfulfilled orders created in Shopify Admin). Re-run after the fix.

### Shopify Step 3 — inbound order synchronisation (Shopify session, 2026-09-07, branch `shopify/integration`)

- [x] `orders-in.ts`: `syncShopifyOrder` (create / update / cancel / refund via core contracts only), line resolution
      by mapping or exact SKU, non-shipping lines noted not reserved (Option A, D-050), state-based line reconciliation,
      attention for refunds after shipment / lines added in Shopify, `reconcileOrders`, `importOrdersSince`;
      `order-webhooks.ts` for the five order topics; daily reconciliation in maintenance
- [x] Store settings `importTestOrders` + `ordersImportSince` (migration `20260907150000_shopify_store_order_import_settings`,
      applied to the Neon test branch; **production pending**); Orders tab (activity, Retry, Sync orders now, Import orders since…)
- [x] Verified: `test:shopify` 58/58, `e2e:shopify3` 39/39 (multi-owner import + reservation, 5× concurrent duplicates →
      one order, unknown SKU → no order + Retry, non-shipping mapped / SKU-less / all / mixed, insufficient stock, no
      warehouse, test orders, import-since + backfill, stale updates, edits, refunds before/after shipment, cancel + release,
      two stores same #1001, reconciliation, webhook routing, Orders tab), regressions `e2e:shopify1` 58/58 and
      `e2e:shopify2` 49/49; typecheck, lint (0 errors), build
- [x] Core follow-up requests recorded (shopify-integration.md §6.1) — non-blocking
- [x] **Production-verified 2026-09-07** (main `c7d9d93`, migration applied to production): Shopify order `#1002`
      (id 7554033647905) → one V3PL order 1116 (CONFIRMED / RESERVED), line `XVS-TEST-001` → mapping MATCHED/SKU_EXACT →
      owner XVS (line owner = product owner), warehouse MAIN, reservedQty 1, exactly one RESERVE ledger row carrying
      externalEventId `<eventId>:create`, sync log SUCCESS linked to the order, 5 webhook events PROCESSED (an
      `orders/updated` arrived before `orders/create` and was handled correctly), 4 header updates with distinct
      idempotency suffixes, no duplicate order, no duplicate reservation; stock 200 on hand / 1 reserved / 199 available

### Shopify Step 2 — catalog sync + variant mapping (Shopify session, 2026-09-07, branch `shopify/integration`)

- [x] Services: `catalog.ts` (paged/bulk pull, snapshot upsert, re-match, prune, `syncProduct`), `catalog-match.ts` (pure
      matcher), `mapping.ts` (list/filter, manual map, unmap, ignore, unmatched CSV), `catalog-import.ts` (preview/confirm
      through core `createProduct`), `catalog-webhook.ts` (`products/update` handler); daily catalog sync in maintenance
- [x] Migration `20260907090000_shopify_mapping_unique_variant` (unique store + internal variant) — applied to the Neon test
      branch; **production pending** (apply with `prisma migrate deploy` at deploy time)
- [x] UI: “Product mapping” tab (counts, filters, search, Sync products now, Import unmatched into V3PL, Unmatched CSV,
      Map / Unmap / Ignore / Unignore); overview shows mapping counts; `GET /api/shopify/stores/:id/unmatched` CSV route
- [x] Verified: `test:shopify` 51/51 (incl. 16 matcher cases), `e2e:shopify2` 49/49, `e2e:shopify1` 58/58 regression,
      typecheck, lint (0 errors), build
- [x] Production-verified 2026-09-07 on `shakilxvs.myshopify.com` (catalog sync, `XVS-TEST-001` matched, `products/update` processed)
- [ ] Dev Dashboard: protected customer data form still to be saved before Step 3 (order import needs addresses)

### Shopify Step 1 — store connection layer (Shopify session, 2026-09-06, branch `shopify/integration`)

- [x] Schema: `ShopifyStore`, `ShopifyStoreWarehouse`, `ShopifyVariantMapping`, `ShopifyWebhookEvent`, `ShopifySyncLog`,
      `ShopifyOutboundJob` (+ enums) in a delimited section of `prisma/schema.prisma`; back-relation list fields on
      `Warehouse`, `ProductVariant`, `Order` (no core column/constraint changes); migration `20260906120000_shopify_connection`
      generated offline (6 tables, additive only) — **not yet applied to any database**
- [x] `src/server/services/shopify/`: `env` (validated group, D-023 scopes), `crypto` (AES-256-GCM, webhook + OAuth HMAC,
      shop-domain normalisation), `client` (GraphQL transport: throttle retry, 401 → UNAUTHORIZED, injectable fetch),
      `oauth` (authorization-code grant with `expiring=1`, encrypted tokens, proactive refresh, NEEDS_REAUTH), `api`
      (store-aware GraphQL, shop + locations metadata), `stores` (secret-free projections, settings, disconnect, uninstall,
      test connection), `webhooks` (verify → record → process, retry sweep, backoff, `app/uninstalled` + compliance handlers),
      `jobs` (dedupe queue + runner registry), `register` (core shipment/inventory hooks → jobs), `maintenance` (drain + daily)
- [x] Routes: `GET /api/shopify/oauth/callback`, `POST /api/webhooks/shopify`, `POST /api/webhooks/shopify/compliance`,
      `GET /api/cron/shopify-daily` (+ `vercel.json` daily cron), `src/instrumentation.ts` registers the hooks per instance
- [x] Admin UI: `/admin/settings` hub, `/admin/settings/shopify` (cards, Add Shopify Store → OAuth), store detail with
      Overview / Settings / Sync log / Webhooks / Outbound jobs tabs, actions (Test, Run pending, Reconnect, Disconnect,
      Remove); navigation “Settings” enabled (`comingSoonPhase` removed)
- [x] Verified: `npm run test:shopify` 35/35 (encryption, HMAC incl. Shopify doc vector, domains, env, transport),
      `tsc --noEmit`, `eslint` (0 errors), `next build`
- [x] `npm run e2e:shopify1` **58/58** on a dedicated Neon test branch (2026-09-06): install/authorize URL, callback
      HMAC/state/shop/replay rejection, encrypted tokens + `expiring=1`, proactive refresh, metadata + auto location,
      secret-free projections, settings validation, hook-driven INVENTORY_PUBLISH / FULFILLMENT_CREATE jobs (dedupe,
      re-arm, manual orders excluded), webhook HTTP (200/401/400, duplicate, unknown shop, compliance 401), retry sweep +
      stale locks, app/uninstalled, reconnect, disconnect, admin pages (no secrets in HTML), callback route redirects,
      cron auth + daily run; test data removed. Migration `20260906120000_shopify_connection` applied to the test branch
      only — **production/shared Neon untouched; core session applies it with `prisma migrate deploy` after merge**
- [x] Dev Dashboard: version `v3plmxvs-platform-3` released from `shopify.app.toml` (scopes, URLs, 9 webhook topics, 3 compliance topics); dev store `shakilxvs.myshopify.com` connected on production; `products/update` delivery verified (2026-09-07)

### Shopify design track (Shopify session, 2026-09-02) — merged into `main` at `4761a66`

- [x] Design reconciled with the public-distribution app; decisions D-021 … D-032
- [x] Scopes verified against Admin GraphQL 2026-07; operational checklist ([shopify-setup.md](shopify-setup.md))
- [x] Shopify branch isolated in worktree `../Vendor-3PL-shopify` (`shopify/integration`)

### Phase 1 — Core scaffold (core session, 2026-09-02)

- [x] Next.js 16 (App Router, TypeScript, Tailwind v4, shadcn/ui, Lucide) project structure
- [x] Prisma 7 + `pg` adapter; `prisma/schema.prisma` with `User` (roles, status) and `AuditLog`
- [x] Initial migration `prisma/migrations/20260902000000_init` generated; `prisma.config.ts` with pooled/direct URLs
- [x] Environment validation (`src/lib/env.ts`), `.env.example` documented, secrets gitignored
- [x] Firebase Admin SDK + client SDK wiring; session-cookie auth (`/api/auth/session`, D-033)
- [x] Server-side guards: `requireStaff`, `requireRole`, `requirePortalUser`, `requirePortalRole`, `authorizeApi`
- [x] Edge proxy redirecting cookie-less requests on `/admin/*` and `/portal/*`
- [x] `/admin/login` (staff) and `/user/login` (vendor/3PL) with wrong-portal detection; `/user` entry redirect
- [x] Admin layout: responsive sidebar + mobile drawer, role-filtered navigation, account menu, sign-out
- [x] Admin dashboard with live database status; portal foundation pages for vendor and 3PL
- [x] Audit-log service (`recordAudit`, transaction-aware) and `seed:admin` bootstrap script
- [x] Verified: `npm install`, `tsc --noEmit`, `eslint`, `prisma validate`, `next build`, runtime redirects

### Infrastructure reset (core session, 2026-09-04)

- [x] Firebase moved to project `v3plxvs`; new Admin service account verified; web config in `.env.local`
- [x] Neon unchanged; connectivity verified on pooled + direct URLs; migration `20260902000000_init` applied
- [x] First admin `vendor3pl@gmail.com` linked as `ADMIN` (existing Firebase user)
- [x] Fixed: migration SQL had dotenv console lines prepended (generated via shell redirect); cleaned
- [x] Fixed: `server-only` import broke CLI scripts (removed from `firebase/admin.ts`, `audit.ts`)
- [x] Fixed: icon components passed from Server → Client Component (nav icons now string keys)
- [x] `scripts/e2e-auth-check.mjs` (`npm run e2e:auth`): 19/19 checks pass against the built app
- [x] Git `origin` → `https://github.com/V3PL/v3pl`

### Phase 2 — Owner + Vendor + 3PL management (core session, 2026-09-04)

- [x] Schema: `Owner` (type, unique code, business/contact/address, ACTIVE/INACTIVE), `User.ownerId` (Restrict FK),
      `UserStatus.DELETED`, `deletedAt`/`deletedEmail`; migration `20260904000000_phase2_owners` with hand-written
      CHECK `User_owner_role_check` (portal roles ⇔ ownerId) — applied to Neon, no drift
- [x] Services: `owners.ts` (list/search/paginate, create, update, activate/deactivate — audited),
      `users.ts` (create Firebase+DB account with compensation, profile update, disable/ban/reactivate with Firebase
      disable + token revocation, password reset, soft delete with e-mail tombstone D-037, last-admin and self-action guards)
- [x] Server Actions (`src/server/actions/*`, D-038) with shared Zod schemas (`src/lib/validation/*`)
- [x] Admin UI: `/admin/vendors`, `/admin/3pl-clients` (list + search + status filter + pagination, new, detail, edit,
      deactivate/reactivate), portal-user management on the owner detail page, `/admin/users` (all users, role/status
      filters, new staff user, reset password, disable/ban/reactivate/delete); dashboard partner stats
- [x] Portals: vendor and 3PL home show the owner's own profile; scope is always `session.ownerId`
      (`requirePortalRole` returns a non-null ownerId); inactive owner locks its users out on the next request
- [x] Navigation: Vendors, 3PL Clients, Users enabled (ADMIN only)
- [x] Verified: typecheck, lint, build, `e2e:auth` 19/19, `e2e:phase2` 29/29 (owner CRUD, duplicate code/e-mail,
      DB CHECK, vendor A ⇸ vendor B / 3PL / admin, 3PL ⇸ vendor, warehouse ⇸ admin-only pages, disable → immediate
      sign-out + Firebase disabled, owner deactivation lock-out, self-disable blocked, delete tombstone + e-mail reuse,
      audit rows); test data cleaned up (Firebase + DB)

### Phase 3 — Products, warehouses, inventory ledger (core session, 2026-09-05)

- [x] Schema (migration `20260905000000_phase3_catalog_inventory`, applied to Neon, no drift): `Product`, `ProductVariant`
      (unique SKU, Decimal price/cost, isDefault), `ProductImage`, `Warehouse`, `Location` (unique label per warehouse,
      one default), `InventoryBalance` (variant × warehouse), `InventoryLevel` (variant × warehouse × location),
      `InventoryTransaction` (append-only ledger with before/after, refs, `externalEventId`), `ReceivingRecord/Item`,
      `Transfer/Item`; hand-written CHECKs for non-negative stock, `reserved ≤ onHand`, non-zero ledger quantities
- [x] `services/inventory.ts` — the only writer of stock tables: receive, adjust (in/out/damage/missing), move,
      reserve, release, ship (consumes reservation), return, transferOut/In; `FOR UPDATE` on the balance row;
      queries (`stockForVariant(s)`, `listStock`, `listMovements`, `stockTotals`, `availableForVariants` for Shopify,
      `verifyLedgerConsistency`); integration hook registry (`inventory-hooks.ts`, D-045)
- [x] `services/products.ts` (owner-locked once history exists, global SKU uniqueness, archive-not-delete, images),
      `warehouses.ts` (default MAIN location, deactivation requires zero stock), `receiving.ts` (owner/SKU match,
      posted atomically), `transfers.ts` (two-legged, D-044); Cloudinary signed uploads (`lib/cloudinary.ts`)
- [x] Admin UI: Products (list/search/filter, create/edit with variant rows, detail with stock by warehouse, images,
      recent movements, archive), Warehouses (list with stock summary, create/edit, locations manager), Inventory
      (overview + totals + filters, Adjust, Move, Movements ledger browser), Receiving (list/new/detail),
      Transfers (list/new/detail with receive-at-destination and cancel); dashboard stock tiles; navigation enabled
- [x] Portals: tab navigation; owner-scoped "Products & stock" and "Inventory history" for vendors and 3PL clients
- [x] Verified: typecheck, lint, build; `e2e:phase3` 46/46 (receiving, reservation limits, ship, adjustments with
      before/after, moves, transfers complete/cancel, 10 concurrent reservations → exactly the affordable number succeed,
      ledger = balance = Σ locations, Shopify `availableForVariants`, hooks fired, owner lock, variant history lock,
      DB CHECK, admin pages, portal isolation); `e2e:auth` 19/19 and `e2e:phase2` 29/29 regressions; test data removed

### Phase 4 — Orders, fulfilment, shipments, returns, CSV (core session, 2026-09-06)

- [x] Schema (migration `20260906000000_phase4_orders_fulfillment`, applied to Neon, no drift): `Order` (source, sourceRef,
      Shopify identity columns, three status fields, financial status, ship-to snapshot, totals, needsAttention),
      `OrderItem` (owner per line, reserved/shipped/returned/cancelled counters), `Fulfillment/Item`, `Shipment/Item`,
      `Return/Item`, `OrderEvent`, `ImportJob`; ledger FKs to order/item/shipment; `Order_number_seq`; CHECKs on quantities
- [x] Services: `orders.ts` (createOrder/createExternal with idempotent identity, partial reservation + attention,
      reserveOrder delta-only, confirm, cancel incl. after partial shipment, adjustLineQuantity, syncExternalUpdate,
      attention flags, financial status, notes, scoped queries), `fulfillment.ts` (startPicking with double-pick guard,
      markPacked, shipFulfillment, recordExternalShipment once, tracking/status updates, work queue, shipment hooks),
      `returns.ts` (receive → inspect → restock or damaged write-off), `order-status.ts` (derivation),
      `order-csv.ts` + `lib/csv.ts` (Shopify-compatible preview/validate/import/export, failed-row report), `imports.ts` (jobs)
- [x] Admin UI: Orders list (filters incl. date range/attention), New order (multi-owner lines), Order detail (lines,
      actions, picking dialog, fulfilment cards with pack/ship, shipment cards with tracking/status, returns receive/inspect,
      history), Fulfillment work queue, Imports (upload → preview → confirm → results, failed-rows CSV, history),
      Export (filter → CSV); dashboard order tiles; navigation enabled
- [x] Portals: 3PL clients create fulfilment orders for their own SKUs and track them; vendors see orders containing
      their lines (own lines only, no totals, neutral history); scoped CSV export
- [x] API: `GET /api/orders/export` (staff filters / portal scope), `GET /api/imports/:id/failed-rows`
- [x] Verified: typecheck, lint, build; `e2e:phase4` 61/61 (multi-owner order, identity idempotency incl. 5 concurrent
      creates, partial reservation + retry, concurrent reservations, partial + multiple shipments, double-pick guard,
      delivered → FULFILLED, cancel before/after shipment, line edits with replay guard, external shipment mirrored once,
      header sync replay, returns inspection restock/damaged, ledger consistency, Shopify CSV import, row-level errors,
      failed-row CSV, missing columns, V3PL CSV, export layout/filters, round trip, import job lifecycle, admin pages,
      portal isolation); regressions `e2e:auth` 19/19, `e2e:phase2` 29/29, `e2e:phase3` 46/46

### Phase 5 — Portals, dashboards, reports (core session, 2026-09-05)

- [x] `services/reports.ts` (D-048): `portalDashboard`, `skuActivityReport`, `ordersSummaryReport`, `shipmentsReport`,
      `returnsReport`, `inventorySnapshotCsv` + CSV builders — all live from ledger/orders, owner-scoped by the caller
- [x] Portal dashboards (vendor + 3PL): stock tiles (on hand / reserved / available / low stock), open orders, picking/packed,
      shipped & received last 30 days, attention/returns/damage badges, recent orders, stock by warehouse, recent activity,
      business profile, report shortcuts; friendly first-run message for empty accounts
- [x] Portal pages: Reports (activity / orders / shipments / returns / inventory tabs with period, warehouse, status, search
      filters, pagination, CSV download), Shipments, Returns; tab navigation extended
- [x] Admin `/admin/reports` (same engine, owner filter); navigation enabled
- [x] `GET /api/reports/:report` CSV — staff filters, portal users always scoped to their owner (ownerId parameter ignored)
- [x] Loading skeletons, error boundaries and not-found pages for portal and admin areas
- [x] Verified: typecheck, lint, build; `e2e:phase5` (dashboard figures, activity/orders/shipments/returns/inventory reports,
      date/warehouse/status filters, CSV content and permissions, scope widening attempts ignored, admin owner filter,
      role-based access, empty states, pagination, deactivated owner lock-out, not-found page); regressions Phases 1–4

### Core capability requests for Shopify Step 4 (core session, 2026-09-07)

- [x] R-1 `fulfillment.recordExternalReference` and R-2 `TRACKING_UPDATED` shipment hook implemented (D-052);
      hook runners hardened with savepoints; `npm run e2e:core-requests` 21/21; all regression suites re-run

### Shopify customers → V3PL customer directory (Shopify session, 2026-09-22, D-065)

- [x] `customers-sync.ts` (paged `customers` 2026-07, incremental `updated_at`, budget, per-record isolation), core
      `upsertShopifyCustomer`, `read_customers` scope (`shopify.app.toml`, env), *Sync customers now* on the store
      Overview, order import links `Order.customerId`; migration `20260922120000_shopify_customer_sync` (applied on the
      Neon test branch only — production needs `prisma migrate deploy` before the deploy); `e2e:shopify-customers` 23/23
- [ ] Dev store: create + release the app version with `read_customers`, Vercel `SHOPIFY_SCOPES`, production
      migration, Reconnect `shakilxvs.myshopify.com`, run *Sync customers now*, check the directory and an imported order

### Shopify inventory for V3PL-created orders (Shopify session, 2026-09-22, D-066)

- [x] Root cause from production evidence: not a reference problem; the reservation's publish (the only path that
      lowers Shopify under `BYPASS`) had been a permanent compare conflict since the 2026-09-15 publish-location change,
      and the conflict rule flagged every Shopify sale. Fix: both-sides-equal = in sync (baseline re-anchored),
      baseline reset when the publish location changes, `BYPASS` kept. `e2e:shopify-order-create` 49/49 (23a–23j)
- [x] Dev store 2026-09-22: Force publish repaired the stale baseline (192 → 276 = V3PL available); V3PL order 1756 (1 × XVS-TEST-001) → Shopify #1018 (BYPASS, tags V3PL / V3PL-1756); Shopify available 276 → 275, V3PL available 276 → 275 (reserved 9 → 10, on hand 285 unchanged); publish job DONE `published 276 → 275`; drain re-run 0 jobs, verify publish `skipped_equal`, Shopify still 275 — decreased exactly once

### Shopify product import: V3PL stock destination (Shopify session, 2026-09-22, D-067)

- [x] Import preview shows Shopify quantities as reference; per-SKU initial quantity + V3PL warehouse/location destination
      (store default warehouse pre-selected) booked through core `createProductWithInitialStock`; refused without a valid
      destination; data-only import unchanged; no schema change. `e2e:shopify2` extended (57/57, 8 new checks; regression shopify4 46/46, initial-stock 15/15)
- [ ] Manual check on the dev store: Product mapping → Import unmatched → Preview → destination + quantity → Import →
      product stock visible at the chosen location; Shopify quantities untouched

## In progress

- (none — awaiting Shopify Step 4 completion; then Phase 6)

## Pending

- Shopify Part B (App URL / redirect / webhooks) — production URL `https://v3pl.vercel.app` is now known
- Explicit go-ahead for Phase 3

## Next phase dependencies (Phase 6 — reports polish & imports; Phase 7 — Shopify)

- Phase 6: Excel/PDF exports (spec §47) and product/inventory CSV import reuse `lib/csv.ts`, `ImportJob` and `ReportView`
- Shopify session can now build on: `orders.createExternal`, `syncExternalUpdate`, `adjustLineQuantity`, `cancelOrder`,
  `flagAttention/clearAttention`, `fulfillment.recordExternalShipment`, `updateShipmentTracking`,
  `inventory.availableForVariants`, `registerInventoryChangeHandler`, `registerShipmentHandler`; all core columns from
  shopify-integration.md §5.2 exist

## Known issues

- `npm audit` reports 3 advisories (deepmerge-ts, mysql2, uuid) — all transitive dev/CLI dependencies
  of Prisma tooling, none in the runtime bundle; revisit when Prisma publishes updated tooling
- `prisma` CLI prints an "update available" notice for 8.0 release candidate — intentionally pinned to 7.10 (D-034)

## Testing notes

- **Acceptance source of truth:** [QA-MASTER.md](QA-MASTER.md) — every requirement with AUTO-PASS / MANUAL-PASS / FAIL / MISSING / PARTIAL / PENDING status, known-bug register, manual checklist (2026-09-12)

- Phase 1 verification checklist: [runbook.md](runbook.md) §7
- Phase gates per phase: [roadmap.md](roadmap.md); Shopify test matrix: [shopify-integration.md](shopify-integration.md) §18
- Full edge-case list: spec §64; real-business test required before v1 sign-off (spec §63)
