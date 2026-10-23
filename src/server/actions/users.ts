"use server";

import { revalidatePath } from "next/cache";
import {
  passwordResetSchema,
  userCreateSchema,
  userProfileSchema,
  userStatusActionSchema,
  type UserCreateInput,
} from "@/lib/validation/users";
import { requireRole } from "@/server/auth/guards";
import {
  UserServiceError,
  createUserAccount,
  deleteUser,
  resetUserPassword,
  setUserStatus,
  updateUserProfile,
} from "@/server/services/users";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof UserServiceError) {
    if (err.code === "EMAIL_TAKEN") return fail(err.message, { email: err.message });
    if (err.code === "OWNER_INVALID") return fail(err.message, { ownerId: err.message });
    return fail(err.message);
  }
  console.error("[users action]", err);
  return fail("Something went wrong. Please try again.");
}

function revalidateUserViews(ownerId?: string | null, ownerType?: "VENDOR" | "THREEPL_CLIENT" | null) {
  revalidatePath("/admin/users");
  if (ownerId && ownerType) {
    revalidatePath(`${ownerType === "VENDOR" ? "/admin/vendors" : "/admin/3pl-clients"}/${ownerId}`);
  }
}

export async function createUserAction(input: UserCreateInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = userCreateSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const user = await createUserAccount(parsed.data, actor.id);
    revalidateUserViews(user.ownerId, user.owner?.type ?? null);
    return ok({ id: user.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateUserProfileAction(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = userProfileSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const user = await updateUserProfile(id, parsed.data, actor.id);
    revalidateUserViews(user.ownerId, user.owner?.type ?? null);
    return ok({ id: user.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function setUserStatusAction(id: string, status: unknown): Promise<ActionResult<{ status: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = userStatusActionSchema.safeParse(status);
  if (!parsed.success) return fail("Invalid status.");
  try {
    const user = await setUserStatus(id, parsed.data, actor.id);
    revalidateUserViews(user.ownerId, user.owner?.type ?? null);
    return ok({ status: user.status });
  } catch (err) {
    return handleError(err);
  }
}

export async function resetUserPasswordAction(id: string, input: unknown): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  const parsed = passwordResetSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    await resetUserPassword(id, parsed.data.password, actor.id);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function deleteUserAction(id: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await deleteUser(id, actor.id);
    revalidatePath("/admin/users");
    revalidatePath("/admin/vendors");
    revalidatePath("/admin/3pl-clients");
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}
