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
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { LocationSelect } from "@/components/inventory/location-select";
import { VariantPicker, type PickedVariant } from "@/components/inventory/variant-picker";
import { moveFormSchema, type MoveFormInput } from "@/lib/validation/inventory";
import { moveStockAction } from "@/server/actions/inventory";

type Warehouse = { id: string; code: string; name: string };

export function MoveForm({ warehouses }: { warehouses: Warehouse[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedVariant | null>(null);
  const form = useForm<MoveFormInput>({
    resolver: zodResolver(moveFormSchema),
    defaultValues: { variantId: "", warehouseId: warehouses.length === 1 ? warehouses[0].id : "", fromLocationId: "", toLocationId: "", quantity: 1, notes: "" },
  });
  const { errors } = form.formState;
  const warehouseId = form.watch("warehouseId");

  function onSubmit(values: MoveFormInput) {
    setFormError(null);
    startTransition(async () => {
      const res = await moveStockAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof MoveFormInput, { message: m });
        return;
      }
      toast.success("Stock moved");
      router.push("/admin/inventory/movements");
      router.refresh();
    });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Move between locations</CardTitle>
          <CardDescription>Relocate units inside one warehouse. Warehouse totals and availability do not change.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="variantId" label="SKU" required error={errors.variantId?.message} className="sm:col-span-2">
            <Controller control={form.control} name="variantId" render={({ field }) => <VariantPicker id="variantId" value={picked} disabled={pending} invalid={!!errors.variantId} onChange={(v) => { setPicked(v); field.onChange(v?.id ?? ""); }} />} />
          </FormField>
          <FormField id="warehouseId" label="Warehouse" required error={errors.warehouseId?.message} className="sm:col-span-2">
            <NativeSelect id="warehouseId" disabled={pending} {...form.register("warehouseId", { onChange: () => { form.setValue("fromLocationId", ""); form.setValue("toLocationId", ""); } })}>
              <option value="">Choose…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="fromLocationId" label="From location" required error={errors.fromLocationId?.message}>
            <Controller control={form.control} name="fromLocationId" render={({ field }) => <LocationSelect id="fromLocationId" warehouseId={warehouseId} value={field.value} onChange={field.onChange} disabled={pending} invalid={!!errors.fromLocationId} />} />
          </FormField>
          <FormField id="toLocationId" label="To location" required error={errors.toLocationId?.message}>
            <Controller control={form.control} name="toLocationId" render={({ field }) => <LocationSelect id="toLocationId" warehouseId={warehouseId} value={field.value} onChange={field.onChange} disabled={pending} invalid={!!errors.toLocationId} autoDefault={false} />} />
          </FormField>
          <FormField id="quantity" label="Quantity" required error={errors.quantity?.message}>
            <Input id="quantity" type="number" min={1} step={1} inputMode="numeric" disabled={pending} {...form.register("quantity")} />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message}>
            <Input id="notes" disabled={pending} {...form.register("notes")} />
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
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Move stock
        </Button>
      </div>
    </form>
  );
}
