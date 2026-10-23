"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncCatalogAction } from "@/server/actions/shopify";

export function SyncCatalogButton({ storeId, disabled }: { storeId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending || disabled}
      onClick={() =>
        start(async () => {
          const r = await syncCatalogAction(storeId);
          if (r.ok) {
            const s = r.data.summary;
            toast.success(`${r.data.seen} Shopify variants read (${r.data.mode})${r.data.full ? "" : " — partial"}: ${s.MATCHED} matched, ${s.UNMATCHED} unmatched, ${s.CONFLICT} conflicts, ${s.IGNORED} ignored`);
          } else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync products now
    </Button>
  );
}
