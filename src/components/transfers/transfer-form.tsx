"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { LocationSelect } from "@/components/inventory/location-select";
import { VariantPicker, type PickedVariant } from "@/components/inventory/variant-picker";
import { transferFormSchema, type TransferFormInput } from "@/lib/validation/inventory";
import { createTransferAction } from "@/server/actions/inventory";

type Warehouse = { id: string; code: string; name: string };

export function TransferForm({ warehouses }: { warehouses: Warehouse[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, PickedVariant | null>>({});
  const form = useForm<TransferFormInput>({
    resolver: zodResolver(transferFormSchema),
    defaultValues: { sourceWarehouseId: "", destWarehouseId: "", reference: "", notes: "", lines: [{ variantId: "", sourceLocationId: "", quantity: 1 }] },
  });
  const lines = useFieldArray({ control: form.control, name: "lines" });
  const { errors } = form.formState;
  const sourceId = form.watch("sourceWarehouseId");
  const lineErrors = errors.lines as unknown as Array<Record<string, { message?: string }> | undefined> | undefined;

  function onSubmit(values: TransferFormInput) {
    setFormError(null);
    startTransition(async () => {
      const res = await createTransferAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof TransferFormInput, { message: m });
        return;
      }
      toast.success("Transfer created — stock is now in transit");
      router.push(`/admin/transfers/${res.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Transfer</CardTitle>
          <CardDescription>Stock leaves the source immediately (in transit) and is booked into the destination when the transfer is completed.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="sourceWarehouseId" label="From warehouse" required error={errors.sourceWarehouseId?.message}>
            <NativeSelect id="sourceWarehouseId" disabled={pending} {...form.register("sourceWarehouseId", { onChange: () => lines.fields.forEach((_, i) => form.setValue(`lines.${i}.sourceLocationId`, "")) })}>
              <option value="">Choose…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="destWarehouseId" label="To warehouse" required error={errors.destWarehouseId?.message}>
            <NativeSelect id="destWarehouseId" disabled={pending} {...form.register("destWarehouseId")}>
              <option value="">Choose…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id} disabled={w.id === sourceId}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="reference" label="Reference" error={errors.reference?.message}>
            <Input id="reference" disabled={pending} {...form.register("reference")} />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message}>
            <Textarea id="notes" rows={1} disabled={pending} {...form.register("notes")} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <CardDescription>Only available (unreserved) stock can be transferred.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-72">SKU *</TableHead>
                  <TableHead className="min-w-44">From location *</TableHead>
                  <TableHead className="w-28">Quantity *</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.fields.map((field, i) => {
                  const err = lineErrors?.[i];
                  return (
                    <TableRow key={field.id}>
                      <TableCell className="align-top">
                        <Controller control={form.control} name={`lines.${i}.variantId`} render={({ field: f }) => <VariantPicker value={picked[i] ?? null} disabled={pending} invalid={!!err?.variantId} onChange={(v) => { setPicked((p) => ({ ...p, [i]: v })); f.onChange(v?.id ?? ""); }} />} />
                        {err?.variantId?.message && <p className="mt-1 text-xs text-destructive">{err.variantId.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Controller control={form.control} name={`lines.${i}.sourceLocationId`} render={({ field: f }) => <LocationSelect warehouseId={sourceId} value={f.value} onChange={f.onChange} disabled={pending} invalid={!!err?.sourceLocationId} />} />
                        {err?.sourceLocationId?.message && <p className="mt-1 text-xs text-destructive">{err.sourceLocationId.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input type="number" min={1} step={1} inputMode="numeric" disabled={pending} aria-invalid={!!err?.quantity} {...form.register(`lines.${i}.quantity`)} />
                        {err?.quantity?.message && <p className="mt-1 text-xs text-destructive">{err.quantity.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove line" disabled={pending || lines.fields.length === 1} onClick={() => lines.remove(i)}>
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {typeof errors.lines?.message === "string" && <p className="text-sm text-destructive">{errors.lines.message}</p>}
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => lines.append({ variantId: "", sourceLocationId: "", quantity: 1 })}>
            <Plus /> Add line
          </Button>
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
          Create transfer
        </Button>
      </div>
    </form>
  );
}
