import { z } from "zod";
import { PRESENTED_STATUSES } from "@/lib/order-presentation";
import { optionalMoney, optionalText, positiveInt } from "@/lib/validation/common";

export const ORDER_STATUSES = ["DRAFT", "NEW", "CONFIRMED", "CANCELLED", "COMPLETED"] as const;
export const FULFILLMENT_STATUSES = ["UNFULFILLED", "RESERVED", "PICKING", "PACKED", "PARTIALLY_SHIPPED", "SHIPPED", "FULFILLED"] as const;
export const SHIPMENT_STATUSES = ["PENDING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED"] as const;
export const FINANCIAL_STATUSES = ["NOT_INVOICED", "INVOICED", "PAID", "PARTIALLY_PAID", "OUTSTANDING"] as const;
export const ORDER_SOURCES = ["MANUAL", "CSV_IMPORT", "SHOPIFY", "THREEPL_PORTAL"] as const;

export const shipToSchema = z.object({
  customerName: optionalText(120),
  customerEmail: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v.toLowerCase()))
    .pipe(z.email("Enter a valid email").nullable())
    .nullable()
    .optional(),
  customerPhone: optionalText(40),
  shipName: optionalText(120),
  shipCompany: optionalText(120),
  shipAddress1: optionalText(160),
  shipAddress2: optionalText(160),
  shipCity: optionalText(80),
  shipProvince: optionalText(80),
  shipZip: optionalText(20),
  shipCountry: optionalText(80),
  shipPhone: optionalText(40),
});

export const orderLineSchema = z.object({
  variantId: z.string().min(1, "Choose a SKU"),
  quantity: positiveInt,
  unitPrice: optionalMoney,
});

/** Manual (admin/sales) and 3PL-portal order creation. */
export const manualOrderFormSchema = shipToSchema.extend({
  /** Directory customer picked in the form (D-060); verified against the session scope server-side. */
  customerId: z.string().trim().nullable().optional(),
  /** Save the typed customer/ship-to as a new directory record (an exact e-mail/phone match is reused instead). */
  saveCustomer: z.boolean().default(false),
  warehouseId: z.string().min(1, "Choose the warehouse that will fulfil this order"),
  shippingMethod: optionalText(80),
  notes: optionalText(2000),
  tags: optionalText(200),
  reserve: z.boolean().default(true),
  lines: z
    .array(orderLineSchema)
    .min(1, "Add at least one line")
    .max(500)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        if (seen.has(l.variantId)) ctx.addIssue({ code: "custom", path: [i, "variantId"], message: "SKU already on the order — change the quantity instead" });
        seen.add(l.variantId);
      });
    }),
});
export type ManualOrderFormInput = z.input<typeof manualOrderFormSchema>;
export type ManualOrderFormValues = z.output<typeof manualOrderFormSchema>;

export const pickFormSchema = z.object({
  warehouseId: z.string().min(1, "Choose a warehouse"),
  lines: z.array(z.object({ orderItemId: z.string().min(1), quantity: positiveInt })).min(1, "Choose at least one line to pick"),
});
export type PickFormInput = z.input<typeof pickFormSchema>;

export const shipFormSchema = z.object({
  carrier: z.string().trim().min(1, "Carrier is required").max(80),
  service: optionalText(80),
  trackingNumber: optionalText(120),
  trackingUrl: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .pipe(z.url("Enter a full URL").nullable())
    .nullable()
    .optional(),
  shippedAt: z.coerce.date().optional(),
  notes: optionalText(500),
});
export type ShipFormInput = z.input<typeof shipFormSchema>;

export const trackingFormSchema = shipFormSchema.pick({ carrier: true, service: true, trackingNumber: true, trackingUrl: true });

export const returnReceiveSchema = z.object({
  warehouseId: z.string().min(1, "Choose the warehouse receiving the return"),
  reference: optionalText(80),
  reason: optionalText(200),
  notes: optionalText(2000),
  lines: z.array(z.object({ orderItemId: z.string().min(1), quantity: positiveInt })).min(1, "Choose at least one line"),
});
export type ReturnReceiveInput = z.input<typeof returnReceiveSchema>;

export const returnInspectSchema = z.object({
  lines: z
    .array(
      z.object({
        returnItemId: z.string().min(1),
        condition: z.enum(["SELLABLE", "DAMAGED"]),
        locationId: z.string().min(1, "Choose a location"),
        notes: optionalText(300),
      }),
    )
    .min(1),
});
export type ReturnInspectInput = z.input<typeof returnInspectSchema>;

export const financialStatusFormSchema = z.object({
  financialStatus: z.enum(FINANCIAL_STATUSES),
  invoiceReference: optionalText(80),
});

export const orderListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  /** Default ALL (QA ORD-07): completed orders must never look like they disappeared. */
  status: z.enum([...ORDER_STATUSES, "ALL", "OPEN"]).default("ALL"),
  fulfillmentStatus: z.enum([...FULFILLMENT_STATUSES, "ALL"]).default("ALL"),
  /** Customer-facing status (D-055). */
  view: z.enum([...PRESENTED_STATUSES, "ALL"]).default("ALL"),
  source: z.enum([...ORDER_SOURCES, "ALL"]).default("ALL"),
  ownerId: z.string().trim().optional(),
  warehouseId: z.string().trim().optional(),
  needsAttention: z.coerce.boolean().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type OrderListQuery = z.output<typeof orderListQuerySchema>;

export const exportFiltersSchema = z.object({
  status: z.enum([...ORDER_STATUSES, "ALL"]).default("ALL"),
  fulfillmentStatus: z.enum([...FULFILLMENT_STATUSES, "ALL"]).default("ALL"),
  shipmentStatus: z.enum([...SHIPMENT_STATUSES, "ALL"]).default("ALL"),
  source: z.enum([...ORDER_SOURCES, "ALL"]).default("ALL"),
  ownerId: z.string().trim().optional(),
  warehouseId: z.string().trim().optional(),
  shopifyStoreId: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});
export type ExportFilters = z.output<typeof exportFiltersSchema>;

export const importOptionsSchema = z.object({
  defaultWarehouseId: z.string().min(1, "Choose the default warehouse"),
  reserve: z.boolean().default(true),
});
export type ImportOptions = z.output<typeof importOptionsSchema>;
