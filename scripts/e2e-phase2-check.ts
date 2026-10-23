/**
 * Phase 2 end-to-end check: owners, user accounts, and owner-level isolation.
 *
 * Creates two vendors, one 3PL client and one portal user each (real Firebase
 * accounts) through the core services, signs in as each via a custom token, and
 * verifies routing + isolation against a running server. Cleans up everything
 * it created (Firebase accounts and DB rows) at the end.
 *
 * Usage: npm run e2e:phase2 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `e2e${Date.now().toString(36)}`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
  const { prisma } = await import("../src/lib/prisma");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");

  const auth = firebaseAdminAuth();
  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });

  const created = { ownerIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[] };

  async function idTokenFor(uid: string) {
    const custom = await auth.createCustomToken(uid);
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    });
    return (await res.json()).idToken as string;
  }
  async function sessionFor(uid: string, audience: "staff" | "portal") {
    const res = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: await idTokenFor(uid), audience }),
    });
    const body = await res.json();
    return { status: res.status, body, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
  }
  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: cookie } });
  const loc = (res: Response) => new URL(res.headers.get("location") ?? "/", base).pathname;

  try {
    // --- Owners -------------------------------------------------------------
    const vendorA = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `E2E Vendor A ${RUN}`), admin.id);
    const vendorB = await owners.createOwner("VENDOR", ownerInput(`${RUN}-B`, `E2E Vendor B ${RUN}`), admin.id);
    const client = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `E2E Client C ${RUN}`), admin.id);
    created.ownerIds.push(vendorA.id, vendorB.id, client.id);
    check("Create vendors and 3PL client", true, `${vendorA.code}, ${vendorB.code}, ${client.code}`);

    let dup: unknown = null;
    try {
      await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, "dup"), admin.id);
    } catch (e) {
      dup = e;
    }
    check("Duplicate owner code rejected", dup instanceof owners.OwnerServiceError && dup.code === "CODE_TAKEN");

    // --- Users ----------------------------------------------------------------
    const mk = (n: string, role: "VENDOR" | "THREEPL_CLIENT" | "WAREHOUSE", ownerId: string | null) =>
      users.createUserAccount(
        { name: `E2E ${n}`, email: `${RUN}-${n.toLowerCase()}@example.test`, password: "E2eTestPass123", role, ownerId, phone: null, notes: null },
        admin.id,
      );
    const uA = await mk("UserA", "VENDOR", vendorA.id);
    const uB = await mk("UserB", "VENDOR", vendorB.id);
    const uC = await mk("UserC", "THREEPL_CLIENT", client.id);
    const uW = await mk("Warehouse", "WAREHOUSE", null);
    for (const u of [uA, uB, uC, uW]) {
      created.userIds.push(u.id);
      created.firebaseUids.push(u.firebaseUid);
    }
    check("Create portal + staff users (Firebase + DB)", [uA, uB, uC, uW].every((u) => u.firebaseUid && u.status === "ACTIVE"));

    let mismatch: unknown = null;
    try {
      await mk("Wrong", "THREEPL_CLIENT", vendorA.id);
    } catch (e) {
      mismatch = e;
    }
    check("3PL role on a vendor owner rejected", mismatch instanceof users.UserServiceError && mismatch.code === "OWNER_INVALID");

    let dupEmail: unknown = null;
    try {
      await users.createUserAccount(
        { name: "Dup", email: uA.email, password: "E2eTestPass123", role: "VENDOR", ownerId: vendorA.id, phone: null, notes: null },
        admin.id,
      );
    } catch (e) {
      dupEmail = e;
    }
    check("Duplicate e-mail rejected", dupEmail instanceof users.UserServiceError && dupEmail.code === "EMAIL_TAKEN");

    let dbCheck: unknown = null;
    try {
      await prisma.user.create({ data: { firebaseUid: `${RUN}-bad`, email: `${RUN}-bad@example.test`, name: "bad", role: "VENDOR", ownerId: null } });
    } catch (e) {
      dbCheck = e;
    }
    check("DB CHECK constraint blocks portal user without owner", dbCheck !== null);

    // --- Portal isolation ---------------------------------------------------
    const sA = await sessionFor(uA.firebaseUid, "portal");
    check("Vendor user logs in at /user → /portal/vendor", sA.status === 200 && sA.body.redirectTo === "/portal/vendor");
    const staffAttempt = await sessionFor(uA.firebaseUid, "staff");
    check("Vendor user refused at /admin login", staffAttempt.status === 403 && staffAttempt.body.error === "wrong_portal");

    let res = await get("/portal/vendor", sA.cookie);
    let html = await res.text();
    check("Vendor A portal shows only Vendor A", res.status === 200 && html.includes(vendorA.businessName) && !html.includes(vendorB.businessName));
    res = await get("/portal/3pl", sA.cookie);
    check("Vendor A cannot open 3PL portal", res.status === 307 && loc(res) === "/portal/vendor", loc(res));
    res = await get("/admin", sA.cookie);
    check("Vendor A cannot open /admin", res.status === 307 && loc(res) === "/portal/vendor", loc(res));
    res = await get(`/admin/vendors/${vendorB.id}`, sA.cookie);
    check("Vendor A cannot open another vendor's admin record", res.status === 307, loc(res));

    const sC = await sessionFor(uC.firebaseUid, "portal");
    res = await get("/portal/3pl", sC.cookie);
    html = await res.text();
    check("3PL user portal shows only Client C", res.status === 200 && html.includes(client.businessName) && !html.includes(vendorA.businessName));
    res = await get("/portal/vendor", sC.cookie);
    check("3PL user cannot open vendor portal", res.status === 307 && loc(res) === "/portal/3pl", loc(res));

    // --- Staff role checks --------------------------------------------------
    const sW = await sessionFor(uW.firebaseUid, "staff");
    check("Warehouse user logs in at /admin", sW.status === 200 && sW.body.redirectTo === "/admin");
    res = await get("/admin/vendors", sW.cookie);
    check("Warehouse user blocked from Vendors (ADMIN only)", res.status === 307 && loc(res) === "/admin", `${loc(res)}${res.headers.get("location")?.includes("forbidden") ? "?forbidden" : ""}`);
    res = await get("/admin/users", sW.cookie);
    check("Warehouse user blocked from Users (ADMIN only)", res.status === 307);

    const sAdmin = await sessionFor(admin.firebaseUid, "staff");
    res = await get("/admin/vendors?status=ALL&q=" + encodeURIComponent(RUN), sAdmin.cookie);
    html = await res.text();
    check("Admin vendor list shows both test vendors", res.status === 200 && html.includes(vendorA.businessName) && html.includes(vendorB.businessName));
    res = await get(`/admin/vendors/${vendorA.id}`, sAdmin.cookie);
    html = await res.text();
    check("Admin vendor detail lists its portal user", res.status === 200 && html.includes(uA.email));
    res = await get(`/admin/3pl-clients/${vendorA.id}`, sAdmin.cookie);
    check("Vendor id under /admin/3pl-clients is 404 (type-scoped lookup)", res.status === 404);
    res = await get("/admin/users?q=" + encodeURIComponent(RUN), sAdmin.cookie);
    html = await res.text();
    check("Admin users list shows created users with owner names", res.status === 200 && html.includes(uW.email) && html.includes(vendorB.businessName));

    // --- Status changes --------------------------------------------------------
    await users.setUserStatus(uA.id, "DISABLED", admin.id);
    res = await get("/portal/vendor", sA.cookie);
    check("Disabled vendor user is signed out immediately", res.status === 307 && loc(res) === "/user/login");
    const fbA = await auth.getUser(uA.firebaseUid);
    check("Disabled user is disabled in Firebase too", fbA.disabled === true);
    await users.setUserStatus(uA.id, "ACTIVE", admin.id);
    res = await get("/portal/vendor", sA.cookie);
    check("Reactivated vendor user regains access", res.status === 200);

    await owners.setOwnerStatus(vendorA.id, "VENDOR", "INACTIVE", admin.id);
    res = await get("/portal/vendor", sA.cookie);
    check("Deactivating the owner locks out its users", res.status === 307 && loc(res) === "/user/login");
    await owners.setOwnerStatus(vendorA.id, "VENDOR", "ACTIVE", admin.id);

    let selfErr: unknown = null;
    try {
      await users.setUserStatus(admin.id, "DISABLED", admin.id);
    } catch (e) {
      selfErr = e;
    }
    check("Admin cannot disable own account", selfErr instanceof users.UserServiceError && selfErr.code === "SELF_ACTION");

    // --- Delete (tombstone) -------------------------------------------------
    await users.deleteUser(uB.id, admin.id);
    const deleted = await prisma.user.findUnique({ where: { id: uB.id } });
    let fbGone = false;
    try {
      await auth.getUser(uB.firebaseUid);
    } catch {
      fbGone = true;
    }
    check("Deleted user: row kept as DELETED, e-mail tombstoned, Firebase account removed", deleted?.status === "DELETED" && deleted.deletedEmail === uB.email && deleted.email !== uB.email && fbGone);
    const reuse = await mk("UserB", "VENDOR", vendorB.id);
    created.userIds.push(reuse.id);
    created.firebaseUids.push(reuse.firebaseUid);
    check("Deleted user's e-mail can be reused", reuse.email === uB.email);

    const audits = await prisma.auditLog.count({ where: { entityType: { in: ["User", "Owner"] }, entityId: { in: [...created.ownerIds, ...created.userIds] } } });
    check("Audit rows written for owner/user actions", audits >= 12, `${audits} rows`);
  } finally {
    // --- Cleanup -------------------------------------------------------------
    for (const uid of created.firebaseUids) await auth.deleteUser(uid).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...created.userIds, ...created.ownerIds] } } });
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.user.deleteMany({ where: { email: `${RUN}-bad@example.test` } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${created.userIds.length} users, ${created.ownerIds.length} owners removed).`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

function ownerInput(code: string, businessName: string) {
  return {
    code: code.toUpperCase(),
    businessName,
    contactName: "E2E Contact",
    email: null,
    phone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    notes: null,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
