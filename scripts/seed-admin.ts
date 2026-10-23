/**
 * Bootstrap (or promote) the first ADMIN platform user.
 *
 * Admin accounts are created manually in Firebase Console → Authentication
 * (spec §7). This script links that Firebase account to a platform User row.
 *
 * Usage:
 *   npm run seed:admin -- admin@company.com "Full Name"
 *   npm run seed:admin -- admin@company.com "Full Name" --force   # promote an existing non-admin row
 *
 * Requires .env.local with DATABASE_URL and FIREBASE_ADMIN_* (see .env.example).
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

async function main() {
  const [email, nameArg, ...flags] = process.argv.slice(2);
  const force = flags.includes("--force");

  if (!email || !email.includes("@")) {
    console.error('Usage: npm run seed:admin -- <email> "<Full Name>" [--force]');
    process.exit(1);
  }

  // Imported lazily so env is loaded first.
  const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
  const { prisma } = await import("../src/lib/prisma");
  const { recordAudit } = await import("../src/server/services/audit");

  let firebaseUser;
  try {
    firebaseUser = await firebaseAdminAuth().getUserByEmail(email);
  } catch {
    console.error(
      `No Firebase Authentication user found for ${email}.\n` +
        "Create it first in Firebase Console → Authentication → Add user, then re-run this script.",
    );
    process.exit(1);
  }

  const name = nameArg?.trim() || firebaseUser.displayName || email.split("@")[0];

  const existing = await prisma.user.findFirst({
    where: { OR: [{ firebaseUid: firebaseUser.uid }, { email: email.toLowerCase() }] },
  });

  if (existing && existing.role === "ADMIN" && existing.status === "ACTIVE") {
    console.log(`Already an active ADMIN: ${existing.email} (${existing.id}). Nothing to do.`);
    return;
  }

  if (existing && !force) {
    console.error(
      `A user row already exists for ${existing.email} with role ${existing.role} / status ${existing.status}.\n` +
        "Re-run with --force to promote it to an active ADMIN.",
    );
    process.exit(1);
  }

  const user = await prisma.$transaction(async (tx) => {
    const saved = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { firebaseUid: firebaseUser.uid, role: "ADMIN", status: "ACTIVE", name },
        })
      : await tx.user.create({
          data: {
            firebaseUid: firebaseUser.uid,
            email: email.toLowerCase(),
            name,
            role: "ADMIN",
            status: "ACTIVE",
          },
        });

    await recordAudit(
      {
        userId: null,
        action: "user.seeded",
        entityType: "User",
        entityId: saved.id,
        oldValues: existing ? { role: existing.role, status: existing.status } : null,
        newValues: { role: saved.role, status: saved.status, email: saved.email },
        metadata: { source: "scripts/seed-admin.ts" },
      },
      tx,
    );
    return saved;
  });

  console.log(`${existing ? "Promoted" : "Created"} ADMIN user ${user.email} (id ${user.id}, firebaseUid ${user.firebaseUid}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect().catch(() => undefined);
  });
