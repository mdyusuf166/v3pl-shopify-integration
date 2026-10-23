"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Package, Truck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/common/form-field";
import { formatDateTime } from "@/lib/format";
import { shipFormSchema, type ShipFormInput } from "@/lib/validation/orders";
import { cancelFulfillmentAction, markPackedAction, shipFulfillmentAction } from "@/server/actions/orders";

export type FulfillmentView = {
  id: string;
  status: "PICKING" | "PACKED" | "SHIPPED" | "CANCELLED";
  type: "MANUAL" | "EXTERNAL";
  warehouse: { code: string };
  createdAt: Date;
  createdBy: { name: string };
  items: { id: string; quantity: number; orderItem: { sku: string }; location: { label: string } | null }[];
};

const STATUS_TONE: Record<string, string> = {
  PICKING: "border-amber-200 bg-amber-50 text-amber-800",
  PACKED: "border-sky-200 bg-sky-50 text-sky-700",
  SHIPPED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  CANCELLED: "border-border bg-muted text-muted-foreground",
};

export function FulfillmentCard({ f, orderId, canOperate }: { f: FulfillmentView; orderId: string; canOperate: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shipOpen, setShipOpen] = useState(false);
  const form = useForm<ShipFormInput>({ resolver: zodResolver(shipFormSchema), defaultValues: { carrier: "", service: "", trackingNumber: "", trackingUrl: "", notes: "" } });
  const { errors } = form.formState;

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
  function onShip(values: ShipFormInput) {
    run(() => shipFulfillmentAction(f.id, orderId, values), "Shipped — stock deducted and reservation consumed", () => setShipOpen(false));
  }
  const reg = (name: keyof ShipFormInput) => ({ id: `ship-${f.id}-${name}`, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="size-4 text-muted-foreground" /> Fulfilment · {f.warehouse.code}
            <Badge variant="outline" className={STATUS_TONE[f.status]}>
              {f.status === "PICKING" ? "Picking" : f.status === "PACKED" ? "Packed" : f.status === "SHIPPED" ? "Shipped" : "Cancelled"}
            </Badge>
            {f.type === "EXTERNAL" && <Badge variant="outline">from Shopify</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(f.createdAt)} · {f.createdBy.name}
          </p>
        </div>
        {canOperate && (f.status === "PICKING" || f.status === "PACKED") && (
          <div className="flex flex-wrap gap-2">
            {f.status === "PICKING" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => markPackedAction(f.id, orderId), "Marked as packed")}>
                Mark packed
              </Button>
            )}
            <Dialog open={shipOpen} onOpenChange={setShipOpen}>
              <DialogTrigger render={<Button size="sm" />}>
                <Truck /> Ship
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <form onSubmit={form.handleSubmit(onShip)} noValidate className="space-y-4">
                  <DialogHeader>
                    <DialogTitle>Ship this fulfilment</DialogTitle>
                    <DialogDescription>Works without any courier integration. Stock is deducted and the reservation consumed when you confirm.</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField id={`ship-${f.id}-carrier`} label="Carrier" required error={errors.carrier?.message}>
                      <Input {...reg("carrier")} placeholder="e.g. UPS" />
                    </FormField>
                    <FormField id={`ship-${f.id}-service`} label="Service" error={errors.service?.message}>
                      <Input {...reg("service")} placeholder="e.g. Ground" />
                    </FormField>
                    <FormField id={`ship-${f.id}-trackingNumber`} label="Tracking number" error={errors.trackingNumber?.message}>
                      <Input {...reg("trackingNumber")} />
                    </FormField>
                    <FormField id={`ship-${f.id}-trackingUrl`} label="Tracking URL" error={errors.trackingUrl?.message}>
                      <Input {...reg("trackingUrl")} placeholder="https://…" />
                    </FormField>
                    <FormField id={`ship-${f.id}-notes`} label="Notes" error={errors.notes?.message} className="sm:col-span-2">
                      <Input {...reg("notes")} />
                    </FormField>
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => setShipOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={pending}>
                      {pending && <Loader2 className="animate-spin" />}Confirm shipment
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelFulfillmentAction(f.id, orderId), "Picking cancelled")}>
              Cancel picking
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {f.items.map((i) => (
            <li key={i.id} className="flex items-center justify-between py-1.5">
              <span>
                <span className="font-mono text-xs">{i.orderItem.sku}</span>
                {i.location && <span className="ml-2 text-xs text-muted-foreground">pick from {i.location.label}</span>}
              </span>
              <span className="tabular-nums">× {i.quantity}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
