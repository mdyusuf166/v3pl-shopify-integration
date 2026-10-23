"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/common/form-field";
import { importOrdersSinceAction, reconcileOrdersAction, retryOrderImportAction } from "@/server/actions/shopify";
import type { ReconcileSummary } from "@/server/services/shopify/orders-in";

const summarize = (r: ReconcileSummary) => `${r.scanned} checked — ${r.created} imported, ${r.updated} updated, ${r.cancelled} cancelled, ${r.unresolved} need attention, ${r.skipped} skipped${r.complete ? "" : " (time limit — run again to continue)"}`;

export function SyncOrdersButton({ storeId, disabled }: { storeId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending || disabled}
      onClick={() =>
        start(async () => {
          const r = await reconcileOrdersAction(storeId);
          if (r.ok) toast.success(`Orders synchronised: ${summarize(r.data)}`);
          else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync orders now
    </Button>
  );
}

export function ImportOrdersSinceDialog({ storeId, disabled, defaultSince }: { storeId: string; disabled?: boolean; defaultSince: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState(defaultSince);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" disabled={disabled} />}>
        <CalendarClock /> Import orders since…
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import existing Shopify orders</DialogTitle>
          <DialogDescription>
            One-off backfill of orders created on or after the date below, regardless of the import start date configured for the store. Shopify only exposes orders from the last 60 days. Orders already in V3PL are updated, never duplicated; unknown SKUs are reported, not guessed.
          </DialogDescription>
        </DialogHeader>
        <FormField id="ios-since" label="Created on or after" required>
          <Input id="ios-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} disabled={pending} />
        </FormField>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || !since}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await importOrdersSinceAction(storeId, { since });
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                toast.success(`Import finished: ${summarize(r.data)}`);
                setOpen(false);
                router.refresh();
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RetryOrderButton({ storeId, shopifyOrderId }: { storeId: string; shopifyOrderId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryOrderImportAction(storeId, shopifyOrderId);
          if (r.ok) (r.data.action === "unresolved" ? toast.error : toast.success)(r.data.message);
          else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RotateCw />} Retry
    </Button>
  );
}
