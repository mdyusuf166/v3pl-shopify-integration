# Order CSV — import & export format (D-046)

V3PL reads and writes order CSV files in a **Shopify-compatible layout** so people who know
Shopify's order export can work with V3PL files immediately. The V3PL data model is the truth;
where Shopify's vocabulary differs, the mapping below is applied and V3PL's own values are
carried in explicitly named `V3PL …` columns.

## Layout

- One row per **line item**. Rows with the same `Name` form one order.
- Like Shopify's export, the **first row of an order carries the order-level fields**
  (customer, totals, address…); later rows of the same order repeat only `Name` and the
  `Lineitem …` columns. On import, order-level fields are taken from the first non-empty value
  in the group, so files that repeat the header fields on every row also work.
- UTF-8 with BOM, CRLF line endings, RFC 4180 quoting — opens cleanly in Excel / Google Sheets.
- Headers are matched case- and whitespace-insensitively (`lineitem sku` ≙ `Lineitem sku`).

## Import: `Upload → Detect format → Preview → Validate → Row-level errors → Confirm → Results`

| Column | Required | Mapped to | Rules |
|---|---|---|---|
| `Name` | **yes** | `Order.sourceRef` (grouping key) | Unique per source (`CSV_IMPORT`). An existing order with the same Name = **duplicate → skipped** |
| `Lineitem sku` | **yes** | `OrderItem.sku` → `ProductVariant` → **owner** | Must exist and be active in the V3PL catalogue. Never matched by title |
| `Lineitem quantity` | **yes** | `OrderItem.quantity` | Whole number ≥ 1 |
| `Lineitem price`, `Lineitem discount` | no | `unitPrice`, `discount` | Decimal, optional `$` |
| `Lineitem name` | no | `title` snapshot | Falls back to the catalogue product name |
| `Lineitem requires shipping` | no | `requiresShipping` | `true/false`, default true |
| `Email`, `Phone` | no | `customerEmail`, `customerPhone` | |
| `Shipping Name/Company/Address1/Address2/City/Province/Zip/Country/Phone` | no | ship-to snapshot | `Shipping Street` is split into Address1/Address2 when Address1 is absent |
| `Currency`, `Subtotal`, `Shipping`, `Taxes`, `Total`, `Discount Amount`, `Shipping Method` | no | order totals | Decimal; informational (V3PL does no accounting) |
| `Financial Status` (Shopify) | no | `financialStatus` | `paid→PAID`, `partially_paid→PARTIALLY_PAID`, `pending/authorized/unpaid/refunded/voided→OUTSTANDING`, blank→`NOT_INVOICED`. **`V3PL Financial Status` wins when present** |
| `Created at` | no | `placedAt` | ISO or Excel date |
| `Notes`, `Tags` | no | `notes`, `tags` | |
| `V3PL Warehouse` | no | `warehouseId` (by code) | Falls back to the import's default warehouse |
| `V3PL Owner Code` | no | validation only | Must match the SKU's owner, otherwise the row errors |
| `V3PL Financial Status`, `V3PL Invoice Reference` | no | exact V3PL values | |
| Any other column (e.g. Shopify `Billing …`, `Risk Level`, `Id`, `Payment …`) | — | **ignored** | Listed as "ignored columns" in the preview. Not stored (spec §25/§37) |

**Fulfillment / shipment columns are never imported** — fulfilment state is created by warehouse
activity in V3PL, not by a file.

Validation is row-level and order-level. **An order with any failing row is skipped entirely**
(never a partial order). The preview shows every error next to its row/order; the failed-rows
report is the original rows + an `Error` column, ready to fix and re-upload. Confirm re-runs
duplicate detection so an order imported in between is not created twice. Each order is created
in its own transaction; a failure in one does not roll back the others.

Reservation on import follows D-028: stock is reserved per line when available; a short line
leaves the order `needsAttention` with the SKU and quantity, never negative stock.

## Export: `Filter → Export → CSV`

`GET /api/orders/export` (staff) or the portal export button (always scoped to the signed-in
owner). Filters: order status, fulfillment status, shipment status, source, owner, warehouse,
Shopify store, placed-at date range. Up to 5,000 orders per file.

Columns, in order: all Shopify columns above (with Shopify vocabulary: `Financial Status` =
`paid|partially_paid|pending`, `Fulfillment Status` = `fulfilled|partial|unfulfilled`,
`Lineitem fulfillment status` = `fulfilled|partial|pending`, `Vendor` = owner business name,
`Source` = lower-case V3PL source), then the V3PL columns:

`V3PL Order Number`, `V3PL Order Status`, `V3PL Fulfillment Status`, `V3PL Financial Status`,
`V3PL Invoice Reference`, `V3PL Needs Attention`, `V3PL Warehouse`, `V3PL Owner Code`,
`V3PL Line Reserved`, `V3PL Line Shipped`, `V3PL Line Returned`, `V3PL Line Cancelled`,
`V3PL Shipment Status`, `V3PL Carrier`, `V3PL Tracking Number`, `V3PL Tracking URL`,
`V3PL Shipped At`, `V3PL Shopify Store`, `V3PL Shopify Order Id`.

Manual, portal, CSV and Shopify orders are all exported the same way.

## Round trip

An exported file re-imports as new orders when `Name` values are changed (otherwise every order
is detected as a duplicate). All ship-to fields, totals, notes, tags, line quantities, prices and
the V3PL financial status survive the round trip. Fulfilment/shipment columns are informational
on export and ignored on import by design.

## Known limits

- No billing address (not stored by V3PL).
- `Id` (Shopify numeric order id) is not an import key — CSV import is not Shopify sync. Real
  Shopify orders arrive through the Shopify integration (Phase 7) keyed by store + order id.
- Line-level tax is not imported (order-level `Taxes` is).
