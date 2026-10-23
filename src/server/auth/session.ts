import "server-only";
import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import { firebaseAdminAuth } from "@/lib/firebase/admin";
import { isProduction } from "@/lib/env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth-constants";

/** ID tokens older than this are refused at login (prevents replay of stale tokens). */
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

export class InvalidIdTokenError extends Error {}

/**
 * Verifies a freshly minted Firebase ID token and mints an httpOnly session
 * cookie for it. Does NOT touch the database — the caller decides whether the
 * Firebase identity is allowed onto the platform.
 */
export async function mintSessionCookie(
  idToken: string,
): Promise<{ decoded: DecodedIdToken; cookieValue: string }> {
  const auth = firebaseAdminAuth();
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch {
    throw new InvalidIdTokenError("Invalid or expired sign-in token.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - decoded.auth_time > MAX_TOKEN_AGE_SECONDS) {
    throw new InvalidIdTokenError("Sign-in took too long. Please try again.");
  }
  const cookieValue = await auth.createSessionCookie(idToken, {
    expiresIn: SESSION_TTL_SECONDS * 1000,
  });
  return { decoded, cookieValue };
}

export async function setSessionCookie(value: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 0 });
}

/**
 * Reads and cryptographically verifies the session cookie.
 * Returns null when absent or invalid. Revocation is not checked here on
 * purpose: the database `User.status` check in getCurrentUser() runs on every
 * request and is the authoritative kill switch (D-033).
 */
export async function readSessionClaims(): Promise<DecodedIdToken | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  try {
    return await firebaseAdminAuth().verifySessionCookie(value, false);
  } catch {
    return null;
  }
}
