"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
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
import { deleteWarehouseAction } from "@/server/actions/warehouses";

/** Delete a warehouse that has no history (D-054); otherwise explains why and points to Deactivate. */
export function WarehouseDeleteButton({ id, code, name, blockers }: { id: string; code: string; name: string; blockers: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const canDelete = blockers.length === 0;

  function confirm() {
    startTransition(async () => {
      const res = await deleteWarehouseAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Warehouse ${res.data.code} deleted`);
      setOpen(false);
      router.push("/admin/warehouses");
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" className="text-destructive hover:text-destructive" />}>
        <Trash2 /> Delete
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{canDelete ? `Delete ${name} (${code})?` : `${name} cannot be deleted`}</AlertDialogTitle>
          <AlertDialogDescription>
            {canDelete
              ? "The warehouse and its locations are removed permanently. Nothing references them yet, so no history is lost."
              : "It is part of records that must be kept for inventory and order integrity. Deactivate it instead: inactive warehouses cannot receive or ship, while history stays intact."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!canDelete && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{canDelete ? "Cancel" : "Close"}</AlertDialogCancel>
          {canDelete && (
            <AlertDialogAction onClick={confirm} disabled={pending} variant="destructive">
              {pending && <Loader2 className="animate-spin" />}
              Delete
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
