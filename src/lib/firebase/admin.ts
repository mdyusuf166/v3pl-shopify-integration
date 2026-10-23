// NOTE: no `server-only` import here — this module is also used by CLI scripts (scripts/*.ts).
// It is still server-only by construction: it reads FIREBASE_ADMIN_* via serverEnv().
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { firebaseAdminEnv } from "@/lib/env";

/**
 * Firebase Admin SDK — server only. Used to verify ID tokens, mint/verify
 * session cookies and (from Phase 2) create/disable Firebase accounts.
 */
export function firebaseAdminApp(): App {
  const existing = getApps();
  if (existing.length > 0) return existing[0];
  const env = firebaseAdminEnv();
  return initializeApp({
    credential: cert({
      projectId: env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY,
    }),
  });
}

export function firebaseAdminAuth(): Auth {
  return getAuth(firebaseAdminApp());
}
