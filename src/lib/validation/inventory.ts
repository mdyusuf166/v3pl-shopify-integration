import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const qty = z.coerce.number().int("Whole units only").positive("Quantity must be at least 1").max(1_000_000);

export const receivingLineSchema = z.object({
  variantId: z.string().min(1, "Choose a SKU"),
  locationId: z.string().min(1, "Choose a location"),
  quantity: qty,
});

export const receivingFormSchema = z.object({
  ownerId: z.string().min(1, "Choose the vendor or 3PL client"),
  warehouseId: z.string().min(1, "Choose a warehouse"),
  reference: optionalText(80),
  notes: optionalText(2000),
  receivedAt: z.coerce.date().optional(),
  lines: z
    .array(receivingLineSchema)
    .min(1, "Add at least one line")
    .max(500)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        const key = `${l.variantId}:${l.locationId}`;
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: [i, "variantId"], message: "Duplicate SKU + location line" });
        seen.add(key);
      });
    }),
});
export type ReceivingFormInput = z.input<typeof receivingFormSchema>;
export type ReceivingFormValues = z.output<typeof receivingFormSchema>;

/** Manual stock corrections (spec §19–20). Reason is mandatory. */
export const adjustmentKinds = ["ADJUSTMENT_IN", "ADJUSTMENT_OUT", "DAMAGE", "MISSING"] as const;
export type AdjustmentKind = (typeof adjustmentKinds)[number];

export const adjustmentFormSchema = z.object({
  variantId: z.string().min(1, "Choose a SKU"),
  warehouseId: z.string().min(1, "Choose a warehouse"),
  locationId: z.string().min(1, "Choose a location"),
  kind: z.enum(adjustmentKinds),
  quantity: qty,
  reason: z.string().trim().min(3, "A reason is required").max(200),
  notes: optionalText(2000),
});
export type AdjustmentFormInput = z.input<typeof adjustmentFormSchema>;
export type AdjustmentFormValues = z.output<typeof adjustmentFormSchema>;

/** Move stock between two locations of the same warehouse. */
export const moveFormSchema = z
  .object({
    variantId: z.string().min(1, "Choose a SKU"),
    warehouseId: z.string().min(1, "Choose a warehouse"),
    fromLocationId: z.string().min(1, "Choose the source location"),
    toLocationId: z.string().min(1, "Choose the destination location"),
    quantity: qty,
    notes: optionalText(500),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, { path: ["toLocationId"], message: "Choose a different destination" });
export type MoveFormInput = z.input<typeof moveFormSchema>;

export const transferLineSchema = z.object({
  variantId: z.string().min(1, "Choose a SKU"),
  sourceLocationId: z.string().min(1, "Choose the source location"),
  quantity: qty,
});

export const transferFormSchema = z
  .object({
    sourceWarehouseId: z.string().min(1, "Choose the source warehouse"),
    destWarehouseId: z.string().min(1, "Choose the destination warehouse"),
    reference: optionalText(80),
    notes: optionalText(2000),
    lines: z.array(transferLineSchema).min(1, "Add at least one line").max(500),
  })
  .refine((v) => v.sourceWarehouseId !== v.destWarehouseId, { path: ["destWarehouseId"], message: "Destination must differ from source" });
export type TransferFormInput = z.input<typeof transferFormSchema>;
export type TransferFormValues = z.output<typeof transferFormSchema>;

export const transferCompleteSchema = z.object({
  lines: z.array(z.object({ itemId: z.string().min(1), destLocationId: z.string().min(1, "Choose a location") })).min(1),
});
export type TransferCompleteInput = z.input<typeof transferCompleteSchema>;

export const inventoryListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  ownerId: z.string().trim().optional(),
  warehouseId: z.string().trim().optional(),
  lowStock: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export const movementListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  ownerId: z.string().trim().optional(),
  warehouseId: z.string().trim().optional(),
  type: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
});
