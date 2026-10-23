"use server";

import { revalidatePath } from "next/cache";
import {
  financialStatusFormSchema,
  manualOrderFormSchema,
  pickFormSchema,
  returnInspectSchema,
  returnReceiveSchema,
  shipFormSchema,
  trackingFormSchema,
  type ManualOrderFormInput,
  type PickFormInput,
  type ReturnInspectInput,
  type ReturnReceiveInput,
  type ShipFormInput,
} from "@/lib/validation/orders";
import type { ShipmentStatus } from "@/generated/prisma/client";
import { requireRole, requireStaff, requirePortalRole } from "@/server/auth/guards";
import { FulfillmentServiceError, cancelFulfillment, markPacked, shipFulfillment, startPicking, updateShipmentStatus, updateShipmentTracking } from "@/server/services/fulfillment";
import { InventoryError } from "@/server/services/inventory";
import { OrderServiceError, addOrderNote, cancelOrder, clearAttention, confirmOrder, createOrder, deleteOrder, reserveOrder, setFinancialStatus } from "@/server/services/orders";
import { ReturnServiceError, inspectReturn, receiveReturn } from "@/server/services/returns";
import { CustomerServiceError, resolveOrderCustomer } from "@/server/services/customers";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof OrderServiceError || err instanceof FulfillmentServiceError || err instanceof ReturnServiceError || err instanceof InventoryError) return fail(err.message);
  if (err instanceof CustomerServiceError) return err.field ? fail(err.message, { [err.field]: err.message }) : fail(err.message);
  console.error("[orders action]", err);
  return fail("Something went wrong. Please try again.");
}

function revalidateOrder(orderId?: string) {
  revalidatePath("/admin/orders");
  revalidatePath("/admin/fulfillment");
  revalidatePath("/admin/inventory");
  revalidatePath("/admin");
  if (orderId) revalidatePath(`/admin/orders/${orderId}`);
}

export type OrderCreated = { id: string; orderNumber: string; short: number; customer: { id: string; name: string | null; created: boolean; reused: boolean } | null };

export async function createManualOrderAction(input: ManualOrderFormInput): Promise<ActionResult<OrderCreated>> {
  const actor = await requireRole("ADMIN", "SALES", "WAREHOUSE");
  const parsed = manualOrderFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const { lines, reserve, warehouseId, shippingMethod, notes, tags, customerId, saveCustomer, ...shipTo } = parsed.data;
    // Staff manual orders: any directory customer may be picked; a customer saved from here is a company customer (ownerId NULL).
    const customer = await resolveOrderCustomer({ ownerId: undefined }, { customerId, saveCustomer, shipTo, ownerIdForNew: null, source: "ORDER" }, actor.id);
    const res = await createOrder({ source: "MANUAL", ...shipTo, customerId: customer.customerId, warehouseId, shippingMethod, notes, tags, reserve, lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice ?? null })) }, actor.id);
    revalidateOrder(res.orderId);
    revalidatePath("/admin/customers");
    return ok({ id: res.orderId, orderNumber: res.orderNumber, short: res.reservation.short.length, customer: customer.customerId ? { id: customer.customerId, name: customer.customerName, created: customer.created, reused: customer.reused } : null });
  } catch (err) {
    return handleError(err);
  }
}

/** 3PL portal: submit a fulfilment order for the client's own SKUs (D-011). */
export async function createPortalOrderAction(input: ManualOrderFormInput): Promise<ActionResult<OrderCreated>> {
  const user = await requirePortalRole("THREEPL_CLIENT");
  const parsed = manualOrderFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const { lines, warehouseId, shippingMethod, notes, customerId, saveCustomer, ...shipTo } = parsed.data;
    // 3PL portal: customers are always the client's own (scope = session owner); a foreign customerId is refused.
    const customer = await resolveOrderCustomer({ ownerId: user.ownerId }, { customerId, saveCustomer, shipTo, ownerIdForNew: user.ownerId, source: "THREEPL_PORTAL" }, user.id);
    const res = await createOrder({ source: "THREEPL_PORTAL", ...shipTo, customerId: customer.customerId, warehouseId, shippingMethod, notes, submittedByOwnerId: user.ownerId, reserve: true, lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) }, user.id);
    revalidatePath("/portal/3pl/orders");
    revalidatePath("/portal/3pl/customers");
    revalidateOrder(res.orderId);
    return ok({ id: res.orderId, orderNumber: res.orderNumber, short: res.reservation.short.length, customer: customer.customerId ? { id: customer.customerId, name: customer.customerName, created: customer.created, reused: customer.reused } : null });
  } catch (err) {
    return handleError(err);
  }
}

export async function reserveOrderAction(orderId: string): Promise<ActionResult<{ short: number }>> {
  const actor = await requireRole("ADMIN", "SALES", "WAREHOUSE");
  try {
    const outcome = await reserveOrder(orderId, actor.id);
    revalidateOrder(orderId);
    return ok({ short: outcome.short.length });
  } catch (err) {
    return handleError(err);
  }
}

export async function confirmOrderAction(orderId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "SALES");
  try {
    await confirmOrder(orderId, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function cancelOrderAction(orderId: string, reason: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "SALES");
  if (reason.trim().length < 3) return fail("Give a short reason.", { reason: "Required" });
  try {
    await cancelOrder(orderId, reason.trim(), actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

/** Hard delete (D-054): only orders with no ledger / fulfilment history and not from Shopify. */
export async function deleteOrderAction(orderId: string): Promise<ActionResult<{ orderNumber: string }>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await deleteOrder(orderId, actor.id);
    revalidateOrder();
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

export async function clearAttentionAction(orderId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "SALES", "WAREHOUSE");
  try {
    await clearAttention(orderId, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function setFinancialStatusAction(orderId: string, input: unknown): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "SALES");
  const parsed = financialStatusFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    await setFinancialStatus(orderId, parsed.data.financialStatus, parsed.data.invoiceReference ?? null, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function addOrderNoteAction(orderId: string, message: string): Promise<ActionResult<undefined>> {
  const actor = await requireStaff();
  const text = message.trim();
  if (text.length < 1 || text.length > 2000) return fail("Write a note between 1 and 2000 characters.");
  try {
    await addOrderNote(orderId, text, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

// --- Fulfilment -------------------------------------------------------------

export async function startPickingAction(orderId: string, input: PickFormInput): Promise<ActionResult<{ fulfillmentId: string }>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = pickFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const f = await startPicking({ orderId, warehouseId: parsed.data.warehouseId, lines: parsed.data.lines }, actor.id);
    revalidateOrder(orderId);
    return ok({ fulfillmentId: f.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function markPackedAction(fulfillmentId: string, orderId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  try {
    await markPacked(fulfillmentId, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function cancelFulfillmentAction(fulfillmentId: string, orderId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  try {
    await cancelFulfillment(fulfillmentId, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function shipFulfillmentAction(fulfillmentId: string, orderId: string, input: ShipFormInput): Promise<ActionResult<{ shipmentId: string }>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = shipFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const s = await shipFulfillment(fulfillmentId, parsed.data, actor.id);
    revalidateOrder(orderId);
    return ok({ shipmentId: s.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateTrackingAction(shipmentId: string, orderId: string, input: unknown): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = trackingFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    await updateShipmentTracking(shipmentId, parsed.data, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function updateShipmentStatusAction(shipmentId: string, orderId: string, status: ShipmentStatus): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  if (!["SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(status)) return fail("Invalid status.");
  try {
    await updateShipmentStatus(shipmentId, status, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

// --- Returns ----------------------------------------------------------------

export async function receiveReturnAction(orderId: string, input: ReturnReceiveInput): Promise<ActionResult<{ returnId: string }>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = returnReceiveSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const r = await receiveReturn({ orderId, ...parsed.data }, actor.id);
    revalidateOrder(orderId);
    return ok({ returnId: r.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function inspectReturnAction(returnId: string, orderId: string, input: ReturnInspectInput): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "WAREHOUSE");
  const parsed = returnInspectSchema.safeParse(input);
  if (!parsed.success) return fail("Decide the condition and location for every line.", zodFieldErrors(parsed.error.issues));
  try {
    await inspectReturn(returnId, parsed.data, actor.id);
    revalidateOrder(orderId);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}
