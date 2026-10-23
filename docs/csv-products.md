# Product CSV — import & export format (D-053)

V3PL reads and writes product CSV files in **Shopify's product-export layout**, so a catalogue can be
maintained once and moved between Shopify and V3PL without retyping. The V3PL model is the truth;
V3PL-only values travel in explicitly named `V3PL …` columns and Shopify-only columns are ignored.

## Layout

- One row per **variant**. Rows with the same `Handle` form **one product** with several variants —
  they are never turned into separate products.
- Like Shopify's export, the **first row of a product carries the product fields** (`Title`,
  `Status`, `Option1 Name` …); later rows repeat only `Handle`, the option *values* and the
  `Variant …` columns. On import the first non-empty value in the group is used, so files that
  repeat product fields on every row also work.
- A simple product (no options) is written the Shopify way: `Option1 Name = Title`,
  `Option1 Value = Default Title`.
- `Variant SKU` is **required on every row** and stays **globally unique**: it is the operational
  identity for inventory, orders, fulfilment, receiving, transfers and Shopify mapping.
- UTF-8 with BOM, CRLF, RFC 4180 quoting; headers matched case- and whitespace-insensitively.

## Import: `Upload → Detect format → Preview → Validate → Row-level errors → Confirm → Results`

Admin → Imports & exports → *Import products from CSV*. Options: **owner** for rows without a
`V3PL Owner Code`, and an optional **warehouse** that receives `Variant Inventory Qty` for *new* SKUs.

| Column | Required | Mapped to | Rules |
|---|---|---|---|
| `Handle` | **yes** | grouping key | Rows sharing a handle = one product |
| `Title` | first row | `Product.name` | Required on the first row of each handle |
| `Option1/2/3 Name` | no | `Product.options` | Up to 3; `Title` + `Default Title` = simple product |
| `Option1/2/3 Value` | when options | `ProductVariant.optionValues` | One value per option; combinations unique within the product; label = values joined with ` / ` |
| `Variant SKU` | **yes** | `ProductVariant.sku` | Uppercased, `A-Z 0-9 . _ -`, 2–64 chars, unique across the platform and within the file |
| `Variant Price` | no | `price` (retail) | Decimal, optional `$` |
| `Variant Grams` | no | `weightGrams` | Whole grams (a trailing `.0` is accepted) |
| `V3PL Wholesale Price` | no | `wholesalePrice` | Decimal; owner valuation, never used on customer orders |
| `V3PL Length (cm)`, `V3PL Width (cm)`, `V3PL Height (cm)` | no | `lengthCm` / `widthCm` / `heightCm` | Centimetres, up to 2 decimals |
| `Variant Barcode` | no | `barcode` | Optional; no spaces, ≤ 64 chars; **globally unique** — duplicates inside the file or a barcode already used by another SKU error the row (D-059) |
| `Cost per item` (Shopify) | no | `cost` | Used when `V3PL Cost` is absent |
| Image-only rows (`Handle` + `Image Src` / `Image Position`, nothing else) | — | recognised as **media rows** | Shopify lists extra product images as their own rows; they are not variants and produce no SKU/option errors (counted as "media rows" in the preview) |
| `Variant Inventory Qty` | no | initial stock | Whole number ≥ 0. **New, active SKUs only**, booked as a *receipt* into the chosen warehouse's default location through the inventory service. Existing SKUs keep their stock and archived SKUs receive nothing (both noted in the preview) |
| `Status` | no | `Product.status` | `active` / `draft` → ACTIVE (draft noted), `archived` → ARCHIVED |
| `V3PL Owner Code` | no | owner | Wins over the owner chosen in the form; must exist and be active |
| `V3PL Product Status`, `V3PL Variant Status` | no | exact V3PL values | Override `Status` |
| `V3PL Cost` | no | `cost` | Decimal |
| `Vendor`, `Body (HTML)`, `Tags`, `Type`, `Published`, `Image …`, `Variant Grams/Tracker/Policy/Fulfillment Service/Compare At/Taxable/Requires Shipping` | — | **ignored** | Listed as ignored columns in the preview |

### Existing SKUs

- A SKU that already exists is **updated** (option values, price, barcode, statuses) and its product's
  title/status/options are taken from the file. New SKUs in the same handle are added to that product.
- All existing SKUs of one handle must belong to the **same** V3PL product and the **same owner**;
  otherwise the group errors ("SKUs are unique across the platform").
- Changing a product's option names requires every variant of that product to be in the file
  (so no variant is left with mismatched values).

### Errors

A product with any error is skipped whole — nothing is imported partially. The preview lists every
error per row/product; the **failed-rows CSV** (original columns + `Error`) can be fixed and
re-uploaded. Confirm re-validates against the current catalogue before writing.

## Export

Admin → Products → *Export* (honours the list filters) or `GET /api/products/export?ownerId=&status=&q=`.
Portal users get their own owner's products only. One row per variant, Shopify columns first, then
`V3PL Owner Code`, `V3PL Owner`, `V3PL Product Status`, `V3PL Variant Status`, `V3PL Wholesale Price`, `V3PL Cost`,
`V3PL Length (cm)`, `V3PL Width (cm)`, `V3PL Height (cm)`, `V3PL On Hand`, `V3PL Reserved`, `V3PL Available`;
`Variant Grams` carries the weight. `Variant Inventory Qty` = available across all
warehouses (never negative). `Handle` is a slug of the title (suffixed when two products share one).

**Round trip:** an exported file re-imports without errors as *updates* (owner from the code column,
SKUs matched, options preserved). Fixed Shopify values in the export: `Variant Inventory Tracker =
shopify`, `Variant Inventory Policy = deny`, `Variant Fulfillment Service = manual`, `Variant
Requires Shipping = TRUE`, `Variant Taxable = TRUE`.
