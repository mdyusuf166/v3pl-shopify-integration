"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { LocationSelect } from "@/components/inventory/location-select";
import { VariantPicker, type PickedVariant } from "@/components/inventory/variant-picker";
import { adjustmentFormSchema, type AdjustmentFormInput } from "@/lib/validation/inventory";
import { adjustStockAction } from "@/server/actions/inventory";

type Warehouse = { id: string; code: string; name: string };

const KIND_LABELS: Record<string, { label: string; hint: string }> = {
  ADJUSTMENT_IN: { label: "Adjustment (+) add units", hint: "Count correction upwards. Requires a reason." },
  ADJUSTMENT_OUT: { label: "Adjustment (−) remove units", hint: "Count correction downwards. Cannot remove reserved units." },
  DAMAGE: { label: "Damaged (−)", hint: "Units no longer sellable. Recorded permanently against the owner." },
  MISSING: { label: "Missing (−)", hint: "Units that cannot be located or accounted for." },
};

export function AdjustForm({ warehouses }: { warehouses: Warehouse[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedVariant | null>(null);

  const form = useForm<AdjustmentFormInput>({
    resolver: zodResolver(adjustmentFormSchema),
    defaultValues: { variantId: "", warehouseId: warehouses.length === 1 ? warehouses[0].id : "", locationId: "", kind: "ADJUSTMENT_OUT", quantity: 1, reason: "", notes: "" },
  });
  const { errors } = form.formState;
  const warehouseId = form.watch("warehouseId");
  const kind = form.watch("kind");

  function onSubmit(values: AdjustmentFormInput) {
    setFormError(null);
    startTransition(async () => {
      const res = await adjustStockAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof AdjustmentFormInput, { message: m });
        return;
      }
      toast.success("Stock adjusted and recorded in the ledger");
      router.push("/admin/inventory/movements");
      router.refresh();
    });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Stock adjustment</CardTitle>
          <CardDescription>Every adjustment is written to the ledger with who, when, why and the before/after quantity. Nothing is overwritten.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="variantId" label="SKU" required error={errors.variantId?.message} className="sm:col-span-2">
            <Controller
              control={form.control}
              name="variantId"
              render={({ field }) => (
                <VariantPicker
                  id="variantId"
                  value={picked}
                  invalid={!!errors.variantId}
                  disabled={pending}
                  onChange={(v) => {
                    setPicked(v);
                    field.onChange(v?.id ?? "");
                  }}
                />
              )}
            />
          </FormField>
          <FormField id="warehouseId" label="Warehouse" required error={errors.warehouseId?.message}>
            <NativeSelect id="warehouseId" disabled={pending} {...form.register("warehouseId", { onChange: () => form.setValue("locationId", "") })}>
              <option value="">Choose…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="locationId" label="Location" required error={errors.locationId?.message}>
            <Controller control={form.control} name="locationId" render={({ field }) => <LocationSelect id="locationId" warehouseId={warehouseId} value={field.value} onChange={field.onChange} disabled={pending} invalid={!!errors.locationId} />} />
          </FormField>
          <FormField id="kind" label="Type" required error={errors.kind?.message} hint={KIND_LABELS[kind]?.hint}>
            <NativeSelect id="kind" disabled={pending} {...form.register("kind")}>
              {Object.entries(KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="quantity" label="Quantity" required error={errors.quantity?.message}>
            <Input id="quantity" type="number" min={1} step={1} inputMode="numeric" disabled={pending} {...form.register("quantity")} />
          </FormField>
          <FormField id="reason" label="Reason" required error={errors.reason?.message} className="sm:col-span-2">
            <Input id="reason" placeholder="e.g. Cycle count 2026-09-04 found 3 fewer units" disabled={pending} {...form.register("reason")} />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea id="notes" rows={2} disabled={pending} {...form.register("notes")} />
          </FormField>
        </CardContent>
      </Card>
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} variant={kind === "ADJUSTMENT_IN" ? "default" : "destructive"}>
          {pending && <Loader2 className="animate-spin" />}
          Record adjustment
        </Button>
      </div>
    </form>
  );
}
