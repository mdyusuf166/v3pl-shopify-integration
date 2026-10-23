"use server";

import { revalidatePath } from "next/cache";
import type { OwnerStatus, OwnerType } from "@/generated/prisma/client";
import { OWNER_TYPE_META, ownerFormSchema, type OwnerFormInput } from "@/lib/validation/owners";
import { requireRole } from "@/server/auth/guards";
import { OwnerServiceError, createOwner, setOwnerStatus, updateOwner } from "@/server/services/owners";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof OwnerServiceError) {
    return err.code === "CODE_TAKEN" ? fail(err.message, { code: err.message }) : fail(err.message);
  }
  console.error("[owners action]", err);
  return fail("Something went wrong. Please try again.");
}

export async function createOwnerAction(type: OwnerType, input: OwnerFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = ownerFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const owner = await createOwner(type, parsed.data, actor.id);
    revalidatePath(OWNER_TYPE_META[type].basePath);
    return ok({ id: owner.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateOwnerAction(type: OwnerType, id: string, input: OwnerFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = ownerFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const owner = await updateOwner(id, type, parsed.data, actor.id);
    revalidatePath(OWNER_TYPE_META[type].basePath);
    revalidatePath(`${OWNER_TYPE_META[type].basePath}/${id}`);
    return ok({ id: owner.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function setOwnerStatusAction(type: OwnerType, id: string, status: OwnerStatus): Promise<ActionResult<{ status: OwnerStatus }>> {
  const actor = await requireRole("ADMIN");
  try {
    const owner = await setOwnerStatus(id, type, status, actor.id);
    revalidatePath(OWNER_TYPE_META[type].basePath);
    revalidatePath(`${OWNER_TYPE_META[type].basePath}/${id}`);
    return ok({ status: owner.status });
  } catch (err) {
    return handleError(err);
  }
}
