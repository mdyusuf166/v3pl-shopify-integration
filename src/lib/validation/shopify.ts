import { z } from "zod";
import { optionalText } from "@/lib/validation/common";

export const addStoreSchema = z.object({
  /** "casabella", "casabella.myshopify.com" or a full URL — normalised server-side. */
  shopDomain: z.string().trim().min(3, "Enter the store's myshopify.com domain").max(160),
  name: optionalText(80),
});
export type AddStoreInput = z.input<typeof addStoreSchema>;
export type AddStoreValues = z.output<typeof addStoreSchema>;

const optionalId = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

export const storeSettingsSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  ordersImportEnabled: z.boolean(),
  importTestOrders: z.boolean().default(false),
  /** ISO date (yyyy-mm-dd) or empty; orders created before it are not imported automatically. */
  ordersImportSince: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || !Number.isNaN(Date.parse(v)), "Enter a valid date")
    .nullable()
    .optional(),
  publishEnabled: z.boolean(),
  publishLocationId: optionalId,
  fulfilLocationId: optionalId,
  /** Ordered; the first entry is the default reservation warehouse. */
  warehouseIds: z.array(z.string().min(1)).max(50).default([]),
  /** Chosen default; moved to the front of warehouseIds on save. */
  defaultWarehouseId: optionalId,
});
export type StoreSettingsInput = z.input<typeof storeSettingsSchema>;
export type StoreSettingsFormValues = z.output<typeof storeSettingsSchema>;

export const mappingStatusValues = ["MATCHED", "UNMATCHED", "CONFLICT", "IGNORED"] as const;

export const mapVariantSchema = z.object({ mappingId: z.string().min(1), variantId: z.string().min(1, "Choose a V3PL SKU") });
export type MapVariantInput = z.input<typeof mapVariantSchema>;

export const importPreviewSchema = z.object({
  mappingIds: z.array(z.string().min(1)).min(1, "Select at least one Shopify variant").max(500),
  ownerId: z.string().min(1, "Choose the vendor or 3PL client that owns these products"),
  /** Per-Shopify-product owner overrides chosen in the preview. */
  ownerOverrides: z.record(z.string(), z.string().min(1)).default({}),
});
export type ImportPreviewInput = z.input<typeof importPreviewSchema>;

export const importConfirmSchema = z.object({
  items: z
    .array(
      z.object({
        shopifyProductId: z.string().min(1),
        ownerId: z.string().min(1),
        mappingIds: z.array(z.string().min(1)).min(1),
        /** Initial stock per mapping id (whole units); absent / 0 = data-only import for that SKU (D-067). */
        quantities: z.record(z.string(), z.coerce.number().int().min(0).max(1_000_000)).default({}),
      }),
    )
    .min(1, "Nothing selected")
    .max(50),
  /** V3PL warehouse + location that receives the initial stock. Required only when a quantity is entered. */
  destination: z.object({ warehouseId: z.string().min(1), locationId: z.string().min(1) }).nullable().optional(),
});
export type ImportConfirmInput = z.input<typeof importConfirmSchema>;

export const importSinceSchema = z.object({
  since: z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date"),
});
export type ImportSinceInput = z.input<typeof importSinceSchema>;
