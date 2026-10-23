import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "positive" | "neutral" | "warning" | "negative" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  positive: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  neutral: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  negative: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  muted: "border-border bg-muted text-muted-foreground",
};

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: "Active", tone: "positive" },
  INACTIVE: { label: "Inactive", tone: "muted" },
  DISABLED: { label: "Disabled", tone: "warning" },
  BANNED: { label: "Banned", tone: "negative" },
  DELETED: { label: "Deleted", tone: "muted" },
  ARCHIVED: { label: "Archived", tone: "muted" },
  PENDING: { label: "In transit", tone: "warning" },
  COMPLETED: { label: "Completed", tone: "positive" },
  CANCELLED: { label: "Cancelled", tone: "negative" },
  DRAFT: { label: "Draft", tone: "muted" },
  PREVIEW: { label: "Awaiting confirmation", tone: "warning" },
  FAILED: { label: "Failed", tone: "negative" },
  DISCARDED: { label: "Discarded", tone: "muted" },
  NEW: { label: "New", tone: "neutral" },
  CONFIRMED: { label: "Confirmed", tone: "positive" },
  SHIPPED: { label: "Shipped", tone: "positive" },
  IN_TRANSIT: { label: "In transit", tone: "neutral" },
  DELIVERED: { label: "Delivered", tone: "positive" },
  RETURNED: { label: "Returned", tone: "warning" },
  // Customer-facing order statuses (D-055)
  UNFULFILLED: { label: "Unfulfilled", tone: "warning" },
  PARTIALLY_FULFILLED: { label: "Partially fulfilled", tone: "neutral" },
  FULFILLED: { label: "Fulfilled", tone: "positive" },
};

/** Consistent status pill for owner/user (and later order/shipment) statuses. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge variant="outline" className={cn("font-medium", TONE_CLASS[meta.tone], className)}>
      {meta.label}
    </Badge>
  );
}
