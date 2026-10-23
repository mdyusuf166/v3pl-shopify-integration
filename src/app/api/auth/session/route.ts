import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { homePathForRole, isStaffRole } from "@/lib/roles";
import {
  InvalidIdTokenError,
  clearSessionCookie,
  mintSessionCookie,
  setSessionCookie,
} from "@/server/auth/session";

export const runtime = "nodejs";

const bodySchema = z.object({
  idToken: z.string().min(1),
  /** Which login screen the request came from (D-010). */
  audience: z.enum(["staff", "portal"]),
  /** Optional post-login path; only same-area relative paths are honoured. */
  next: z.string().optional(),
});

function safeNextPath(next: string | undefined, allowedPrefix: string, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  if (!next.startsWith(allowedPrefix)) return fallback;
  if (next.endsWith("/login")) return fallback;
  return next;
}

/**
 * POST /api/auth/session — exchange a Firebase ID token for a session cookie.
 * Authorization happens here, server-side:
 *   1. token must verify and be fresh
 *   2. a platform User row must exist for the Firebase UID (no auto-provisioning)
 *   3. the user must be ACTIVE
 *   4. the role must match the login screen used
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", message: "Invalid request." }, { status: 400 });
  }
  const { idToken, audience, next } = parsed.data;

  let minted: Awaited<ReturnType<typeof mintSessionCookie>>;
  try {
    minted = await mintSessionCookie(idToken);
  } catch (err) {
    const message = err instanceof InvalidIdTokenError ? err.message : "Sign-in could not be verified.";
    return NextResponse.json({ error: "invalid_token", message }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { firebaseUid: minted.decoded.uid },
    select: { id: true, role: true, status: true },
  });

  if (!user) {
    return NextResponse.json(
      {
        error: "no_account",
        message: "This sign-in is not linked to a platform account. Contact an administrator.",
      },
      { status: 403 },
    );
  }
  if (user.status !== "ACTIVE") {
    return NextResponse.json(
      { error: "account_disabled", message: "This account has been disabled. Contact an administrator." },
      { status: 403 },
    );
  }

  const staff = isStaffRole(user.role);
  if (audience === "staff" && !staff) {
    return NextResponse.json(
      { error: "wrong_portal", message: "Vendor and 3PL accounts sign in at the user portal.", redirectTo: "/user/login" },
      { status: 403 },
    );
  }
  if (audience === "portal" && staff) {
    return NextResponse.json(
      { error: "wrong_portal", message: "Staff accounts sign in at the admin portal.", redirectTo: "/admin/login" },
      { status: 403 },
    );
  }

  await setSessionCookie(minted.cookieValue);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const home = homePathForRole(user.role);
  const redirectTo = staff ? safeNextPath(next, "/admin", home) : safeNextPath(next, "/portal", home);
  return NextResponse.json({ redirectTo });
}

/** DELETE /api/auth/session — sign out (clears the cookie). */
export async function DELETE() {
  await clearSessionCookie();
  return new NextResponse(null, { status: 204 });
}
