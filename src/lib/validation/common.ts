import { z } from "zod";

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/** Money as a decimal string with up to 2 decimals; empty → null. */
export const optionalMoney = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : v.trim()))
  .transform((v) => (v === "" ? null : v.replace(/^\$/, "")))
  .refine((v) => v === null || /^-?\d{1,10}(\.\d{1,2})?$/.test(v), "Enter an amount like 12.50")
  .nullable()
  .optional();

export const positiveInt = z.coerce.number().int("Whole units only").positive("Must be at least 1").max(1_000_000);
