"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncCustomersAction } from "@/server/actions/shopify";

/** "Sync customers now" (D-065): pulls the store's customers into the V3PL customer directory. */
export function SyncCustomersButton({ storeId, disabled }: { storeId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending || disabled}
      onClick={() =>
        start(async () => {
          const r = await syncCustomersAction(storeId);
          if (r.ok) (r.data.failed > 0 || !r.data.full ? toast.warning : toast.success)(r.data.message);
          else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Users />} Sync customers now
    </Button>
  );
}
