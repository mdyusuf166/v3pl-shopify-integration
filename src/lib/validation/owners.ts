import { z } from "zod";

/** Shared (client + server) validation for vendors and 3PL clients. */

export const OWNER_TYPES = ["VENDOR", "THREEPL_CLIENT"] as const;
export type OwnerTypeValue = (typeof OWNER_TYPES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const ownerCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, "Code must be at least 2 characters")
  .max(20, "Code must be 20 characters or fewer")
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, "Use letters, numbers and hyphens only");

export const ownerFormSchema = z.object({
  code: ownerCodeSchema,
  businessName: z.string().trim().min(2, "Business name is required").max(120),
  contactName: optionalText(120),
  email: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v.toLowerCase()))
    .pipe(z.email("Enter a valid email address").nullable())
    .nullable()
    .optional(),
  phone: optionalText(40),
  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(20),
  country: optionalText(80),
  notes: optionalText(2000),
  /** Operational charges apply to this owner's shipments only when enabled (NR-8, D-063). */
  chargesEnabled: z.boolean().optional(),
});

export type OwnerFormInput = z.input<typeof ownerFormSchema>;
export type OwnerFormValues = z.output<typeof ownerFormSchema>;

export const ownerListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ALL"]).default("ACTIVE"),
  page: z.coerce.number().int().min(1).default(1),
});

/** Presentation helpers shared by admin screens. */
export const OWNER_TYPE_META: Record<
  OwnerTypeValue,
  { singular: string; plural: string; basePath: string; userRole: "VENDOR" | "THREEPL_CLIENT"; portalPath: string }
> = {
  VENDOR: { singular: "Vendor", plural: "Vendors", basePath: "/admin/vendors", userRole: "VENDOR", portalPath: "/portal/vendor" },
  THREEPL_CLIENT: {
    singular: "3PL Client",
    plural: "3PL Clients",
    basePath: "/admin/3pl-clients",
    userRole: "THREEPL_CLIENT",
    portalPath: "/portal/3pl",
  },
};
