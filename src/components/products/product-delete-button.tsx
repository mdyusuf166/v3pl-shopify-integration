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
import { deleteProductAction, setProductStatusAction } from "@/server/actions/products";

type Props = {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  /** Reasons the product cannot be hard-deleted (computed on the server, D-054). */
  blockers: string[];
  /** Where to go after a successful delete. */
  redirectTo?: string;
  /** Render as a dropdown-menu item instead of a button. */
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Delete with a clear fallback: products with history cannot be removed, so the dialog explains
 * why and offers Archive instead (keeps stock, orders and ledger consistent).
 */
export function ProductDeleteButton({ id, name, status, blockers, redirectTo, trigger, open: openProp, onOpenChange }: Props) {
  const router = useRouter();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [pending, startTransition] = useTransition();
  const canDelete = blockers.length === 0;

  function confirmDelete() {
    startTransition(async () => {
      const res = await deleteProductAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${res.data.name} deleted`);
      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    });
  }

  function archive() {
    startTransition(async () => {
      const res = await setProductStatusAction(id, "ARCHIVED");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} archived`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <AlertDialogTrigger render={trigger} />
      ) : (
        <AlertDialogTrigger render={<Button variant="outline" className="text-destructive hover:text-destructive" />}>
          <Trash2 /> Delete
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{canDelete ? `Delete ${name}?` : `${name} cannot be deleted`}</AlertDialogTitle>
          <AlertDialogDescription>
            {canDelete
              ? "This permanently removes the product and its SKUs. Nothing references them yet, so no history is lost. This cannot be undone."
              : "Its SKUs are part of records that must be kept for inventory and order integrity. Archive it instead: archived products are hidden from receiving and new orders, while stock and history stay intact."}
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
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          {canDelete ? (
            <AlertDialogAction onClick={confirmDelete} disabled={pending} variant="destructive">
              {pending && <Loader2 className="animate-spin" />}
              Delete
            </AlertDialogAction>
          ) : status === "ACTIVE" ? (
            <AlertDialogAction onClick={archive} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Archive instead
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
