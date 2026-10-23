import { z } from "zod";

export const REPORT_TYPES = ["activity", "orders", "shipments", "returns", "inventory"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional();

/** Shared report filters; `ownerId` is honoured for staff only (portal scope comes from the session). */
export const reportQuerySchema = z.object({
  report: z.enum(REPORT_TYPES).default("activity"),
  from: isoDate,
  to: isoDate,
  warehouseId: z.string().trim().optional(),
  ownerId: z.string().trim().optional(),
  status: z.string().trim().optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type ReportQuery = z.output<typeof reportQuerySchema>;

/** Convert the parsed query into a service scope (inclusive end of day for `to`). */
export function scopeFromQuery(q: { from?: string; to?: string; warehouseId?: string }, ownerId?: string) {
  return {
    ownerId,
    warehouseId: q.warehouseId || undefined,
    from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined,
    to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined,
  };
}

export const REPORT_LABELS: Record<ReportType, { title: string; description: string }> = {
  activity: { title: "SKU activity", description: "Units received, shipped, returned, damaged, missing and adjusted per SKU in the period, with current stock." },
  orders: { title: "Orders summary", description: "Order counts by status and source, and units ordered, shipped, cancelled and returned in the period." },
  shipments: { title: "Shipments", description: "Every shipment in the period with carrier, tracking and status." },
  returns: { title: "Returns", description: "Returns received in the period and their inspection outcome." },
  inventory: { title: "Inventory snapshot", description: "Current stock per SKU and warehouse (not affected by the date range)." },
};
