import { z } from "zod";
import { optionalText } from "@/lib/validation/common";

/** Customer directory (D-060): operational records, shared by admin, vendor and 3PL screens. */

export const optionalEmail = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v.toLowerCase()))
  .pipe(z.email("Enter a valid email").nullable())
  .nullable()
  .optional();

/** Digits only, for duplicate matching; empty when fewer than 6 digits remain. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D+/g, "");
  return digits.length >= 6 ? digits : null;
}

export const customerFormSchema = z.object({
  /** Admin only: vendor / 3PL client the customer belongs to; empty = V3PL company customer. Portal users never send it. */
  ownerId: z.string().trim().nullable().optional(),
  name: z.string().trim().min(1, "Customer name is required").max(120),
  email: optionalEmail,
  phone: optionalText(40),
  shipName: optionalText(120),
  shipCompany: optionalText(120),
  shipAddress1: optionalText(160),
  shipAddress2: optionalText(160),
  shipCity: optionalText(80),
  shipProvince: optionalText(80),
  shipZip: optionalText(20),
  shipCountry: optionalText(80),
  shipPhone: optionalText(40),
  billName: optionalText(120),
  billCompany: optionalText(120),
  billAddress1: optionalText(160),
  billAddress2: optionalText(160),
  billCity: optionalText(80),
  billProvince: optionalText(80),
  billZip: optionalText(20),
  billCountry: optionalText(80),
  notes: optionalText(2000),
});
export type CustomerFormInput = z.input<typeof customerFormSchema>;
export type CustomerFormValues = z.output<typeof customerFormSchema>;

export const customerListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  ownerId: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export const CUSTOMER_SOURCE_LABEL: Record<string, string> = {
  MANUAL: "Added manually",
  ORDER: "From an order",
  THREEPL_PORTAL: "3PL portal",
  SHOPIFY: "Shopify",
  CSV_IMPORT: "CSV import",
};
