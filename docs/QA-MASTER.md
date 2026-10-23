# V3PL — QA & Acceptance Master (source of truth)

**Purpose.** The single, persistent acceptance document for V3PL. Every business requirement — from the
original master plan (`PROJECT_MASTER_PROMPT.md`), the decision log (`docs/DECISIONS.md`) and the
clarifications added on 2026-09-12 — is listed once, with its current verification status, the evidence
behind that status and the area of the system it lives in. Update this file whenever a requirement is
implemented, verified, or found broken. Nothing here is marked passed merely because code exists.

**Baseline of this revision:** audit of **`c03ff78`** (2026-09-09) on 2026-09-12; **Batch 1 bug fixes** in
**`6bc99e1`** / **`b773314`** (details in §19); **Batch 2 — Product & SKU enhancements** on 2026-09-12 (D-057; commit `108da41`, §23); initial inventory on create (D-058, `c9ab9ec`); unique variant barcode (D-059, `42808ee`); customer directory (D-060, see §23). Database schema at migration `20260915120000_customer_directory` (11 migrations, no drift).

> **Environment note (2026-09-12):** the Firebase Admin service-account key was rejected by Google earlier in
> the day (`invalid_grant: account not found`) and was replaced the same day; session-minting suites run again.
> Production sign-in should still be re-verified once with the new key.

## Status legend

| Tag | Meaning |
|---|---|
| `[AUTO-PASS]` | Verified by an automated suite listed in §1 (name given in Evidence) |
| `[MANUAL-PASS]` | Verified by a person (date and place given in Evidence) |
| `[FAIL]` | Known broken behaviour (reproduced, reported by manual testing, or confirmed by code reading) |
| `[MISSING]` | Required functionality not implemented |
| `[PARTIAL]` | Implemented in part; the gap is stated |
| `[PENDING]` | Implemented but not yet verified the way the row requires |
| `[N/A]` | Not applicable / explicitly out of scope |

Rows carry an ID (`AREA-nn`), the source (`§n` = master plan section, `D-nnn` = decision, `NR-n` = new
requirement of 2026-09-12) and an *Area* pointing at the code that owns the behaviour.

---

## 1. Automated test suites and latest known results

All suites run against the shared Neon database with unique run ids and clean up after themselves. HTTP
checks need a local production server: `npm run build && npx next start -p 3100`. Last full run:
**2026-09-12 on `b773314`** (local production build; the same commit is on `main`/production).

| Command | Scope | Checks | Last result |
|---|---|---|---|
| `npm run e2e:auth` | Phase 1: login routes, session cookie, guards, role routing, health | 19 | 19/19 pass |
| `npm run e2e:phase2` | Owners, users, ban/disable/delete, vendor/3PL isolation, portal foundations | 29 | 29/29 pass |
| `npm run e2e:phase3` | Products, SKUs, warehouses/locations, receiving, ledger, moves, transfers, damages, adjustments, portal scoping, DB CHECKs | 46 | 46/46 pass (2026-09-12) |
| `npm run e2e:phase4` | Orders (manual, multi-owner, duplicates, races), reservation, picking/packing/shipping, partial shipments, returns, order CSV import/export, portals | 61 | 61/61 pass |
| `npm run e2e:phase5` | Portal dashboards, reports, report filters, CSV permissions, empty states, deactivated owners | 49 | 49/49 pass (2026-09-12) |
| `npm run e2e:core-requests` | R-1 `recordExternalReference`, R-2 tracking hook, savepointed hook handlers | 21 | 21/21 pass |
| `npm run e2e:refinement` | Product options/variants, SKU uniqueness, product CSV import/export, deletion rules, customer-facing status, sticky sidebar, Inter | 55 | 55/55 pass (2026-09-09) |
| `npm run e2e:sidebar` | Sidebar polish: height budget model (old vs new density + account footer vs 768 px), sticky + scroll-fallback markup, account footer outside the nav, mobile-only header, hidden scrollbar CSS, labels/icons, active accent class, served CSS colours | 11 | 11/11 pass (2026-09-15, `844cbcd`) |
| `npm run e2e:shopify-order` | Manual order → Shopify, core side (D-061): store resolution rules, one ORDER_CREATE job per order (repeat + concurrent), contract payload, reference recorded once / conflicts, inbound dedupe, ineligible sources / cancelled / cancelled lines, failure → retry → re-arm, order page card, action via HTTP (ADMIN ok, WAREHOUSE refused), jobs stay PENDING without a runner | 33 | 33/33 pass (2026-09-15, `6094af3`) |
| `npm run e2e:customers` | Customer directory (D-060): create/update/search, isolation, manual + 3PL + vendor order linking, duplicate reuse, historical orders, snapshot independence, reserved Shopify fields, pages/permissions | 26 | 26/26 pass (2026-09-15, `7fc9083`) |
| `npm run e2e:barcode` | Unique barcode per variant (D-059): schema, creation, edit, builder preservation, duplicates within/across products (schema/service/DB), blanks, legacy, search + isolation, CSV, page markup | 19 | 19/19 pass (2026-09-15, `42808ee`) |
| `npm run e2e:initial-stock` | Initial inventory during product creation (D-058): per-variant quantities, blank/zero, warehouse + non-default location, receipt + RECEIVE ledger + audit, no-stock creation, vendor/3PL scoping, compensation on refused receipt, page markup | 15 | 15/15 pass (2026-09-13, `c9ab9ec`) |
| `npm run e2e:batch2` | Batch 2: option/value builder (1–3 options, preservation, rename, locked rows, duplicates), new variant fields through schema/service/CSV, duplicate SKU protection, computed product inventory, retail-vs-wholesale on orders, Shopify store conflict detection, product page HTTP checks | 31 | 31/31 pass (2026-09-12) |
| `npm run e2e:batch1` | Batch 1 bug regressions: SKU search price, search scope (3PL redirect root cause), dropdown placement, official Shopify export with image rows, orders default filter, nav/progress markup, search server action as 3PL user (id resolved from the served build) | 22 | 22/22 pass (2026-09-12, after the action-id fix in the test) |
| `npm run test:shopify` | Shopify unit tests (crypto, HMAC, matching, status mapping, job dedupe, orderCreate mapping, customer node mapping / scope guard / incremental query / 2026-07 documents …) | 86 | 86/86 pass (2026-09-22) |
| `npm run e2e:shopify1` | Step 1: store connection, OAuth, webhooks record/process/retry, compliance | 58 | 58/58 pass (2026-09-12) |
| `npm run e2e:shopify2` | Step 2: catalog sync, variant mapping, Shopify → V3PL product import, **import destination + initial stock (D-067):** Shopify quantity as reference, refused without destination, wrong-warehouse location refused, 7 units booked via core receipt, 0-qty SKU data-only, mappings/log, re-sync no duplicate, data-only unchanged | 57 | 57/57 pass (2026-09-22) |
| `npm run e2e:shopify3` | Step 3: inbound orders, reservation, edits, cancellations, reconciliation | 39 | 39/39 pass (2026-09-12) |
| `npm run e2e:finance` | Charges (rules, validation, ranges, basis, immutability) + settlement ledger under D-064: receiving creates nothing; vendor shipments create charges only (no payable); vendor payable allocation 60/40/41/concurrent/full/idempotent/historical cost; gross margin vs payable; 3PL product-value payable at shipment (idempotent) with charges on the separate receivable; payments and adjustments touch one side; no netting; ledger consistency; multi-owner shipment; charges-disabled owner; scope isolation; admin access; legacy compatibility; admin + portal pages and permissions | 43 | 43/43 pass (2026-09-16, `2ea44e3`) |
| `npm run e2e:hooks` | Core hook registry per module instance (needs `next start -p 3100`): fresh process starts with empty registries and self-registers on the first stock change (INVENTORY_PUBLISH for the mapped SKU only), a second fresh process ships a Shopify-linked manual order (FULFILLMENT_CREATE), Shopify-originated / external / tracking / pending-creation behaviour unchanged, `shipFulfillmentAction` through the built server enqueues FULFILLMENT_CREATE + INVENTORY_PUBLISH | 10 | 10/10 pass (2026-09-15, `c32e0ce`) |
| `npm run e2e:shopify-runner` | Runner registry inside the BUILT server (needs `next start -p 3100`): fresh instance self-registers, PENDING ORDER_CREATE / FULFILLMENT_CREATE discovered, claimed (attempts 0 → 1) and executed by the webhook `after()` drain and the cron route, in-process claim semantics | 8 | 8/8 pass (2026-09-15) |
| `npm run e2e:shopify-order-create` | Manual order → Shopify, Shopify side (D-062) with Shopify simulated in-process: ORDER_CREATE runner, mapping, marker, idempotency/adoption, lost response, userErrors, retry state, no double reservation, webhook race, fulfilment push, scope guard, **inventory effect (D-066):** V3PL order → Shopify available −qty per line via publish with BYPASS, multi-line, partial, re-run no double, Shopify-originated sale no conflict, genuine manual edit still conflict, missing inventory item skips safely, publish-location change resets the baseline, publishing off | 49 | 49/49 pass (2026-09-22) |
| `npm run e2e:shopify-customers` | Shopify customers → customer directory (D-065) with Shopify simulated in-process: scope guard, initial import over 3 cursor pages, creation (source SHOPIFY, company pool), field mapping, missing e-mail/phone/name, adoption of an unmapped company customer by e-mail with V3PL-only data kept, owner pools untouched, checkpoint + SUCCESS log, audit, repeat sync = no duplicates + incremental filter, mapped update without blanking, store isolation (same id / e-mail), corrupt record skipped, time budget → partial, 502 → FAILED log, order import links mapped / creates unknown / skips without scope, directory list/search/detail/isolation | 23 | 23/23 pass (2026-09-22) |\n| `npm run e2e:shopify4` | Step 4 with Shopify simulated in-process: fulfilment push/pull, tracking, inventory publishing | 46 | 46/46 pass (2026-09-12) |
| `npm run typecheck` · `npm run lint` · `npm run build` | Static checks | — | clean (lint: 0 errors, 8 pre-existing react-hook-form warnings) |

**Total automated checks: 856** (848 + 8 import-destination checks in `e2e:shopify2`). **Full re-run on 2026-09-12 against `b773314` (Batch 1 final):** `e2e:auth` 19/19, `e2e:phase2` 29/29, `e2e:phase3` 46/46, `e2e:phase4` 61/61, `e2e:phase5` 49/49, `e2e:core-requests` 21/21, `e2e:refinement` 55/55, `e2e:batch1` 22/22, `test:shopify` 73/73, `e2e:shopify1` 58/58, `e2e:shopify2` 49/49, `e2e:shopify3` 39/39, `e2e:shopify4` 46/46 — **567/567**; typecheck, lint (0 errors, 8 pre-existing warnings) and production build clean. Note: one `e2e:phase5` attempt inside the sequential batch aborted before printing a summary (output not retained); an isolated rerun passed 49/49, so no regression is recorded. Not covered by automation: real browser behaviour (client-side form
interactions, scrollbars, loading feedback, dropdown clipping), the real Shopify store (only Step 1–3 were
production-verified by hand; Step 4 pending), e-mail, Excel/PDF.

---

## 2. Foundation, authentication, security (§7, §8, §56, §57, Phase 1–2)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| SEC-01 | Firebase e-mail/password auth with server session cookie; staff at `/admin`, partners at `/user` | `[AUTO-PASS]` | e2e:auth (routing, cookie, wrong-audience rejection); D-010, D-033 | `src/server/auth/*`, `src/proxy.ts` |
| SEC-02 | Server-side authorization on every route/action; user status re-read per request | `[AUTO-PASS]` | e2e:auth, e2e:phase2 (banned/disabled users lose access) | `guards.ts`, `current-user.ts` |
| SEC-03 | Vendor A ≠ Vendor B; 3PL ≠ Vendor; owner scope comes from the session only, never the URL | `[AUTO-PASS]` | e2e:phase2, phase3 (portal products/history), phase4 (portal order 404 for foreign order), phase5 (export scoping), refinement (product export scoping) | portal pages, `scopeOwnerId` in services |
| SEC-04 | Input validation shared client/server (Zod) | `[AUTO-PASS]` | every action parses with schemas; refinement checks product schema rules | `src/lib/validation/*` |
| SEC-05 | Secrets only in `.env.local` / Vercel; `.env.example` names only; never printed | `[MANUAL-PASS]` | Reviewed 2026-09-08 during Step 4 audit; `.gitignore`, D-036 | repo hygiene |
| SEC-06 | Audit log for important actions | `[AUTO-PASS]` | phase2–5 + refinement assert audit rows (deletions, status changes) | `services/audit.ts` |
| SEC-07 | Production health endpoint without secrets | `[MANUAL-PASS]` | `/api/health` checked 2026-09-08 (`status: ok`) | `api/health` |
| SEC-08 | User delete = tombstone (row kept, Firebase account removed, e-mail reusable) | `[AUTO-PASS]` | e2e:phase2; D-037 | `services/users.ts` |

## 3. Owners (vendors / 3PL clients), users, portals (§4–§6, §9, §10, Phase 2 & 5)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| OWN-01 | Unified Owner model (VENDOR / THREEPL_CLIENT), unique code, INACTIVE instead of delete | `[AUTO-PASS]` | e2e:phase2; D-003 | `services/owners.ts` |
| OWN-02 | Every product/SKU has exactly one owner; owner locked once history exists | `[AUTO-PASS]` | e2e:phase3 "Owner cannot change once the product has inventory history" | `services/products.ts` |
| OWN-03 | Vendor portal: dashboard, products & stock, inventory history, orders (own lines only), shipments, returns, reports, CSV export | `[AUTO-PASS]` | e2e:phase5, phase3, phase4 | `src/app/portal/vendor/**` |
| OWN-04 | 3PL portal: same plus order submission | `[AUTO-PASS]` | e2e:phase4 "3PL portal new-order page renders", order visible in portal list | `src/app/portal/3pl/**` |
| OWN-05 | Portal views hide other owners' SKUs and money totals | `[AUTO-PASS]` | e2e:phase4 (no A1/B1 on C's view, no totals) | `orders.getOrder(scopeOwnerId)` |
| OWN-06 | Staff roles ADMIN / WAREHOUSE / SALES with role-filtered navigation and guards | `[AUTO-PASS]` | e2e:auth/phase2; D-010 | `config/navigation.ts`, guards |
| OWN-07 | Admin can send a manual e-mail from a vendor / 3PL profile (§50, NR-10) | `[MISSING]` | No e-mail provider configured, no send action, no UI. Needs: provider env vars (names only in `.env.example`), `services/email.ts`, "Send e-mail" dialog on owner detail, audit row | owner detail page, new e-mail service |

## 4. Products and variants (§12, §13, D-053, NR-1, NR-14)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| PRD-01 | Product = container; Variant = sellable/inventory unit; SKU globally unique | `[AUTO-PASS]` | e2e:phase3 "Global SKU uniqueness", refinement "SKU uniqueness is global"; D-004 | `Product`, `ProductVariant` |
| PRD-02 | Shopify-like options (≤3 names), one value per option per variant, derived label "White / L" | `[AUTO-PASS]` | refinement (create, edit, validation of missing/duplicate values, duplicate names); D-053 | `validation/products.ts`, `services/products.ts` |
| PRD-03 | Each option supports **multiple values** entered as a list, and variants are **generated as combinations** (White/L, White/XL, Black/L …) | `[AUTO-PASS]` (logic) + `[PENDING]` (browser) | Implemented 2026-09-12 (Batch 2, D-057): option name + comma-separated values per option (≤ 3); every combination becomes a variant row; existing rows keep SKU/prices/physical data/id; same-position value edits are renames; rows with stock history are kept as orphaned, never dropped; duplicates impossible. `e2e:batch2` covers 1/2/3 options, preservation, rename, removal, locked rows, duplicate values; browser walk-through pending | `lib/variant-builder.ts`, `product-form.tsx` |
| PRD-04 | Each variant has its own SKU, price, status and inventory | `[AUTO-PASS]` | refinement (per-variant price/status; inventory per variant in phase3) | schema, services |
| PRD-05 | Inventory is never a total per option group; product-level figures are computed summaries only | `[AUTO-PASS]` | Ledger/balances are keyed by variant × warehouse (× location); list/detail totals are computed (`inventorySummary`) — phase3, refinement | `services/inventory.ts`, `products.ts` |
| PRD-06 | Title defaults to SKU for a new simple product and stays editable | `[AUTO-PASS]` + `[PENDING]` | Helper `suggestedTitle` covered by refinement; real typing behaviour in the browser not yet manually verified | `product-form.tsx` |
| PRD-07 | Product UI limited to needed Shopify-like information (owner, title, status, variants: values/SKU/price/inventory/status) | `[AUTO-PASS]` + `[PENDING]` | refinement HTTP checks on list/detail/new/edit; visual review pending | product pages |
| PRD-08 | Optional weight and dimensions per variant | `[AUTO-PASS]` + `[PENDING]` (browser) | Implemented 2026-09-12 (Batch 2): `ProductVariant.weightGrams`, `lengthCm/widthCm/heightCm` (migration `20260912120000_variant_pricing_physical`), form inputs per variant, detail page display, CSV `Variant Grams` + `V3PL Length/Width/Height (cm)`. `e2e:batch2` covers schema validation, persistence, edit preservation, CSV export/import. No product-level default (kept minimal; variants are the physical units) | schema, product form, product-csv |
| PRD-09 | Same product capabilities for Vendor- and 3PL-owned products | `[AUTO-PASS]` | Owner type is irrelevant to product code paths; phase4/5 create 3PL products the same way | `services/products.ts` |
| PRD-10 | Product images (Cloudinary, signed uploads, max/positions) | `[PENDING]` | Implemented (Phase 3); no automated coverage; Cloudinary configured in production. Manual check pending | `product-images.tsx`, `lib/cloudinary.ts` |
| PRD-11 | Archive / reactivate products and variants; archived SKUs blocked from receiving and new orders | `[AUTO-PASS]` | e2e:phase3, refinement (archived SKU cannot receive) | services |
| PRD-12 | Product delete only without history; otherwise archive, with blockers shown | `[AUTO-PASS]` | refinement; D-054 | `productDeleteCheck`, delete button |
| PRD-14 | Unique barcode per variant (D-059): optional, variant-level, globally unique; blank allowed; never silently changed or duplicated; duplicates within a product and across products rejected with the conflicting barcode named; existing products without barcodes stay valid; barcode search alongside SKU; CSV `Variant Barcode` validated | `[AUTO-PASS]` + `[PENDING]` (browser) | `e2e:barcode`: creation with mixed blank/filled barcodes, edit/clear, preservation through rename + regeneration, across-product and edit clashes (`BARCODE_TAKEN` names barcode + SKU), schema bypass caught by the DB unique index, index present, blanks coexist, legacy edits, search by barcode + owner isolation, CSV export/round trip/validation/persist, form and detail markup. Browser: type barcodes on generated rows, see the duplicate error, see the barcode on the detail page and in the SKU picker | schema, `validation/products.ts`, `services/products.ts`, `product-form.tsx`, `product-csv.ts` |
| PRD-13 | Current product UI supports real multi-variant products (NR-11) | `[AUTO-PASS]` + `[PENDING]` | Data + pages verified by refinement and batch2 (3-option product, 8 variants); manual browser walk-through of creating a 2-option product still pending | product form |

## 5. Pricing (NR-2)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| PRC-01 | Wholesale price per variant | `[AUTO-PASS]` | Implemented 2026-09-12 (Batch 2): `ProductVariant.wholesalePrice`, form column "Wholesale", detail page column, CSV `V3PL Wholesale Price`. `e2e:batch2` persists, edits and round-trips it | schema, product form, product-csv |
| PRC-02 | Retail price per variant | `[AUTO-PASS]` | `ProductVariant.price` is the retail price (labelled "Retail" in the form and detail page since Batch 2); refinement/phase3/batch2 | schema |
| PRC-03 | Customer orders use retail price by default | `[AUTO-PASS]` (server) + `[PENDING]` (form) | Server: a line without a typed price stores the retail price and never the wholesale price (`e2e:batch1`, `e2e:batch2`); a typed price overrides. Form: the unit price field is filled from the picked SKU and stays editable — browser check pending | `orders.createOrder`, `order-form.tsx` |
| PRC-04 | Price auto-populates when a SKU is selected | `[AUTO-PASS]` (data) + `[PENDING]` (browser) | Fixed 2026-09-12 (Batch 1): `searchVariants` returns `price` + `currency`, `PickedVariant` carries them, the order form sets `unitPrice` on pick when empty (typed prices preserved, cleared with the SKU). `e2e:batch1` covers the service; the client fill is a manual check | `services/products.searchVariants`, `variant-picker.tsx`, `order-form.tsx` |
| PRC-05 | Wholesale value used for owner/business valuation | `[MISSING]` (deferred) | Wholesale price is now stored (PRC-01); its use in valuation / due-owe belongs to the finance ledger (FIN-01) | reports / finance ledger |

## 6. SKU ↔ Shopify store rule (NR-3, D-004)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| SKU-01 | Internal SKU globally unique | `[AUTO-PASS]` | phase3, refinement | `ProductVariant.sku @unique` |
| SKU-02 | One internal SKU maps to at most one Shopify variant **per store** | `[AUTO-PASS]` | DB unique `(storeId, variantId)`; e2e:shopify2 | `ShopifyVariantMapping` |
| SKU-03 | Warn on create/edit when the SKU already exists in another connected Shopify store | `[AUTO-PASS]` (detection) + `[PENDING]` (browser) | Implemented 2026-09-12 (Batch 2): read-only `skuStoreConflicts` over `ShopifyVariantMapping` of *connected* stores; the product form shows a non-blocking "Shopify store check" alert (already mapped in store X / exists as Shopify SKU / appears in N stores) and never changes mappings. `e2e:batch2`: mapped, unmapped, two-store, pending-store and own-product cases; mapping unchanged after save. Not yet in the CSV preview (deferred, low value) | `services/products.ts`, `actions/products.ts`, `product-form.tsx` |
| SKU-04 | If one SKU is mapped to several connected stores, manual order creation must ask which store to use | `[AUTO-PASS]` (as "refuse and explain", D-061) | 2026-09-15: `resolveShopifyStoreForVariants` returns `AMBIGUOUS_MAPPING` naming the SKU and the stores; the order form hint and the order page show it, no job is created and V3PL never guesses. A per-order store picker was deliberately not built (fix the mapping instead). `e2e:shopify-order` | `shopify-order-request.ts`, `order-form.tsx`, `shopify-outbound-card.tsx` |

## 7. Warehouses, exact locations, inventory engine (§11, §14–§20, NR-7, D-006/D-007/D-043–D-045)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| INV-01 | Multiple warehouses; each has a default `MAIN` location | `[AUTO-PASS]` | phase3 | `services/warehouses.ts` |
| INV-02 | Exact physical location = Warehouse → Zone → Rack → Shelf → Bin | `[PARTIAL]` | `Location` rows carry `label` + optional `zone/rack/shelf/bin` attributes and stock is tracked per location (phase3 moves). There is no hierarchical zone/rack/shelf tree or picker; a location is chosen by label | `Location`, `location-select.tsx` |
| INV-03 | Receiving selects the exact location per line; variants of one product can sit in different locations with different quantities | `[AUTO-PASS]` | phase3 (receiving per location, move MAIN → A-01-1-B1, warehouse total invariant) | `receiving-form.tsx`, `inventory.receiveStock` |
| INV-09 | Initial inventory entered while creating a product: optional quantity per generated variant, warehouse + location choice, booked through the receiving service (receipt, RECEIVE ledger, audit), zero-stock creation still possible, same for vendor- and 3PL-owned products (D-058) | `[AUTO-PASS]` (service + markup) + `[PENDING]` (browser) | `e2e:initial-stock`: 25/30/15 across variants with one blank, non-default location in a second warehouse for a 3PL product, exactly N RECEIVE rows with user/warehouse/location/reference and before/after, audit rows, ledger consistency, blank/zero → no receipt, quantity without warehouse refused, refused receipt rolls the product back, page renders the card, edit page has none. Browser: enter quantities, save, see the receipt in Receiving and stock on the product | `products.createProductWithInitialStock`, `actions/products.createProductAction`, `product-form.tsx` |
| INV-04 | Append-only ledger with before/after, cached balances, `onHand ≥ 0`, `reserved ≤ onHand`, DB CHECKs | `[AUTO-PASS]` | phase3 "DB CHECK blocks negative onHand", ledger consistency | `services/inventory.ts`, migrations |
| INV-05 | Inventory service is the sole writer of stock tables (incl. CSV imports and Shopify) | `[AUTO-PASS]` | refinement (CSV quantities booked as receipts), shopify3/4 use core services; D-027 | services |
| INV-06 | Reservation, release, ship, return, transfer (two legs), damage, missing, audited adjustments | `[AUTO-PASS]` | phase3, phase4 | `services/inventory.ts`, `transfers.ts`, `returns.ts` |
| INV-07 | Warehouse/location deactivate only when empty; delete only without history | `[AUTO-PASS]` | phase3, refinement | `services/warehouses.ts` |
| INV-08 | Inventory CSV import (§47) | `[MISSING]` | Planned for Phase 6; order and product CSV exist, inventory does not | imports |

## 8. Orders (§21–§27, §34, §35, D-046/D-047, NR-12)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| ORD-01 | Manual order: search SKU → quantity → warehouse → validate stock → create → reserve | `[AUTO-PASS]` | phase4 (creation, reservation, shortages flagged as attention); price population fixed in Batch 1 (PRC-04) | `order-form.tsx`, `orders.createOrder` |
| ORD-02 | Multi-owner orders: one order, each line keeps its owner | `[AUTO-PASS]` | phase4 (3 owners, portal sees own lines) | `OrderItem.ownerId` |
| ORD-03 | Duplicate protection: `UNIQUE(source, sourceRef)`, `UNIQUE(store, shopifyOrderId)`, concurrent creates → one order | `[AUTO-PASS]` | phase4 (race test 5 concurrent), shopify3 | `orders.createOrder` |
| ORD-04 | Delta-only reservation, `needsAttention` on shortage, "Reserve now" retry | `[AUTO-PASS]` | phase4 | `orders.reserveOrder` |
| ORD-05 | Three status dimensions derived, never hand-edited | `[AUTO-PASS]` | phase4; D-008 | `order-status.ts` |
| ORD-06 | Primary UI status: Unfulfilled / Partially fulfilled / Fulfilled / Delivered / Returned / Cancelled; warehouse stage secondary | `[AUTO-PASS]` + `[PENDING]` | refinement (derivation, list, detail, portal); D-055. Visual review pending | `lib/order-presentation.ts` |
| ORD-07 | Order stays visible with the correct status after a Shopify-side fulfilment | `[AUTO-PASS]` + `[PENDING]` (browser) | Fixed 2026-09-12 (Batch 1): the list defaults to **All orders** (newest first) with an explicit caption of the active filters; "Open only / Completed only / Cancelled only" remain as filters; the dashboard "Open orders" tile links to `?status=OPEN`. `e2e:batch1`: a fully shipped COMPLETED order is in the default list, excluded from Open only, found by number search, and shown on the served list page with the caption | `validation/orders.ts`, orders page, `order-stats.tsx` |
| ORD-08 | Order delete only without history; otherwise cancel | `[AUTO-PASS]` | refinement; D-054 | `orders.deleteOrder` |
| ORD-09 | Order history/events, notes, financial status + invoice reference per order | `[AUTO-PASS]` | phase4/5 | `OrderEvent`, `setFinancialStatus` |
| ORD-10 | Bulk order CSV (Shopify-compatible) upload → preview → validate → errors → confirm → results; export with filters; lossless round trip | `[AUTO-PASS]` | phase4 (import/export/round trip/failed rows); D-046, `docs/csv-orders.md` | `order-csv.ts`, `imports.ts` |
| ORD-11 | Customer snapshot on the order (name/e-mail/phone/ship-to) | `[AUTO-PASS]` | phase4 | `Order.customer*`, `ship*` |

## 9. Fulfilment, shipping, returns (§28–§33, Phase 4)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| FUL-01 | Picking (partial lines allowed), packing, shipping with carrier/tracking; partial shipments; double-pick prevented | `[AUTO-PASS]` | phase4 | `services/fulfillment.ts` |
| FUL-02 | Shipment status Pending → Shipped → In transit → Delivered → Returned; all delivered ⇒ FULFILLED | `[AUTO-PASS]` | phase4 | `updateShipmentStatus` |
| FUL-03 | Returns → inspection → restock or write-off (ledger RETURN + DAMAGE) | `[AUTO-PASS]` | phase4, phase5 | `services/returns.ts` |
| FUL-04 | Tracking edits after shipping (idempotent, external replay ignored) | `[AUTO-PASS]` | phase4, core-requests (R-2) | `updateShipmentTracking` |
| FUL-05 | Warehouse queue (Open / Picking / Packed / Shipped) | `[PENDING]` | Implemented in Phase 4; page renders in phase3 route sweep; workflow tested via services. Manual tablet check pending (§55) | `admin/fulfillment/page.tsx` |

## 10. 3PL order workflow (§10, D-011, NR-6)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| TPL-01 | 3PL stock received → available → client submits order → reserve → pick → pack → ship → tracking → delivery | `[AUTO-PASS]` | phase4/phase5 exercise every step through services on 3PL-owned SKUs; portal submission via `createPortalOrderAction` (source `THREEPL_PORTAL`) | `orders.ts`, `fulfillment.ts` |
| TPL-02 | Submitted 3PL order appears in Admin Orders **and** 3PL Orders | `[AUTO-PASS]` | phase4 (portal list shows order; admin list unscoped). Screen-level re-check after the status redesign: `[PENDING]` | orders pages |
| TPL-03 | 3PL client sees only its own lines/shipments/returns | `[AUTO-PASS]` | phase4 | `getOrder(scopeOwnerId)` |

## 11. Customer directory (§25, NR-5)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| CUS-01 | Simple operational directory (no CRM, no customer logins): name, e-mail, phone, shipping + billing address, source, timestamps | `[AUTO-PASS]` + `[PENDING]` (browser) | Implemented 2026-09-15 (D-060): `Customer` model, admin list/search/detail/create/edit at `/admin/customers`, portal Customers tabs. `e2e:customers` covers create/update (normalised e-mail/phone, audit), search by name/e-mail/phone, pages | `services/customers.ts`, `components/customers/*`, `app/admin/(dashboard)/customers/**` |
| CUS-02 | Manual orders can select an existing customer; new customers are saved; reuse | `[AUTO-PASS]` + `[PENDING]` (browser) | Order forms have a customer picker (fills the form) and "Save as new customer"; an exact e-mail/phone match in the same owner pool is reused. `e2e:customers`: existing customer linked, new saved with source ORDER, second save reuses, name required | `order-form.tsx`, `customer-picker.tsx`, `resolveOrderCustomer` |
| CUS-03 | Shopify customers from all connected stores synchronised (new added, existing updated) | `[AUTO-PASS]` + `[PENDING]` dev store | Implemented 2026-09-22 (D-065, Shopify session): *Sync customers now* on the store Overview pages `customers` (2026-07, `defaultEmailAddress` / `defaultPhoneNumber`, cursor pagination, incremental `updated_at` filter after the first complete run, 120 s budget → partial + re-run); identity = (store, numeric Shopify id) unique pair; core `upsertShopifyCustomer` updates mapped records without blanking V3PL-only data, links an unmapped company customer with the same e-mail once, otherwise creates a company customer with source SHOPIFY; one bad record is logged and skipped; imported Shopify orders link `Order.customerId` when the store granted `read_customers`. `e2e:shopify-customers` 23/23. **Intentional limits:** no customer webhooks / scheduled sync (manual action only), no writes to Shopify, all store customers are company customers (no per-owner assignment), no backfill of earlier orders. **Dev-store verification pending** (app version with `read_customers`, production migration, reconnect) | `services/shopify/customers-sync.ts`, `services/customers.ts` (`upsertShopifyCustomer`), `sync-customers-button.tsx`, `orders-in.ts` |
| CUS-04 | Customer data isolation (owner scope; portals never see other owners' customers; company customers hidden from portals) | `[AUTO-PASS]` | Scope from the session only; `e2e:customers`: list/get/update/search scoped, browser ownerId ignored, foreign customerId on an order refused (FORBIDDEN) for 3PL and vendor scopes, HTTP 404 for foreign detail | `services/customers.ts`, actions, pages |
| CUS-05 | Customer history shows related orders | `[AUTO-PASS]` | Detail page lists linked orders (portal: only orders with the viewer's lines); `e2e:customers` | `customer-detail.tsx` |
| CUS-07 | Historical orders keep their stored customer data; new orders link via `Order.customerId`; editing a customer never rewrites order snapshots | `[AUTO-PASS]` | `e2e:customers`: unlinked legacy order displayed/listed with no directory record; linked order unchanged after customer edit; customer with orders cannot change owner | `orders.ts`, `customers.ts` |
| CUS-06 | Compliance redaction of customer data (`customers/redact`) | `[PARTIAL]` | Webhook acknowledged and flagged for manual action (Step 1); core `redactCustomerData` (R-6) not built | `webhooks.ts`, core-requests R-6 |

## 12. Shopify integration (§36–§46, D-023…D-032, D-050…D-052; Shopify session owns the code)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| SHP-01 | Multiple store connections, single public app, OAuth, encrypted expiring tokens, refresh | `[AUTO-PASS]` + `[MANUAL-PASS]` | shopify1; dev store `shakilxvs.myshopify.com` connected on production 2026-09-06 | `shopify/oauth.ts`, `stores.ts` |
| SHP-02 | Webhooks: verify → record → 200 → process; retry sweep; compliance topics | `[AUTO-PASS]` + `[MANUAL-PASS]` | shopify1; production webhooks observed (orders, products, fulfillments) | `webhooks.ts` |
| SHP-03 | Catalog sync + SKU matching (exact SKU only; manual map; conflicts; import Shopify products into V3PL through core `createProduct`) | `[AUTO-PASS]` + `[MANUAL-PASS]` | shopify2; production 2026-09-07 (`XVS-TEST-001` matched) **D-067 (2026-09-22):** import preview shows Shopify's sellable quantity as reference; optional initial quantity per SKU booked into an explicitly chosen V3PL warehouse/location (store default warehouse pre-selected) through core `createProductWithInitialStock`; refused without a valid destination; no quantities = unchanged data-only import; Shopify locations never treated as V3PL warehouses. `e2e:shopify2` 57/57. Browser check of the dialog `[PENDING]` | `catalog*.ts`, `mapping.ts` |
| SHP-04 | Inbound orders: import, reserve, edits, cancellations, reconciliation, non-shipping lines, test orders | `[AUTO-PASS]` + `[MANUAL-PASS]` | shopify3; production 2026-09-07 (order #1002) | `orders-in.ts` |
| SHP-05 | Outbound fulfilment + tracking (one Shopify fulfilment per shipment, adoption on retry, R-1/R-2) | `[AUTO-PASS]` + `[PENDING]` | shopify4 with simulated Shopify; **production verification pending** — needs fresh unfulfilled dev-store orders (all existing ones already fulfilled; app has read-only order scope) | `fulfillment-out.ts` |
| SHP-06 | Inbound fulfilment mirror once, replay no-op, no loop-back | `[AUTO-PASS]` + `[PENDING]` | shopify4; production pending (same blocker) | `fulfillment-in.ts` |
| SHP-07 | Inventory publishing: compare-and-set, activation, equal skip, mismatch attention, force, disable, daily sweep | `[AUTO-PASS]` + `[PENDING]` | shopify4; production run on 2026-09-08 was **NOT PASS** (missing `@idempotent`); fixed in `1dbb0b5` and verified against the real API with a temp script; full production sequence still to be re-run **D-066 (2026-09-22):** conflict rule corrected (Shopify == V3PL available is never a conflict; Shopify-originated sales no longer flag), publish-location change resets the baseline; dev store 2026-09-22: V3PL order 1756 → Shopify #1018, Shopify available 276 → 275, V3PL 276 → 275, re-run unchanged | `inventory-publish.ts` |
| SHP-08 | Sync log, outbound job queue with dedupe, attention states, retry, daily cron on Hobby tier | `[AUTO-PASS]` | shopify1–4; D-031 | `jobs.ts`, `maintenance.ts`, `sync-log.ts` |
| SHP-09 | No duplication of inventory/order/fulfilment logic in the integration (NR-14, D-027) | `[AUTO-PASS]` | Shopify code calls `orders.createExternal`, `recordExternalShipment`, `recordExternalReference`, `availableForVariants`; hooks only enqueue jobs — core-requests, shopify3/4 | `register.ts`, core services |
| SHP-10 | Manual V3PL order for a SKU mapped to one store ⇒ Shopify order created automatically in that store, tagged/noted as from V3PL, references kept both ways, no duplicates, no double deduction, retry/attention on API failure (NR-4) | `[AUTO-PASS]` + `[PENDING]` dev store | Core (D-061, `6094af3`): resolution, idempotent `ORDER_CREATE` job, contract, result hooks, UI — `e2e:shopify-order` 33/33. Shopify side (D-062, 2026-09-15): `order-out.ts` runner — `orderCreate` 2026-07 with `inventoryBehaviour: BYPASS` (Shopify never claims stock; V3PL reservation is the only effect), `financialStatus: PENDING`, V3PL retail `priceSet`, email/phone/addresses (no customer object), tags `V3PL` + `V3PL-<n>`, note `Created from V3PL order <n>.`, attributes `V3PL order` / `v3pl_idempotency_key`; adoption by tag + attribute and remembered id before create; inbound `orders/create` links (never imports) V3PL-origin orders so the webhook race cannot duplicate; fulfilment push widened to "has Shopify reference" with variant-based line matching; `write_orders` scope in `shopify.app.toml` + runner scope guard. `e2e:shopify-order-create` 39/39 (registration, execution, store/variant/price/customer/shipping/billing mapping, marker, reference, DONE, repeat, adoption, lost response, remembered id, userErrors, 502 → retry, no double reservation, webhook-first race, duplicate refused, orders/updated safe, fulfilment push, Shopify-originated unchanged, scope guard). **Dev-store verification pending:** release the new app version, set `SHOPIFY_SCOPES` on Vercel, reconnect `shakilxvs.myshopify.com`, then run the 17-step checklist (shopify-integration.md §12.2). | `order-out.ts`, `orders-in.ts`, `register.ts`, `fulfillment-out.ts`, `shopify.app.toml` |
| SHP-11 | Shopify product CSV (Shopify export format) import/export in V3PL (§46) | `[PARTIAL]` | See CSV-01…CSV-06; real-export image rows break import (CSV-05) | `product-csv.ts` |

## 13. Product CSV import / export (§46, §47, §53, D-053, NR-13)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| CSV-01 | Preserve Handle, Title, option names, option values, Variant SKU, Variant Price, Variant Inventory Qty; multiple variants grouped under one product | `[AUTO-PASS]` | refinement (3-variant hoodie, simple mug/hat, round trip) ; `docs/csv-products.md` | `product-csv.ts` |
| CSV-02 | Existing SKUs updated in place; new SKUs added to the same product; owner rules; option-change guard | `[AUTO-PASS]` | refinement | `product-csv.ts` |
| CSV-03 | Quantities booked as receipts for new active SKUs only | `[AUTO-PASS]` | refinement | `product-csv.ts` → `receiving.createReceiving` |
| CSV-04 | Row-level errors, failed-rows CSV, whole-product skip, import job history | `[AUTO-PASS]` | refinement | `imports.ts`, imports pages |
| CSV-05 | A **real Shopify product export** imports without false errors | `[AUTO-PASS]` + `[PENDING]` (customer's original file) | Fixed 2026-09-12 (Batch 1): image-only rows (Handle + `Image Src`/`Image Position`, no product/option/variant data) are recognised as media rows, excluded from variants and from errors, and counted in the preview; `Cost per item` maps to cost. `e2e:batch1` imports a fixture with the official 46-column Shopify header (incl. `Option1 Linked To`, `Variant Weight Unit`, market columns) and 3 image rows: 0 errors, 3 variants, simple product intact, rows without SKU still error. The customer's original failing file was not available to the session — re-run it manually | `previewProductCsv`, `isMediaRow` |
| CSV-06 | Export = Shopify layout + `V3PL …` columns; filters; portal scoped | `[AUTO-PASS]` | refinement; `/api/products/export` | `product-csv.ts`, route |
| CSV-07 | Excel export / PDF reports (§47) | `[MISSING]` | Phase 6 | reports |

## 14. Operational charges (NR-8)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| CHG-01 | Charge types: picking, packing, shipping, storage, fulfilment, service, utility, other/custom | `[AUTO-PASS]` | 2026-09-16 (D-063): `ChargeType` enum + `ChargeRule` (name, type, basis, amount, active, applicability, ranges, notes); Settings → Operational charges (list, create, edit, activate/deactivate, delete-if-unused). `e2e:finance` 1–3 | `charges.ts`, `charge-rule-form.tsx`, `charge-rules-table.tsx` |
| CHG-02 | Rules by weight range, dimension range, weight + dimension, per order, per shipment, per unit (configurable ranges) | `[AUTO-PASS]` | 2026-09-16: ranges on the variant's existing `weightGrams` and longest side of `lengthCm/widthCm/heightCm` (no new fields); PER_UNIT per item, PER_SHIPMENT once per owner per shipment, PER_ORDER once per owner per order at first shipment; unknown data never matches a ranged rule. `e2e:finance` 4–7 | `charges.ts` (`ruleMatches`, `longestSideCm`), `finance.ts` (`recordShipmentFinancials`) |
| CHG-03 | Charges enabled optionally per vendor and per 3PL client | `[AUTO-PASS]` | 2026-09-16: `Owner.chargesEnabled` (default off) on the owner form; rules also target a specific owner or an owner type. `e2e:finance` owner flag, 23, 23b | `owner-form.tsx`, `validation/owners.ts` |
| CHG-04 | Charges recorded against orders/shipments/storage periods and feed the finance ledger | `[AUTO-PASS]` (orders/shipments) + `[MISSING]` (storage periods) | 2026-09-16: immutable `Charge` rows (frozen rule name / unit amount, order + shipment + item refs, dedupeKey) each mirrored by one RECEIVABLE ledger entry; recorded at shipment for warehouse and Shopify-mirrored fulfilments; rule edits never rewrite history. Unchanged by the D-064 correction. Storage-period charges deferred. `e2e:finance` 7, 8, 10, 21, 22 | `finance.ts`, `fulfillment.ts` |

## 15. Operational finance ledger (§49, Phase 8, NR-9)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| FIN-01 | Owner-level ledger: wholesale value, operational charges, manual payments/settlements, remaining balance, who owes whom | `[AUTO-PASS]` | **Corrected 2026-09-16 (D-064):** two independent accounts (PAYABLE / RECEIVABLE, INCREASE / DECREASE), balances derived per account and never netted. Vendors: no automatic payable at receiving or shipping; Admin allocates received units into `VENDOR_PAYABLE` entries (60 of 100 → 40 remaining; 41 refused; concurrent allocations row-locked; historical unit cost frozen); wholesale price is the cost basis of the gross-margin report only. 3PL: automatic `PRODUCT_VALUE` payable per shipped unit (idempotent per shipment/item), charges on the receivable side, payments settle one side only. `e2e:finance` V1–V11, 3PL-S1–S7, 16, 20 | `finance.ts`, `vendor-payable-form.tsx`, `settlement-form.tsx`, docs/finance.md §3 |
| FIN-02 | Statuses Not Invoiced / Invoiced / Partially Paid / Paid / Outstanding | `[PARTIAL]` | Per-order `financialStatus` unchanged; at owner level the ledger presents *Payable to owner* and *Receivable from owner* separately (D-064). Invoice-level statuses remain a later accounting decision | `Order.financialStatus`, `balance-card.tsx` |
| FIN-03 | Balance visible on Admin dashboard, Vendor dashboard, 3PL dashboard, Vendor profile, 3PL profile, reports | `[AUTO-PASS]` (markup) + `[PENDING]` (browser) | 2026-09-16 (D-064): every surface shows payable and receivable side by side — admin dashboard gross totals (ADMIN), Admin → Finance overview (no netted column) + owner ledger, two-sided balance card on vendor / 3PL profiles and both portal dashboards, portal Finance tabs; vendors additionally see the gross-margin report (sales − wholesale cost), never mixed into the ledger. `e2e:finance` HTTP checks | `finance-stats.tsx`, `balance-card.tsx`, `gross-margin-card.tsx`, `/admin/finance`, `/portal/*/finance` |
| FIN-04 | No accounting software / payment processing; accounting abstraction only | `[N/A]` (by design) | D-020 style decision in Phase 0; nothing to verify until Phase 8 | — |

## 16. Reports, dashboards, exports (§48, §54, Phase 5–6)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| REP-01 | Reports: SKU activity, orders summary, shipments, returns, inventory snapshot; filters; CSV; portal scoped | `[AUTO-PASS]` | phase5 | `services/reports.ts`, `/api/reports/:report` |
| REP-02 | Remaining §48 reports: sales, vendor/3PL activity, warehouses, fulfilment, damages, missing, adjustments, Shopify sync, financial | `[PARTIAL]` | Inventory movement types cover damages/missing/adjustments inside SKU activity; Shopify sync visible per store; no dedicated sales/fulfilment/financial reports | Phase 6 |
| REP-03 | Admin dashboard tiles (§54) | `[PARTIAL]` | Orders (open/picking/packed/shipped today/attention), stock, partners exist; low stock, Shopify sync alerts, recent activity not on the dashboard. `[PENDING]` manual review | `components/dashboard/*` |
| REP-04 | Excel / PDF | `[MISSING]` | Phase 6 | — |

## 17. Global UI/UX, layout, typography (§52, §55, D-056, NR-11, NR-12)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| UI-01 | Fixed/sticky admin sidebar; content scrolls independently; **no unnecessary sidebar scrollbar at 100% zoom on normal desktop heights**; internal scrolling only when the viewport is genuinely too short | `[AUTO-PASS]` (markup + height model) + `[PENDING]` (browser) | Root cause found 2026-09-15: at the previous density (32 px rows, 20 px section gaps, 32 px padding) the full ADMIN navigation needed ≈ 806 px including the brand bar, more than a typical 13-inch laptop viewport (≈ 700–800 px at 100% zoom), so `overflow-y-auto` scrolled legitimately. Fix: compact density (28 px rows, 12 px section gaps, 24 px padding, 16 px headers) → ≈ 686 px, plus `min-h-0` on the nav so the scroll fallback engages correctly when the viewport really is shorter (zoom, small window). `e2e:sidebar` models both densities against a 720 px viewport and asserts sticky/h-screen/min-h-0/overflow-y-auto markup; pixel-level browser check pending | `admin-shell.tsx`, `sidebar-nav.tsx` |
| UI-02 | Inter everywhere; no decorative font | `[AUTO-PASS]` | refinement (CSS contains Inter, no Geist, variable on `<html>`) | `layout.tsx`, `globals.css` |
| UI-03 | Vendor portal shows an unnecessary navigation scrollbar | `[AUTO-PASS]` (markup) + `[PENDING]` (browser) | Fixed 2026-09-12 (Batch 1): the tab strip no longer uses `overflow-x-auto`; tabs wrap on narrow screens (`flex-wrap`) and the strip is sticky under the header. `e2e:batch1` asserts the served nav markup; browser confirmation pending | `components/layout/portal-nav.tsx` |
| UI-04 | 3PL portal shows the same unnecessary navigation scrollbar | `[PENDING]` (fix applied) | Same component and fix as UI-03 | `portal-nav.tsx` |
| UI-05 | Immediate loading feedback when switching pages/tabs | `[AUTO-PASS]` (mounted) + `[PENDING]` (behaviour) | Fixed 2026-09-12 (Batch 1): global `NavigationProgress` bar in the root layout (admin, portals, login) starts on same-origin link clicks / back-forward, appears after 120 ms to avoid flashing, completes when the route renders, safety timeout 15 s. `e2e:batch1` asserts it is mounted on the login page, an admin page and a portal page; timing/visual behaviour is a browser check. Programmatic `router.push` after form submits still relies on the form's own pending state | `components/layout/navigation-progress.tsx`, `app/layout.tsx` |
| UI-06 | 3PL New Order SKU search can make the order screen disappear before search completes | `[AUTO-PASS]` (root cause) + `[PENDING]` (HTTP regression, browser) | **Root cause reproduced 2026-09-12:** the SKU picker calls `searchVariantsAction`, which began with `requireStaff()`. For a 3PL user that guard calls `redirect("/portal/3pl")`; a redirect thrown from a server action navigates the browser, so the New Order form unmounted as soon as the first search fired. **Fix:** the action now resolves a search scope without redirecting (`variantSearchScope`: staff → optional filter, portal users → their own owner regardless of the client-supplied id, anonymous → failure result) and the picker shows an inline "Searching…" state and inline errors. `e2e:batch1` covers the scope helper, owner scoping, and the server-action HTTP regression as a 3PL user (200, no `x-action-redirect`, own SKUs only, foreign ownerId ignored) — the test resolves the action id from the served build because Next answers 404 "Server action not found" for ids of another build | `server/actions/products.ts`, `lib/variant-search-scope.ts`, `variant-picker.tsx` |
| UI-07 | SKU search dropdown appears clipped inside its container | `[AUTO-PASS]` (placement) + `[PENDING]` (browser) | Fixed 2026-09-12 (Batch 1): results render in a `document.body` portal with `position: fixed`, placed from the input rectangle (`placeDropdown`: below when room, flips above near the bottom, min width, kept inside the viewport), repositioned on scroll/resize; nothing widens the table. `e2e:batch1` unit-tests the placement | `variant-picker.tsx`, `lib/dropdown-position.ts` |
| UI-08 | Manual order SKU selection populates saved price/product info | see PRC-04 | Fixed in Batch 1 | order form |
| UI-09 | Responsive on desktop/tablet/phone; warehouse actions practical on tablets | `[PENDING]` | Tailwind responsive classes throughout; no device testing recorded | all pages |
| UI-10 | Confirmation for destructive operations, helpful empty states and errors | `[AUTO-PASS]` + `[PENDING]` | Dialogs for archive/cancel/delete/deactivate (refinement asserts markup); empty states in phase5; visual review pending | components |
| UI-14 | Sidebar layout: brand → scrollable navigation → account row anchored at the bottom; no desktop page header (content starts at the top); nav scrollbar visually hidden while scrolling still works; mobile keeps a minimal header (menu + brand) with the same sheet (nav + account) | `[AUTO-PASS]` (markup + CSS) + `[PENDING]` (browser) | 2026-09-15: `AccountFooter` (`shrink-0 border-t`) after the `min-h-0 flex-1 overflow-y-auto scrollbar-none` nav inside the `h-screen` aside; header `md:hidden`; `UserMenu variant="sidebar"` opens upwards. `e2e:sidebar`: footer after `</nav>` with the account trigger, header mobile-only without the account, `.scrollbar-none` CSS, height model incl. footer ≤ 768 px | `admin-shell.tsx`, `user-menu.tsx`, `sidebar-nav.tsx`, `globals.css` |
| UI-13 | Sidebar colours: surface `#10171A`, selected item `#242C2F`, light text; font, icons, labels and hierarchy unchanged (also applied to the mobile navigation sheet) | `[AUTO-PASS]` (CSS + markup) + `[PENDING]` (browser) | 2026-09-15: `--sidebar` / `--sidebar-accent` (+ matching foreground, border, brand badge) set in both themes; nav headers/muted items use sidebar-foreground opacities for contrast. `e2e:sidebar`: served CSS declares both values twice (light + dark), no oklch sidebar surface left, Inter present, all 15 labels + icons render, active item uses the accent class | `globals.css`, `sidebar-nav.tsx`, `admin-shell.tsx` |
| UI-11 | Product variant builder with option value lists + combination generation | `[AUTO-PASS]` + `[PENDING]` (browser) | See PRD-03 (Batch 2) | product form |
| UI-12 | SKU search shows a loading state while searching | `[PENDING]` | Added in Batch 1 ("Searching…" row + spinner from the first keystroke); browser check pending | `variant-picker.tsx` |

## 18. Core architecture rules (§5, §14, D-027, NR-14)

| ID | Requirement | Status | Evidence / notes | Area |
|---|---|---|---|---|
| ARC-01 | Monolith, no Redis/queues/paid Vercel features; Hobby tier | `[MANUAL-PASS]` | Deployed on Hobby since 2026-09-04; single daily cron; `after()` piggyback | D-031, D-039–D-042 |
| ARC-02 | SKU is the operational identity; Product is the container; Variant is the unit | `[AUTO-PASS]` | phase3/4, refinement, shopify2 (matching by SKU only) | schema + services |
| ARC-03 | Shopify code never writes core tables directly and never duplicates business logic | `[AUTO-PASS]` | core-requests, shopify3/4; boundary D-027 | `services/shopify/*` |
| ARC-04 | Idempotency everywhere (external event ids, dedupe keys, unique identities) | `[AUTO-PASS]` | phase4 (replays), shopify1–4 | services |
| ARC-05 | Migrations reviewed, hand-written CHECKs preserved, no drift | `[MANUAL-PASS]` | `prisma migrate status` up to date on 2026-09-09 (8 migrations) | `prisma/migrations` |

---

## 19. Known bugs register

All seven bugs confirmed in the 2026-09-12 audit were fixed in **Batch 1 (2026-09-12, commit `6bc99e1`)**. One further production bug (Shopify runner registry, 2026-09-15) is fixed below. A second production bug of the same family (core hook registry, 2026-09-15) is fixed below. Open bugs: none known.
Fixed bugs stay listed with their evidence so they cannot silently return:

| Bug | Row | Root cause | Fix | Regression test |
|---|---|---|---|---|
| Shopify outbound jobs never claimed in production (ORDER_CREATE PENDING, 0 attempts; "Run pending now" no effect) | SHP-08, SHP-10 | Job runner registry is module state; the Turbopack server bundle holds several instances of `jobs.ts`/`runners.ts`; `globalThis` once-flags let only the instrumentation instance register, so every draining instance (server actions, webhook `after()`, cron) filtered on an empty type list | Module-local guards + `ensureRunnersRegistered()` (lazy `import("./runners")`) in `runJob` / `runDueJobs` (2026-09-15) | `e2e:shopify-runner` (through the built server) |
| V3PL shipment of a Shopify-linked order pushed nothing to Shopify (V3PL 1586 shipped, Shopify #1010 stayed Unfulfilled; no FULFILLMENT_CREATE job) and stock changes enqueued no INVENTORY_PUBLISH | SHP-05, SHP-07, SHP-10 | Same family as the runner registry: the handler arrays in `fulfillment-hooks.ts` / `inventory-hooks.ts` are module state; `instrumentation.ts` imported `shopify/register.ts` into the instrumentation bundle instance, while the shipping / receiving server actions ran `runShipmentHandlers` / `runInventoryChangeHandlers` in their own instance with an empty array | `ensureShipmentHandlersRegistered()` / `ensureInventoryHandlersRegistered()`: lazy `import("@/server/services/shopify/register")` in the hook runners before the registry is read (cycle-safe, idempotent, failures logged and never block the warehouse action) (2026-09-15, `c32e0ce`) | `e2e:hooks` (fresh processes + through the built server) |
| Shopify inventory never decreased for V3PL-created orders on the dev store (Shopify #1011–#1017 created, stock unchanged) | SHP-07, SHP-10 | Not a reference problem (all jobs DONE). By design (`BYPASS`, D-062) the reservation's `INVENTORY_PUBLISH` job is what lowers Shopify; that publish had been refused daily since 2026-09-15 as a compare conflict ("Shopify shows 192 but V3PL last published 281") because the publish location was switched after 281 was written to the old location, and the conflict rule also flagged every Shopify-originated sale (Shopify −n, V3PL −n) as "changed by hand" | D-066 (2026-09-22): Shopify == V3PL available is in sync regardless of the baseline (re-anchored, no write); conflict only when Shopify differs from both; publish-location change clears the baseline for the store's mappings. `BYPASS` kept (a Shopify-side claim would double-deduct because publish drains before `ORDER_CREATE`) | `e2e:shopify-order-create` 23a–23j, `e2e:shopify4`; dev store 2026-09-22: Force publish repaired the stale baseline (192 → 276 = V3PL available); V3PL order 1756 (1 × XVS-TEST-001) → Shopify #1018 (BYPASS, tags V3PL / V3PL-1756); Shopify available 276 → 275, V3PL available 276 → 275 (reserved 9 → 10, on hand 285 unchanged); publish job DONE `published 276 → 275`; drain re-run 0 jobs, verify publish `skipped_equal`, Shopify still 275 — decreased exactly once |
| Manual order SKU selection does not populate price | PRC-04 / UI-08 | `searchVariants` never selected `price`; `PickedVariant` had no price; form never set `unitPrice` | price + currency returned and applied on pick (typed price kept) | `e2e:batch1` service checks; browser `[PENDING]` |
| SKU search dropdown clipped | UI-07 | `absolute` list inside `overflow-x-auto` table wrappers | portal + `position: fixed` placement (`placeDropdown`) | `e2e:batch1` placement unit checks |
| Real Shopify export → false SKU/option errors | CSV-05 | image-only rows treated as variants | `isMediaRow` skips them; `Cost per item` mapped | `e2e:batch1` official-header fixture |
| Order "disappears" after Shopify fulfilment | ORD-07 | list default `status=OPEN` hid COMPLETED | default All orders + filter caption; dashboard tile → `?status=OPEN` | `e2e:batch1` default/open/search checks |
| Portal navigation scrollbar (vendor + 3PL) | UI-03/04 | `overflow-x-auto` tab strip | wrap tabs, sticky strip | `e2e:batch1` served-markup check |
| No navigation loading feedback | UI-05 | no global indicator | `NavigationProgress` in root layout | `e2e:batch1` mounted check (login page) |
| 3PL New Order screen disappears during SKU search | UI-06 | `requireStaff()` redirect inside the search server action | non-redirecting `variantSearchScope`; inline loading/error | `e2e:batch1` scope checks + HTTP server-action call as 3PL user (action id from the served build) |

## 20. Manual verification checklist (`[PENDING]` until someone ticks them with a date)

- [ ] Add product (simple): title mirrors SKU while typing, stays editable; save; detail shows SKU + stock
- [ ] Add product (2 options × values): type "White, Black" and "L, XL, XXL" → 6 rows generated; fill SKUs, retail/wholesale, weight, L×W×H; save
- [ ] Customers: add a customer (company) with shipping + billing; search it by phone digits; edit it; open its detail
- [ ] Manual order: search and pick the customer → fields fill; change the address for this order; create → order detail shows "Customer record" link; the customer detail lists the order; edit the customer → the order still shows the original details
- [ ] Manual order without picking: type name + e-mail, tick "Save as new customer" → toast says saved; repeat with the same e-mail → toast says linked to existing
- [ ] 3PL portal: Customers tab shows only own customers; New order picker finds only own customers; foreign customer URL → 404
- [ ] Add product: enter a barcode on two generated rows, leave others blank, save; detail shows barcodes under the SKUs; searching the barcode in the order SKU picker finds the variant; entering the same barcode twice shows "already used on row N"; using another product's barcode shows the conflicting SKU
- [ ] Add product with initial inventory: choose warehouse (location defaults to MAIN), enter 25 / 30 / 15 on three rows, leave one blank → toast "70 units received across 3 SKUs"; product detail shows the stock; Receiving lists one "Initial stock" receipt; inventory history shows 3 RECEIVE rows
- [ ] Edit that product: rename a value in place (rows keep SKUs), remove a value (rows without history disappear, rows with stock stay highlighted), add a third option
- [ ] Type a SKU that exists in the connected dev store → "Shopify store check" warning appears; saving still works and the mapping is unchanged
- [ ] Product list on a long catalogue: columns, actions menu, delete dialog with blockers, archive path
- [ ] Import the customer's **real** Shopify product export (CSV-05 fix applied; fixture with the official header passes)
- [ ] Manual order: pick a SKU → unit price fills with the saved price; edit it; clear the SKU → price clears (PRC-04)
- [ ] SKU picker dropdown fully visible in a narrow table and near the bottom of the screen (UI-07); "Searching…" shown (UI-12)
- [ ] 3PL New Order: type a SKU → results appear, form data stays, no navigation (UI-06)
- [ ] Navigate between admin pages and portal tabs: top progress bar appears for slow pages and never flashes for instant ones (UI-05)
- [ ] Export products from the list and re-import unchanged (expect all "update", no errors)
- [ ] Orders list: default view, `Any status` filter values, warehouse stage hints, attention icon
- [ ] Order detail: primary status badge, payment badge, Delete/Cancel dialogs
- [ ] 3PL portal: submit order → appears in Admin Orders and 3PL Orders with matching status
- [ ] Vendor / 3PL portal navigation: no scrollbar, tabs wrap on narrow screens, strip stays under the header (UI-03/04)
- [ ] SKU picker in manual order, 3PL new order, receiving, transfers: dropdown fully visible (UI-07), screen stable (UI-06)
- [ ] Warehouse detail: Delete blockers, location delete/deactivate, default location protected
- [ ] Fulfilment queue on a tablet: pick → pack → ship dialogs usable
- [ ] Admin sidebar at 100% zoom on a normal laptop/desktop viewport: no scrollbar in the sidebar, all 15 items visible; zoom to 150% (or shrink the window height): the sidebar scrolls internally while the page scrolls independently; narrow (<768 px) viewport: the menu button opens the navigation sheet
- [ ] Sidebar colours: background #10171A, selected item #242C2F, light text; icons and Inter unchanged
- [ ] Sidebar footer: account row (name + role) anchored at the bottom; zoom to 150% → the navigation scrolls (no visible scrollbar) while the account row stays put; the menu opens upwards with e-mail, role and Sign out; desktop pages start directly with their own title (no header bar); on a phone the header shows only the menu button and brand, and the sheet ends with the account row
- [ ] Inter visible in headings, tables, forms, badges, dialogs (no fallback flashes)
- [ ] Product images upload/remove (Cloudinary)
- [ ] Shopify Step 4 production sequence on `shakilxvs.myshopify.com` (auto-fulfilment OFF): push, tracking, mirror, publishing enable/publish/activation/equal/mismatch/force/disable — needs fresh unfulfilled orders

## 21. Roadmap status against the master plan (§62)

| Phase | Status | Notes |
|---|---|---|
| 0 Preparation | done | D-001…D-020, docs |
| 1 Foundation | done, `[AUTO-PASS]` | e2e:auth |
| 2 Users / vendors / 3PL | done, `[AUTO-PASS]` | e2e:phase2 |
| 3 Products / warehouses / inventory | done, `[AUTO-PASS]` | e2e:phase3 (+ D-053 options) |
| 4 Orders / fulfilment | done, `[AUTO-PASS]` | e2e:phase4 |
| 5 Portals / dashboards / reports | done, `[AUTO-PASS]` | e2e:phase5 |
| Pre-6 refinement | done, `[AUTO-PASS]` | e2e:refinement; D-053…D-056 |
| 6 Reports + import/export | not started | Excel/PDF, inventory import, remaining §48 reports |
| 7 Shopify | code complete (Steps 1–4), production verification of Step 4 pending | plus new NR-4 outbound orders and NR-5 customer sync (missing) |
| 8 Financial status + accounting-ready | per-order status only | NR-8 charges + NR-9 ledger extend this phase |
| 9 Final QA + deployment | not started | this document is its checklist |

## 22. Recommended implementation order (for planning only)

1. ~~**Bug fixes with confirmed root causes**~~ — **done in Batch 1 (2026-09-12)**; browser confirmation and the Firebase-blocked HTTP checks remain.
1b. **Environment:** Firebase Admin key replaced 2026-09-12; all suites re-run green the same day. Re-verify production sign-in once with the new key.
2. ~~**Product data completion**~~ — **done in Batch 2 (2026-09-12)**: weight/dimensions, wholesale price, option-value builder, Shopify-store SKU warning. Browser confirmation pending.
3. ~~**Customer directory (CUS-01…05)**~~ — **done 2026-09-15 (D-060)**; Shopify customer sync (CUS-03) remains for the Shopify session.
4. **Manual order → Shopify (SHP-10, SKU-04)**: core side **done 2026-09-15 (D-061)**; Shopify side **done 2026-09-15 (D-062)**: runner, `orderCreate`, `write_orders` in `shopify.app.toml`. Remaining: release the new app version, Vercel `SHOPIFY_SCOPES`, reconnect the dev store, dev-store verification.
5. ~~**Operational charges (CHG-01…04)**~~ — **done 2026-09-16 (D-063)**; storage-period charges deferred.
6. ~~**Finance ledger (FIN-01…03)**~~ — **done 2026-09-16 (D-063)**; Shopify payment-status sync and invoice statuses deferred. Next: **manual e-mail (OWN-07)**.
7. **Phase 6** reports, Excel/PDF, inventory import.
8. **Shopify Step 4 production verification** as soon as fresh unfulfilled dev-store orders exist (independent of the above).

---

## 23. Batch log

| Batch | Date | Scope | Code commit | Evidence |
|---|---|---|---|---|
| 1 | 2026-09-12 | Seven confirmed bugs (§19) | `6bc99e1`, test contract fix `b773314` | `e2e:batch1` 22/22; full regression 567/567 |
| 2 | 2026-09-12 | Product & SKU enhancements: option/value builder, wholesale price, weight/dimensions, Shopify SKU warning (D-057) | `108da41` | `e2e:batch2` 31/31; full regression 598/598 (§1). In the sequential run `e2e:phase4` and `e2e:shopify2` aborted without a summary (filtered log, output not retained) and passed 61/61 and 49/49 when re-run in isolation; `e2e:refinement` needed one expectation update (Variant Grams is now an imported column) |

| Feature | 2026-09-13 | Initial inventory during product creation (D-058) | `c9ab9ec` | `e2e:initial-stock` 15/15; relevant regression phase3 46/46, refinement 55/55, batch1 22/22, batch2 31/31 (one HTTP check failed inside the sequence and passed 31/31 alone), phase4 61/61 |

| Feature | 2026-09-15 | Unique barcode per variant (D-059) | `42808ee` | `e2e:barcode` 19/19; relevant regression phase3 46/46, refinement 55/55, batch1 22/22, batch2 31/31, initial-stock 15/15, phase4 61/61 |

| Batch | 2026-09-15 | Customer directory + order customer workflow (D-060) | `7fc9083` | `e2e:customers` 26/26; relevant regression auth 19/19, phase2 29/29, phase4 61/61, refinement 55/55, batch1 22/22, batch2 31/31, initial-stock 15/15, barcode 19/19, phase5 49/49. Shopify customer sync deferred |

| Polish | 2026-09-15 | Sidebar UX: no unnecessary scrollbar at normal desktop heights, colours #10171A / #242C2F (UI-01, UI-13) | `e5be7e7` | `e2e:sidebar` 8/8; regression refinement 55/55, batch1 22/22, auth 19/19 |

| Polish | 2026-09-15 | Sidebar layout: account footer anchored at the bottom, no desktop page header, hidden nav scrollbar (UI-14) | `844cbcd` | `e2e:sidebar` 11/11; regression refinement 55/55, batch1 22/22, auth 19/19 |

| Feature | 2026-09-15 | Manual V3PL order → Shopify order, core side (SHP-10 partial, SKU-04; D-061) | `6094af3` | `e2e:shopify-order` 33/33; relevant regression test:shopify 73/73, shopify1 58/58, shopify2 49/49, shopify3 39/39, shopify4 46/46, phase4 61/61, customers 26/26, batch1 22/22; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean |
| Feature | 2026-09-15 | Manual V3PL order → Shopify order, Shopify side (SHP-10 automated complete, dev store pending; D-062): `ORDER_CREATE` runner, `orderCreate` BYPASS/PENDING, marker, adoption, inbound link-not-import, fulfilment push widening, `write_orders` (app version `v3plmxvs-platform-4`, unreleased) | `b35e39d` | `e2e:shopify-order-create` 39/39; unit 80/80; regression `e2e:shopify-order` 33/33, `e2e:core-requests` 21/21, shopify1 58/58, shopify2 49/49, shopify3 39/39, shopify4 46/46; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean; no migration |
| Fix | 2026-09-15 | Shopify outbound jobs never claimed in production (per-module-instance runner registry; ORDER_CREATE PENDING 0 attempts) — lazy `ensureRunnersRegistered()` in `jobs.ts`, module-local guards | `c576569` | `e2e:shopify-runner` 9/9 through the built server; regression test:shopify 80/80, `e2e:shopify-order-create` 39/39, shopify1 58/58, shopify4 46/46; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean |

| Fix | 2026-09-15 | Production: core hook registry per module instance — server actions enqueue FULFILLMENT_CREATE / INVENTORY_PUBLISH again (SHP-05/07/10) | `c32e0ce` | `e2e:hooks` 10/10; regression once: test:shopify 80/80, shopify4 46/46, core-requests 21/21, shopify-runner 8/8, shopify-order-create 39/39, shopify1 58/58; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean. No migration |

| Batch | 2026-09-16 | Operational charges + owner settlement ledger (CHG-01…04, FIN-01…03; D-063) | `0402620` | `e2e:finance` 35/35; regression once: phase2 29/29, phase4 61/61, shopify4 46/46, core-requests 21/21, hooks 10/10, customers 26/26, batch2 31/31; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean. Migration `20260916090000_charges_finance_ledger` (additive; no backfill) |

| Fix | 2026-09-16 | Finance business-logic correction (D-064): two accounts never netted, vendor payables allocated manually against received lines, 3PL product value at shipment, gross-margin report (FIN-01…03) | `2ea44e3` | `e2e:finance` 43/43; regression once: phase3 46/46, phase4 61/61, shopify4 46/46 (three inbound-webhook checks failed inside the sequential chain and passed 46/46 in isolation — known chain flake), core-requests 21/21, hooks 10/10, phase2 29/29, initial-stock 15/15, customers 26/26; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean. Migration `20260916150000_finance_accounts` converts existing rows |

Deferred from Batch 2 on purpose: product-level physical defaults, conflict warnings inside the CSV preview, any Shopify scope change, manual V3PL → Shopify orders, the finance ledger consuming wholesale value.
| Feature | 2026-09-22 | Shopify customers → V3PL customer directory (CUS-03 automated complete, dev store pending; D-065): `customers-sync.ts`, core `upsertShopifyCustomer`, `read_customers` scope, *Sync customers now*, order import links the directory, migration `20260922120000_shopify_customer_sync` | `68deca8` | `e2e:shopify-customers` 23/23; unit 86/86; regression `e2e:customers`, `e2e:shopify3`, `e2e:shopify-order-create` (see §1); typecheck, lint (0 errors, 8 pre-existing warnings), production build clean |
| Fix | 2026-09-22 | Shopify inventory for V3PL-created orders (D-066): publish conflict rule (both sides equal = in sync), baseline reset on publish-location change, `BYPASS` kept; also restores three doc table rows clobbered by the 2026-09-22 customer-sync docs edit | `092510a` | `e2e:shopify-order-create` 49/49 (10 new inventory checks); `e2e:shopify4` 46/46; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean; no migration; dev store: Force publish repaired the stale baseline (192 → 276 = V3PL available); V3PL order 1756 (1 × XVS-TEST-001) → Shopify #1018 (BYPASS, tags V3PL / V3PL-1756); Shopify available 276 → 275, V3PL available 276 → 275 (reserved 9 → 10, on hand 285 unchanged); publish job DONE `published 276 → 275`; drain re-run 0 jobs, verify publish `skipped_equal`, Shopify still 275 — decreased exactly once |
| Feature | 2026-09-22 | Shopify product import: explicit V3PL destination + optional initial stock per SKU (SHP-03 extension, D-067) — no schema change | `22818a8` | `e2e:shopify2` 57/57 (8 new); regression `e2e:shopify4` 46/46, `e2e:initial-stock` 15/15; typecheck, lint (0 errors, 8 pre-existing warnings), production build clean |

*Maintainers: update the row status, evidence and date in the same change that alters behaviour. Add new
requirements as new rows with a source; never delete rows — mark them `[N/A]` with the reason.*
