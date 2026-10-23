# Runbook — local setup, environment, deployment, operations

Updated: 2026-09-05 (Phase 5)

---

## 1. Prerequisites

- Node.js **24.x** (pinned in `package.json` engines — required for the firebase-admin → jwks-rsa → jose chain, D-039), npm
- A Neon PostgreSQL database (or any PostgreSQL 14+)
- Firebase project with **Email/Password** sign-in enabled
- Firebase Admin SDK service-account key (server-side only)

## 2. Local setup

```bash
git clone https://github.com/V3PL/v3pl.git
cd v3pl
npm install
cp .env.example .env.local          # then fill in the values below
npx prisma generate                 # generates the client into src/generated/prisma (gitignored)
npx prisma migrate deploy           # applies prisma/migrations to the database in DIRECT_URL
npm run seed:admin -- admin@company.com "Admin Name"
npm run dev                         # http://localhost:3000
```

## 3. Environment variables

All variables are listed in [.env.example](../.env.example). Real values live only in
`.env.local` (development) and Vercel → Project → Environment Variables (production).

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | app (Prisma, pooled) | Neon: the `-pooler` connection string |
| `DIRECT_URL` | `prisma migrate` | Neon: the direct (non-pooled) string. Falls back to `DATABASE_URL` |
| `NEXT_PUBLIC_FIREBASE_API_KEY` / `_AUTH_DOMAIN` / `_PROJECT_ID` / `_APP_ID` | browser sign-in | Firebase Console → Project settings → Your apps → Web app → SDK config |
| `FIREBASE_ADMIN_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` | server token verification, session cookies, user admin | From the service-account JSON. Paste the private key with `\n` escapes on one line |
| `NEXT_PUBLIC_APP_URL` | optional override for `appUrl()` | **Leave unset on Vercel** — the origin is derived from `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` (D-042). Set locally or for self-hosting. Code must call `appUrl()` from `src/lib/env.ts`, never read the variable directly |
| `CLOUDINARY_*` | Phase 3 | |
| `SHOPIFY_*`, `CRON_SECRET` | Phase 7 (Shopify session) | see docs/shopify-setup.md |

The server validates its variables on first use (`src/lib/env.ts`) and fails with a
readable list of what is missing.

## 4. Firebase setup (one time)

1. Firebase Console → **Authentication → Sign-in method** → enable **Email/Password**. Do not enable
   any self-service sign-up UI; the platform has no registration screen.
2. **Authentication → Users → Add user** → create the first administrator (email + password).
3. **Project settings → Service accounts → Generate new private key** → save the JSON outside the
   repository. Copy `project_id`, `client_email`, `private_key` into `.env.local`.
   If the Admin SDK reports `invalid_grant: account not found`, the key belongs to a deleted
   service account — generate a new one.
4. **Project settings → Your apps → Add app → Web** (if none exists) → copy the SDK config values
   into the `NEXT_PUBLIC_FIREBASE_*` variables.
5. Run `npm run seed:admin -- <admin email> "<name>"` to link that Firebase user to a platform
   `User` row with role `ADMIN`. Every other account is created later from the admin UI (Phase 2).

## 5. Database & migrations

- Schema: `prisma/schema.prisma`. Config: `prisma.config.ts` (Prisma 7; loads `.env.local` then `.env`).
- Create a migration during development: `npx prisma migrate dev --name <change>` (uses `DIRECT_URL`).
- Apply migrations anywhere (CI, production): `npx prisma migrate deploy`.
- Never edit the production schema by hand (spec §59). Commit before major migrations.
- Backups/restore: see [backups.md](backups.md).

## 6. Authentication model (D-033)

```text
Browser: Firebase signInWithEmailAndPassword → ID token (in-memory only, then signed out)
       → POST /api/auth/session { idToken, audience }
Server:  verify ID token (Admin SDK, must be < 5 min old)
       → User row by firebaseUid must exist and be ACTIVE (no auto-provisioning)
       → role must match the login screen (/admin = staff, /user = vendor/3PL)
       → mint Firebase session cookie (httpOnly, secure, SameSite=Lax, 5 days)
Every request: proxy redirects cookie-less requests; the protected layout verifies the cookie
       signature and re-reads User.status from the database → DISABLED/BANNED lose access at once.
Sign out: DELETE /api/auth/session clears the cookie.
```

Guards live in `src/server/auth/guards.ts`: `requireStaff`, `requireRole`, `requirePortalUser`,
`requirePortalRole`, and `authorizeApi` for Route Handlers.

## 7. Verification checklist (Phases 1–5)

| Check | How |
|---|---|
| Dependencies install | `npm install` |
| TypeScript | `npm run typecheck` |
| Lint | `npm run lint` |
| Prisma schema valid | `npm run prisma:validate` |
| Migration applies | `npx prisma migrate deploy` against a fresh database |
| Build | `npm run build` |
| Admin login | `/admin/login` with the seeded admin → lands on `/admin` |
| Wrong-portal login | Admin at `/user/login` → refused with a link to `/admin/login` |
| Unauthenticated access | `/admin` without cookie → redirected to `/admin/login`; `/portal/vendor` → `/user/login` |
| Disabled account | Set `User.status = DISABLED` → next request is signed out |
| Unknown Firebase user | Firebase account without a `User` row → "not linked to a platform account" |
| **Phase 2 end-to-end run** | Same server: `npm run e2e:phase2 -- http://localhost:3100 <admin email>` — creates temporary vendors/3PL client/users (real Firebase accounts), verifies isolation, status changes, delete/tombstone, then removes everything it created (29 checks) |
| **Phase 3 end-to-end run** | Same server: `npm run e2e:phase3 -- http://localhost:3100 <admin email>` — creates temporary vendors, warehouses, products; exercises receiving, reservations, ship, adjustments, moves, transfers (complete/cancel), 10 concurrent reservations, ledger consistency, owner-scoped portal pages; removes everything it created |
| **Phase 4 end-to-end run** | Same server: `npm run e2e:phase4 -- http://localhost:3100 <admin email>` — orders (multi-owner, idempotency, concurrency), pick/pack/ship (partial, multiple), cancel, returns, Shopify service contract, CSV import/export/round-trip, import jobs, portal isolation; removes everything it created (61 checks) |
| **Phase 5 end-to-end run** | Same server: `npm run e2e:phase5 -- http://localhost:3100 <admin email>` — dashboards, reports, filters, CSV permissions/content, pagination, roles, empty states, deactivated owners; removes everything it created |
| **Automated end-to-end run** | `npm run build && npm run start -- -p 3100` then `npm run e2e:auth -- http://localhost:3100 <admin email>` — mints a custom token for the admin and exercises login, guards, disable/reactivate, sign-out and rejection paths (19 checks) |

## 8. Deployment (GitHub → Vercel, Hobby)

- Import the GitHub repository in Vercel. Framework: Next.js. Build command: `npm run build`
  (runs `prisma generate` first). Install command: `npm install`. Node version comes from
  `package.json` engines (`24.x`); do not select an older runtime in project settings.
- After every deploy check `GET https://<deployment>/api/health` → `status: "ok"`, `database: "connected"`, `checks.firebaseAdmin.ok: true`, `checks.serverEnv.problems: []`. With `Authorization: Bearer <CRON_SECRET>` the response adds full diagnostics (D-040).
  A `node` value below 22.12 means the runtime cannot load Firebase Admin (`ERR_REQUIRE_ESM`, D-039).
- Add every variable from section 3 for Production (and Preview if used). Mark secrets as sensitive.
- Run `npx prisma migrate deploy` against the production database **before** the first deploy that
  needs a new migration (locally with `DIRECT_URL` pointing at production, or via a CI step).
- After the first deployment, give the production URL to the Shopify session for
  [shopify-setup.md](shopify-setup.md) Part B.
- Vercel Hobby is for the build/testing phase only (D-031); review hosting before commercial go-live.

## 9. Operations

| Task | Command / place |
|---|---|
| Bootstrap or promote an admin | `npm run seed:admin -- <email> "<name>" [--force]` |
| Inspect data | `npm run prisma:studio` (development only) |
| Check DB connectivity / runtime | `GET /api/health` (public, no secrets) or Admin dashboard → System status card |
| Create vendors / 3PL clients | Admin → Vendors / 3PL Clients → New. Code must be unique (used in imports/reports) |
| Add a portal user | Owner detail page → Add user (creates the Firebase account; share the initial password securely) |
| Add staff | Admin → Users → New staff user |
| Disable / ban / reactivate / delete a user | Users table → ⋯ menu. Disable/ban signs the user out immediately (DB status + Firebase disabled + tokens revoked). Delete is permanent (D-037) |
| Reset a password | Users table → ⋯ → Reset password (sets a new password, signs out existing sessions) |
| Deactivate a vendor / 3PL client | Owner detail → Deactivate: all its portal users lose access at once; history kept |
| Create a warehouse / locations | Admin → Warehouses → New (creates `MAIN`); detail page → Add location (zone/rack/shelf/bin) |
| Add products & SKUs | Admin → Products → New: choose owner, one row per SKU. SKUs are unique platform-wide; owner is locked once stock exists |
| Receive stock | Admin or Warehouse → Inventory → Receive (or Receiving → Receive stock): owner, warehouse, lines with location. Posted immediately |
| Correct stock (count, damage, missing) | Inventory → Adjust: type + quantity + **reason**; before/after recorded in the ledger. Reserved units cannot be removed |
| Move stock inside a warehouse | Inventory → Move (location → location) |
| Transfer between warehouses | Transfers → New (stock leaves the source at once); destination → Receive at destination; or Cancel (stock returns to source) |
| Investigate any stock figure | Inventory → Movements (filters by SKU, type, warehouse, owner) — the ledger is the source of truth |
| Create an order | Admin/Sales → Orders → New order: ship-to, warehouse, SKUs (any owners), reserve. 3PL clients: portal → Orders → New order (own SKUs) |
| Import orders from CSV | Admin/Sales → Imports & Exports → upload (Shopify export or V3PL export layout) → preview → fix errors (download failed rows) → Import. Format: [csv-orders.md](csv-orders.md) |
| Export orders | Orders → Export (filters) → CSV; portals export their own scope |
| Pick / pack / ship | Order detail → Start picking (choose lines for partial shipments) → Mark packed → Ship (carrier, tracking). Fulfillment page = work queue |
| Handle "needs attention" | Order detail banner names the short SKUs; receive stock, then Reserve now; Clear attention when resolved |
| Cancel an order | Order detail → Cancel order (releases reservations; shipped units stay shipped) |
| Returns | Order detail → Receive return (no stock effect) → Inspect: sellable → restocked at a location; damaged → written off in the ledger |
| Reports (admin) | Admin → Reports: SKU activity, orders summary, shipments, returns, inventory snapshot; owner/warehouse/period filters; Download CSV |
| Reports (portals) | Portal → Reports / Shipments / Returns tabs; always limited to the signed-in business |
| Check ledger consistency for a SKU | `verifyLedgerConsistency(variantId, warehouseId)` in `src/server/services/inventory.ts` (used by the e2e script) |

## 10. Troubleshooting

- **"Invalid server environment"** on start → a required variable is missing in `.env.local`.
- **"Firebase is not configured for this environment"** on the login page → `NEXT_PUBLIC_FIREBASE_*`
  missing; restart `next dev` after editing `.env.local` (public vars are inlined at build).
- **`invalid_grant: account not found`** → service-account key is for a deleted account; regenerate.
- **HTTP 500 on every page, logs show `ERR_REQUIRE_ESM … jose … jwks-rsa`** → the `jose` v4 override for `jwks-rsa` (D-041) is missing from `package.json`/lockfile, or Node < 22.12 is deployed. `/api/health` → `checks.firebaseAdmin.code` shows the inner error code.
- **`/api/health` shows `checks.serverEnv.problems`** → the listed variable names are missing/malformed in Vercel (values are never shown). `checks.appUrl` shows the resolved canonical URL and which variable it came from.
- **Prisma `P1001` cannot reach database** → check `DATABASE_URL`, Neon project awake, `sslmode=require`.
- **Login returns "not linked to a platform account"** → run the seed script for that email.
