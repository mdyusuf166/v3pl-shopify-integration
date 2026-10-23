import type { ShopifyJobStatus, ShopifyStoreStatus, ShopifySyncStatus, ShopifyWebhookEventStatus } from "@/generated/prisma/client";
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

const STORE: Record<ShopifyStoreStatus, { label: string; tone: Tone }> = {
  PENDING_INSTALL: { label: "Waiting for authorization", tone: "warning" },
  CONNECTED: { label: "Connected", tone: "positive" },
  NEEDS_REAUTH: { label: "Needs reconnect", tone: "negative" },
  UNINSTALLED: { label: "Uninstalled in Shopify", tone: "negative" },
  DISCONNECTED: { label: "Disconnected", tone: "muted" },
};

const SYNC: Record<ShopifySyncStatus, { label: string; tone: Tone }> = {
  SUCCESS: { label: "OK", tone: "positive" },
  FAILED: { label: "Failed", tone: "negative" },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "warning" },
  SKIPPED: { label: "Skipped", tone: "muted" },
};

const EVENT: Record<ShopifyWebhookEventStatus, { label: string; tone: Tone }> = {
  RECEIVED: { label: "Received", tone: "neutral" },
  PROCESSING: { label: "Processing", tone: "neutral" },
  PROCESSED: { label: "Processed", tone: "positive" },
  FAILED: { label: "Failed", tone: "negative" },
  SKIPPED_DUPLICATE: { label: "Duplicate", tone: "muted" },
  SKIPPED_STALE: { label: "Outdated", tone: "muted" },
  IGNORED: { label: "Ignored", tone: "muted" },
};

const JOB: Record<ShopifyJobStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Pending", tone: "neutral" },
  RUNNING: { label: "Running", tone: "neutral" },
  DONE: { label: "Done", tone: "positive" },
  FAILED: { label: "Failed", tone: "negative" },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "warning" },
};

function Pill({ meta, className }: { meta: { label: string; tone: Tone }; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", TONE_CLASS[meta.tone], className)}>
      {meta.label}
    </Badge>
  );
}

export function StoreStatusBadge({ status, className }: { status: ShopifyStoreStatus; className?: string }) {
  return <Pill meta={STORE[status]} className={className} />;
}
export function SyncStatusBadge({ status, className }: { status: ShopifySyncStatus; className?: string }) {
  return <Pill meta={SYNC[status]} className={className} />;
}
export function EventStatusBadge({ status, className }: { status: ShopifyWebhookEventStatus; className?: string }) {
  return <Pill meta={EVENT[status]} className={className} />;
}
export function JobStatusBadge({ status, className }: { status: ShopifyJobStatus; className?: string }) {
  return <Pill meta={JOB[status]} className={className} />;
}
