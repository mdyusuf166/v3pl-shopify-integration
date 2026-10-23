# Architecture & Business Decisions

Every important decision is recorded here with its date and rationale.
Do not remove entries — supersede them with a new entry referencing the old one.

---

## D-001 · 2026-09-01 · Overall architecture: single Next.js monolith

**Decision:** One Next.js (App Router) application containing UI + API routes, deployed on Vercel. No microservices, no Redis, no message queues, no background worker infrastructure.

**Why:** Client-confirmed requirement for simplicity. The scale (single company, its vendors and 3PL clients) does not justify distributed infrastructure. Correctness is achieved with PostgreSQL transactions, not queues.

---

## D-002 · 2026-09-01 · Database: PostgreSQL + Prisma, provider = Neon (proposed)

**Decision:** PostgreSQL with Prisma ORM. Recommended provider: **Neon** (free tier, automatic backups, point-in-time restore, Vercel-friendly). Awaiting client confirmation or an existing provider.

**Why:** Spec mandates PostgreSQL + Prisma. Neon satisfies the automatic-backup/restore requirement at no cost initially.

---

## D-003 · 2026-09-01 · Unified `Owner` model for Vendors and 3PL Clients

**Decision:** One `Owner` table with `type: VENDOR | THREEPL_CLIENT` instead of two separate tables. Client approved.

**Why:** Vendors and 3PL clients are structurally identical (own products/SKUs, inventory, order lines, portal access). A single non-null `Product.ownerId` foreign key makes the "every SKU belongs to exactly one owner" rule database-enforced and impossible to violate. UI still presents "Vendors" and "3PL Clients" separately.

---

## D-004 · 2026-09-01 · SKUs are globally unique platform-wide

**Decision:** Internal SKU is unique across the entire platform (unique constraint on `ProductVariant.sku`), not merely per owner. Client confirmed.

**Why:** Shopify line items are matched by SKU alone; global uniqueness makes SKU → product → owner resolution always unambiguous.

---

## D-005 · 2026-09-01 · SKU/inventory always lives on the variant

**Decision:** Every product has at least one `ProductVariant` (a "default variant" for single-variant products). SKU, price, and all inventory records attach to the variant, never directly to the product.

**Why:** Matches Shopify's model, supports variants without schema migration later, and gives one consistent inventory join path.

---

## D-006 · 2026-09-01 · Inventory = append-only ledger + cached levels

**Decision:** `InventoryTransaction` is an immutable append-only ledger. `InventoryLevel` caches `onHand`/`reserved` per (variant, warehouse, location) and is updated in the same DB transaction as the ledger insert. `available = onHand − reserved` is always computed, never stored. All movement types go through one inventory service module — the only code allowed to write these tables.

**Why:** Spec forbids overwriting stock quantities and requires full auditable movement history. Cached levels keep reads fast without sacrificing the audit trail.

---

## D-007 · 2026-09-01 · No negative available stock; concurrency-safe reservations

**Decision:** Reservations use conditional updates inside DB transactions (reserve succeeds only if `available >= qty`). Negative available stock is rejected.

**Why:** Spec §17. Prevents overselling under concurrent order creation / webhook processing.

---

## D-008 · 2026-09-01 · Three independent status dimensions on orders

**Decision:** `Order.status` (Draft/New/Confirmed/Cancelled/Completed), `Order.fulfillmentStatus` (derived from line-level quantities), and per-`Shipment` status are separate fields, never combined.

**Why:** Spec §26–28. They represent different concepts and diverge under partial shipment.

---

## D-009 · 2026-09-01 · Vendor association lives on the order line

**Decision:** `OrderItem.ownerId` (denormalized from the variant at order creation). Orders never carry a single vendor.

**Why:** Spec §24 — one order can contain SKUs from many owners. Denormalizing on the line preserves historical ownership even if a product's owner is later corrected, and makes portal isolation queries simple and fast.

---

## D-010 · 2026-09-01 · Login routes and roles

**Decision:** `/admin` is the login for all internal staff (Admin, Warehouse Employee, Salesperson) with role-based access inside. `/user` is the shared login for Vendors and 3PL Clients, routed to their portal by role. Client confirmed.

---

## D-011 · 2026-09-01 · 3PL clients create fulfillment orders in their portal

**Decision:** 3PL portal includes order creation/submission restricted to the client's own SKUs. Client confirmed.

---

## D-012 · 2026-09-01 · Currency: USD now, extensible later

**Decision:** All money fields carry a `currency` column defaulting to `USD`; the initial system operates in USD only. No conversion logic. Client confirmed.

---

## D-013 · 2026-09-01 · Shopify idempotency is constraint-enforced

**Decision:** Unique DB constraints on `(shopifyStoreId, shopifyOrderId)` for orders and `(storeId, webhookId)` for webhook events. Every webhook is recorded before processing; already-seen events are skipped. Inventory effects of an external event are applied at most once.

**Why:** Spec §34–35. Duplicate protection must survive races; a uniqueness constraint cannot be bypassed by application bugs.

---

## D-014 · 2026-09-01 · Shopify sync direction rules

**Decision:** Internal warehouse inventory is operational truth. Shopify → platform: orders, fulfillment/tracking events (via verified webhooks + reconciliation polling). Platform → Shopify: calculated sellable inventory per store (per-store publishing rule, architected to allow future per-store stock splits) and fulfillment/tracking updates. No uncontrolled two-way overwrites; every sync recorded in `ShopifySyncLog` with previous/new values.

**Why:** Spec §39–40.

---

## D-015 · 2026-09-01 · Shopify order mapping stored on the Order (no separate mapping table)

**Decision:** `Order` carries nullable `shopifyStoreId` + `shopifyOrderId` with a composite unique index, instead of a separate ShopifyOrderMapping table. Same approach for fulfillments (`Fulfillment.shopifyFulfillmentId`). Product/variant mappings DO get a dedicated table (`ShopifyVariantMapping`) because one internal variant can map to many stores.

**Why:** Spec §66 — "do not create unnecessary entities." An order originates from at most one store; a 1:1 mapping table adds joins without value.

---

## D-016 · 2026-09-01 · Shopify Admin GraphQL API only

**Decision:** Use the current Shopify Admin **GraphQL** API (including bulk operations for large reads). No REST Admin API usage.

**Why:** Spec §37/§45; REST Admin API is legacy.

---

## D-017 · 2026-09-01 · Per-store Shopify credentials encrypted in DB

**Decision:** Each `ShopifyStore` row stores its Admin API access token encrypted (AES-256-GCM) with a single `SHOPIFY_TOKEN_ENCRYPTION_KEY` environment secret. Custom-app tokens per store (client's stores), not a public OAuth app.

**Why:** Multiple stores must be addable at runtime by Admin without redeploying; tokens must never be plaintext at rest or in git.

---

## D-018 · 2026-09-01 · Accounting: abstraction only

**Decision:** Manual financial status fields (Not Invoiced / Invoiced / Paid / Partially Paid / Outstanding) plus invoice reference fields. A thin `AccountingProvider` interface documents the future integration seam. No provider-specific code. Client confirmed.

---

## D-019 · 2026-09-01 · Warehouse locations = one flat table

**Decision:** `Location` is a single table (warehouseId, zone, rack, shelf, bin, label) rather than four nested tables.

**Why:** Spec §11 — do not over-engineer the physical-location system. A flat row with a human-readable label (e.g. `A-01-3-B2`) covers Zone→Rack→Shelf→Bin with trivial queries.

---

## D-020 · 2026-09-01 · UI stack: Tailwind CSS + shadcn/ui

**Decision:** Tailwind CSS with shadcn/ui components (tables, forms, drawers, dialogs, badges).

**Why:** Clean modern SaaS look per spec §52, fully responsive, no license cost, no heavy component-framework lock-in.

---

## D-021 · 2026-09-02 · Shopify: one public-distribution OAuth app (supersedes D-017 in part)

**Decision:** The Shopify integration uses the single app already created in the client's Dev Dashboard with **Public distribution** (permanent). Stores connect through the OAuth authorization code grant started from V3PL (`Settings → Shopify Stores → Add Shopify Store`). The app is **not embedded**; V3PL is the UI. D-017's "custom-app token per store" approach is withdrawn; D-017's encryption requirement (AES-256-GCM with `SHOPIFY_TOKEN_ENCRYPTION_KEY`) stands. `ShopifyStore` keeps optional per-store client-credential override columns so a custom-distribution app could be attached later without a schema change.

**Why:** The client's stores are in separate Shopify organizations; custom distribution cannot span organizations, and client credentials only work inside the app's own organization. Public distribution is the only single-app option. Client confirmed 2026-09-02.

**Consequence:** Public apps require Shopify app review before installation on any non-development store (confirmed by Shopify staff, April 2026), plus protected-customer-data approval and mandatory compliance webhooks. Development store first (D-026).

---

## D-022 · 2026-09-02 · Shopify: expiring offline access tokens with refresh

**Decision:** Tokens are requested with `expiring=1`. Access token (~24 h) and refresh token (~90 days) are stored encrypted per store with their expiry timestamps. The API client refreshes proactively before calls; a daily cron refreshes every connected store. Refresh failure → store status `NEEDS_REAUTH`, visible to Admin, fixed by *Reconnect*.

**Why:** Mandatory for new public apps since April 2026; all public apps must comply by 2027-01-01.

---

## D-023 · 2026-09-02 · Shopify: minimum access scopes

**Decision:** `read_orders`, `write_merchant_managed_fulfillment_orders`, `read_fulfillments`, `read_products`, `write_inventory`, `read_locations`. Not requested: `write_orders`, `write_products`, `read_customers`, `write_fulfillments`, `read_all_orders`, `read_returns`, fulfillment-service scopes.

**Why:** Verified against the 2026-07 Admin GraphQL reference: `fulfillmentCreate`, `fulfillmentTrackingInfoUpdate` and `fulfillmentOrderMove` require a fulfillment-order scope (merchant-managed in our architecture), not `write_fulfillments`. `read_fulfillments` is only for the `fulfillments/*` webhooks. `read_all_orders` needs a separate approval and only matters for history older than 60 days — deferred until the business asks. Protected customer data (name/address/email/phone) is requested separately for shipping.

---

## D-024 · 2026-09-02 · Shopify inventory publishing: one-way, off by default, compare-and-set

**Decision:** Inventory flows only platform → Shopify. Each store has `publishEnabled` (default false), one target Shopify location, a set of internal warehouses, and a `publishRule` enum (v1 `ALL_AVAILABLE`). Pushes use `inventorySetQuantities` with `compareQuantity` = last value we published; a mismatch is logged as NEEDS_ATTENTION instead of overwriting. Shopify `inventory_levels/update` webhooks are not consumed.

**Why:** Spec §39–40 and D-014: internal inventory is operational truth; no uncontrolled two-way overwrites; stores go live with order import first and publishing only after reviewed reconciliation.

---

## D-025 · 2026-09-02 · Shopify webhooks: app-specific subscriptions, record-then-process, GraphQL re-fetch

**Decision:** Webhook topics are configured once in the Dev Dashboard (app-specific) so every installing store gets them without code or per-store API calls. Receiver: verify HMAC (app client secret) → insert `ShopifyWebhookEvent` (`webhookId` unique) → 200 → process via `waitUntil`; stuck/failed events retried by cron (max 5) then NEEDS_ATTENTION. Handlers re-fetch the entity via GraphQL; the payload is a notification, not the source of truth. Stale updates (older `updatedAt`) are skipped. Outbound pushes are `ShopifyOutboundJob` rows with a unique `dedupeKey`.

**Why:** Spec §43, D-013. Shopify's 5-second response budget and 8-retries/4-hour policy; app-specific subscriptions are not deleted on failure.

---

## D-026 · 2026-09-02 · Shopify rollout: development store first, live stores gated

**Decision:** All development and the full test matrix run against a Shopify development store (optionally two). Live stores are connected only after: test matrix passed, protected-customer-data approval, app review approval, and per-store location/fulfilment-model confirmation. Live stores start with `Import orders = on`, `Publish inventory = off`.

**Why:** Client instruction 2026-09-02; live inventory must never be touched by unfinished code.

---

## D-027 · 2026-09-02 · Two AI sessions, one repository: ownership boundary

**Decision:** The **core session** owns the core schema and services (users, owners, products, inventory, warehouses, orders, fulfilment, portals, reports). The **Shopify session** owns `src/server/services/shopify/**`, `src/app/api/shopify/**`, `src/app/api/webhooks/shopify/**`, `src/app/api/cron/shopify-*`, `src/app/admin/settings/shopify/**`, the Shopify Prisma models (`ShopifyStore`, `ShopifyStoreWarehouse`, `ShopifyVariantMapping`, `ShopifyWebhookEvent`, `ShopifySyncLog`, `ShopifyOutboundJob`) added in their own migration, and `docs/shopify-*.md`. The Shopify session requests — never edits — core-table columns (shopify-integration.md §5.2) and core service capabilities (§6). Shopify work is done on a `shopify/*` branch and merged after the core Phase 1 schema is committed.

**Why:** Prevents duplicate engines and conflicting schema edits; keeps the Shopify integration a consumer of core services.

---

## D-028 · 2026-09-02 · Shopify orders reserve inventory on import regardless of payment status

**Decision:** An imported Shopify order reserves inventory for every line at import time, whatever its financial status, provided the order is not cancelled and stock is available. Insufficient stock → order created with the line unreserved and `needsAttention`; never negative available (D-007). Cancellation releases.

**Why:** Shopify decrements its own available quantity at checkout; not reserving would let the next publish push stock back and oversell. Client confirmed.

---

## D-029 · 2026-09-02 · Shopify sends the customer shipping notification

**Decision:** Outbound `fulfillmentCreate` uses `notifyCustomer: true`. V3PL sends no automated e-mails (spec §50); Shopify's standard shipping confirmation with tracking is the customer notification.

---

## D-030 · 2026-09-02 · No historical order import; `read_all_orders` not requested

**Decision:** Orders inside Shopify's default 60-day window are enough for go-live. `read_all_orders` and the associated approval are deferred until the business explicitly asks for older history.

---

## D-031 · 2026-09-02 · Hosting: GitHub → Vercel Hobby under the developer's accounts; free-tier scheduling

**Decision:** Development and deployment run through the developer's own GitHub and Vercel (Hobby) accounts initially. The integration is designed so that no paid Vercel feature is required: webhooks are the primary real-time mechanism; outbound pushes run immediately via `waitUntil`; retries piggyback on webhook processing and Admin page loads; one daily Vercel cron does token refresh, reconciliation, publish sweep, catalog sync and health checks in per-store chunks under the 300 s Hobby limit; manual buttons cover the rest. No Render, Redis, queues or other hosts. A GitHub Actions scheduled workflow (every 30 min, within the free Actions allowance) is documented as an optional reliability upgrade and will only be added with explicit approval.

**Risk recorded:** Vercel's fair-use guidelines limit Hobby to non-commercial personal use. Moving to a paid plan or the client's account before commercial go-live is recommended and is configuration-only.

**Why:** Client instruction 2026-09-02; keeps the whole stack free and within the normal GitHub → Vercel workflow.

**Addendum 2026-09-02:** GitHub Actions scheduler **declined** for now; the low-frequency reconciliation design is the default. The Hobby non-commercial limitation is accepted by the developer for the build/testing phase **only**; hosting for the client's commercial production deployment will be reviewed separately before go-live. GitHub repository: `v3plmxvs/vendor-3pl-platform` (private).

---

## D-032 · 2026-09-02 · Fulfillments created in Shopify Admin are mirrored automatically

**Decision:** A `fulfillments/create` event for a fulfillment V3PL did not create produces exactly one internal Fulfillment + Shipment (unique `(shopifyStoreId, shopifyFulfillmentId)`), consumes the matching reservation exactly once (`externalEventId` on ledger rows), and is logged. Lines without a reservation ship from on-hand if available; otherwise the order is flagged for attention instead of creating negative stock.

**Why:** Spec §33/§41 and client confirmation; keeps V3PL inventory correct even when staff act directly in Shopify.

---

## D-033 · 2026-09-02 · Authentication: Firebase session cookies + per-request database status check

**Decision:** The browser uses the Firebase client SDK only to obtain an ID token (in-memory persistence, signed out immediately). The token is exchanged once at `POST /api/auth/session` for a Firebase **session cookie** (httpOnly, Secure, SameSite=Lax, 5 days) minted by the Admin SDK. On every request the protected layout verifies the cookie signature and reloads the `User` row by `firebaseUid`; the row must exist and be `ACTIVE`. There is **no auto-provisioning**: a Firebase account without a `User` row is refused. The login screen used must match the role class (`/admin` = ADMIN/WAREHOUSE/SALES, `/user` = VENDOR/THREEPL_CLIENT). Cookie revocation is not checked per request because the database status is the authoritative kill switch; disabling/banning (Phase 2) also disables the Firebase user and revokes its refresh tokens.

**Why:** Spec §8/§56 — account type determined securely, role/ownership checks server-side, no reliance on client state. Session cookies keep the browser free of long-lived Firebase tokens and let Server Components authorize without a client round-trip.

---

## D-034 · 2026-09-02 · Prisma 7 with the `pg` driver adapter; generated client outside `node_modules`

**Decision:** Prisma 7.10 (`prisma` + `@prisma/client` pinned to the same version) with `@prisma/adapter-pg`. The client is generated into `src/generated/prisma` (gitignored; regenerated by `npm run build` = `prisma generate && next build`). Configuration lives in `prisma.config.ts`, which loads `.env.local` then `.env`. The app connects through `DATABASE_URL` (Neon pooled); migrations use `DIRECT_URL` (non-pooled). The initial migration was generated offline with `prisma migrate diff` and is applied with `prisma migrate deploy`. `src/lib/prisma.ts` constructs the client lazily so builds never require database credentials.

**Why:** Prisma 7 requires a driver adapter and a config file; pinning avoids the 8.0 release-candidate that `latest` currently points at. Lazy construction and pooled/direct separation are the documented Neon + Vercel pattern.

---

## D-035 · 2026-09-02 · Navigation shows unreleased modules as disabled, not as stub pages

**Decision:** The admin sidebar lists the full module set filtered by role; modules not yet delivered are rendered disabled with their phase number and a tooltip, and no placeholder route files are created for them. Items become links when their phase ships.

**Why:** Client instruction — no placeholder files to satisfy checklists — while giving staff a truthful picture of the navigation that is coming and letting role-visibility be reviewed early.

---

## D-036 · 2026-09-04 · Infrastructure reset: new Google/Firebase project, new GitHub organisation, new Vercel team

**Decision:** The original client Google account was banned and is unrecoverable. Everything tied to it is replaced; everything else is preserved unchanged.

| Component | Before | Now |
|---|---|---|
| Google account | (banned) | `vendor3pl@gmail.com` (client-controlled) |
| Firebase project | `v3plmxvs` | **`v3plxvs`** — new web app config and Admin service account |
| GitHub repository | `v3plmxvs/vendor-3pl-platform` | **`V3PL/v3pl`** (private; `shakilxvs` collaborator) |
| Vercel | — | team **`v3pl`**, GitHub → Vercel, Hobby tier (D-031 unchanged) |
| Neon PostgreSQL | same | **unchanged** — same database, same credentials, migrations applied on top |
| Cloudinary | pending | cloud `v3pl` (credentials in env only; used from Phase 3) |
| Shopify app | same | **unchanged** — independent of Google; same client ID/secret |

The Phase 1 migration `20260902000000_init` was applied to Neon on 2026-09-04 and the first admin (`vendor3pl@gmail.com`, the existing Firebase user) was linked as `ADMIN`. The code needed no changes for the reset: only `.env.local` / Vercel variables differ.

**Why:** Client instruction 2026-09-04. Keeping Neon, Shopify and the codebase avoids data loss and rework; only the identity provider and hosting accounts moved.

**Note on credentials:** the `DIRECT_URL` supplied had a typo in the password (`npg-…`); the working value uses `npg_…` (same as `DATABASE_URL`). Recorded here so nobody "fixes" it back.

---

## D-037 · 2026-09-04 · User deletion is a soft delete with an e-mail tombstone

**Decision:** "Delete user" removes the Firebase Authentication account and marks the platform row `status = DELETED` with `deletedAt`, `deletedEmail` (original address) and a tombstoned `email` / `firebaseUid` (`deleted-<id>…`). The row is never removed, so `AuditLog` and, from Phase 3, `InventoryTransaction.userId` keep pointing at a real person. The original e-mail becomes available for a new account. DELETED is terminal (no reactivation). Owners (vendors / 3PL clients) are never deleted at all — only set `INACTIVE`, which immediately locks out their portal users.

**Why:** Spec §20/§51 require permanent, attributable audit history; a hard delete would null out `userId` on every historical record. A partial unique index would let the e-mail be reused without a tombstone, but Prisma Migrate does not model partial indexes and could fight it — the tombstone keeps the schema fully Prisma-managed.

**Also enforced in the database:** `User_owner_role_check` (hand-written in migration `20260904000000_phase2_owners`) guarantees VENDOR / THREEPL_CLIENT users always have an `ownerId` and staff never do. Prisma leaves CHECK constraints alone (verified: `migrate diff` reports no drift).

---

## D-038 · 2026-09-04 · Admin mutations use Server Actions on top of the core services

**Decision:** Admin forms call Server Actions (`src/server/actions/*`) which (1) call `requireRole("ADMIN")`, (2) validate with the shared Zod schema, (3) call the core service, (4) revalidate paths, and (5) return a uniform `ActionResult` with field-level errors. Business rules live only in `src/server/services/*`; actions and route handlers are thin adapters. The Shopify session and any future API consumer call the same services.

**Why:** Less boilerplate than a REST layer for internal forms while keeping the single-service-layer rule from architecture.md. Route Handlers remain for non-form endpoints (auth session, webhooks, cron).

---

## D-039 · 2026-09-04 · Node.js runtime pinned to 24.x

**Decision:** `package.json` declares `"engines": { "node": "24.x" }`. Vercel honours this over the project setting and deploys the latest 24.x; local development also runs Node 24.

**Why:** `firebase-admin` 14 depends on `jwks-rsa` 4, which does a CommonJS `require('jose')`, and `jose` 6 is ESM-only. That only works where Node's built-in `require(esm)` is available (20.19+, 22.12+, 24). The first Vercel deployment ran on an older runtime and every request that touched Firebase Admin failed with `ERR_REQUIRE_ESM` (HTTP 500) even though the build succeeded. Reproduced locally with `node --no-experimental-require-module`. Pinning the runtime is the smallest fix: no dependency downgrades, no overrides, no auth changes. `GET /api/health` reports `process.version` so the deployed runtime can be verified.

---

## D-040 · 2026-09-04 · Environment validation is split into independent groups; health reports variable names

**Decision:** `src/lib/env.ts` validates three independent groups lazily — `databaseEnv()` (DATABASE_URL), `firebaseAdminEnv()` (FIREBASE_ADMIN_*), `appEnv()` (NODE_ENV, NEXT_PUBLIC_APP_URL). The Prisma client uses only the database group and the Admin SDK only the Firebase group. `GET /api/health` publicly reports, per group, the *names* of missing or malformed variables plus the database and Firebase Admin load status as error codes; with `Authorization: Bearer <CRON_SECRET>` it adds full diagnostics (error messages, value lengths, key format) — never values.

**Why:** The first deployment on the new infrastructure had every variable present but one malformed, and the single `serverEnv()` validator made the database and authentication fail together with an opaque 500. Grouping limits the blast radius of a cosmetic variable; the health report identifies the offending variable without log access or secret exposure.

---

## D-041 · 2026-09-04 · `jose` pinned to v4 for `jwks-rsa` via npm override (supplements D-039)

**Decision:** `package.json` carries `"overrides": { "jwks-rsa": { "jose": "^4.15.9" } }`. Only `jwks-rsa` (a dependency of `firebase-admin`) receives `jose` 4; every other package keeps `jose` 6. The Node 24.x pin (D-039) stays.

**Why:** Even on Vercel's Node 24.18 runtime, loading `firebase-admin/auth` still failed with `ERR_REQUIRE_ESM` (confirmed through the `/api/health` inner-code probe after D-039 was deployed), so the runtime there does not honour `require(esm)` for this path. `jwks-rsa` 4 does a CommonJS `require('jose')` and uses only `importJWK`, `exportSPKI`, `decodeJwt`, `decodeProtectedHeader` — all present in `jose` 4, which ships CommonJS and ESM builds. Verified locally with `node --no-experimental-require-module`: Firebase Admin loads, and both end-to-end suites pass. The override is removed when `jwks-rsa`/`firebase-admin` ship a CommonJS-compatible `jose` import.

---

## D-042 · 2026-09-04 · Canonical app URL derived from Vercel system variables; `NEXT_PUBLIC_APP_URL` optional

**Decision:** `appUrl()` in `src/lib/env.ts` resolves the public origin in this order: explicit `NEXT_PUBLIC_APP_URL` (if set and a valid URL) → on Vercel production `https://` + `VERCEL_PROJECT_PRODUCTION_URL` (the project's stable production domain, currently `https://v3pl.vercel.app`) → on Vercel preview `https://` + `VERCEL_URL` → `http://localhost:3000`. An empty `NEXT_PUBLIC_APP_URL` is treated as unset. All code that needs the origin (absolute links, the Shopify OAuth `redirect_uri` and webhook URLs in Phase 7) must call `appUrl()` rather than read the variable directly. `/api/health` reports the resolved URL and its source.

**Why:** Vercel's variable UI forced `NEXT_PUBLIC_APP_URL` into the Secret type, which is wrong for a public value and impossible to reconcile with the browser bundle. Vercel already provides the production domain as a system variable at build and runtime (system variables are enabled on this project — `VERCEL_ENV` is populated), so no variable needs to be stored at all. If a custom domain is added later, `VERCEL_PROJECT_PRODUCTION_URL` follows it automatically; `NEXT_PUBLIC_APP_URL` remains an explicit override for self-hosting.

---

## D-043 · 2026-09-05 · Inventory model: warehouse-level balance + location-level placement; a location is always known

**Decision:** Stock is cached at two granularities. `InventoryBalance` (variant × warehouse) holds `onHand` and `reserved` and is the row locked (`SELECT … FOR UPDATE`) by every movement, so concurrent operations on the same SKU/warehouse serialise. `InventoryLevel` (variant × warehouse × location) holds `onHand` only — the physical put-away. Reservations are warehouse-level (picking chooses the location later). Every warehouse is created with a default `MAIN` location and stock rows always carry a location, so the level key is fully non-null (no nullable-column uniqueness problem). The service enforces `balance.onHand = Σ levels.onHand` in the same transaction; the database enforces `onHand ≥ 0`, `reserved ≥ 0`, `reserved ≤ onHand` and one default location per warehouse via hand-written constraints. Removing stock (adjustment, damage, missing, transfer) may never reduce `onHand` below `reserved`; shipping releases the reservation and removes on-hand in one call.

**Why:** Spec §11/§14/§17: per-warehouse tracking with simple locations, no negative available, no overwrites. Locking a single warehouse-level row is the simplest correct concurrency strategy for PostgreSQL and was verified with 10 parallel reservations (exactly the affordable number succeeds).

---

## D-044 · 2026-09-05 · Transfers are two-legged: out at creation (in transit), in at completion

**Decision:** Creating a transfer writes `TRANSFER_OUT` at the source locations immediately (only available, unreserved stock may leave), so the source's available figure drops at once and the units are "in transit" — held by no warehouse. Completing writes `TRANSFER_IN` at the destination locations the receiver chooses (default `MAIN`). Cancelling a pending transfer writes `TRANSFER_IN` back to the original source locations. Both legs carry the `transferId`, so history shows both sides (spec §18).

**Why:** Avoids double-counting during transit and makes "warehouse transfer during order processing" (spec §64) safe: reserved units cannot be transferred, and stock that has left cannot be sold from the source.

---

## D-045 · 2026-09-05 · Integration hook: inventory change handlers run inside the movement transaction

**Decision:** `src/server/services/inventory-hooks.ts` exposes `registerInventoryChangeHandler(handler)`. After a movement batch writes its ledger rows and cached figures, every handler is called with the transaction client and the new warehouse-level figures per SKU (`onHand`, `reserved`, `available`, `ownerId`). Handlers may write rows in the same transaction (e.g. the Shopify session's `ShopifyOutboundJob` INVENTORY_PUBLISH rows) but must not perform network calls; a throwing handler is logged and ignored so an integration can never roll back a warehouse action. `inventory.availableForVariants(variantIds, warehouseIds)` is the read-side contract.

**Why:** shopify-integration.md §6 requires the publish job to be enqueued atomically with the stock change without the Shopify code touching core tables (D-027).

---

## D-046 · 2026-09-06 · Order CSV import/export uses a Shopify-compatible layout with `V3PL …` columns

**Decision:** Order CSV files follow Shopify's order-export layout (one row per line item grouped by `Name`, Shopify column names and vocabulary) so Shopify users need no new format. Required import columns are `Name`, `Lineitem sku`, `Lineitem quantity`; SKUs are resolved against the V3PL catalogue and each line inherits its owner from the SKU. V3PL-specific data is exported in columns prefixed `V3PL ` and can be supplied on import (`V3PL Warehouse`, `V3PL Owner Code`, `V3PL Financial Status`, `V3PL Invoice Reference`). Shopify-only columns that V3PL does not store (billing address, risk, payment references, numeric `Id`) are ignored and reported as such. Fulfilment/shipment columns are export-only. Full mapping: [csv-orders.md](csv-orders.md).

**Why:** Client requirement (2026-09-06): familiar to Shopify users, import **and** export, no information lost on round trip, but the V3PL model must not be bent to Shopify's CSV. Prefixing preserves both vocabularies unambiguously.

---

## D-047 · 2026-09-06 · Order engine rules: identity, reservation, cancellation, returns, numbering

**Decision:**
- **Identity / idempotency:** `UNIQUE (shopifyStoreId, shopifyOrderId)` and `UNIQUE (source, sourceRef)`. `createOrder` returns the existing order (`created: false`) instead of duplicating, including under a concurrent race (unique violation → re-read). External events carry `externalEventId` on order events and ledger rows; replays are detected and ignored.
- **Reservation:** state lives on `OrderItem.reservedQty`; `reserveOrder` reserves only the unreserved delta, so retries never double-reserve. Insufficient stock leaves the line unreserved and flags the order (D-028); available is never negative (D-007). A fully reserved NEW order becomes CONFIRMED automatically.
- **Picking cannot double-count:** a line's pickable quantity = ordered − shipped − cancelled − units already in open (PICKING/PACKED) fulfilments.
- **Shipping:** one Shipment per Fulfillment (unique FK); `shipStock` consumes the reserved part and takes any unreserved remainder from available stock; statuses are recomputed from line quantities (`order-status.ts`).
- **Cancellation:** releases all unshipped reservations, cancels open picking, records the unshipped remainder as `cancelledQty`. Nothing shipped → CANCELLED; partially shipped → COMPLETED with the remainder cancelled. Idempotent.
- **Returns:** `receiveReturn` has no stock effect; `inspectReturn` books SELLABLE units back (RETURN) and books DAMAGED units in and immediately out (RETURN + DAMAGE) so both the return and the write-off are in the ledger and damaged units never become available.
- **Numbering:** human order numbers come from the Postgres sequence `Order_number_seq` starting at 1001; internal ids stay cuids.
- **Portal scope:** portal users see only orders containing their lines and only those lines; totals are hidden. 3PL clients create orders restricted to their own SKUs (`submittedByOwnerId`).

**Why:** Spec §17, §21–§35, §64 and shopify-integration.md §6/§8.2/§10/§12; keeps the inventory service the sole stock writer and makes every external effect replay-safe.

---

## D-048 · 2026-09-05 · Reports are computed live from operational tables; one report engine for admin and portals

**Decision:** `src/server/services/reports.ts` derives every dashboard and report figure from the inventory ledger, balances, orders, shipments and returns at request time — no report tables, no cached metrics. A single `ReportView` component serves `/admin/reports` and the portal Reports / Shipments / Returns pages. Scope is decided by the caller: portal pages and `/api/reports/*` always inject the session owner id and ignore any `ownerId` parameter; staff may filter by owner. Portal outputs never include owner columns, other owners' lines, order totals or admin-only text. CSV is the export format for all reports; the "orders" report reuses the Shopify-compatible order export (D-046). Excel/PDF are deferred to Phase 6 where the spec introduces them.

**Why:** Spec §48 (reports reflect real operational data; vendor/3PL reports scoped to own information) and §54 ("useful rather than decorative"). Live derivation keeps the ledger the single source of truth and avoids a second dataset that could drift.

---

## D-049 · 2026-09-07 · Shopify catalog matching rules and one-to-one mapping guard

**Decision:** Shopify variants are matched to V3PL SKUs by **SKU only**, normalised with trim + upper-case and nothing else; titles, barcodes and prices are never used to match. Only ACTIVE internal variants of ACTIVE products match; archived ones are reported as unmatched. Duplicate SKUs within a store, and SKUs already mapped manually to another Shopify variant, are CONFLICT. Manual mappings survive every sync; IGNORED is sticky until the Shopify SKU changes. A unique constraint `(storeId, variantId)` on `ShopifyVariantMapping` enforces one internal SKU ↔ at most one Shopify variant per store. Unmatched Shopify products may be created in V3PL only through the preview flow where the Admin assigns the owner per Shopify product (a store never implies ownership). Catalog sync never reads Shopify inventory quantities.

**Why:** Spec §36/§46 and shopify-integration.md §1 (“no guessing”, store ≠ vendor); client approval of the three judgment calls on 2026-09-07 (case-insensitive exact SKU, no archived matches, owner per Shopify product).

---

## D-050 · 2026-09-07 · Shopify order import rules (Step 3) and non-shipping lines (Option A)

**Decision:** Shopify orders are imported through one path that re-fetches the order and calls only the core order contracts. Line resolution is by variant mapping or exact normalised SKU; any unresolved shippable line means **no V3PL order** (attention item + Retry after the mapping is fixed). Reservation happens at import regardless of payment state at the store's configured default warehouse; without a warehouse the order is created unreserved and flagged. Lines with `requiresShipping = false` are **never passed to the core**: no OrderItem, no reservation, no fulfilment; they are recorded on the order as a note (`addOrderNote`) and in the sync log; a SKU-less non-shipping line never fails an import; an all-non-shipping order creates no V3PL order in v1 (core requires at least one line — follow-up requested, shopify-integration.md §6.1). Updates are state-based (Shopify `currentQuantity` is the target); refunds after shipment and lines added in Shopify only flag the order — physical stock changes only through V3PL returns. Per-store settings `Import test orders` (default off) and `Import orders created since` (default = first connection) control what is imported; a manual backfill covers Shopify's 60-day window. `sourceRef` = shop domain + order name.

**Why:** Spec §34–§38, D-028, and client approvals of 2026-09-07 (eight decisions plus the amended non-shipping rule and Option A). Keeps the inventory engine the sole stock writer and the Shopify layer a consumer of core contracts (D-027).


---

## D-051 · 2026-09-07 · Core capabilities R-1 / R-2 for outbound Shopify fulfilment; hook handlers run in savepoints

**Decision:**
- **R-1** `fulfillment.recordExternalReference(fulfillmentId, { shopifyStoreId, shopifyFulfillmentId }, actorId)` links a shipped V3PL fulfilment to the external fulfillment that represents it: sets `Fulfillment.shopifyStoreId/shopifyFulfillmentId`, stamps `Shipment.shopifySyncedAt`, writes one `shopify_synced` order event and one audit row. Idempotent for the same reference (`{ updated: false }`); a different id on a linked fulfilment, a store mismatch with the order, an unshipped fulfilment, or a unique-constraint clash all surface as `BAD_STATUS`; blank inputs as `INVALID_REFERENCE`. No stock or status effect. The service stays Shopify-agnostic: it only writes the two identity columns that already exist on core tables (shopify-integration.md §5.2).
- **R-2** `ShipmentEvent` gains `kind: "SHIPPED" | "TRACKING_UPDATED"`. `updateShipmentTracking` computes a normalised diff, is a no-op when nothing changes, and on a real change writes one event + audit row and fires one `TRACKING_UPDATED` hook carrying `tracking`, `previousTracking`, `externalEventId` and `external` (true for EXTERNAL fulfilments or when driven by an external event id) so integrations never push a change back to its origin.
- **Hardening:** every handler in `runShipmentHandlers` / `runInventoryChangeHandlers` runs inside a PostgreSQL savepoint. A handler failing at the SQL level is rolled back to its savepoint and logged; the warehouse action still commits. Previously only the JavaScript error was caught, which would have left the transaction aborted.

**Why:** docs/core-requests.md R-1/R-2 (Shopify Step 4 outbound fulfilment and tracking push) and D-027 (Shopify never writes core tables). The savepoint rule makes the long-standing promise "an integration failure never rolls back a warehouse action" true at the database level.

---

## D-052 · 2026-09-07 · Shopify fulfillment sync and inventory publishing rules (Step 4)

**Decision:** Shipping a Shopify-originated order in V3PL enqueues one `FULFILLMENT_CREATE` job per shipment (dedupe `fulfillment:{shipmentId}`), drained right after the response via Next `after()` with the drain/daily run as fallback. The runner allocates shipped lines to Shopify fulfillment-order line items by `shopifyLineItemId`, **moves** fulfillment orders assigned to another location to the store's configured fulfilment location (a refused move → attention, never a silent skip), adopts an existing Shopify fulfillment with the same tracking number instead of creating a second one, sends carrier text + tracking number + URL with `notifyCustomer: true`, and links the V3PL fulfilment to the Shopify id **only through the core contract `fulfillment.recordExternalReference` (R-1)** — until the core ships it the job stops in *Needs attention* with the Shopify id remembered, and Retry links without a second Shopify write. Fulfillments created in Shopify Admin are mirrored once via `recordExternalShipment` (reservation consumed exactly once, replay-safe); Shopify delivery statuses map to shipment statuses (DELIVERED/PICKED_UP → DELIVERED; IN_TRANSIT/OUT_FOR_DELIVERY/ATTEMPTED_DELIVERY → IN_TRANSIT); a fulfillment cancelled or failed in Shopify only flags the order — stock moves only through V3PL returns. Inventory publishing is off by default; enabling it runs an initial publish that adopts Shopify's current quantity as the compare baseline; every later push is compare-and-set against the last published value; any mismatch (read ≠ last published, or Shopify rejecting the compare mid-flight) is logged with both values and needs an explicit **Force publish**; inventory items not stocked at the publish location are activated there; the daily sweep reads Shopify for every matched SKU (`verify`) so manual Shopify edits surface within a day; hooks/jobs skip without a Shopify call when V3PL is unchanged. Shopify quantities are never written into V3PL.

**Why:** Client approvals of 2026-09-07 (eight Step 4 decisions: R-1 contract, auto-move with attention on refusal, cancellation = attention only, carrier + URL, activation allowed, Shopify-current baseline with attention + Force publish on mismatch, `after()` + drain fallback, auto-fulfilment off on the dev store); D-027 (Shopify never writes core tables), D-029, D-031 (free tier), D-032 (mirror Shopify fulfillments), spec §37–§39.

---

## D-053 · 2026-09-09 · Shopify-like product structure (options / variants) and product CSV

**Decision:** `Product.options String[]` (≤ 3 option names, e.g. `["Color","Size"]`) and `ProductVariant.optionValues String[]` (one value per option); the variant label (`name`) is *derived* (`"Black / Small"`), never typed. A simple product has no options and one default variant. The product UI shows only owner, title, status, and per variant option values, SKU, price, inventory and status; category/description/notes/barcode/cost stay in the schema but leave the form. The title of a simple product defaults to its SKU until the user types one. Product CSV import/export uses Shopify's product-export layout (`Handle` groups variants of one product; `Option1..3 Name/Value`; `Variant SKU` required and globally unique; `Title`/`Default Title` for simple products) plus `V3PL …` columns; quantities are booked as receipts (inventory service) for new active SKUs only; existing SKUs are updated in place. Migration `20260909000000_product_options` backfills legacy free-text variant names as a one-option product ("Variant").

**Why:** Client request 2026-09-09 (pre-Phase-6 refinement): one catalogue maintained once for Shopify and V3PL, Shopify-like organisation with a deliberately small interface, SKU remaining the operational identity (D-004). Existing 1→N Product/Variant architecture already supported multi-variant products; only option names/values were missing, so the change is two array columns and no business-rule change.

---

## D-054 · 2026-09-09 · Deletion rules: hard delete only without history, otherwise archive / cancel / deactivate

**Decision:** Products, orders, warehouses and locations get a *Delete* action that hard-deletes only while nothing references the record: products — no ledger rows, stock records, order lines, receipts, transfers, returns or MATCHED Shopify mapping on any SKU; orders — no ledger rows, fulfilments, shipments or returns, and never Shopify-sourced; warehouses/locations — no stock or operational history, and never the default location. Every check is computed server-side (`productDeleteCheck`, `orderDeleteCheck`, `warehouseDeleteCheck`, `locationDeleteCheck`), the dialog lists the blockers and offers the existing soft path (Archive / Cancel / Deactivate). Deletions are audited and ADMIN-only. Owners and users keep their existing rules (INACTIVE / tombstone).

**Why:** Client request 2026-09-09: deletion from the UI without destroying inventory, fulfilment, shipment or audit history. The database's RESTRICT foreign keys remain the last guard (P2003 → "cannot be deleted").

---

## D-055 · 2026-09-09 · Customer-facing order status as the primary status

**Decision:** The UI leads with one Shopify-like status derived from the internal dimensions (`lib/order-presentation.ts`): Cancelled (order CANCELLED) → Returned (everything shipped was returned) → Delivered (`FULFILLED`) → Fulfilled (`SHIPPED`) → Partially fulfilled (`PARTIALLY_SHIPPED`) → Unfulfilled (everything else). Staff screens add the warehouse stage (Reserved / Picking / Packed) as a secondary hint; the fulfilment queue keeps the full workflow. The orders list filters by this status (`view=`) next to Open / Completed / Cancelled / All. Internal statuses, CSV columns and reports are unchanged.

**Why:** Client request 2026-09-09: statuses should read like Shopify rather than exposing warehouse workflow states, without removing backend workflow capabilities (D-008 derivation stays).

---

## D-056 · 2026-09-09 · Inter as the only UI font; sticky admin sidebar

**Decision:** `next/font/google` Inter (`--font-inter`) is the `--font-sans` for the whole app; the Geist display/mono pair is removed and code/SKU text uses the system monospace stack. The desktop admin sidebar is `sticky top-0 h-screen` inside the flex frame so it never scrolls away; the nav scrolls internally when taller than the viewport and the main column scrolls with the page.

**Why:** Client request 2026-09-09 (global typography and layout fix); no new decorative font.


---

## D-057 · 2026-09-12 · Option/value builder, retail + wholesale prices, physical data, Shopify SKU warning (Batch 2)

**Decision:** The product form gains a Shopify-like builder: up to 3 options, each with a *list of values*; every
combination is generated as a `ProductVariant` row (`lib/variant-builder.ts`: `generateCombinations`,
`mergeVariantRows`, `renameOptionValue`). Existing rows keep SKU, prices, physical data, status and id when values
change; a same-position value change is treated as a rename; rows with stock history are never dropped (kept as
"orphaned" until archived or the value is re-added); duplicate combinations are impossible. Option values are not a
separate entity — they are derived from the variants' `optionValues`, which stay the source of truth.
`ProductVariant` gains `wholesalePrice`, `weightGrams`, `lengthCm/widthCm/heightCm` (migration
`20260912120000_variant_pricing_physical`); `price` is the **retail** price and remains the default unit price on
orders; wholesale is stored for owner valuation and later due/owe work and is never used on customer orders. Product
CSV carries `Variant Grams`, `V3PL Wholesale Price` and the three dimension columns. Creating/editing a SKU runs a
read-only check against `ShopifyVariantMapping` of *connected* stores (`skuStoreConflicts`) and shows non-blocking
warnings (already mapped in a store, exists as a Shopify SKU, present in several stores); mappings are never changed
by the product form.

**Why:** Client requirements NR-1/NR-2/NR-3 of 2026-09-12 (Batch 2). Deferred on purpose: option-level entities, manual
V3PL → Shopify orders and any Shopify scope change, the finance ledger that will consume wholesale value.


---

## D-058 · 2026-09-13 · Initial inventory during product creation

**Decision:** The Add product form gets an optional "Initial inventory" card: one warehouse + location (defaulting
to the warehouse's main location) and a quantity per generated variant/SKU. On save, `createProductWithInitialStock`
creates the product through `createProduct` and then books every non-zero quantity as ONE receipt through the
existing receiving service (`createReceiving`: receiving record, RECEIVE ledger rows with user, timestamp, warehouse,
location, before/after, reference "Initial stock", audit `inventory.received`). Balances are never written
directly. Blank/zero quantities are ignored, so a product can still be created with no stock. If the receipt is
refused (inactive warehouse, location of another warehouse…) the just-created product — which has no history yet —
is deleted again, so the operation is all-or-nothing for the user. `initialQuantity` lives only in the form
payload; it is never stored on the variant. The edit form has no such card (stock changes go through
Receiving/Adjustments as before). Product creation is admin-only; the capability therefore applies equally to
vendor- and 3PL-owned products created by staff.

**Why:** Client request 2026-09-13: entering opening stock SKU by SKU in Inventory after creating a multi-variant
product was slow. Reusing the receiving service keeps the single-writer rule (D-006/D-007) and the full history.


---

## D-059 · 2026-09-15 · Variant barcode is optional and globally unique

**Decision:** `ProductVariant.barcode` stays a variant-level field (like the SKU and like Shopify's
`ProductVariant.barcode`) and becomes **globally unique** (`ProductVariant_barcode_key`, NULLs excluded). Format is
kept minimal: trimmed, 1–64 characters, no whitespace; blank means "no barcode". Uniqueness is checked in three
layers — form/schema (duplicates inside one product, row named), service pre-check (`BARCODE_TAKEN` naming the
conflicting barcode, SKU, product and owner) and the database index (a raced P2002 is mapped to the same error),
so a barcode is never silently changed or duplicated. Existing products, variants, orders and history without
barcodes stay valid. Barcode search already works through `searchVariants`; the picker shows the barcode of a
match. Product CSV keeps the existing `Variant Barcode` column and now validates uniqueness. No product-level
barcode. Shopify barcode sync is deliberately not started; the model is ready for a 1:1 mapping later.

**Why:** Client request 2026-09-15; keeps the SKU as the operational identity while giving warehouses a scannable
unique code per sellable unit.


---

## D-060 · 2026-09-15 · Customer directory (operational, owner-scoped) and order linkage

**Decision:** A single `Customer` model serves admin, vendor and 3PL screens: name, e-mail (lower-cased), phone
(+ digits-only `phoneNormalized`), shipping and billing address, notes, `source` (MANUAL / ORDER / THREEPL_PORTAL /
SHOPIFY / CSV_IMPORT), timestamps. **Scope = `ownerId`**: NULL means a V3PL company customer (staff manual orders);
otherwise the vendor / 3PL client the customer belongs to. Every read/write goes through a scope derived from the
session (staff → all, portal user → own owner); owner ids from the browser are ignored for portal users. No logins,
no CRM. E-mail and phone are deliberately **not** platform-unique — the same person can be a customer of several
owners; duplicates are detected *within one owner pool* (same e-mail, same phone digits, same name) and surfaced as a
warning; "save as new customer" from an order reuses an exact e-mail/phone match instead of creating a duplicate.
`Order.customerId` (SetNull) links new orders to the directory, but the order keeps its own customer/ship-to
**snapshot**: editing a customer never rewrites past orders, and orders created before the directory (no
`customerId`) keep displaying their stored data — no backfill. `shopifyStoreId` + `shopifyCustomerId` are reserved
(unique pair) for the future Shopify customer sync; nothing writes them yet and the sync itself is out of scope.

**Why:** Client requirement NR-5 (2026-09-12) implemented on 2026-09-15 without Shopify sync. One model + one
service keeps admin and portals consistent (spec §5 isolation) while the snapshot rule protects order history.


---

## D-061 · 2026-09-15 · Manual V3PL order → Shopify order: core side (request, contract, result)

**Decision:** Sending a manual V3PL order to Shopify is an explicit, **idempotent request** handled by core
(`src/server/services/shopify-order-request.ts`), not an automatic side effect of `createOrder`. Core resolves the
target store **server-side from the variant mappings** — every active line needs exactly one `MATCHED` mapping in a
`CONNECTED` store and all lines must resolve to the same store; missing, ambiguous (SKU matched in several connected
stores) and mixed cases are refused with a named reason and create nothing. The browser never names a store. The
request reuses the existing outbound queue: one `ShopifyOutboundJob` of the new type `ORDER_CREATE` per order
(`dedupeKey = order:{orderId}`), never re-armed once `DONE` or once a reference exists; `FAILED`/`NEEDS_ATTENTION`
jobs may be re-armed by a new request (manual retry). The order records `shopifyOutboundStatus`
(`PENDING | CREATED | FAILED`, NULL = never requested) and `shopifyOutboundError`; the created Shopify order is stored
in the existing `shopifyStoreId / shopifyOrderId / shopifyOrderName` columns through `recordShopifyOrderReference`
(same-reference → no-op, conflicting reference → `BAD_STATUS`, `UNIQUE(shopifyStoreId, shopifyOrderId)` guarantees
one Shopify order ↔ one V3PL order), so the inbound `orders/create` webhook for that Shopify order dedupes onto the
same MANUAL order without any change to the import pipeline. Only `MANUAL` orders are eligible (portal / CSV /
Shopify-sourced orders are not); cancelled orders and fully cancelled lines are excluded. Inventory is never touched
by the request: the reservation from order creation is the only stock effect, and Shopify must not deduct again. The
Shopify API call itself, the `ORDER_CREATE` runner, `write_orders` scope, and tags/notes wording belong to the
Shopify session (contract in `docs/shopify-order-request.md`). SKU-04 ("ask which store") is resolved as *refuse and
explain* rather than a store picker: with one SKU per store (SKU-02/03) the ambiguity should be fixed in the mapping,
not chosen per order.

**Why:** Client requirement NR-4 (2026-09-12), core half implemented 2026-09-15. Reusing the job queue and the
existing reference columns avoids a second idempotency system (§14, D-027 boundary) and keeps the V3PL order the
source of truth even when Shopify is down.

---

## D-062 · 2026-09-15 · Manual V3PL order → Shopify order: Shopify side (runner, scope, inventory, idempotency, marker)

**Decision:** The `ORDER_CREATE` runner (`src/server/services/shopify/order-out.ts`) consumes the D-061 contract
unchanged and creates the order with Admin API 2026-07 `orderCreate`, requiring the new scope **`write_orders`**
(new app version from `shopify.app.toml`; every connected store must be reconnected; the runner refuses a store whose
granted scopes lack it). Inventory: `inventoryBehaviour: BYPASS` — Shopify never claims or decrements stock for an
order V3PL created; the V3PL reservation is the only stock effect and Shopify quantities keep flowing one-way from
publishing, and the `orders/create` webhook for such an order **links** the manual order (recognised by the
`v3pl_idempotency_key` attribute) instead of importing it. Payment: `financialStatus: PENDING` always (V3PL records no
payment); no `customer` object is sent (email/phone/addresses only — no customer scopes); the V3PL retail unit price
is sent as `priceSet` and is the price of record. Idempotency reuses the FULFILLMENT_CREATE pattern: recorded
reference → id remembered on the job → adoption by tag `V3PL-<orderNumber>` + attribute `v3pl_idempotency_key =
order:<id>` → create; the id is persisted on the job before `recordShopifyOrderReference`, a refused link
(`BAD_STATUS`) stops in attention with the id kept, and a DONE job is never re-armed — so one V3PL order yields at most
one Shopify order even across lost responses and the webhook race. Marker wording: tags `V3PL`, `V3PL-<orderNumber>`;
note `Created from V3PL order <orderNumber>.` (+ V3PL notes); attributes `V3PL order`, `v3pl_idempotency_key`.
Fulfilment push eligibility becomes "the order carries a Shopify reference" (was `source === SHOPIFY`), and because
V3PL-created orders have no Shopify line ids on their items, fulfilment allocation and inbound line sync match lines
through the store's variant mapping (exact SKU as last resort) and never zero an unmatched V3PL line. The core action
`requestShopifyOrderAction` gained one additive line, `scheduleAfterResponse(storeId)`, so the job runs seconds after
the request (D-045 pattern). Not done in v1: taxes/discounts on the Shopify order, retroactive fulfilment push for
shipments made before the Shopify order existed, a store setting for `sendReceipt`.

**Why:** Client requirement NR-4 and the D-061 contract; `BYPASS` is the only inventory strategy compatible with the
one-way compare-and-set publishing of D-052 (a Shopify-side decrement would surface as a false "changed by hand"
conflict); `PENDING` avoids inventing a payment state the platform does not have; reusing the job queue, the
adoption pattern and the reference columns keeps a single idempotency system (D-027, §14).


---

## D-063 · 2026-09-16 · Operational charges + owner settlement ledger (one model, immutable entries, no accounting)

**Decision:** One coherent finance model in core: `ChargeRule` (admin configuration), `Charge` (an applied charge with
frozen name / unit amount), `LedgerEntry` (immutable financial movement) and `Owner.chargesEnabled` (default off). Charges
and the vendor's wholesale valuation are recorded **at shipment time** — the moment goods actually leave — inside the
shipping transaction, for both warehouse shipments and Shopify-mirrored fulfilments, and every write carries a
`dedupeKey` so a re-run is a no-op. Rules match on the variant's existing `weightGrams` and the **longest side** of its
existing `lengthCm/widthCm/heightCm` (no new physical or price fields); unknown data never matches a ranged rule.
PER_UNIT charges per order item, PER_SHIPMENT once per owner per shipment, PER_ORDER once per owner per order at its
first shipment. Valuation uses **wholesale price × quantity shipped** for vendors only (3PL clients own their goods and
only receive charges); retail price is never used. The balance is never stored: Σ `PAYABLE_TO_OWNER` − Σ
`RECEIVABLE_FROM_OWNER`, worded *payable to owner / receivable from owner / settled*. Payments and authorised
adjustments are manual, admin-only, idempotent through a client-generated key, and expressed as kinds (paid to owner,
received from owner, adjustment either way) mapped to a type + direction — never a signed balance edit. Editing or
deactivating a rule never changes history; an applied rule cannot be deleted. Owner isolation reuses the session-derived
scope from D-060 (`customerScopeFor`): portal users are pinned to their owner regardless of what they send. **No
backfill:** orders shipped before this feature have no entries; opening balances, if ever needed, are explicit
adjustments. Not built: accounting/tax engine, invoices, payment gateway, Shopify payment-status sync (manual V3PL →
Shopify orders stay `financialStatus: PENDING`, D-062), returns reversing valuation, storage-period charges.

**Why:** Client requirements NR-8 and NR-9 (2026-09-12) grouped because charges are ledger inputs. Spec §49 forbids
accounting software and payouts; an operational settlement ledger with derived balances satisfies the business need
while keeping the accounting integration layer a later decision.


---

## D-064 · 2026-09-16 · Finance correction: two accounts, manual vendor payables, automatic 3PL product value

**Decision:** Supersedes the valuation and balance rules of D-063 (charges unchanged). (1) A vendor is a supplier: its
wholesale price is the product **cost** used for gross-margin reporting (retail sales − wholesale cost of shipped units)
and is **not** a liability — receiving and shipping never create a vendor payable. Admin creates `VENDOR_PAYABLE` entries
manually against a specific received line (quantity × historical unit cost, defaulting to the wholesale price at that
time), and the allocated quantity per received line can never exceed the received quantity (row-locked, transactional,
idempotent). (2) A 3PL client owns its goods: shipping their units automatically posts `PRODUCT_VALUE` payable to them
(quantity × wholesale / product value), while operational charges continue on the receivable side. (3) The ledger has two
independent accounts — `PAYABLE` and `RECEIVABLE` — each entry an `INCREASE` or `DECREASE` on one of them. Balances are
derived per account and **never netted**: every screen shows *Payable to owner* and *Receivable from owner* separately.
Payments settle exactly one side (payment to owner → payable decrease; payment from owner → receivable decrease);
adjustments name their side and direction. The previous `direction` column and `WHOLESALE_VALUE` type were converted by
migration `20260916150000_finance_accounts` (one existing charge row). No backfill of history.

**Why:** Finalised business rules (2026-09-16) after the first finance batch: automatic wholesale payables overstated
what V3PL owed suppliers, 3PL clients were owed nothing for shipped goods, and a single netted balance hid the two
obligations. Reusing `LedgerEntry` with account + effect kept the change to a column swap and a payable-allocation
function rather than a redesign.


---

## D-065 · 2026-09-22 · Shopify customers → V3PL customer directory (sync, not replacement)

**Decision:** Shopify customers are synchronised **into** the D-060 customer directory by an explicit Admin action
per store (*Sync customers now*), not by webhooks or a schedule. Identity is the (store, numeric Shopify customer id)
pair reserved by D-060 — never the e-mail. The merge lives in one core contract, `upsertShopifyCustomer`: a mapped
record is updated with Shopify values **only where Shopify has a value** (V3PL-only notes, billing address, owner,
source and unknown contact data are never blanked); an unmapped **company** customer with the same e-mail is linked
once instead of duplicated (owner pools are never adopted); otherwise a company customer is created with source
`SHOPIFY`. Only identity, name, default e-mail, default phone and the default address are read (data minimisation).
The first run pages through every customer (`sortKey: ID`, 100 per page, 120 s budget → partial + re-run); later runs
filter `updated_at` from the last complete run minus 10 minutes, and `ShopifyStore.lastCustomerSyncAt` is stamped only
after a complete run. One bad record is counted, logged with attention and skipped. New Shopify orders imported from a
store that granted `read_customers` resolve their customer through the same upsert first and link `Order.customerId`
(the order keeps its own ship-to snapshot; failures never block the import; no backfill). Scope: `read_customers`
added (read-only; no `write_customers`), requiring a new app version and store re-authorisation; stores without it are
refused by the sync and import orders exactly as before.

**Why:** Client requirement CUS-03 with the smallest surface: the schema slot, the customer service, the GraphQL
client, the sync log and the store page already existed, so the batch adds one service, one contract, one button and
one additive migration. Store customers belong to the company pool because a Shopify store is connected by V3PL and
serves several owners' SKUs; per-owner assignment would need a rule the business has not defined.


---

## D-066 · 2026-09-22 · Shopify inventory for V3PL-created orders: keep `BYPASS`, fix the publish conflict rule

**Decision:** A V3PL-created Shopify order stays inventory-neutral in Shopify (`inventoryBehaviour: BYPASS`, D-062);
Shopify's available is lowered by the `INVENTORY_PUBLISH` job that the V3PL reservation re-arms, i.e. by publishing
V3PL's truth — never by a Shopify-side claim. `DECREMENT_OBEYING_POLICY` / `DECREMENT_IGNORING_POLICY` were rejected
because the publish job is created inside the order transaction and drains before `ORDER_CREATE`: Shopify would claim
the units on top of the already-published reservation (double deduction) and every such order would end in a
compare conflict. Two defects in the publish path are corrected instead. (1) **Conflict rule:** when Shopify already
shows what V3PL would publish, the SKU is in sync regardless of `lastPublishedAvailable` — the baseline is re-anchored
and nothing is written; a conflict is only "Shopify differs from both the last published value and V3PL available".
The old rule flagged every Shopify-originated sale (Shopify −n at checkout, V3PL −n on import) as "changed by hand",
which put the SKU into a permanent conflict that also swallowed the publishes carrying V3PL-created orders.
(2) **Publish location change** clears `lastPublishedAvailable` / `lastPublishedAt` for the store's mappings: the
baseline belongs to the location it was written to, and the next publish anchors on the new location's current
value. No schema change.

**Why:** Production evidence (dev store, 2026-09-15 → 2026-09-22): all `ORDER_CREATE` and `FULFILLMENT_CREATE` jobs
DONE with references, yet every publish of XVS-TEST-001 was refused daily as "Shopify shows 192 but V3PL last published
281" after the publish location was switched from "My Custom Location" (where 281 had been written) to "Shop
location"; the V3PL orders' reservations therefore never reached Shopify. Both fixes are a few lines in the existing
write path; the reservation → publish → Shopify chain stays the single inventory effect (no double deduction).


---

## D-067 · 2026-09-22 · Shopify product import: explicit V3PL destination for initial stock

**Decision:** The catalog sync stays data-only (mappings, never inventory — D-024/D-049). The explicit *Import unmatched
into V3PL* flow gains an optional **initial stock** step reusing the D-058 core contract `createProductWithInitialStock`:
in the preview the Admin sees Shopify's sellable quantity per variant (`inventoryQuantity`, reference only), may enter an
initial quantity per SKU ("Use Shopify quantities" fills them), and chooses the **V3PL destination** — an active
warehouse and an active location of that warehouse, pre-selected to the store's default reservation warehouse and its
default location. Quantities > 0 are booked as ONE receipt per product (reference "Initial stock", RECEIVE ledger rows,
audit) into that location; a product with quantities but no valid destination is refused before anything is created,
and a wrong location (other warehouse) is refused the same way. Without quantities the import remains exactly the old
data-only import whatever destination is shown. A Shopify location is never treated as a V3PL warehouse: the store's
Shopify publish/fulfil locations and its V3PL warehouse pool are unrelated concepts, and no Shopify-location →
warehouse mapping is introduced. Re-sync safety comes from the existing rule that an already-mapped SKU cannot be
imported again, so repeated catalog syncs or import attempts never book stock twice. No schema change.

**Why:** The request was to control *where* Shopify-synced inventory is stocked in V3PL. The existing flows already had
the pieces — an explicit import, a core initial-stock contract with warehouse + location, the product CSV precedent
(`stockWarehouseId`: quantities only when a destination is chosen) — so the batch adds a destination + quantities to the
import instead of a new sync/reconciliation model, and keeps V3PL as the single inventory source of truth for the
publish flow (D-066).
