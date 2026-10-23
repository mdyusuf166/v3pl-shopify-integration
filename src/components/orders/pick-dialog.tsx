"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/common/native-select";
import { startPickingAction } from "@/server/actions/orders";

type Line = { orderItemId: string; sku: string; title: string; pickable: number };
type Warehouse = { id: string; code: string; name: string };

/** Choose which lines/quantities to pick; the service prevents double-picking. */
export function PickDialog({ orderId, lines, warehouses, defaultWarehouseId }: { orderId: string; lines: Line[]; warehouses: Warehouse[]; defaultWarehouseId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId ?? warehouses[0]?.id ?? "");
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(lines.map((l) => [l.orderItemId, l.pickable])));
  const chosen = lines.filter((l) => (qty[l.orderItemId] ?? 0) > 0).map((l) => ({ orderItemId: l.orderItemId, quantity: qty[l.orderItemId] }));

  function submit() {
    startTransition(async () => {
      const res = await startPickingAction(orderId, { warehouseId, lines: chosen });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Picking started");
      setOpen(false);
      router.refresh();
    });
  }

  if (lines.length === 0) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <ClipboardList /> Start picking
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start picking</DialogTitle>
          <DialogDescription>Pick everything, or only part of the order for a partial shipment. Lines already being picked are excluded.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pick-wh">Warehouse</Label>
            <NativeSelect id="pick-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={pending}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.orderItemId} className="grid grid-cols-[1fr_6rem] items-center gap-3 text-sm">
                <div>
                  <span className="font-mono text-xs">{l.sku}</span>
                  <div className="truncate text-muted-foreground">{l.title}</div>
                </div>
                <Input type="number" min={0} max={l.pickable} value={qty[l.orderItemId] ?? 0} onChange={(e) => setQty((q) => ({ ...q, [l.orderItemId]: Math.max(0, Math.min(l.pickable, Number(e.target.value) || 0)) }))} disabled={pending} aria-label={`Quantity for ${l.sku} (max ${l.pickable})`} />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || chosen.length === 0 || !warehouseId}>
            {pending && <Loader2 className="animate-spin" />}Start picking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
