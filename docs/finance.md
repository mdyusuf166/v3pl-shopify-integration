# Operational charges and owner settlement ledger (NR-8 / NR-9, D-063, corrected by D-064)

Status: implemented 2026-09-16 (core session). Operational only — **not** accounting, tax, invoicing, payouts or a
payment gateway (spec §49). Shopify payment / financial-status synchronisation is deliberately **not** part of this;
manual V3PL orders still reach Shopify with `financialStatus: PENDING` and nothing here changes that (D-062).

## 1. Model

| Table | Purpose | Mutability |
|---|---|---|
| `ChargeRule` | Admin configuration: `chargeType` (PICKING, PACKING, SHIPPING, STORAGE, FULFILLMENT, SERVICE, UTILITY, OTHER), `basis` (PER_ORDER, PER_SHIPMENT, PER_UNIT), `amount`, `active`, applicability (`ownerId` → one business; else `ownerType` → vendors / 3PL clients; else everyone), optional `minWeightGrams/maxWeightGrams`, optional `minLongestCm/maxLongestCm`, notes | Editable; deletable only while never applied (otherwise deactivate) |
| `Charge` | One applied charge: owner, rule reference **plus frozen copies** (`ruleName`, `unitAmount`, `basis`, `chargeType`), `quantity`, `amount`, `reason`, order / shipment / order-item references, `dedupeKey` | Immutable (no update/delete path) |
| `LedgerEntry` | One financial movement: owner, `type` (PRODUCT_VALUE, VENDOR_PAYABLE, CHARGE, PAYMENT, ADJUSTMENT), `account` (PAYABLE / RECEIVABLE), `effect` (INCREASE / DECREASE), positive `amount`, optional `quantity`, frozen `unitAmount`, `receivingItemId` (vendor payables), order / shipment / charge links, `reference`, `description`, `dedupeKey`, `occurredAt`, `createdById` | Immutable |
| `Owner.chargesEnabled` | Per vendor / 3PL client switch (default **off**). Charges are only ever recorded for owners with it on | Owner form |

Physical data comes from the existing `ProductVariant.weightGrams / lengthCm / widthCm / heightCm`; pricing from the
existing `ProductVariant.price` (retail, customer orders) and `wholesalePrice` (business valuation). No new price or
physical fields exist.

## 2. Charge calculation rules (server-side only, `services/charges.ts` + `services/finance.ts`)

- Charges are recorded **when a shipment is created** — both warehouse shipments (`shipFulfillment`) and fulfilments
  mirrored from Shopify (`recordExternalShipment`) — inside the same transaction as the stock movement.
- Applicable rules for an owner = active rules where `ownerId = owner`, or `ownerId IS NULL AND ownerType = owner.type`,
  or both null.
- **PER_UNIT:** one charge per order item in the shipment: `quantity × amount`. Ranges use the unit's own weight and
  longest side (`max(length, width, height)`).
- **PER_SHIPMENT:** one charge per owner per shipment: `1 × amount`. Ranges use the total weight of that owner's units
  in the shipment and the largest unit's longest side.
- **PER_ORDER:** one charge per owner per order, applied at the first shipment (dedupe `charge:order:{orderId}:rule:{ruleId}:owner:{ownerId}`); later shipments of the same order never repeat it.
- A rule with a weight range never matches a unit / shipment whose weight is unknown; the same for dimensions. Rules
  without ranges match everything. Weight and dimension ranges combine with AND.
- Every charge is written with `dedupeKey` (`charge:shipment:{sid}:rule:{rid}:item:{itemId}` / `…:owner:{ownerId}`),
  so re-running the shipment financials is a no-op.
- **Historical safety:** a charge carries the rule name and unit amount in force at the time. Editing, deactivating or
  (when unused) deleting a rule never changes recorded charges, and history is never recalculated from current rules.

## 3. Ledger rules (corrected 2026-09-16, D-064)

- Every entry belongs to one **account** — `PAYABLE` (V3PL owes the owner) or `RECEIVABLE` (the owner owes V3PL) —
  with an **effect** `INCREASE` or `DECREASE`. Amounts are always positive.
- **Open balance per account** (never stored, never netted against the other account):
  `open payable = Σ payable INCREASE − Σ payable DECREASE`, `open receivable = Σ receivable INCREASE − Σ receivable
  DECREASE`. Every screen shows *Payable to owner* and *Receivable from owner* side by side; there is no single
  "outstanding" figure.
- **Vendors** (we buy their goods and sell them): receiving and shipping create **no** liability. Admin creates a
  `VENDOR_PAYABLE` manually against one received line: `quantity × unit cost`, where the unit cost defaults to the
  variant's wholesale price at that moment and is frozen on the entry (`unitAmount`). The entry stores
  `receivingItemId` and `quantity`; the sum of allocated quantities per received line can never exceed the received
  quantity (checked inside a row lock, so concurrent allocations cannot double-allocate). The wholesale price is
  otherwise the **product cost used for gross-margin reporting only**: `vendorGrossMargin()` = Σ shipped × retail
  (order unit price, else variant retail) − Σ shipped × wholesale. Gross margin is never written to the ledger.
- **3PL clients** (they own their goods): shipping their units automatically posts `PRODUCT_VALUE` on the payable
  account, `quantity × wholesale price` (the owner's product value), one entry per shipped order item
  (`product-value:shipment:{sid}:item:{itemId}`). Receiving posts nothing. Operational charges post to the receivable
  account exactly as before. Example: ship 1 unit at 10.00 with a 5.00 fulfilment charge → *Payable to 3PL 10.00*,
  *Receivable from 3PL 5.00*, never "5.00 net".
- **Charges:** every `Charge` is mirrored by exactly one `CHARGE` entry on the receivable account (`chargeId` link).
- **Payments / adjustments:** manual, admin only (`recordSettlement`); each kind touches exactly one account:

  | Kind | Account | Effect |
  |---|---|---|
  | Payment made to owner | PAYABLE | DECREASE |
  | Payment received from owner | RECEIVABLE | DECREASE |
  | Adjustment — increase payable | PAYABLE | INCREASE |
  | Adjustment — decrease payable | PAYABLE | DECREASE |
  | Adjustment — increase receivable | RECEIVABLE | INCREASE |
  | Adjustment — decrease receivable | RECEIVABLE | DECREASE |

  Each settlement records amount, date, payment reference, notes and actor plus an audit row; the form generates an
  idempotency key per instance so a double submit records one entry.

## 4. Where it is recorded

`fulfillment.shipFulfillment` and `fulfillment.recordExternalShipment` call `finance.recordShipmentFinancials(tx,
shipmentId, actorId)` after the SHIP ledger rows and before the integration hooks: 3PL product value + charges for
3PL clients, charges only for vendors. Vendor payables come from `finance.createVendorPayable` (Admin → Finance →
vendor → "Create payable from received inventory"). Returns, cancellations after shipping and storage periods are
**not** ledgered automatically (record an adjustment when needed).

## 5. Owner isolation

Every read goes through an `OwnerScope` derived from the session (`customerScopeFor(user)`): staff → any owner named
in the admin URL; portal users → pinned to their own `ownerId`, and any owner id they might send is ignored
(`scopedOwnerId`). Writes (rules, payables, settlements) are ADMIN-only server actions. Vendors and 3PL clients see
only their own balances, ledger, charges and (vendors) gross margin.

## 6. Historical data

No backfill. Orders shipped before 2026-09-16 have no ledger entries and no charges; their owners start at zero on
both accounts and everything else about those orders keeps working. Entries written under the 2026-09-16 morning
rules (vendor "wholesale value" at shipment) were converted by migration `20260916150000_finance_accounts` into
account + effect form — the one row that existed was a charge. If an opening balance is needed, record it as an
authorised adjustment with a reference — never fabricate per-order history.

## 7. Screens

- Admin → Settings → **Operational charges**: rules table (activate / deactivate / edit / delete-if-unused), rule form.
- Admin → **Finance**: every owner's payable and receivable (separate columns and gross totals); owner page with the
  two-sided balance card, payment / adjustment form, ledger and charges; vendors additionally get "Create payable from
  received inventory" (received / allocated / remaining per line, historical unit cost) and the gross-margin card.
- Admin vendor / 3PL profile: balance card → owner ledger. Admin dashboard: payable-to-owners / receivable-from-owners
  totals (ADMIN only).
- Vendor / 3PL portal: **Finance** tab (two-sided balance, ledger, charges; vendors also gross margin; read-only) and a
  compact two-sided balance card on the overview.
- Owner form: "Apply operational charges" switch.

## 8. Deferred

Shopify payment-status sync, invoices / statements, returns reversing wholesale value, storage-period charges,
Excel/PDF export of the ledger, accounting-software integration layer (spec §49) — all later decisions.

## 9. Tests

`npm run e2e:finance -- http://localhost:3100 vendor3pl@gmail.com` (in-process + HTTP; see QA-MASTER §1).
