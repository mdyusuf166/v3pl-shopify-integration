# Central Multi-Vendor Inventory + 3PL + Warehouse + Shopify Management Platform

Internal SaaS platform for managing multi-vendor inventory, 3PL client fulfillment,
multi-warehouse operations, orders, and multi-store Shopify synchronization.

## Source of Truth

- [PROJECT_MASTER_PROMPT.md](PROJECT_MASTER_PROMPT.md) — the full project specification
- [docs/DECISIONS.md](docs/DECISIONS.md) — every important business/architecture decision
- [docs/progress.md](docs/progress.md) — current project state

## Documentation

| Document | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Final architecture, system workflows, data flows |
| [docs/database.md](docs/database.md) | Database design / ERD plan |
| [docs/shopify-integration.md](docs/shopify-integration.md) | Shopify sync design (stores, orders, inventory, fulfillment, webhooks) |
| [docs/shopify-setup.md](docs/shopify-setup.md) | Shopify Dev Dashboard, development store and credentials checklist |
| [docs/core-requests.md](docs/core-requests.md) | Capabilities the Shopify session requests from the core session (R-1 …) |
| [docs/roadmap.md](docs/roadmap.md) | Development roadmap (15-day initial target) |
| [docs/setup-checklist.md](docs/setup-checklist.md) | Credentials / configuration checklist per phase |
| [docs/backups.md](docs/backups.md) | Backup, retention, and restore procedures |

## Stack

Next.js (App Router) · React · TypeScript · PostgreSQL · Prisma · Firebase Auth ·
Cloudinary · Tailwind CSS + shadcn/ui · Vercel

## Quick start

See [docs/runbook.md](docs/runbook.md) for full setup. In short:

```bash
npm install
cp .env.example .env.local        # fill in database + Firebase values
npx prisma generate
npx prisma migrate deploy
npm run seed:admin -- admin@company.com "Admin Name"
npm run dev
```

Staff sign in at `/admin`; vendors and 3PL clients at `/user`.

## Status

**Phase 1 — Core scaffold complete** (auth, roles, admin shell, database foundation).
Current state and open items: [docs/progress.md](docs/progress.md).
