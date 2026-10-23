"use server";

import { revalidatePath } from "next/cache";
import type { WarehouseStatus } from "@/generated/prisma/client";
import { locationFormSchema, warehouseFormSchema, type LocationFormInput, type WarehouseFormInput } from "@/lib/validation/warehouses";
import { requireRole } from "@/server/auth/guards";
import {
  WarehouseServiceError,
  createLocation,
  createWarehouse,
  deleteLocation,
  deleteWarehouse,
  setDefaultLocation,
  setLocationActive,
  setWarehouseStatus,
  updateLocation,
  updateWarehouse,
} from "@/server/services/warehouses";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof WarehouseServiceError) {
    if (err.code === "CODE_TAKEN") return fail(err.message, { code: err.message });
    if (err.code === "LABEL_TAKEN") return fail(err.message, { label: err.message });
    return fail(err.message);
  }
  console.error("[warehouses action]", err);
  return fail("Something went wrong. Please try again.");
}

const BASE = "/admin/warehouses";

export async function createWarehouseAction(input: WarehouseFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = warehouseFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const wh = await createWarehouse(parsed.data, actor.id);
    revalidatePath(BASE);
    return ok({ id: wh.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateWarehouseAction(id: string, input: WarehouseFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = warehouseFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    await updateWarehouse(id, parsed.data, actor.id);
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return ok({ id });
  } catch (err) {
    return handleError(err);
  }
}

export async function setWarehouseStatusAction(id: string, status: WarehouseStatus): Promise<ActionResult<{ status: WarehouseStatus }>> {
  const actor = await requireRole("ADMIN");
  try {
    const wh = await setWarehouseStatus(id, status, actor.id);
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return ok({ status: wh.status });
  } catch (err) {
    return handleError(err);
  }
}

export async function createLocationAction(warehouseId: string, input: LocationFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = locationFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const loc = await createLocation(warehouseId, parsed.data, actor.id);
    revalidatePath(`${BASE}/${warehouseId}`);
    return ok({ id: loc.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateLocationAction(id: string, warehouseId: string, input: LocationFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = locationFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    await updateLocation(id, parsed.data, actor.id);
    revalidatePath(`${BASE}/${warehouseId}`);
    return ok({ id });
  } catch (err) {
    return handleError(err);
  }
}

export async function setLocationActiveAction(id: string, warehouseId: string, isActive: boolean): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  try {
    await setLocationActive(id, isActive, actor.id);
    revalidatePath(`${BASE}/${warehouseId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function setDefaultLocationAction(id: string, warehouseId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  try {
    await setDefaultLocation(id, actor.id);
    revalidatePath(`${BASE}/${warehouseId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

/** Hard delete (D-054): only warehouses with no stock or operational history. */
export async function deleteWarehouseAction(id: string): Promise<ActionResult<{ code: string }>> {
  const actor = await requireRole("ADMIN");
  try {
    const w = await deleteWarehouse(id, actor.id);
    revalidatePath(BASE);
    return ok({ code: w.code });
  } catch (err) {
    return handleError(err);
  }
}

export async function deleteLocationAction(id: string, warehouseId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await deleteLocation(id, actor.id);
    revalidatePath(`${BASE}/${warehouseId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}
