# Architecture & System Workflows

Status: **Phase 0 — approved design, no implementation yet.**
See [DECISIONS.md](DECISIONS.md) for the rationale behind each choice.

---

## 1. Stack

| Layer | Technology |
|---|---|
| Application | Next.js (App Router), React, TypeScript — single monolith |
| Database | PostgreSQL (Neon proposed) + Prisma ORM |
| Authentication | Firebase Authentication (email/password only, no public registration) |
| Authorization | Firebase Admin SDK server-side, role + ownership checks on every request |
| Images | Cloudinary (signed server-side uploads; secret never in browser) |
| Shopify | Admin GraphQL API, HMAC-verified webhooks, bulk operations for large reads |
| UI | Tailwind CSS + shadcn/ui |
| Validation | Zod schemas shared between client and server |
| Hosting | Vercel (client account) · GitHub private repo (client-owned) |

No microservices, no Redis, no queues, no background workers. Correctness comes from
PostgreSQL transactions; scheduled reconciliation uses Vercel Cron hitting an internal route.

## 2. Application Structure (planned)

```text
src/
  app/
    (auth)/admin/            # staff login
    (auth)/user/             # vendor + 3PL shared login
    admin/...                # internal staff area (role-gated: ADMIN / WAREHOUSE / SALES)
    portal/vendor/...        # vendor portal
    portal/3pl/...           # 3PL client portal
    api/
      webhooks/shopify/      # webhook receiver (HMAC verified, no session)
      cron/                  # reconciliation & retry endpoints (Vercel Cron)
      ...                    # all other API routes
  server/
    auth/                    # token verification, session, role/ownership guards
    services/
      inventory.ts           # THE ONLY module that writes inventory tables
      orders.ts
      fulfillment.ts
      receiving.ts
      transfers.ts
      shopify/               # client, sync-in, publish-out, webhook processing
      imports.ts             # CSV import/export engine
      audit.ts
  lib/                       # shared utils, zod schemas, constants
prisma/
  schema.prisma
  migrations/
docs/
```

Rules:

- **UI components never touch Prisma.** All mutations go through `server/services/*`.
- **Only `services/inventory.ts` writes** `InventoryTransaction` / `InventoryLevel`.
- **Every service mutation writes `AuditLog`** in the same transaction where important.

## 3. Roles & Access

| Role | Login | Access |
|---|---|---|
| ADMIN | `/admin` | Everything |
| WAREHOUSE | `/admin` | Receiving, picking, packing, shipping, transfers, adjustments, inventory views |
| SALES | `/admin` | Order creation/viewing, product & availability lookup |
| VENDOR | `/user` | Own data only (products, inventory, orders, reports) |
| THREEPL_CLIENT | `/user` | Own data only + create/submit fulfillment orders for own SKUs |

### Request authorization flow (every API request)

```text
Request → verify Firebase ID token (Admin SDK)
        → load User row by firebaseUid (status must be ACTIVE)
        → role check for the route
        → if VENDOR/THREEPL: inject user.ownerId into every query filter
          (never read owner identity from URL/body)
        → execute → audit log where applicable
```

A disabled/banned user fails at step 2 regardless of a valid Firebase token.

## 4. Inventory Engine

Two tables, one writer module:

- **`InventoryTransaction`** — append-only ledger. Every movement records: variant/SKU, owner,
  warehouse, location, signed quantity, bucket (ON_HAND / RESERVED), type, reason, user,
  timestamp, and links to the causing record (order, receiving, transfer, shipment, return).
  Never updated, never deleted.
- **`InventoryLevel`** — cached `(variant, warehouse, location) → onHand, reserved`,
  updated in the **same DB transaction** as the ledger insert.
  `available = onHand − reserved`, always computed.

### Movement semantics

| Operation | onHand | reserved | Notes |
|---|---|---|---|
| Receive | +q | — | from ReceivingRecord |
| Reserve | — | +q | requires `available ≥ q` (conditional update, concurrency-safe) |
| Release reservation | — | −q | cancellation before shipment |
| Ship | −q | −q | consumes the reservation |
| Transfer | −q source / +q dest | — | both sides in one transaction, both visible in history |
| Return (sellable) | +q | — | linked to order/return record |
| Return (damaged) | ledger event only → damaged | — | not returned to sellable stock |
| Damage / Missing | −q | — | requires reason + user |
| Manual adjustment | ±q | — | requires reason, notes; before/after recorded |

No negative available stock. No silent changes — every movement has a user and a reason.

## 5. Order Lifecycle (main workflow)

```text
CREATE (manual / CSV / Shopify / 3PL portal)
  └─ each line: SKU → variant → owner (denormalized to the line)
  └─ validate stock → RESERVE per line (chosen warehouse)
        │
        ▼                       Order status:      Draft → New → Confirmed → Completed
PICK  (warehouse staff,                                    └────→ Cancelled (release reservations)
       location-guided list,
       double-pick prevention)
        │
        ▼
PACK  (simple confirmation)
        │
        ▼
SHIP  (manual: carrier, tracking no., date — works with no courier API)
  └─ Fulfillment(+items) + Shipment(+items); partial shipments supported:
     an order can have many fulfillments/shipments, quantities tracked per line
  └─ inventory: shipped lines consume reservations (onHand−, reserved−)
  └─ Shopify-originated orders: push fulfillment/tracking back to Shopify
        │
        ▼
TRACK / DELIVERED / RETURNED (shipment status, separate from order status)
```

Fulfillment status per order is **derived** from line quantities:
Unfulfilled → Reserved → Picking → Packed → Partially Shipped → Shipped → Fulfilled.

## 6. CSV Bulk Order Import Flow

```text
Upload CSV → parse → validate columns → validate each row
  (SKU exists? owner resolved? quantity valid? duplicate external ref?)
→ preview with row-level errors (nothing silently skipped)
→ user confirms → create valid orders + reserve inventory (one DB txn per order)
→ ImportJob summary: total / success / failed / duplicate / insufficient stock
→ downloadable failed-row report (CSV)
```

Same Upload → Preview → Validate → Errors → Confirm → Results pattern is reused for
product and inventory imports (Shopify-style UX, spec §53).

## 7. Shopify Data Flow (summary — details in [shopify-integration.md](shopify-integration.md))

```text
INBOUND (Shopify → platform)
  webhook (orders/create, orders/updated, fulfillments/*, ...)
    → verify HMAC → record ShopifyWebhookEvent (unique storeId+webhookId → dup = skip)
    → match order by (store, shopifyOrderId): exists ? sync-update : create
    → SKU matching per line; unknown SKU → sync FAILED, exact SKU reported, NO inventory effect
    → reserve inventory / apply fulfillment updates idempotently
    → ShopifySyncLog entry
  + reconciliation polling (Vercel Cron) as safety net — webhooks are notifications,
    not the source of truth

OUTBOUND (platform → Shopify)
  calculated sellable inventory per store (publishing rule per store)
  fulfillment + tracking updates for Shopify-originated orders
  every push logged with previous value / new value / result
```

## 8. Financial Status (no accounting integration yet)

Manual per-order (and where useful per-owner) status: Not Invoiced / Invoiced / Paid /
Partially Paid / Outstanding, plus free-text invoice reference. A documented
`AccountingProvider` interface marks the future integration seam. Nothing provider-specific.

## 9. Security Summary

- Firebase Auth; accounts created only by Admin (staff manually in Firebase console; vendor/3PL from the app which creates Firebase user + DB profile atomically).
- All authorization server-side; frontend checks are UX only.
- Ownership isolation by injected `ownerId` filter — IDs in URLs are never trusted.
- Zod validation on every input; Prisma parameterized queries (no SQL injection).
- Secrets only in `.env.local` / Vercel env vars; Shopify tokens encrypted at rest.
- Webhooks HMAC-verified before any processing.
- Append-only audit log for user management, inventory, orders, fulfillment, sync, ownership changes.
