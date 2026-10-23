"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { FinancialStatus, OrderStatus } from "@/generated/prisma/client";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/common/native-select";
import { FINANCIAL_STATUSES } from "@/lib/validation/orders";
import { addOrderNoteAction, cancelOrderAction, clearAttentionAction, confirmOrderAction, deleteOrderAction, reserveOrderAction, setFinancialStatusAction } from "@/server/actions/orders";

type Props = {
  orderId: string;
  orderNumber?: string;
  status: OrderStatus;
  needsAttention: boolean;
  unreserved: number;
  financialStatus: FinancialStatus;
  invoiceReference: string | null;
  canManage: boolean;
  canOperate: boolean;
  /** Admin: reasons the order cannot be hard-deleted (D-054). Undefined hides the Delete button. */
  deleteBlockers?: string[];
};

export function OrderActions({ orderId, orderNumber, status, needsAttention, unreserved, financialStatus, invoiceReference, canManage, canOperate, deleteBlockers }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [finOpen, setFinOpen] = useState(false);
  const [fin, setFin] = useState<FinancialStatus>(financialStatus);
  const [invoice, setInvoice] = useState(invoiceReference ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Failed");
      else {
        toast.success(success);
        after?.();
        router.refresh();
      }
    });
  }
  const open = status === "NEW" || status === "CONFIRMED";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canOperate && open && unreserved > 0 && (
        <Button variant="outline" disabled={pending} onClick={() => run(() => reserveOrderAction(orderId), "Reservation attempted")}>
          Reserve now
        </Button>
      )}
      {canManage && status === "NEW" && (
        <Button variant="outline" disabled={pending} onClick={() => run(() => confirmOrderAction(orderId), "Order confirmed")}>
          Confirm
        </Button>
      )}
      {canOperate && needsAttention && (
        <Button variant="outline" disabled={pending} onClick={() => run(() => clearAttentionAction(orderId), "Attention flag cleared")}>
          Clear attention
        </Button>
      )}
      {canManage && (
        <Dialog open={finOpen} onOpenChange={setFinOpen}>
          <DialogTrigger render={<Button variant="outline" />}>Financial status</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Financial status</DialogTitle>
              <DialogDescription>Manual tracking only — no accounting integration yet.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="fin">Status</Label>
                <NativeSelect id="fin" value={fin} onChange={(e) => setFin(e.target.value as FinancialStatus)}>
                  {FINANCIAL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.toLowerCase().replace("_", " ")}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv">Invoice reference</Label>
                <Input id="inv" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFinOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button disabled={pending} onClick={() => run(() => setFinancialStatusAction(orderId, { financialStatus: fin, invoiceReference: invoice }), "Financial status updated", () => setFinOpen(false))}>
                {pending && <Loader2 className="animate-spin" />}Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogTrigger render={<Button variant="outline" />}>Add note</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a note to the order history</DialogTitle>
          </DialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Internal note…" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button disabled={pending || note.trim().length === 0} onClick={() => run(() => addOrderNoteAction(orderId, note), "Note added", () => { setNoteOpen(false); setNote(""); })}>
              {pending && <Loader2 className="animate-spin" />}Add note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {canManage && open && (
        <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <AlertDialogTrigger render={<Button variant="destructive" />}>Cancel order</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
              <AlertDialogDescription>All unshipped reservations are released and open picking is cancelled. Already shipped units stay shipped.</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reason">Reason</Label>
              <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer request" />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Keep order</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending || reason.trim().length < 3} onClick={() => run(() => cancelOrderAction(orderId, reason), "Order cancelled", () => setCancelOpen(false))}>
                {pending && <Loader2 className="animate-spin" />}Cancel order
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {deleteBlockers && (
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogTrigger render={<Button variant="outline" className="text-destructive hover:text-destructive" />}>Delete</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{deleteBlockers.length === 0 ? `Delete order ${orderNumber ?? ""}?` : `Order ${orderNumber ?? ""} cannot be deleted`}</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteBlockers.length === 0
                  ? "The order and its lines are removed permanently. It never touched stock, so no history is lost. This cannot be undone."
                  : "It is part of records that must be kept for inventory and order integrity. Cancel it instead — cancelling releases stock and keeps the history."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteBlockers.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {deleteBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>{deleteBlockers.length === 0 ? "Keep order" : "Close"}</AlertDialogCancel>
              {deleteBlockers.length === 0 && (
                <AlertDialogAction
                  variant="destructive"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await deleteOrderAction(orderId);
                      if (!res.ok) toast.error(res.error);
                      else {
                        toast.success(`Order ${res.data.orderNumber} deleted`);
                        router.push("/admin/orders");
                        router.refresh();
                      }
                    })
                  }
                >
                  {pending && <Loader2 className="animate-spin" />}Delete order
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
