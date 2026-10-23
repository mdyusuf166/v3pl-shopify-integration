"use server";

import { revalidatePath } from "next/cache";
import { chargeRuleFormSchema, settlementFormSchema, vendorPayableFormSchema, type ChargeRuleFormInput, type SettlementFormInput, type VendorPayableFormInput } from "@/lib/validation/finance";
import { requireRole } from "@/server/auth/guards";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";
import { ChargeServiceError, createChargeRule, deleteChargeRule, setChargeRuleActive, updateChargeRule } from "@/server/services/charges";
import { FinanceServiceError, createVendorPayable, recordSettlement } from "@/server/services/finance";

/** Charges + settlement ledger actions (D-063). Admin only; owner ids come from the URL the admin is on, never from a portal user. */

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof ChargeServiceError || err instanceof FinanceServiceError) return fail(err.message);
  console.error("[finance action]", err);
  return fail("Something went wrong. Please try again.");
}

const revalidateFinance = (ownerId?: string) => {
  revalidatePath("/admin/finance");
  revalidatePath("/admin");
  if (ownerId) {
    revalidatePath(`/admin/finance/${ownerId}`);
    revalidatePath(`/admin/vendors/${ownerId}`);
    revalidatePath(`/admin/3pl-clients/${ownerId}`);
  }
};

export async function createChargeRuleAction(input: ChargeRuleFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = chargeRuleFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const rule = await createChargeRule(parsed.data, actor.id);
    revalidatePath("/admin/settings/charges");
    return ok({ id: rule.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateChargeRuleAction(id: string, input: ChargeRuleFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = chargeRuleFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const rule = await updateChargeRule(id, parsed.data, actor.id);
    revalidatePath("/admin/settings/charges");
    return ok({ id: rule.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function setChargeRuleActiveAction(id: string, active: boolean): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await setChargeRuleActive(id, active, actor.id);
    revalidatePath("/admin/settings/charges");
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function deleteChargeRuleAction(id: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await deleteChargeRule(id, actor.id);
    revalidatePath("/admin/settings/charges");
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function recordSettlementAction(ownerId: string, input: SettlementFormInput): Promise<ActionResult<{ id: string; created: boolean }>> {
  const actor = await requireRole("ADMIN");
  const parsed = settlementFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const r = await recordSettlement(ownerId, parsed.data, actor.id);
    revalidateFinance(ownerId);
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

/** Admin: allocate part of a received line into a vendor payable (D-064). Over-allocation is refused server-side. */
export async function createVendorPayableAction(ownerId: string, input: VendorPayableFormInput): Promise<ActionResult<{ id: string; created: boolean }>> {
  const actor = await requireRole("ADMIN");
  const parsed = vendorPayableFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const r = await createVendorPayable(ownerId, parsed.data, actor.id);
    revalidateFinance(ownerId);
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}
