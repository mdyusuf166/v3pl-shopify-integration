import type { Prisma, UserRole, UserStatus } from "@/generated/prisma/client";
import { firebaseAdminAuth } from "@/lib/firebase/admin";
import { prisma } from "@/lib/prisma";
import { isPortalRole } from "@/lib/roles";
import type { UserCreateValues, UserProfileValues } from "@/lib/validation/users";
import { recordAudit } from "@/server/services/audit";

/**
 * User account service (spec §6–§7, D-033, D-037).
 *
 * Every account = Firebase Authentication user + platform `User` row linked by UID.
 * - create:   Firebase user first, then DB row; Firebase user is removed if the DB write fails.
 * - disable/ban: DB status (authoritative, takes effect on the next request) + Firebase
 *                `disabled` flag + refresh-token revocation.
 * - reactivate: DB status ACTIVE + Firebase re-enabled.
 * - delete:  Firebase account removed; DB row kept as DELETED with a tombstoned e-mail so
 *            audit/ledger history stays intact and the e-mail can be reused.
 * All DB mutations are audited in the same transaction.
 */

export type UserErrorCode =
  | "EMAIL_TAKEN"
  | "OWNER_INVALID"
  | "NOT_FOUND"
  | "SELF_ACTION"
  | "LAST_ADMIN"
  | "ALREADY_DELETED"
  | "FIREBASE";

export class UserServiceError extends Error {
  constructor(
    public readonly code: UserErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const USER_PAGE_SIZE = 25;

const userSelect = {
  id: true,
  firebaseUid: true,
  email: true,
  name: true,
  role: true,
  status: true,
  ownerId: true,
  phone: true,
  notes: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, type: true, code: true, businessName: true } },
} satisfies Prisma.UserSelect;

export type UserRecord = Prisma.UserGetPayload<{ select: typeof userSelect }>;

export type UserListParams = {
  q?: string;
  role?: UserRole | "ALL";
  status?: UserStatus | "ALL";
  ownerId?: string;
  page?: number;
};

export async function listUsers(params: UserListParams) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.UserWhereInput = {
    ...(params.role && params.role !== "ALL" ? { role: params.role } : {}),
    ...(params.status && params.status !== "ALL" ? { status: params.status } : { status: { not: "DELETED" } }),
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { email: { contains: params.q, mode: "insensitive" } },
            { owner: { businessName: { contains: params.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [total, items] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ status: "asc" }, { name: "asc" }],
      skip: (page - 1) * USER_PAGE_SIZE,
      take: USER_PAGE_SIZE,
      select: userSelect,
    }),
  ]);

  return { items, total, page, pageSize: USER_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / USER_PAGE_SIZE)) };
}

export async function getUser(id: string): Promise<UserRecord | null> {
  return prisma.user.findUnique({ where: { id }, select: userSelect });
}

function firebaseErrorToService(err: unknown, fallback: string): UserServiceError {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "auth/email-already-exists") {
    return new UserServiceError(
      "EMAIL_TAKEN",
      "A Firebase account with this e-mail already exists but is not linked to the platform. Contact support to link it.",
    );
  }
  if (code === "auth/invalid-password") return new UserServiceError("FIREBASE", "Password rejected by the identity provider.");
  return new UserServiceError("FIREBASE", fallback);
}

export async function createUserAccount(values: UserCreateValues, actorId: string): Promise<UserRecord> {
  const email = values.email.toLowerCase();

  const emailTaken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (emailTaken) throw new UserServiceError("EMAIL_TAKEN", "A platform user with this e-mail already exists.");

  if (isPortalRole(values.role)) {
    const owner = await prisma.owner.findUnique({ where: { id: values.ownerId ?? "" }, select: { id: true, type: true, status: true } });
    if (!owner) throw new UserServiceError("OWNER_INVALID", "The selected vendor / 3PL client does not exist.");
    if (owner.status !== "ACTIVE") throw new UserServiceError("OWNER_INVALID", "Cannot add users to an inactive vendor / 3PL client.");
    const expectedRole: UserRole = owner.type === "VENDOR" ? "VENDOR" : "THREEPL_CLIENT";
    if (values.role !== expectedRole) {
      throw new UserServiceError("OWNER_INVALID", `Users of this owner must have the ${expectedRole} role.`);
    }
  }

  const auth = firebaseAdminAuth();
  let firebaseUid: string;
  try {
    const created = await auth.createUser({ email, password: values.password, displayName: values.name, disabled: false });
    firebaseUid = created.uid;
  } catch (err) {
    throw firebaseErrorToService(err, "Could not create the sign-in account.");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firebaseUid,
          email,
          name: values.name,
          role: values.role,
          status: "ACTIVE",
          ownerId: isPortalRole(values.role) ? values.ownerId : null,
          phone: values.phone ?? null,
          notes: values.notes ?? null,
        },
        select: userSelect,
      });
      await recordAudit(
        {
          userId: actorId,
          action: "user.created",
          entityType: "User",
          entityId: user.id,
          newValues: { email, name: values.name, role: values.role, ownerId: user.ownerId },
        },
        tx,
      );
      return user;
    });
  } catch (err) {
    // Compensate: never leave an orphaned Firebase account.
    await auth.deleteUser(firebaseUid).catch(() => undefined);
    throw err;
  }
}

export async function updateUserProfile(id: string, values: UserProfileValues, actorId: string): Promise<UserRecord> {
  const current = await prisma.user.findUnique({ where: { id }, select: { id: true, firebaseUid: true, name: true, phone: true, notes: true, status: true } });
  if (!current) throw new UserServiceError("NOT_FOUND", "User not found.");
  if (current.status === "DELETED") throw new UserServiceError("ALREADY_DELETED", "This user has been deleted.");

  if (values.name !== current.name) {
    await firebaseAdminAuth().updateUser(current.firebaseUid, { displayName: values.name }).catch(() => undefined);
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id },
      data: { name: values.name, phone: values.phone ?? null, notes: values.notes ?? null },
      select: userSelect,
    });
    await recordAudit(
      {
        userId: actorId,
        action: "user.updated",
        entityType: "User",
        entityId: id,
        oldValues: { name: current.name, phone: current.phone, notes: current.notes },
        newValues: { name: values.name, phone: values.phone ?? null, notes: values.notes ?? null },
      },
      tx,
    );
    return user;
  });
}

/**
 * ACTIVE → re-enable; DISABLED / BANNED → block. Both revoke existing sessions:
 * the DB status check in getCurrentUser() rejects the next request, and Firebase
 * refresh tokens are revoked so no new ID token can be minted.
 */
export async function setUserStatus(id: string, status: Exclude<UserStatus, "DELETED">, actorId: string): Promise<UserRecord> {
  const current = await prisma.user.findUnique({ where: { id }, select: { id: true, firebaseUid: true, role: true, status: true } });
  if (!current) throw new UserServiceError("NOT_FOUND", "User not found.");
  if (current.status === "DELETED") throw new UserServiceError("ALREADY_DELETED", "This user has been deleted.");
  if (current.id === actorId && status !== "ACTIVE") throw new UserServiceError("SELF_ACTION", "You cannot disable or ban your own account.");
  if (status !== "ACTIVE") await assertNotLastActiveAdmin(current);

  const auth = firebaseAdminAuth();
  try {
    await auth.updateUser(current.firebaseUid, { disabled: status !== "ACTIVE" });
    if (status !== "ACTIVE") await auth.revokeRefreshTokens(current.firebaseUid);
  } catch (err) {
    throw firebaseErrorToService(err, "Could not update the sign-in account.");
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id }, data: { status }, select: userSelect });
    const action = status === "ACTIVE" ? "user.reactivated" : status === "BANNED" ? "user.banned" : "user.disabled";
    await recordAudit(
      { userId: actorId, action, entityType: "User", entityId: id, oldValues: { status: current.status }, newValues: { status } },
      tx,
    );
    return user;
  });
}

export async function resetUserPassword(id: string, password: string, actorId: string): Promise<void> {
  const current = await prisma.user.findUnique({ where: { id }, select: { id: true, firebaseUid: true, status: true } });
  if (!current) throw new UserServiceError("NOT_FOUND", "User not found.");
  if (current.status === "DELETED") throw new UserServiceError("ALREADY_DELETED", "This user has been deleted.");

  const auth = firebaseAdminAuth();
  try {
    await auth.updateUser(current.firebaseUid, { password });
    await auth.revokeRefreshTokens(current.firebaseUid);
  } catch (err) {
    throw firebaseErrorToService(err, "Could not reset the password.");
  }
  await recordAudit({ userId: actorId, action: "user.password_reset", entityType: "User", entityId: id });
}

/** Terminal. Removes the Firebase account; keeps the row as DELETED (D-037). */
export async function deleteUser(id: string, actorId: string): Promise<void> {
  const current = await prisma.user.findUnique({ where: { id }, select: { id: true, firebaseUid: true, email: true, role: true, status: true } });
  if (!current) throw new UserServiceError("NOT_FOUND", "User not found.");
  if (current.status === "DELETED") throw new UserServiceError("ALREADY_DELETED", "This user has already been deleted.");
  if (current.id === actorId) throw new UserServiceError("SELF_ACTION", "You cannot delete your own account.");
  await assertNotLastActiveAdmin(current);

  try {
    await firebaseAdminAuth().deleteUser(current.firebaseUid);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "auth/user-not-found") throw firebaseErrorToService(err, "Could not remove the sign-in account.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        status: "DELETED",
        deletedAt: new Date(),
        deletedEmail: current.email,
        email: `deleted-${current.id}@deleted.v3pl.invalid`,
        // Firebase UID is gone; keep the row unique but unlinkable.
        firebaseUid: `deleted-${current.id}`,
      },
    });
    await recordAudit(
      { userId: actorId, action: "user.deleted", entityType: "User", entityId: id, oldValues: { email: current.email, status: current.status, role: current.role } },
      tx,
    );
  });
}

async function assertNotLastActiveAdmin(target: { id: string; role: UserRole; status: UserStatus }) {
  if (target.role !== "ADMIN" || target.status !== "ACTIVE") return;
  const others = await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE", id: { not: target.id } } });
  if (others === 0) throw new UserServiceError("LAST_ADMIN", "This is the last active administrator and cannot be disabled or deleted.");
}
