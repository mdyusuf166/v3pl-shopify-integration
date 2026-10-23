"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { retryJobAction, retryWebhookEventAction } from "@/server/actions/shopify";

export function RetryEventButton({ eventId, storeId }: { eventId: string; storeId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryWebhookEventAction(eventId, storeId);
          if (r.ok) toast.success(r.data.status ? `Event ${r.data.status.toLowerCase().replace("_", " ")}` : "Event was already handled");
          else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RotateCw />} Retry
    </Button>
  );
}

export function RetryJobButton({ jobId, storeId }: { jobId: string; storeId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryJobAction(jobId, storeId);
          if (r.ok) toast.success(r.data.status ? `Job ${r.data.status.toLowerCase().replace("_", " ")}` : "Job is not ready to run yet");
          else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RotateCw />} Retry
    </Button>
  );
}
