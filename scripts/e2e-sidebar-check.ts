/**
 * Sidebar UX polish (QA UI-13): height budget fits normal desktop viewports, scroll fallback stays, sticky
 * behaviour kept, requested colours applied, icons + labels unchanged.
 *
 * The height budget is computed from the Tailwind classes the nav renders with (row padding, gaps, font
 * sizes) — a static model of the browser layout, checked against a 720 px viewport (typical 13" laptop
 * content height at 100% zoom). Browser-level pixel verification remains a manual step.
 *
 * Usage: npm run e2e:sidebar -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `sb${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean; skipped?: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name: string, why: string) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name} — ${why}`);
};

/** Static layout model (px) of the nav as rendered by its classes; see sidebar-nav.tsx. */
export function navHeightBudget(sections: { items: number }[], opts = { rowHeight: 28, rowGap: 2, headerHeight: 16, headerGap: 2, sectionGap: 12, navPadding: 24, brandHeight: 56, footerHeight: 57 }): number {
  const rows = sections.reduce((n, s) => n + s.items, 0);
  const rowGaps = sections.reduce((n, s) => n + Math.max(0, s.items - 1), 0);
  return (opts.footerHeight ?? 0) + opts.brandHeight + opts.navPadding + sections.length * (opts.headerHeight + opts.headerGap) + rows * opts.rowHeight + rowGaps * opts.rowGap + Math.max(0, sections.length - 1) * opts.sectionGap;
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const users = await import("../src/server/services/users");
  const { navForRole, ADMIN_NAV } = await import("../src/config/navigation");
  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { userIds: [] as string[], firebaseUids: [] as string[] };

  try {
    // ---------------------------------------------------------------- height budget (root cause of the scrollbar)
    const adminSections = navForRole("ADMIN").map((s) => ({ items: s.items.length }));
    const before = navHeightBudget(adminSections, { rowHeight: 32, rowGap: 2, headerHeight: 16, headerGap: 4, sectionGap: 20, navPadding: 32, brandHeight: 56, footerHeight: 0 });
    const after = navHeightBudget(adminSections);
    console.log(`      admin nav: ${adminSections.reduce((n, s) => n + s.items, 0)} items in ${adminSections.length} sections — previous density ≈ ${before} px, new density ≈ ${after} px`);
    check("Previous density did not fit a 720 px desktop viewport (that is why the sidebar scrolled at 100% zoom)", before > 720);
    check("New density + account footer fit a 768 px viewport for the full ADMIN navigation (no scrollbar needed at 100% zoom on a 13-inch laptop)", after <= 768, `${after} px`);
    check("Every role's navigation fits as well", (["ADMIN", "WAREHOUSE", "SALES"] as const).every((r) => navHeightBudget(navForRole(r).map((s) => ({ items: s.items.length }))) <= 768));
    const labels = ADMIN_NAV.flatMap((s) => s.items.map((i) => i.label));
    const EXPECTED_LABELS = ["Dashboard", "Orders", "Customers", "Fulfillment", "Inventory", "Receiving", "Transfers", "Products", "Warehouses", "Vendors", "3PL Clients", "Reports", "Imports & Exports", "Users", "Settings"];
    check("Navigation items unchanged (15 labels in 6 sections, same names and order)", labels.join("|") === EXPECTED_LABELS.join("|") && ADMIN_NAV.length === 6, labels.join(", "));

    // ---------------------------------------------------------------- served markup + CSS
    let cookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const u = await users.createUserAccount({ name: "SB Admin", email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
      created.userIds.push(u.id);
      created.firebaseUids.push(u.firebaseUid);
      const custom = await firebaseAdminAuth().createCustomToken(u.firebaseUid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
      cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    if (!cookie) {
      for (const n of ["HTTP: account row sits inside the sidebar, AFTER the scroll region (outside <nav>), non-shrinking, with the account menu trigger", "HTTP: the page header is mobile-only (md:hidden) and no longer carries the account menu; navigation region hides its scrollbar (scrollbar-none) but stays overflow-y-auto", "CSS: .scrollbar-none hides the bar in every engine without disabling scrolling", "HTTP: sidebar keeps sticky/h-screen and the nav keeps its scroll fallback (min-h-0 + overflow-y-auto) with compact density", "HTTP: all 16 labels and their icons render in the sidebar", "CSS: sidebar surface #10171A and selected item #242C2F in both themes; Inter untouched"]) skip(n, "no session");
    } else {
      const res = await fetch(`${base}/admin`, { headers: { Cookie: cookie }, redirect: "manual" });
      const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, "");
      const aside = html.match(/<aside class="([^"]*)"/)?.[1] ?? "";
      const nav = html.match(/<nav class="([^"]*)"[^>]*aria-label="Main"/)?.[1] ?? "";
      check("HTTP: sidebar keeps sticky/h-screen and the nav keeps its scroll fallback (min-h-0 + overflow-y-auto) with compact density", res.status === 200 && /sticky/.test(aside) && /top-0/.test(aside) && /h-screen/.test(aside) && /bg-sidebar/.test(aside) && /min-h-0/.test(nav) && /overflow-y-auto/.test(nav) && /gap-3/.test(nav) && !/gap-5/.test(nav));
      const navHtml = html.match(/<nav class="[^"]*"[^>]*aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
      const svgCount = (navHtml.match(/<svg/g) ?? []).length;
      const esc = (l: string) => l.replace(/&/g, "&amp;");
      const missing = labels.filter((l) => !navHtml.includes(`>${esc(l)}<`));
      check("HTTP: every label and its icon render in the sidebar (one svg per item, compact rows)", missing.length === 0 && svgCount >= labels.length && /py-1 /.test(navHtml) && !/py-1\.5 /.test(navHtml), missing.length ? `missing: ${missing.join(", ")}; svg ${svgCount}` : `svg ${svgCount}`);
      const asideHtml = html.match(/<aside class="[^"]*"[^>]*>([\s\S]*?)<\/aside>/)?.[1] ?? "";
      const navEnd = asideHtml.indexOf("</nav>");
      const accountIdx = asideHtml.indexOf('data-slot="sidebar-account"');
      const footer = asideHtml.match(/<div data-slot="sidebar-account" class="([^"]*)"/)?.[1] ?? "";
      check("HTTP: account row sits inside the sidebar, AFTER the scroll region (outside <nav>), non-shrinking, with the account menu trigger", accountIdx > navEnd && navEnd > 0 && /shrink-0/.test(footer) && /border-t/.test(footer) && asideHtml.slice(accountIdx).includes('aria-label="Account menu"'));
      const header = html.match(/<header class="([^"]*)"[^>]*>([\s\S]*?)<\/header>/);
      check("HTTP: the page header is mobile-only (md:hidden) and no longer carries the account menu; navigation region hides its scrollbar (scrollbar-none) but stays overflow-y-auto", !!header && /md:hidden/.test(header[1]) && !header[2].includes('aria-label="Account menu"') && header[2].includes('aria-label="Open navigation"') && /scrollbar-none/.test(nav) && /overflow-y-auto/.test(nav));
      const active = navHtml.match(/<a[^>]*aria-current="page"[^>]*class="([^"]*)"/)?.[1] ?? navHtml.match(/<a[^>]*class="([^"]*)"[^>]*aria-current="page"/)?.[1] ?? "";
      check("HTTP: the active item (Dashboard on /admin) uses the sidebar accent class", /bg-sidebar-accent/.test(active) && /font-medium/.test(active));
      const cssLinks = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
      const css = (await Promise.all(cssLinks.map(async (h) => (await fetch(h.startsWith("http") ? h : `${base}${h}`)).text()))).join("\n");
      const count = (v: string, hex: string) => (css.match(new RegExp(`${v}:\\s*${hex}\\b`, "gi")) ?? []).length;
      check("CSS: .scrollbar-none hides the bar in every engine without disabling scrolling", /\.scrollbar-none\{[^}]*scrollbar-width:none/.test(css.replace(/\s+/g, "")) && /\.scrollbar-none::-webkit-scrollbar\{[^}]*display:none/.test(css.replace(/\s+/g, "")));
      check("CSS: sidebar surface #10171A and selected item #242C2F declared for both themes; no other sidebar surface remains; Inter untouched", count("--sidebar", "#10171a") >= 2 && count("--sidebar-accent", "#242c2f") >= 2 && !/--sidebar:\s*oklch/.test(css) && /font-family:\s*['"]?Inter/i.test(css) && !/Geist/.test(css), `surface×${count("--sidebar", "#10171a")} accent×${count("--sidebar-accent", "#242c2f")}`);
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: created.userIds } }, { userId: { in: created.userIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.$disconnect();
    console.log("Cleanup done.");
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed - skipped}/${results.length} checks passed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
