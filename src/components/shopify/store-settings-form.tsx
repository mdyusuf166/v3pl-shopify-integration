"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { storeSettingsSchema, type StoreSettingsInput } from "@/lib/validation/shopify";
import { updateStoreSettingsAction } from "@/server/actions/shopify";

type Props = {
  storeId: string;
  connected: boolean;
  initial: StoreSettingsInput;
  locations: { id: string; name: string; active: boolean }[];
  warehouses: { id: string; code: string; name: string }[];
};

export function StoreSettingsForm({ storeId, connected, initial, locations, warehouses }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<StoreSettingsInput>({ resolver: zodResolver(storeSettingsSchema), defaultValues: initial });
  const { errors } = form.formState;
  const ordersImportEnabled = useWatch({ control: form.control, name: "ordersImportEnabled" });
  const importTestOrders = useWatch({ control: form.control, name: "importTestOrders" });
  const publishEnabled = useWatch({ control: form.control, name: "publishEnabled" });
  const warehouseIds = useWatch({ control: form.control, name: "warehouseIds" }) ?? [];
  const defaultWarehouseId = useWatch({ control: form.control, name: "defaultWarehouseId" }) ?? "";

  function toggleWarehouse(id: string, checked: boolean) {
    const next = checked ? [...warehouseIds, id] : warehouseIds.filter((w) => w !== id);
    form.setValue("warehouseIds", next, { shouldDirty: true });
    if (!checked && defaultWarehouseId === id) form.setValue("defaultWarehouseId", next[0] ?? "");
    if (checked && !defaultWarehouseId) form.setValue("defaultWarehouseId", id);
  }

  function onSubmit(values: StoreSettingsInput) {
    setFormError(null);
    startTransition(async () => {
      const result = await updateStoreSettingsAction(storeId, values);
      if (!result.ok) {
        setFormError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) form.setError(field as keyof StoreSettingsInput, { message });
        return;
      }
      toast.success("Store settings saved");
      router.refresh();
    });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>How this store appears in V3PL and which parts of the synchronisation are active.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <FormField id="ss-name" label="Display name" required error={errors.name?.message} className="sm:col-span-2">
            <Input id="ss-name" {...form.register("name")} disabled={pending} aria-invalid={!!errors.name} />
          </FormField>

          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="ss-import">Import orders</Label>
              <p className="text-xs text-muted-foreground">New and updated Shopify orders become V3PL orders and reserve stock.</p>
            </div>
            <Switch id="ss-import" checked={!!ordersImportEnabled} disabled={pending} onCheckedChange={(v) => form.setValue("ordersImportEnabled", v, { shouldDirty: true })} />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="ss-test">Import test orders</Label>
              <p className="text-xs text-muted-foreground">Orders Shopify marks as test (test payment gateway). Switch on for development stores only.</p>
            </div>
            <Switch id="ss-test" checked={!!importTestOrders} disabled={pending} onCheckedChange={(v) => form.setValue("importTestOrders", v, { shouldDirty: true })} />
          </div>

          <FormField id="ss-since" label="Import orders created since" error={errors.ordersImportSince?.message} hint="Orders created before this date are not imported automatically. Use “Import orders since…” on the Orders tab for a one-off backfill.">
            <Input id="ss-since" type="date" {...form.register("ordersImportSince")} disabled={pending} />
          </FormField>

          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="ss-publish">Publish inventory to Shopify</Label>
              <p className="text-xs text-muted-foreground">Sends the sellable quantity of mapped SKUs to the Shopify location below. Off until product mapping is reviewed.</p>
              {errors.publishEnabled?.message && <p className="text-xs text-destructive">{errors.publishEnabled.message}</p>}
            </div>
            <Switch id="ss-publish" checked={!!publishEnabled} disabled={pending} onCheckedChange={(v) => form.setValue("publishEnabled", v, { shouldDirty: true })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shopify locations</CardTitle>
          <CardDescription>{connected ? "Loaded live from Shopify. Names are recorded from Shopify when you save." : "Connect the store to choose locations."}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="ss-publishLocation" label="Publish inventory to" error={errors.publishLocationId?.message} hint="Location whose available quantity V3PL controls.">
            <NativeSelect id="ss-publishLocation" {...form.register("publishLocationId")} disabled={pending || !connected}>
              <option value="">— none —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.active ? "" : " (inactive)"}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="ss-fulfilLocation" label="Fulfil orders from" error={errors.fulfilLocationId?.message} hint="Shopify location our shipments are recorded against (usually the same).">
            <NativeSelect id="ss-fulfilLocation" {...form.register("fulfilLocationId")} disabled={pending || !connected}>
              <option value="">— none —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.active ? "" : " (inactive)"}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Warehouses</CardTitle>
          <CardDescription>Internal warehouses whose stock this store sells. Orders reserve from the default warehouse; published quantity is the total available across the selected warehouses.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {warehouses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active warehouses yet. Create one under Warehouses first.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {warehouses.map((w) => {
                const checked = warehouseIds.includes(w.id);
                return (
                  <li key={w.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary">
                      <input type="checkbox" className="size-4 accent-primary" checked={checked} disabled={pending} onChange={(e) => toggleWarehouse(w.id, e.target.checked)} />
                      <span className="font-mono text-xs text-muted-foreground">{w.code}</span>
                      <span className="font-medium">{w.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <FormField id="ss-default" label="Default reservation warehouse" error={errors.defaultWarehouseId?.message} className="max-w-sm">
            <NativeSelect id="ss-default" value={defaultWarehouseId} disabled={pending || warehouseIds.length === 0} onChange={(e) => form.setValue("defaultWarehouseId", e.target.value, { shouldDirty: true })}>
              <option value="">— choose —</option>
              {warehouses
                .filter((w) => warehouseIds.includes(w.id))
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
            </NativeSelect>
          </FormField>
        </CardContent>
      </Card>

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Save settings
        </Button>
      </div>
    </form>
  );
}
