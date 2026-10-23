"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
import { CustomerPicker, type PickedCustomer } from "@/components/customers/customer-picker";
import { VariantPicker, type PickedVariant } from "@/components/inventory/variant-picker";
import { manualOrderFormSchema, type ManualOrderFormInput } from "@/lib/validation/orders";
import { createManualOrderAction, createPortalOrderAction } from "@/server/actions/orders";
import { checkShopifyStoreForVariantsAction, requestShopifyOrderAction, type StoreHint } from "@/server/actions/shopify-order";

type Warehouse = { id: string; code: string; name: string };

type Props = {
  mode: "admin" | "portal";
  warehouses: Warehouse[];
  /** Portal: restrict SKU search to the client's own catalogue. */
  ownerId?: string;
  successPath: string;
};

export function OrderForm({ mode, warehouses, ownerId, successPath }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, PickedVariant | null>>({});
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  // Admin: can the picked SKUs be sent to one connected Shopify store? Server-resolved hint, never a store choice.
  const [storeHint, setStoreHint] = useState<StoreHint | null>(null);
  const [sendToShopify, setSendToShopify] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const form = useForm<ManualOrderFormInput>({
    resolver: zodResolver(manualOrderFormSchema),
    defaultValues: {
      customerId: null, saveCustomer: false, customerName: "", customerEmail: "", customerPhone: "", shipName: "", shipCompany: "", shipAddress1: "", shipAddress2: "", shipCity: "", shipProvince: "", shipZip: "", shipCountry: "", shipPhone: "",
      warehouseId: warehouses.length === 1 ? warehouses[0].id : "", shippingMethod: "", notes: "", tags: "", reserve: true,
      lines: [{ variantId: "", quantity: 1, unitPrice: "" }],
    },
  });
  const lines = useFieldArray({ control: form.control, name: "lines" });
  const { errors } = form.formState;
  const pickedKey = Object.values(picked).filter(Boolean).map((v) => v!.id).sort().join("|");
  useEffect(() => {
    if (mode !== "admin") return;
    if (hintTimer.current) clearTimeout(hintTimer.current);
    if (!pickedKey) {
      hintTimer.current = setTimeout(() => setStoreHint(null), 0);
      return;
    }
    hintTimer.current = setTimeout(async () => {
      const res = await checkShopifyStoreForVariantsAction(pickedKey.split("|"));
      if (res.ok) setStoreHint(res.data);
    }, 300);
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [pickedKey, mode]);
  const lineErrors = errors.lines as unknown as Array<Record<string, { message?: string }> | undefined> | undefined;

  function onSubmit(values: ManualOrderFormInput) {
    setFormError(null);
    startTransition(async () => {
      const res = mode === "portal" ? await createPortalOrderAction(values) : await createManualOrderAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof ManualOrderFormInput, { message: m });
        return;
      }
      const customerNote = res.data.customer?.created ? ` · customer “${res.data.customer.name}” saved` : res.data.customer?.reused ? ` · linked to existing customer “${res.data.customer.name}”` : "";
      toast.success((res.data.short > 0 ? `Order ${res.data.orderNumber} created — ${res.data.short} line(s) could not be fully reserved` : `Order ${res.data.orderNumber} created`) + customerNote);
      if (mode === "admin" && sendToShopify) {
        // Separate step: the V3PL order already exists; a Shopify problem only surfaces as a message on the order page.
        const sent = await requestShopifyOrderAction(res.data.id);
        if (sent.ok) toast.success(`Queued for creation in Shopify store ${sent.data.storeName}`);
        else toast.error(`Order saved, but not sent to Shopify: ${sent.error}`);
      }
      router.push(`${successPath}/${res.data.id}`);
      router.refresh();
    });
  }
  const reg = (name: keyof ManualOrderFormInput) => ({ id: name, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Customer &amp; ship to</CardTitle>
            <CardDescription>Pick an existing customer to fill the details, or type them and save them as a new customer. The order keeps its own copy of what you enter here.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2" data-slot="order-customer">
              <CustomerPicker
                id="customerPicker"
                value={customer}
                disabled={pending}
                onChange={(c) => {
                  setCustomer(c);
                  form.setValue("customerId", c?.id ?? null);
                  if (c) {
                    form.setValue("saveCustomer", false);
                    form.setValue("customerName", c.name);
                    form.setValue("customerEmail", c.email ?? "");
                    form.setValue("customerPhone", c.phone ?? "");
                    form.setValue("shipName", c.shipName ?? c.name);
                    form.setValue("shipCompany", c.shipCompany ?? "");
                    form.setValue("shipAddress1", c.shipAddress1 ?? "");
                    form.setValue("shipAddress2", c.shipAddress2 ?? "");
                    form.setValue("shipCity", c.shipCity ?? "");
                    form.setValue("shipProvince", c.shipProvince ?? "");
                    form.setValue("shipZip", c.shipZip ?? "");
                    form.setValue("shipCountry", c.shipCountry ?? "");
                    form.setValue("shipPhone", c.shipPhone ?? "");
                  }
                }}
              />
              {!customer && (
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 rounded border" disabled={pending} {...form.register("saveCustomer")} /> Save as new customer (an existing customer with the same email or phone is reused instead)
                </label>
              )}
            </div>
            <FormField id="customerName" label="Customer name" error={errors.customerName?.message}>
              <Input {...reg("customerName")} />
            </FormField>
            <FormField id="customerPhone" label="Customer phone" error={errors.customerPhone?.message}>
              <Input {...reg("customerPhone")} type="tel" />
            </FormField>
            <FormField id="shipName" label="Recipient name" error={errors.shipName?.message}>
              <Input {...reg("shipName")} />
            </FormField>
            <FormField id="shipCompany" label="Company" error={errors.shipCompany?.message}>
              <Input {...reg("shipCompany")} />
            </FormField>
            <FormField id="shipAddress1" label="Address line 1" error={errors.shipAddress1?.message} className="sm:col-span-2">
              <Input {...reg("shipAddress1")} />
            </FormField>
            <FormField id="shipAddress2" label="Address line 2" error={errors.shipAddress2?.message} className="sm:col-span-2">
              <Input {...reg("shipAddress2")} />
            </FormField>
            <FormField id="shipCity" label="City" error={errors.shipCity?.message}>
              <Input {...reg("shipCity")} />
            </FormField>
            <FormField id="shipProvince" label="State / Province" error={errors.shipProvince?.message}>
              <Input {...reg("shipProvince")} />
            </FormField>
            <FormField id="shipZip" label="Postal code" error={errors.shipZip?.message}>
              <Input {...reg("shipZip")} />
            </FormField>
            <FormField id="shipCountry" label="Country" error={errors.shipCountry?.message}>
              <Input {...reg("shipCountry")} />
            </FormField>
            <FormField id="shipPhone" label="Phone" error={errors.shipPhone?.message}>
              <Input {...reg("shipPhone")} type="tel" />
            </FormField>
            <FormField id="customerEmail" label="Email" error={errors.customerEmail?.message}>
              <Input {...reg("customerEmail")} type="email" />
            </FormField>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Fulfilment</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FormField id="warehouseId" label="Warehouse" required error={errors.warehouseId?.message}>
              <NativeSelect {...reg("warehouseId")}>
                <option value="">Choose…</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField id="shippingMethod" label="Shipping method" error={errors.shippingMethod?.message}>
              <Input {...reg("shippingMethod")} placeholder="e.g. Standard" />
            </FormField>
            {mode === "admin" && (
              <FormField id="tags" label="Tags" error={errors.tags?.message}>
                <Input {...reg("tags")} placeholder="comma, separated" />
              </FormField>
            )}
            <FormField id="notes" label="Notes" error={errors.notes?.message}>
              <Textarea {...reg("notes")} rows={2} />
            </FormField>
            {mode === "admin" && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 rounded border" disabled={pending} {...form.register("reserve")} /> Reserve stock now
              </label>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <CardDescription>{mode === "portal" ? "Only your own SKUs can be added." : "SKUs from different vendors can share one order; each line keeps its owner."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-80">SKU *</TableHead>
                  <TableHead className="w-28">Quantity *</TableHead>
                  {mode === "admin" && <TableHead className="w-32">Unit price</TableHead>}
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
                              ownerId={ownerId}
                              disabled={pending}
                              invalid={!!err?.variantId}
                              onChange={(v) => {
                                setPicked((p) => ({ ...p, [i]: v }));
                                f.onChange(v?.id ?? "");
                                // Default the line to the SKU's saved (retail) price; a price the user already typed is kept (QA PRC-04).
                                if (mode === "admin") {
                                  const current = String(form.getValues(`lines.${i}.unitPrice`) ?? "").trim();
                                  if (v && current === "") form.setValue(`lines.${i}.unitPrice`, v.price ?? "", { shouldDirty: true });
                                  if (!v) form.setValue(`lines.${i}.unitPrice`, "");
                                }
                              }}
                            />
                          )}
                        />
                        {err?.variantId?.message && <p className="mt-1 text-xs text-destructive">{err.variantId.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input type="number" min={1} step={1} inputMode="numeric" disabled={pending} aria-invalid={!!err?.quantity} {...form.register(`lines.${i}.quantity`)} />
                        {err?.quantity?.message && <p className="mt-1 text-xs text-destructive">{err.quantity.message}</p>}
                      </TableCell>
                      {mode === "admin" && (
                        <TableCell className="align-top">
                          <Input inputMode="decimal" placeholder="Saved price" title="Filled from the SKU's saved price; edit to override" disabled={pending} aria-invalid={!!err?.unitPrice} {...form.register(`lines.${i}.unitPrice`)} />
                          {err?.unitPrice?.message && <p className="mt-1 text-xs text-destructive">{err.unitPrice.message}</p>}
                        </TableCell>
                      )}
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
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => lines.append({ variantId: "", quantity: 1, unitPrice: "" })}>
            <Plus /> Add line
          </Button>
          {mode === "admin" && pickedKey && (
            <div className="rounded-lg border p-3 text-sm" data-slot="shopify-store-hint">
              {!storeHint ? (
                <p className="text-muted-foreground">Checking Shopify mapping…</p>
              ) : storeHint.ok ? (
                <>
                  <p>
                    Shopify: all lines map to <span className="font-medium">{storeHint.storeName}</span>.
                  </p>
                  <label className="mt-2 flex items-center gap-2">
                    <input type="checkbox" className="size-4 rounded border" disabled={pending} checked={sendToShopify} onChange={(e) => setSendToShopify(e.target.checked)} /> Send this order to {storeHint.storeName} after creating it
                  </label>
                </>
              ) : (
                <p className="text-amber-700">Shopify: {storeHint.message} The V3PL order can still be created; it just cannot be sent to Shopify.</p>
              )}
            </div>
          )}
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
          {mode === "portal" ? "Submit order" : "Create order"}
        </Button>
      </div>
    </form>
  );
}
