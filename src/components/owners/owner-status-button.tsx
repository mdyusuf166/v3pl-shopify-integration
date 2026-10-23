"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { OwnerStatus, OwnerType } from "@/generated/prisma/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { OWNER_TYPE_META } from "@/lib/validation/owners";
import { setOwnerStatusAction } from "@/server/actions/owners";

type Props = { type: OwnerType; id: string; status: OwnerStatus; businessName: string };

export function OwnerStatusButton({ type, id, status, businessName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const deactivating = status === "ACTIVE";
  const noun = OWNER_TYPE_META[type].singular.toLowerCase();

  function confirm() {
    startTransition(async () => {
      const result = await setOwnerStatusAction(type, id, deactivating ? "INACTIVE" : "ACTIVE");
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(deactivating ? `${businessName} deactivated` : `${businessName} reactivated`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant={deactivating ? "outline" : "default"} />}>
        {deactivating ? "Deactivate" : "Reactivate"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{deactivating ? `Deactivate ${businessName}?` : `Reactivate ${businessName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {deactivating
              ? `All portal users of this ${noun} lose access immediately and no new activity can be recorded against it. Existing history is kept. You can reactivate at any time.`
              : `Portal users of this ${noun} regain access and it becomes available for new activity.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={deactivating ? "destructive" : "default"} onClick={confirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {deactivating ? "Deactivate" : "Reactivate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
