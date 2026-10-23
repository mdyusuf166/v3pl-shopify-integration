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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocationSelect, type LocationOption } from "@/components/inventory/location-select";
import { cancelTransferAction, completeTransferAction } from "@/server/actions/inventory";

type Line = { itemId: string; sku: string; quantity: number };

export function TransferActions({ id, lines, destWarehouseId, destLocations }: { id: string; lines: Line[]; destWarehouseId: string; destLocations: LocationOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [completeOpen, setCompleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const defaultLoc = destLocations.find((l) => l.isDefault)?.id ?? destLocations[0]?.id ?? "";
  const [dest, setDest] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.itemId, defaultLoc])));

  function complete() {
    startTransition(async () => {
      const res = await completeTransferAction(id, { lines: lines.map((l) => ({ itemId: l.itemId, destLocationId: dest[l.itemId] })) });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Transfer completed — stock booked into the destination");
      setCompleteOpen(false);
      router.refresh();
    });
  }

  function cancel() {
    startTransition(async () => {
      const res = await cancelTransferAction(id, reason);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Transfer cancelled — stock returned to the source");
      setCancelOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogTrigger render={<Button variant="outline" />}>Cancel transfer</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this transfer?</AlertDialogTitle>
            <AlertDialogDescription>The in-transit units are booked back into their original source locations. This is recorded in the ledger.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Truck did not leave" disabled={pending} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending || reason.trim().length < 3} onClick={cancel}>
              {pending && <Loader2 className="animate-spin" />}
              Cancel transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogTrigger render={<Button />}>Receive at destination</DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Receive transfer</DialogTitle>
            <DialogDescription>Choose where each line is put away in the destination warehouse.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {lines.map((l) => (
              <div key={l.itemId} className="grid grid-cols-2 items-center gap-3 text-sm">
                <div>
                  <span className="font-mono text-xs">{l.sku}</span>
                  <span className="text-muted-foreground"> × {l.quantity}</span>
                </div>
                <LocationSelect warehouseId={destWarehouseId} options={destLocations} value={dest[l.itemId] ?? ""} onChange={(v) => setDest((d) => ({ ...d, [l.itemId]: v }))} disabled={pending} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setCompleteOpen(false)}>
              Close
            </Button>
            <Button type="button" disabled={pending || lines.some((l) => !dest[l.itemId])} onClick={complete}>
              {pending && <Loader2 className="animate-spin" />}
              Complete transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
