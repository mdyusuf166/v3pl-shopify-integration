import "server-only";
import { cache } from "react";
import type { UserRole, UserStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { readSessionClaims } from "@/server/auth/session";

export type CurrentUser = {
  id: string;
  firebaseUid: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  /** Set for VENDOR / THREEPL_CLIENT users; null for staff. The only source of owner scope. */
  ownerId: string | null;
};

/**
 * The authenticated platform user for the current request, or null.
 * - Verifies the session cookie signature (Firebase Admin SDK).
 * - Loads the database profile by Firebase UID.
 * - Requires status ACTIVE — disabled/banned users lose access immediately,
 *   regardless of any still-valid cookie.
 * Memoised per request via React cache().
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const claims = await readSessionClaims();
  if (!claims) return null;

  const user = await prisma.user.findUnique({
    where: { firebaseUid: claims.uid },
    select: { id: true, firebaseUid: true, email: true, name: true, role: true, status: true, ownerId: true },
  });
  if (!user || user.status !== "ACTIVE") return null;
  // Portal users must belong to an ACTIVE owner; an inactive owner locks its users out.
  if (user.ownerId) {
    const owner = await prisma.owner.findUnique({ where: { id: user.ownerId }, select: { status: true } });
    if (!owner || owner.status !== "ACTIVE") return null;
  }
  return user;
});
