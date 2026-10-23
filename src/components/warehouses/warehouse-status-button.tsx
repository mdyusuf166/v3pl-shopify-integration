"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { setWarehouseStatusAction } from "@/server/actions/warehouses";

export function WarehouseStatusButton({ id, status, name }: { id: string; status: "ACTIVE" | "INACTIVE"; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const deactivating = status === "ACTIVE";

  function confirm() {
    startTransition(async () => {
      const res = await setWarehouseStatusAction(id, deactivating ? "INACTIVE" : "ACTIVE");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(deactivating ? `${name} deactivated` : `${name} reactivated`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" />}>{deactivating ? "Deactivate" : "Reactivate"}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{deactivating ? `Deactivate ${name}?` : `Reactivate ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {deactivating ? "An inactive warehouse cannot receive, ship or hold stock. Deactivation is only allowed when it holds no stock." : "The warehouse becomes available for receiving, transfers and orders again."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={pending} variant={deactivating ? "destructive" : "default"}>
            {pending && <Loader2 className="animate-spin" />}
            {deactivating ? "Deactivate" : "Reactivate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
