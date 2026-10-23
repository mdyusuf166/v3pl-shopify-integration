# Shopify Setup Checklist (Dev Dashboard, development store, credentials)

Companion to [shopify-integration.md](shopify-integration.md). This is the operational
step-by-step list. Tick items as they are completed and record dates.

Rules: nothing here is done automatically by the AI sessions. Distribution is **Public** and
stays Public. Live stores are **not** connected until Part D is complete.

---

## Part A — Do now (no deployment URL needed)

| # | Step | Where | Status |
|---|---|---|---|
| A1 | Confirm the app is **not embedded**. In the app's current configuration set *Embedded app* = off / uncheck “Embed app in Shopify admin”. | Dev Dashboard → your app → Versions → configuration | ☐ |
| A2′ | 2026-09-15: version `v3plmxvs-platform-4` (adds `write_orders`) was created unreleased with `npx @shopify/cli@latest app deploy --no-release`. **Release it** (Dev Dashboard → Versions), update Vercel `SHOPIFY_SCOPES`, then Reconnect each store. | Dev Dashboard, Vercel, V3PL Admin | ☐ |
| A2″ | 2026-09-22 (D-065): `read_customers` added to `shopify.app.toml` for the customer directory sync; version **`v3plmxvs-platform-5`** was created unreleased with `npx @shopify/cli@latest app deploy --no-release`. **Release it** (Dev Dashboard → Versions), add `read_customers` to Vercel `SHOPIFY_SCOPES` (or remove the variable to use the code default), apply migration `20260922120000_shopify_customer_sync` to production (`npx prisma migrate deploy`) **before** deploying, then Reconnect each store and confirm *Permissions granted* lists `read_customers`. | Dev Dashboard, Vercel, Neon, V3PL Admin | ☐ |\n| A2 | Set **Access scopes** exactly to: `read_orders, write_orders, write_merchant_managed_fulfillment_orders, read_fulfillments, read_products, write_inventory, read_locations, read_customers` (`write_orders` added 2026-09-15 for manual V3PL orders → Shopify, D-062: deploy a new app version from `shopify.app.toml`, release it, set `SHOPIFY_SCOPES` on Vercel to the same list, then **Reconnect** every connected store so the merchant approves the new permission) | same | ☐ |
| A3 | Set **Webhooks API version** = `2026-07` | same | ☐ |
| A4 | Leave App URL as Shopify's default placeholder (`https://shopify.dev/apps/default-app-home`) and Redirect URLs empty **until Part B**. Release this version (a released version is required before any install). | same → Release | ☐ |
| A5 | **Protected customer data**: open the request form, select *Protected customer data*, reason: *order fulfilment and shipping by a third-party logistics platform*. Then request the fields **Name, Address, Email, Phone** with reasons (ship-to contact, delivery notifications by carrier). Complete the data-protection questionnaire and **Save**. Do **not** submit for review yet — saving is enough for development stores. | Dev Dashboard → app → API access / Protected customer data | ☐ |
| A6 | Copy **Client ID** and **Client secret**. Put them only in the places listed in Part E. Never in chat, source files or git. | Dev Dashboard → app → Settings | ☐ |
| A7 | Create the **development store** (Part C). | Dev Dashboard / Partner Dashboard → Stores | ☐ |

## Part B — After the first Vercel production deployment exists

The core session deploys the app. When the real production URL is known (for example
`https://<project>.vercel.app`), substitute it below. Do not use preview URLs: they change per
deploy and are behind Vercel Deployment Protection.

| # | Step | Value | Status |
|---|---|---|---|
| B1 | **App URL** | `https://<PROD-URL>/admin/settings/shopify` | ☐ |
| B2 | **Allowed redirection URL(s)** | `https://<PROD-URL>/api/shopify/oauth/callback` | ☐ |
| B3 | **Webhook subscriptions** (app-specific), all to `https://<PROD-URL>/api/webhooks/shopify` | `orders/create`, `orders/updated`, `orders/edited`, `orders/cancelled`, `refunds/create`, `fulfillments/create`, `fulfillments/update`, `products/update`, `app/uninstalled` | ☐ |
| B4 | **Compliance webhooks** to `https://<PROD-URL>/api/webhooks/shopify/compliance` | `customers/data_request`, `customers/redact`, `shop/redact` | ☐ |
| B5 | Release the new version. | | ☐ |
| B6 | Set Vercel env vars (Part E). Redeploy. | | ☐ |
| B7 | In V3PL: `Settings → Shopify Stores → Add Shopify Store` → enter the dev store domain → approve the scopes in Shopify → store shows **Connected**. | V3PL Admin | ☐ |

Later, when the client adds a custom domain, B1–B4 are updated to the custom domain and a new
version released. Existing store connections keep working (tokens are per store, not per URL).

## Part C — Development store for testing

| # | Step | Status |
|---|---|---|
| C1 | Dev Dashboard / Partner Dashboard → **Stores → Add store → Create development store**. Purpose: *Create a store to test and build*. Name e.g. `v3pl-dev`. Choose **Start with test data** (sample products/orders make testing faster). Leave developer preview off. | ☐ |
| C2 | Open the store admin → **Settings → Locations**. Note the default location name. Add a second location (e.g. `Overflow`) so multi-location routing can be tested. | ☐ |
| C3 | **Settings → Payments**: enable the test gateway (*Shopify Payments test mode* or *(for testing) Bogus Gateway*) so orders can be paid. | ☐ |
| C4 | **Settings → Shipping and delivery**: make sure at least one shipping rate exists for the ship-to country. | ☐ |
| C5 | **Products**: create or edit products so their variant **SKUs match internal SKUs** exactly. Create at least: 3 SKUs owned by *Vendor A*, 2 by *Vendor B*, 1 by a *3PL client*, plus one product with **no SKU** and one with an **unknown SKU** (`XVS99999`) for failure tests. Set *Track quantity* on and *Inventory managed by* Shopify. | ☐ |
| C6 | **Online Store → Preferences**: note the storefront password so test checkouts can be placed from the storefront; alternatively create orders in **Orders → Create order → Mark as paid**. | ☐ |
| C7 | Optional second dev store `v3pl-dev-2` for the two-store tests (same SKUs, different order numbers). | ☐ |
| C8 | Record the store domains here: `__________.myshopify.com`, `__________.myshopify.com`. | ☐ |

Development stores: no app review needed, protected customer data available once A5 is saved,
free, orders can be deleted.

## Part D — Before connecting any live store

| # | Step | Status |
|---|---|---|
| D1 | Full test matrix passed on the dev store(s) ([shopify-integration.md](shopify-integration.md) §18). | ☐ |
| D2 | **Submit protected customer data request for review** (form from A5). | ☐ |
| D3 | Create the **App Store listing** (can be *unlisted*: visible only by direct link) with name, icon, short description, **privacy policy URL**, support contact. | ☐ |
| D4 | **Submit the app for review**. Shopify requires review before a public-distribution app can be installed on any non-development store, even unlisted. Review time is not guaranteed — start early. | ☐ |
| D5 | After approval, set listing visibility to *unlisted* if it should not be discoverable. | ☐ |
| D6 | Per live store: confirm which Shopify **location** the warehouse fulfils from; confirm no fulfilment-service app is assigned to the products. | ☐ |
| D7 | Per live store: connect via `Add Shopify Store` with `Import orders = on`, `Publish inventory = off`. Run *Sync products* → review UNMATCHED mappings → only then enable publishing after a reviewed reconciliation. | ☐ |

## Part E — Where each credential lives

| Credential | Local development | Production |
|---|---|---|
| Client ID | `.env.local` → `SHOPIFY_API_KEY` | Vercel → Project → Settings → Environment Variables → `SHOPIFY_API_KEY` (Production + Preview) |
| Client secret | `.env.local` → `SHOPIFY_API_SECRET` | Vercel env var `SHOPIFY_API_SECRET`, mark **Sensitive** |
| Token encryption key | `.env.local` → `SHOPIFY_TOKEN_ENCRYPTION_KEY` (generate: `openssl rand -base64 32`) | Vercel env var, **Sensitive**. Losing this key makes stored tokens unreadable → stores must reconnect. Keep a copy in the client's password manager. |
| Cron secret | `.env.local` → `CRON_SECRET` (any long random string) | Vercel env var, **Sensitive** |
| API version / scopes | `.env.local` → `SHOPIFY_API_VERSION`, `SHOPIFY_SCOPES` | Vercel env vars (not sensitive) |
| Per-store access/refresh tokens | never in env — encrypted in the `ShopifyStore` table | same |

`.env.local` is git-ignored. Only `.env.example` (placeholders) is committed.

## Part F — GitHub and Vercel (developer's accounts, free tier)

| # | Step | Owner | Status |
|---|---|---|---|
| F1 | Repository: **`github.com/v3plmxvs/vendor-3pl-platform`** (private). Branches: `main` (core session), `shopify/integration` (Shopify session, separate git worktree). | developer | ☑ 2026-09-02 |
| F2 | Create the Vercel project from that repository (Hobby). Production branch = `main`. Framework preset Next.js. Note the production URL `https://<project>.vercel.app` → this is the `<PROD-URL>` for Part B. | developer / core session | ☐ |
| F3 | Vercel → Project → Settings → Environment Variables: add every variable from Part E for **Production** (and Preview). | developer | ☐ |
| F4 | Vercel → Settings → Deployment Protection: leave Production public. Preview protection can stay on; Shopify is never pointed at previews. | developer | ☐ |
| F5 | Confirm Fluid compute is enabled (default for new projects) so `waitUntil` and the 300 s duration apply. | core session | ☐ |
| F6 | `vercel.json` cron entry for `/api/cron/shopify-daily` (once per day) — added by the Shopify session with the code. Vercel supplies `CRON_SECRET` as the bearer token automatically when the env var exists. | Shopify session | ☐ |

## Part G — Things we deliberately do NOT do

- Do not request `read_all_orders` unless the business confirms it needs orders older than 60 days.
- Do not request `write_products`, `read_customers`, `write_fulfillments`. (`write_orders` is requested since D-062 and used for `orderCreate` only — V3PL never edits or cancels Shopify orders.)
- Do not create one app per store to bypass review (against the Partner Program Agreement for a
  public app, and unnecessary).
- Do not install the app on a live store from the Dev Dashboard; installation always starts
  from V3PL (`Add Shopify Store`) so V3PL receives the tokens.
