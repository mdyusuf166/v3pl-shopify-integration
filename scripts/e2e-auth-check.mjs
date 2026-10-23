/**
 * End-to-end authentication check against a running server.
 * Mints a Firebase custom token for the given admin email (no password needed),
 * exchanges it for an ID token, then drives /api/auth/session and the guards.
 *
 * Usage: node scripts/e2e-auth-check.mjs http://localhost:3100 vendor3pl@gmail.com
 * Requires .env.local (FIREBASE_ADMIN_*, NEXT_PUBLIC_FIREBASE_API_KEY, DATABASE_URL).
 * Prints no secrets.
 */
import { config as loadEnv } from "dotenv";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import pg from "pg";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", email = "vendor3pl@gmail.com"] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
    clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const fbUser = await getAuth().getUserByEmail(email);
const customToken = await getAuth().createCustomToken(fbUser.uid);
const signIn = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
);
const { idToken } = await signIn.json();
check("Firebase web API key accepts sign-in for project", Boolean(idToken), `uid ${fbUser.uid}`);

const post = (body) =>
  fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (path, cookie) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
const loc = (res) => new URL(res.headers.get("location") ?? "/", base).pathname;

// Wrong portal
let res = await post({ idToken, audience: "portal" });
let body = await res.json();
check("Staff account refused at /user login (wrong_portal 403)", res.status === 403 && body.error === "wrong_portal", body.redirectTo);

// Correct login
res = await post({ idToken, audience: "staff", next: "/admin/orders" });
body = await res.json();
const setCookie = res.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
check("Staff login creates session (200 + httpOnly cookie)", res.status === 200 && cookie.startsWith("v3pl_session=") && /httponly/i.test(setCookie), `redirectTo ${body.redirectTo}`);
check("Redirect target honours same-area next path", body.redirectTo === "/admin/orders");

// Protected pages with a valid session
res = await get("/admin", cookie);
const html = await res.text();
check("GET /admin with session renders dashboard (200)", res.status === 200 && html.includes("Dashboard"));
check("Dashboard reports database Connected", html.includes("Connected"));
check("Dashboard shows admin name", html.includes("V3PL Admin"));

res = await get("/admin/login", cookie);
check("Signed-in user visiting /admin/login is redirected home", res.status === 307 && loc(res) === "/admin", loc(res));
res = await get("/portal/vendor", cookie);
check("Staff cannot enter vendor portal (redirected to /admin)", res.status === 307 && loc(res) === "/admin", loc(res));
res = await get("/user", cookie);
check("/user entry redirects staff to /admin", res.status === 307 && loc(res) === "/admin", loc(res));

// Disabled account loses access immediately
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query(`UPDATE "User" SET status = 'DISABLED' WHERE "firebaseUid" = $1`, [fbUser.uid]);
  res = await get("/admin", cookie);
  check("DISABLED user with valid cookie is bounced to login", res.status === 307 && loc(res) === "/admin/login", loc(res));
  res = await post({ idToken, audience: "staff" });
  body = await res.json();
  check("DISABLED user cannot create a new session (403 account_disabled)", res.status === 403 && body.error === "account_disabled");
} finally {
  await db.query(`UPDATE "User" SET status = 'ACTIVE' WHERE "firebaseUid" = $1`, [fbUser.uid]);
  await db.end();
}
res = await get("/admin", cookie);
check("Re-activated user regains access", res.status === 200);

// Sign out
res = await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: cookie } });
check("Sign-out returns 204 and clears cookie", res.status === 204 && /max-age=0/i.test(res.headers.get("set-cookie") ?? ""));

// Unauthenticated + malformed
res = await get("/admin");
check("Unauthenticated /admin redirects to login", res.status === 307 && loc(res) === "/admin/login");
res = await get("/admin", "v3pl_session=forged");
check("Forged cookie is rejected", res.status === 307 && loc(res) === "/admin/login");
res = await post({});
check("Malformed body returns 400", res.status === 400);
res = await post({ idToken: "bogus", audience: "staff" });
check("Bogus ID token returns 401", res.status === 401);
res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
check("Non-JSON body returns 400", res.status === 400);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
