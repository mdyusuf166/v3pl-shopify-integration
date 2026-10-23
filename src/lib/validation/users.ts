import { z } from "zod";

/** Shared (client + server) validation for platform user accounts. */

export const USER_ROLES = ["ADMIN", "WAREHOUSE", "SALES", "VENDOR", "THREEPL_CLIENT"] as const;
export const STAFF_ROLE_VALUES = ["ADMIN", "WAREHOUSE", "SALES"] as const;

/** Minimum password policy. Firebase enforces ≥ 6; we require a bit more. */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be 128 characters or fewer")
  .regex(/[a-zA-Z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const userProfileSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  phone: optionalText(40),
  notes: optionalText(2000),
});

/** Creating an account. `ownerId` is required for portal roles and forbidden for staff. */
export const userCreateSchema = userProfileSchema
  .extend({
    email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
    password: passwordSchema,
    role: z.enum(USER_ROLES),
    ownerId: z.string().trim().min(1).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const isPortal = data.role === "VENDOR" || data.role === "THREEPL_CLIENT";
    if (isPortal && !data.ownerId) {
      ctx.addIssue({ code: "custom", path: ["ownerId"], message: "Portal users must belong to a vendor or 3PL client" });
    }
    if (!isPortal && data.ownerId) {
      ctx.addIssue({ code: "custom", path: ["ownerId"], message: "Staff users cannot belong to an owner" });
    }
  });

export type UserCreateInput = z.input<typeof userCreateSchema>;
export type UserCreateValues = z.output<typeof userCreateSchema>;
export type UserProfileValues = z.output<typeof userProfileSchema>;

export const passwordResetSchema = z.object({ password: passwordSchema });

export const userStatusActionSchema = z.enum(["ACTIVE", "DISABLED", "BANNED"]);

export const userListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum([...USER_ROLES, "ALL"]).default("ALL"),
  status: z.enum(["ACTIVE", "DISABLED", "BANNED", "DELETED", "ALL"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
});
