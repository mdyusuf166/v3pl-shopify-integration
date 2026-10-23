import { z } from "zod";

/** Operational charges + settlement ledger forms (NR-8 / NR-9, D-063). */

export const CHARGE_TYPES = ["PICKING", "PACKING", "SHIPPING", "STORAGE", "FULFILLMENT", "SERVICE", "UTILITY", "OTHER"] as const;
export const CHARGE_BASES = ["PER_ORDER", "PER_SHIPMENT", "PER_UNIT"] as const;

export const CHARGE_TYPE_LABELS: Record<(typeof CHARGE_TYPES)[number], string> = {
  PICKING: "Picking",
  PACKING: "Packing",
  SHIPPING: "Shipping",
  STORAGE: "Storage",
  FULFILLMENT: "Fulfillment",
  SERVICE: "Service",
  UTILITY: "Utility",
  OTHER: "Other",
};

export const CHARGE_BASIS_LABELS: Record<(typeof CHARGE_BASES)[number], string> = {
  PER_ORDER: "Per order",
  PER_SHIPMENT: "Per shipment",
  PER_UNIT: "Per unit",
};

const money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 12.50")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

const optionalInt = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null || v === "" ? null : Number(v)))
  .pipe(z.number().int("Whole grams only").min(0).max(100_000_000).nullable());

const optionalDecimal = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null || v === "" ? null : Number(v)))
  .pipe(z.number().min(0).max(100_000).nullable());

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const chargeRuleFormSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(120),
    chargeType: z.enum(CHARGE_TYPES),
    basis: z.enum(CHARGE_BASES),
    amount: money,
    active: z.boolean().default(true),
    /** "" = every owner type; otherwise VENDOR / THREEPL_CLIENT. Ignored when a specific owner is chosen. */
    ownerType: z.enum(["", "VENDOR", "THREEPL_CLIENT"]).default(""),
    /** Specific owner (id) or "" for all owners in scope. */
    ownerId: z.string().trim().max(64).default(""),
    minWeightGrams: optionalInt,
    maxWeightGrams: optionalInt,
    minLongestCm: optionalDecimal,
    maxLongestCm: optionalDecimal,
    notes: optionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.minWeightGrams !== null && v.maxWeightGrams !== null && v.minWeightGrams > v.maxWeightGrams) ctx.addIssue({ code: "custom", path: ["maxWeightGrams"], message: "Max weight must be ≥ min weight" });
    if (v.minLongestCm !== null && v.maxLongestCm !== null && v.minLongestCm > v.maxLongestCm) ctx.addIssue({ code: "custom", path: ["maxLongestCm"], message: "Max length must be ≥ min length" });
  });

export type ChargeRuleFormInput = z.input<typeof chargeRuleFormSchema>;
export type ChargeRuleFormValues = z.output<typeof chargeRuleFormSchema>;

/** Manual settlement kinds, worded from V3PL's point of view (D-063). */
export const SETTLEMENT_KINDS = ["PAYMENT_TO_OWNER", "PAYMENT_FROM_OWNER", "ADJUSTMENT_PAYABLE", "ADJUSTMENT_PAYABLE_DECREASE", "ADJUSTMENT_RECEIVABLE", "ADJUSTMENT_RECEIVABLE_DECREASE"] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

export const SETTLEMENT_KIND_LABELS: Record<SettlementKind, { label: string; hint: string }> = {
  PAYMENT_TO_OWNER: { label: "Payment made to owner (reduces payable)", hint: "V3PL paid the vendor / 3PL client. Affects the payable side only." },
  PAYMENT_FROM_OWNER: { label: "Payment received from owner (reduces receivable)", hint: "The vendor / 3PL client paid V3PL. Affects the receivable side only." },
  ADJUSTMENT_PAYABLE: { label: "Adjustment — increase payable to owner", hint: "Authorised correction in the owner's favour (e.g. a credit). Payable side only." },
  ADJUSTMENT_PAYABLE_DECREASE: { label: "Adjustment — decrease payable to owner", hint: "Authorised write-down of what V3PL owes. Payable side only." },
  ADJUSTMENT_RECEIVABLE: { label: "Adjustment — increase receivable from owner", hint: "Authorised correction in V3PL's favour (e.g. an agreed fee). Receivable side only." },
  ADJUSTMENT_RECEIVABLE_DECREASE: { label: "Adjustment — decrease receivable from owner", hint: "Authorised write-off of what the owner owes. Receivable side only." },
};

export const settlementFormSchema = z.object({
  kind: z.enum(SETTLEMENT_KINDS),
  amount: money,
  occurredAt: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? new Date(v) : null))
    .pipe(z.date().nullable()),
  reference: optionalText(120),
  notes: optionalText(1000),
  /** Client-generated once per form instance: a double submit records one entry (D-063). */
  idempotencyKey: z.string().trim().min(8).max(80),
});

export type SettlementFormInput = z.input<typeof settlementFormSchema>;
export type SettlementFormValues = z.output<typeof settlementFormSchema>;

export const LEDGER_TYPE_LABELS = { PRODUCT_VALUE: "Product value", VENDOR_PAYABLE: "Vendor payable", CHARGE: "Charge", PAYMENT: "Payment", ADJUSTMENT: "Adjustment" } as const;

/** Admin: manual vendor payable allocated against one received line (D-064). */
export const vendorPayableFormSchema = z.object({
  receivingItemId: z.string().trim().min(1, "Choose a received line"),
  quantity: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().int("Whole units only").min(1, "Quantity must be at least 1")),
  /** Blank = the variant's current wholesale price; the value used is frozen on the entry either way. */
  unitAmount: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null))
    .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 12.50").nullable()),
  reference: optionalText(120),
  notes: optionalText(1000),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export type VendorPayableFormInput = z.input<typeof vendorPayableFormSchema>;
export type VendorPayableFormValues = z.output<typeof vendorPayableFormSchema>;
