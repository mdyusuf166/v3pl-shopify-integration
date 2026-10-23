# Backups & Recovery

Status: **plan only** — finalized once the PostgreSQL provider is confirmed (Phase 1),
tested with a real restore before final handover (Phase 9, spec §60).

## Plan (assuming Neon; adjusted if client chooses another provider)

- **Automatic backups:** provider-managed, continuous (point-in-time restore).
- **Retention:** provider default (Neon free tier ≈ 24h PITR window; document exact
  figure at setup — if longer retention is a business requirement, a paid tier or a
  scheduled `pg_dump` to client-owned storage will be proposed as a decision).
- **Restore process:** to be documented step-by-step at Phase 1 setup (branch/restore
  from timestamp → verify → repoint `DATABASE_URL`).
- **Emergency recovery:** documented runbook entry: who does what, in what order,
  including Vercel env repointing and post-restore ledger reconciliation check.
- **Restore test:** mandatory once before final handover; result recorded here with date.

## Also protected

- **Code:** GitHub (private, client-owned) — every phase checkpointed.
- **Secrets:** Vercel env vars + client's own secure storage (never only on one laptop).
- **Cloudinary assets:** remain in Cloudinary; DB stores public IDs so re-linking after
  a DB restore is automatic.
