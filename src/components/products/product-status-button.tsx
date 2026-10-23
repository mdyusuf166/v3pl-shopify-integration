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
import { setProductStatusAction } from "@/server/actions/products";

export function ProductStatusButton({ id, status, name }: { id: string; status: "ACTIVE" | "ARCHIVED"; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const archiving = status === "ACTIVE";

  function confirm() {
    startTransition(async () => {
      const res = await setProductStatusAction(id, archiving ? "ARCHIVED" : "ACTIVE");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(archiving ? `${name} archived` : `${name} reactivated`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" />}>{archiving ? "Archive" : "Reactivate"}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{archiving ? `Archive ${name}?` : `Reactivate ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {archiving
              ? "Archived products cannot receive new stock or be added to new orders. Existing stock and history are kept."
              : "The product and its active SKUs become available for receiving and orders again."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={pending} variant={archiving ? "destructive" : "default"}>
            {pending && <Loader2 className="animate-spin" />}
            {archiving ? "Archive" : "Reactivate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
