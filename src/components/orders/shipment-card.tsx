"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Truck } from "lucide-react";
import { toast } from "sonner";
import type { ShipmentStatus } from "@/generated/prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/common/native-select";
import { StatusBadge } from "@/components/common/status-badge";
import { formatDateTime } from "@/lib/format";
import { updateShipmentStatusAction, updateTrackingAction } from "@/server/actions/orders";

export type ShipmentView = {
  id: string;
  status: ShipmentStatus;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date;
  deliveredAt: Date | null;
  shopifySyncedAt: Date | null;
  createdBy: { name: string };
  items: { id: string; quantity: number; orderItem: { sku: string } }[];
};

export function ShipmentCard({ s, orderId, canOperate }: { s: ShipmentView; orderId: string; canOperate: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [carrier, setCarrier] = useState(s.carrier ?? "");
  const [service, setService] = useState(s.service ?? "");
  const [tracking, setTracking] = useState(s.trackingNumber ?? "");
  const [url, setUrl] = useState(s.trackingUrl ?? "");

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

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="size-4 text-muted-foreground" /> Shipment
            <StatusBadge status={s.status} />
            {s.shopifySyncedAt && <span className="text-xs font-normal text-muted-foreground">sent to Shopify</span>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(s.shippedAt)} · {s.createdBy.name}
            {s.deliveredAt ? ` · delivered ${formatDateTime(s.deliveredAt)}` : ""}
          </p>
        </div>
        {canOperate && (
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect value={s.status} disabled={pending} aria-label="Shipment status" className="w-36" onChange={(e) => run(() => updateShipmentStatusAction(s.id, orderId, e.target.value as ShipmentStatus), "Shipment status updated")}>
              <option value="SHIPPED">Shipped</option>
              <option value="IN_TRANSIT">In transit</option>
              <option value="DELIVERED">Delivered</option>
              <option value="RETURNED">Returned</option>
            </NativeSelect>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button size="sm" variant="outline" />}>Tracking</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Update tracking</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`c-${s.id}`}>Carrier</Label>
                    <Input id={`c-${s.id}`} value={carrier} onChange={(e) => setCarrier(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`sv-${s.id}`}>Service</Label>
                    <Input id={`sv-${s.id}`} value={service} onChange={(e) => setService(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`t-${s.id}`}>Tracking number</Label>
                    <Input id={`t-${s.id}`} value={tracking} onChange={(e) => setTracking(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`u-${s.id}`}>Tracking URL</Label>
                    <Input id={`u-${s.id}`} value={url} onChange={(e) => setUrl(e.target.value)} />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button disabled={pending || carrier.trim().length === 0} onClick={() => run(() => updateTrackingAction(s.id, orderId, { carrier, service, trackingNumber: tracking, trackingUrl: url }), "Tracking updated", () => setOpen(false))}>
                    {pending && <Loader2 className="animate-spin" />}Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>
          {s.carrier ?? "Carrier not set"}
          {s.service ? ` · ${s.service}` : ""}
          {s.trackingNumber ? (
            <>
              {" · "}
              {s.trackingUrl ? (
                <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-4">
                  {s.trackingNumber}
                </a>
              ) : (
                <span className="font-mono text-xs">{s.trackingNumber}</span>
              )}
            </>
          ) : null}
        </p>
        <ul className="divide-y">
          {s.items.map((i) => (
            <li key={i.id} className="flex justify-between py-1">
              <span className="font-mono text-xs">{i.orderItem.sku}</span>
              <span className="tabular-nums">× {i.quantity}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
