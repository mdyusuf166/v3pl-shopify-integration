# Development Roadmap — 15-Day Initial Target

Client-confirmed scope: complete core platform + full Shopify integration.
Each phase has a test gate; the next phase does not start until the gate passes.
Git checkpoint (commit + push) at every phase completion, major migration, and integration.

Honest note (recorded 2026-09-01): this is an aggressive timeline. The phase order
protects data correctness first — if anything slips, it will be reporting polish and
UI refinement, never the inventory ledger, isolation, or idempotency guarantees.
Actual progress is tracked in [progress.md](progress.md), not assumed from this plan.

| Days | Phase | Deliverables | Test gate |
|---|---|---|---|
| 1–2 ✅ | **1 · Foundation** | Next.js + TS + Prisma + Firebase Auth wiring, `/admin` & `/user` logins, role routing, protected routes, base layouts/navigation, env handling, audit-log foundation, docs live in repo | Admin & user login; correct portal routing; unauthorized access blocked; DB connected & migrated |
| 2–3 ✅ | **2 · Users, Vendors, 3PL** | Owner (vendor/3PL) CRUD, admin-driven account creation (Firebase user + DB profile), ban/disable/reactivate/delete, staff roles, portal shells, isolation guards | Vendor A ⇸ Vendor B; 3PL A ⇸ 3PL B; vendor ⇸ 3PL data; disabled account cannot log in |
| 3–5 ✅ | **3 · Products, Warehouses, Inventory** ⚠ most critical | Products/variants/SKUs (+ Cloudinary images), warehouses + locations, receiving, inventory ledger + levels, reservations, releases, transfers, returns, damages, missing, audited adjustments | Ledger balances reconcile under realistic data; every movement has user+reason; no negative available; transfer shows both sides |
| 5–8 ✅ | **4 · Orders & Fulfillment** | Manual orders, CSV bulk import (preview/errors/summary/failed-row report), multi-vendor lines, reservation on create, pick → pack → ship, partial/multiple shipments, cancellations, returns, order history | 5-vendor order; partial shipment; cancel-after-reserve releases stock; duplicate import blocked; return restocks correctly |
| 8–9 ✅ | **5 · Vendor & 3PL Portals** | Complete both portals: dashboards, products, inventory, received, orders, fulfillment status, shipments/tracking, returns/adjustments, reports, exports; 3PL order submission (own SKUs only) | Strict ownership filtering re-verified end-to-end incl. 3PL-created orders |
| 9–10 | **6 · Reports & Import/Export** | Admin reports (sales, orders, inventory, movements, vendor/3PL activity, fulfillment, shipments, returns, damages, adjustments), CSV baseline + Excel where practical + PDF where sensible, import/export history, error reports | Numbers reconcile with the ledger; failed imports produce downloadable reports |
| 10–13 | **7 · Shopify** | Multi-store connections, order import + matching/merging, SKU matching, inventory publish, fulfillment/tracking sync both directions, webhooks + HMAC, duplicate protection, sync logs, retry + reconciliation cron, product import/export, bulk operations | Full test matrix in [shopify-integration.md](shopify-integration.md) §8 (spec Tests 1–7 + extras) |
| 13 | **8 · Financial Status** | Manual financial statuses + invoice reference fields on orders, financial reporting fields, `AccountingProvider` abstraction + integration docs | Statuses editable/reportable; zero provider-specific code |
| 14–15 | **9 · Final QA & Deploy** | Full edge-case matrix (spec §64), real vendor + real 3PL scenario test, backup **restore test**, production env vars, production deploy, production verification, handover docs | Everything in spec §62-Phase 9 list passes in production |

## Standing rules for every phase

1. Read PROJECT_MASTER_PROMPT.md, DECISIONS.md, progress.md before starting.
2. Update progress.md at the end of every working session.
3. Record any new decision in DECISIONS.md the moment it is made.
4. Never rebuild working functionality without a strong, documented reason.
5. Commit before any destructive/major change; never commit secrets.
