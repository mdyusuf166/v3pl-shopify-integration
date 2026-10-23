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
import { receivingFormSchema, type ReceivingFormInput } from "@/lib/validation/inventory";
import { createReceivingAction } from "@/server/actions/inventory";

type Owner = { id: string; code: string; businessName: string; type: "VENDOR" | "THREEPL_CLIENT" };
type Warehouse = { id: string; code: string; name: string };

export function ReceivingForm({ owners, warehouses }: { owners: Owner[]; warehouses: Warehouse[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, PickedVariant | null>>({});

  const form = useForm<ReceivingFormInput>({
    resolver: zodResolver(receivingFormSchema),
    defaultValues: { ownerId: owners.length === 1 ? owners[0].id : "", warehouseId: warehouses.length === 1 ? warehouses[0].id : "", reference: "", notes: "", lines: [{ variantId: "", locationId: "", quantity: 1 }] },
  });
  const lines = useFieldArray({ control: form.control, name: "lines" });
  const { errors } = form.formState;
  const ownerId = form.watch("ownerId");
  const warehouseId = form.watch("warehouseId");
  const lineErrors = errors.lines as unknown as Array<Record<string, { message?: string }> | undefined> | undefined;

  function onSubmit(values: ReceivingFormInput) {
    setFormError(null);
    startTransition(async () => {
      const res = await createReceivingAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof ReceivingFormInput, { message: m });
        return;
      }
      toast.success("Stock received and booked into inventory");
      router.push(`/admin/receiving/${res.data.id}`);
      router.refresh();
    });
  }

  const vendors = owners.filter((o) => o.type === "VENDOR");
  const clients = owners.filter((o) => o.type === "THREEPL_CLIENT");

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Receipt</CardTitle>
          <CardDescription>All SKUs on one receipt belong to the same owner and arrive at the same warehouse.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="ownerId" label="Owner" required error={errors.ownerId?.message}>
            <NativeSelect
              id="ownerId"
              disabled={pending}
              {...form.register("ownerId", {
                onChange: () => {
                  // Owner change invalidates picked SKUs.
                  lines.fields.forEach((_, i) => form.setValue(`lines.${i}.variantId`, ""));
                  setPicked({});
                },
              })}
            >
              <option value="">Choose vendor or 3PL client…</option>
              {vendors.length > 0 && (
                <optgroup label="Vendors">
                  {vendors.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.businessName} ({o.code})
                    </option>
                  ))}
                </optgroup>
              )}
              {clients.length > 0 && (
                <optgroup label="3PL clients">
                  {clients.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.businessName} ({o.code})
                    </option>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </FormField>
          <FormField id="warehouseId" label="Warehouse" required error={errors.warehouseId?.message}>
            <NativeSelect id="warehouseId" disabled={pending} {...form.register("warehouseId", { onChange: () => lines.fields.forEach((_, i) => form.setValue(`lines.${i}.locationId`, "")) })}>
              <option value="">Choose…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="reference" label="Reference" error={errors.reference?.message} hint="Delivery note, PO or shipment number.">
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
          <CardDescription>{ownerId ? "Search only shows this owner's SKUs." : "Choose the owner first to search its SKUs."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-72">SKU *</TableHead>
                  <TableHead className="min-w-44">Location *</TableHead>
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
                        <Controller
                          control={form.control}
                          name={`lines.${i}.variantId`}
                          render={({ field: f }) => (
                            <VariantPicker
                              value={picked[i] ?? null}
                              ownerId={ownerId || undefined}
                              disabled={pending || !ownerId}
                              invalid={!!err?.variantId}
                              placeholder={ownerId ? "Search SKU…" : "Choose owner first"}
                              onChange={(v) => {
                                setPicked((p) => ({ ...p, [i]: v }));
                                f.onChange(v?.id ?? "");
                              }}
                            />
                          )}
                        />
                        {err?.variantId?.message && <p className="mt-1 text-xs text-destructive">{err.variantId.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Controller control={form.control} name={`lines.${i}.locationId`} render={({ field: f }) => <LocationSelect warehouseId={warehouseId} value={f.value} onChange={f.onChange} disabled={pending} invalid={!!err?.locationId} />} />
                        {err?.locationId?.message && <p className="mt-1 text-xs text-destructive">{err.locationId.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input type="number" min={1} step={1} inputMode="numeric" disabled={pending} aria-invalid={!!err?.quantity} {...form.register(`lines.${i}.quantity`)} />
                        {err?.quantity?.message && <p className="mt-1 text-xs text-destructive">{err.quantity.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove line" disabled={pending || lines.fields.length === 1} onClick={() => { lines.remove(i); setPicked((p) => { const n: typeof p = {}; Object.entries(p).forEach(([k, v]) => { const idx = Number(k); if (idx < i) n[idx] = v; else if (idx > i) n[idx - 1] = v; }); return n; }); }}>
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
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => lines.append({ variantId: "", locationId: "", quantity: 1 })}>
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
          Post receipt
        </Button>
      </div>
    </form>
  );
}
