"use server";

import { revalidatePath } from "next/cache";
import { customerScopeFor as scopeFor } from "@/lib/customer-scope";
import { isStaffRole } from "@/lib/roles";
import { customerFormSchema, type CustomerFormInput } from "@/lib/validation/customers";
import { getCurrentUser } from "@/server/auth/current-user";
import type { CurrentUser } from "@/server/auth/current-user";
import { requirePortalUser, requireRole } from "@/server/auth/guards";
import { CustomerServiceError, createCustomer, findDuplicateCustomers, searchCustomers, updateCustomer, type CustomerScope, type DuplicateMatch } from "@/server/services/customers";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

/**
 * Customer directory actions shared by admin and both portals (D-060). The scope always comes
 * from the session: staff see everything, portal users only their own owner. Owner ids sent by the
 * browser are ignored for portal users.
 */

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof CustomerServiceError) return err.field ? fail(err.message, { [err.field]: err.message }) : fail(err.message);
  console.error("[customers action]", err);
  return fail("Something went wrong. Please try again.");
}

async function requireCustomerEditor(): Promise<{ user: CurrentUser; scope: CustomerScope; basePaths: string[] }> {
  const user = await getCurrentUser();
  const scope = scopeFor(user);
  if (!user || !scope) throw new CustomerServiceError("FORBIDDEN", "Sign in again to manage customers.");
  if (isStaffRole(user.role)) {
    await requireRole("ADMIN", "SALES");
    return { user, scope, basePaths: ["/admin/customers"] };
  }
  await requirePortalUser();
  return { user, scope, basePaths: [user.role === "VENDOR" ? "/portal/vendor/customers" : "/portal/3pl/customers"] };
}

export async function createCustomerAction(input: CustomerFormInput): Promise<ActionResult<{ id: string }>> {
  try {
    const { user, scope, basePaths } = await requireCustomerEditor();
    const parsed = customerFormSchema.safeParse(input);
    if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
    const source = user.role === "THREEPL_CLIENT" ? "THREEPL_PORTAL" : "MANUAL";
    const customer = await createCustomer(scope, parsed.data, user.id, source);
    for (const p of basePaths) revalidatePath(p);
    return ok({ id: customer.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateCustomerAction(id: string, input: CustomerFormInput): Promise<ActionResult<{ id: string }>> {
  try {
    const { user, scope, basePaths } = await requireCustomerEditor();
    const parsed = customerFormSchema.safeParse(input);
    if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
    await updateCustomer(scope, id, parsed.data, user.id);
    for (const p of basePaths) {
      revalidatePath(p);
      revalidatePath(`${p}/${id}`);
    }
    return ok({ id });
  } catch (err) {
    return handleError(err);
  }
}

/** Customer picker (order forms): scoped search by name / e-mail / phone. Never redirects. */
export async function searchCustomersAction(q: string): Promise<ActionResult<Awaited<ReturnType<typeof searchCustomers>>>> {
  const scope = scopeFor(await getCurrentUser());
  if (!scope) return fail("Your session has expired — sign in again.");
  try {
    return ok(await searchCustomers(scope, q, 10));
  } catch (err) {
    return handleError(err);
  }
}

/** Likely duplicates for the customer form (same owner pool). Staff pass the owner they are creating for. */
export async function checkCustomerDuplicatesAction(probe: { email?: string | null; phone?: string | null; name?: string | null; ownerId?: string | null; excludeId?: string }): Promise<ActionResult<DuplicateMatch[]>> {
  const user = await getCurrentUser();
  const scope = scopeFor(user);
  if (!user || !scope) return fail("Your session has expired — sign in again.");
  const ownerId = scope.ownerId ?? (probe.ownerId || null);
  try {
    return ok(await findDuplicateCustomers(ownerId, probe, probe.excludeId));
  } catch (err) {
    return handleError(err);
  }
}
