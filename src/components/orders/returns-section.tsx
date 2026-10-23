"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/common/native-select";
import { LocationSelect, type LocationOption } from "@/components/inventory/location-select";
import { formatDateTime } from "@/lib/format";
import { inspectReturnAction, receiveReturnAction } from "@/server/actions/orders";

type Warehouse = { id: string; code: string; name: string };
export type ReturnableLine = { orderItemId: string; sku: string; title: string; returnable: number };
export type ReturnView = {
  id: string;
  status: "RECEIVED" | "INSPECTED";
  reference: string | null;
  reason: string | null;
  receivedAt: Date;
  inspectedAt: Date | null;
  warehouseId: string;
  warehouse: { code: string };
  receivedBy: { name: string };
  items: { id: string; quantity: number; condition: "SELLABLE" | "DAMAGED" | null; orderItem: { sku: string }; location: { label: string } | null }[];
};

export function ReturnsSection({ orderId, returns, returnable, warehouses, defaultWarehouseId, canOperate, locationsByWarehouse }: { orderId: string; returns: ReturnView[]; returnable: ReturnableLine[]; warehouses: Warehouse[]; defaultWarehouseId: string | null; canOperate: boolean; locationsByWarehouse: Record<string, LocationOption[]> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId ?? warehouses[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [inspecting, setInspecting] = useState<ReturnView | null>(null);
  const [decisions, setDecisions] = useState<Record<string, { condition: "SELLABLE" | "DAMAGED"; locationId: string }>>({});

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
  const chosen = returnable.filter((l) => (qty[l.orderItemId] ?? 0) > 0).map((l) => ({ orderItemId: l.orderItemId, quantity: qty[l.orderItemId] }));

  function openInspect(r: ReturnView) {
    const locs = locationsByWarehouse[r.warehouseId] ?? [];
    const def = locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? "";
    setDecisions(Object.fromEntries(r.items.map((i) => [i.id, { condition: "SELLABLE" as const, locationId: def }])));
    setInspecting(r);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Returns</h2>
          <p className="text-sm text-muted-foreground">Received returns wait for inspection; only inspected sellable units go back into available stock.</p>
        </div>
        {canOperate && returnable.some((l) => l.returnable > 0) && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button variant="outline" />}>
              <RotateCcw /> Receive return
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Receive a return</DialogTitle>
                <DialogDescription>Record the units that came back. Stock is not changed until the return is inspected.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ret-wh">Warehouse</Label>
                    <NativeSelect id="ret-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={pending}>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} · {w.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ret-ref">Reference / RMA</Label>
                    <Input id="ret-ref" value={reference} onChange={(e) => setReference(e.target.value)} disabled={pending} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="ret-reason">Reason</Label>
                    <Input id="ret-reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} placeholder="e.g. Wrong size" />
                  </div>
                </div>
                {returnable.filter((l) => l.returnable > 0).map((l) => (
                  <div key={l.orderItemId} className="grid grid-cols-[1fr_6rem] items-center gap-3 text-sm">
                    <div>
                      <span className="font-mono text-xs">{l.sku}</span>
                      <div className="truncate text-muted-foreground">{l.title} · {l.returnable} returnable</div>
                    </div>
                    <Input type="number" min={0} max={l.returnable} value={qty[l.orderItemId] ?? 0} onChange={(e) => setQty((q) => ({ ...q, [l.orderItemId]: Math.max(0, Math.min(l.returnable, Number(e.target.value) || 0)) }))} disabled={pending} aria-label={`Returned quantity for ${l.sku}`} />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={pending || chosen.length === 0} onClick={() => run(() => receiveReturnAction(orderId, { warehouseId, reference, reason, notes: "", lines: chosen }), "Return received — awaiting inspection", () => { setOpen(false); setQty({}); })}>
                  {pending && <Loader2 className="animate-spin" />}Receive
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {returns.length === 0 ? (
        <p className="text-sm text-muted-foreground">No returns.</p>
      ) : (
        returns.map((r) => (
          <Card key={r.id}>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  Return {r.reference ? r.reference : ""} · {r.warehouse.code}
                  <Badge variant="outline" className={r.status === "RECEIVED" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>
                    {r.status === "RECEIVED" ? "Awaiting inspection" : "Inspected"}
                  </Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  received {formatDateTime(r.receivedAt)} by {r.receivedBy.name}
                  {r.reason ? ` · ${r.reason}` : ""}
                  {r.inspectedAt ? ` · inspected ${formatDateTime(r.inspectedAt)}` : ""}
                </p>
              </div>
              {canOperate && r.status === "RECEIVED" && (
                <Button size="sm" onClick={() => openInspect(r)}>
                  Inspect
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {r.items.map((i) => (
                  <li key={i.id} className="flex items-center justify-between py-1.5">
                    <span className="font-mono text-xs">{i.orderItem.sku}</span>
                    <span className="text-muted-foreground">{i.condition ? `${i.condition === "SELLABLE" ? "restocked" : "damaged"}${i.location ? ` at ${i.location.label}` : ""}` : "pending inspection"}</span>
                    <span className="tabular-nums">× {i.quantity}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}

      <Dialog open={inspecting !== null} onOpenChange={(o) => !o && setInspecting(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Inspect return</DialogTitle>
            <DialogDescription>Sellable units go back into stock at the chosen location. Damaged units are recorded and written off — they never become available.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {inspecting?.items.map((i) => (
              <div key={i.id} className="grid grid-cols-[1fr_8rem_10rem] items-center gap-2 text-sm">
                <div>
                  <span className="font-mono text-xs">{i.orderItem.sku}</span> × {i.quantity}
                </div>
                <NativeSelect value={decisions[i.id]?.condition ?? "SELLABLE"} onChange={(e) => setDecisions((d) => ({ ...d, [i.id]: { ...d[i.id], condition: e.target.value as "SELLABLE" | "DAMAGED" } }))} disabled={pending} aria-label="Condition">
                  <option value="SELLABLE">Sellable</option>
                  <option value="DAMAGED">Damaged</option>
                </NativeSelect>
                <LocationSelect warehouseId={inspecting.warehouseId} options={locationsByWarehouse[inspecting.warehouseId] ?? []} value={decisions[i.id]?.locationId ?? ""} onChange={(v) => setDecisions((d) => ({ ...d, [i.id]: { ...d[i.id], locationId: v } }))} disabled={pending} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setInspecting(null)}>
              Cancel
            </Button>
            <Button disabled={pending || !inspecting || inspecting.items.some((i) => !decisions[i.id]?.locationId)} onClick={() => inspecting && run(() => inspectReturnAction(inspecting.id, orderId, { lines: inspecting.items.map((i) => ({ returnItemId: i.id, condition: decisions[i.id].condition, locationId: decisions[i.id].locationId })) }), "Return inspected", () => setInspecting(null))}>
              {pending && <Loader2 className="animate-spin" />}Complete inspection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
