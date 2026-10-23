import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const warehouseCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, "Code is required")
  .max(12, "Code must be 12 characters or fewer")
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, "Use letters, numbers and hyphens only");

export const warehouseFormSchema = z.object({
  code: warehouseCodeSchema,
  name: z.string().trim().min(2, "Name is required").max(120),
  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(20),
  country: optionalText(80),
  notes: optionalText(2000),
});
export type WarehouseFormInput = z.input<typeof warehouseFormSchema>;
export type WarehouseFormValues = z.output<typeof warehouseFormSchema>;

const part = optionalText(20);

export const locationFormSchema = z
  .object({
    /** Optional explicit label; otherwise built from zone-rack-shelf-bin. */
    label: optionalText(40),
    zone: part,
    rack: part,
    shelf: part,
    bin: part,
    notes: optionalText(500),
  })
  .transform((v) => {
    const parts = [v.zone, v.rack, v.shelf, v.bin].filter((p): p is string => !!p);
    const label = (v.label ?? parts.join("-")).toUpperCase();
    return { ...v, label };
  })
  .refine((v) => v.label.length >= 1, { path: ["label"], message: "Enter a label or at least one of zone, rack, shelf, bin" })
  .refine((v) => /^[A-Z0-9][A-Z0-9._ -]*$/.test(v.label), { path: ["label"], message: "Label may contain letters, numbers, spaces, dots, underscores and hyphens" });

export type LocationFormInput = z.input<typeof locationFormSchema>;
export type LocationFormValues = z.output<typeof locationFormSchema>;
