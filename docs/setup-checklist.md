# Setup / Credentials Checklist

What is needed, when, and current status. Secrets go only into `.env.local`
(development) and Vercel environment variables (production) — never into git.

---

## Infrastructure status — as of 2026-09-04 (after the infrastructure reset, D-036)

| # | Item | Details | Status |
|---|---|---|---|
| 1 | **Firebase project** | `v3plxvs` (Google account `vendor3pl@gmail.com`) | ☑ |
| 2 | **Firebase web config** | `NEXT_PUBLIC_FIREBASE_API_KEY` / `_AUTH_DOMAIN` / `_PROJECT_ID` / `_APP_ID` in `.env.local` (storage bucket, sender id, measurement id are not used by the app) | ☑ |
| 3 | **Firebase Auth** | Email/Password user `vendor3pl@gmail.com` exists and signs in | ☑ verified |
| 4 | **Firebase Admin service account** | `~/Developer/v3plxvs-firebase-adminsdk-fbsvc-46ccd00938.json` → `FIREBASE_ADMIN_*` in `.env.local`; verified against project `v3plxvs` | ☑ verified |
| 5 | **First admin account** | `vendor3pl@gmail.com` linked as `ADMIN` via `seed:admin` | ☑ done |
| 6 | **Neon PostgreSQL** | Unchanged database. `DATABASE_URL` (pooled) + `DIRECT_URL` (direct) in `.env.local`; migration `20260902000000_init` applied | ☑ verified |
| 7 | **GitHub repository** | `V3PL/v3pl`. Local `origin` updated. **Push blocked:** the V3PL organisation rejects fine-grained PATs with a lifetime > 366 days, and the token stored on this machine (`github.com/settings/personal-access-tokens/12134215`) exceeds that. Fix: create a fine-grained token with resource owner **V3PL** and lifetime ≤ 366 days (or a classic token with `repo` scope), then update the macOS keychain entry for `github.com` | ☐ **token change needed** |
| 8 | **Vercel** | Team `v3pl` ready. Import `V3PL/v3pl` after the first push; env vars per [runbook.md](runbook.md) §8 | ☐ after push |
| 9 | **Cloudinary** | Cloud `v3pl`; `CLOUDINARY_*` in `.env.local` | ☑ (used from Phase 3) |
| 10 | **Shopify app** | Unchanged; `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` in `.env.local` for the Shopify session | ☑ |

## Deferred — do NOT send yet

| Item | Needed at |
|---|---|
| ~~Shopify per-store custom-app tokens~~ — replaced by the single public OAuth app (D-021). No per-store tokens are ever pasted; stores connect from the V3PL UI. Scopes (D-023): `read_orders, write_merchant_managed_fulfillment_orders, read_fulfillments, read_products, write_inventory, read_locations`. App **Client ID / Client secret** go into `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` only. Full step list: [shopify-setup.md](shopify-setup.md). | Dev Dashboard Part A now; Part B after first deploy |
| EmailJS / email configuration (manual email feature only) | when the manual email feature is built (Phase 5/6) |
| Accounting software anything | not in initial scope — abstraction only |

## Optional but helpful (any time)

- Sample/real product list (names, SKUs, categories, prices) for realistic Phase 3 testing
- Real-ish CSV order sample matching how bulk orders arrive today
- Warehouse list + location naming convention actually used (zones/racks/shelves/bins)
- Company logo / brand color for the UI
- List of initial staff users (name, email, role)

## Environment variable reference

See [.env.example](../.env.example) — the committed template listing every variable
the application will use.
