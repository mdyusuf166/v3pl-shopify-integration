"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { LocationSelect } from "@/components/inventory/location-select";
import { MAX_OPTIONS, productFormSchema, suggestedTitle, variantLabel, type ProductFormInput } from "@/lib/validation/products";
import { mergeVariantRows, parseOptionValues, renameOptionValue, valuesFromRows } from "@/lib/variant-builder";
import { checkSkuStoreConflictsAction, createProductAction, updateProductAction } from "@/server/actions/products";

export type OwnerOption = { id: string; code: string; businessName: string; type: "VENDOR" | "THREEPL_CLIENT" };

type VariantRow = ProductFormInput["variants"][number];
type WarehouseOption = { id: string; code: string; name: string };

type Props = {
  owners: OwnerOption[];
  /** Create flow: active warehouses offered for optional initial stock (D-058). */
  warehouses?: WarehouseOption[];
  /** Editing: product with variants; `lockedVariantIds` have stock history (cannot be removed). */
  product?: { id: string } & ProductFormInput;
  lockedVariantIds?: string[];
  ownerLocked?: boolean;
  /** Read-only stock per variant id for the edit screen. */
  inventory?: Record<string, { onHand: number; available: number }>;
};

const emptyVariant = (optionValues: string[]): VariantRow => ({ sku: "", optionValues, name: "", barcode: "", price: "", wholesalePrice: "", cost: "", weightGrams: "", lengthCm: "", widthCm: "", heightCm: "", initialQuantity: "", status: "ACTIVE" });

/**
 * Shopify-like product form (D-053, D-057): owner, title, status; then either one SKU (simple product)
 * or an option builder — up to 3 options, each with a list of values — that generates every combination
 * as a variant row. Existing rows keep their SKU, prices, physical data and status when values change;
 * rows with stock history are never dropped. The title of a simple product defaults to its SKU until
 * the user types one. SKUs already present in a connected Shopify store raise a non-blocking warning.
 */
export function ProductForm({ owners, warehouses = [], product, lockedVariantIds = [], ownerLocked = false, inventory = {} }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  // Initial stock (create flow only): one warehouse + location for all quantities entered below.
  const [stockWarehouseId, setStockWarehouseId] = useState(warehouses.length === 1 ? warehouses[0].id : "");
  const [stockLocationId, setStockLocationId] = useState("");
  const [stockError, setStockError] = useState<{ warehouseId?: string; locationId?: string } | null>(null);
  const [titleTouched, setTitleTouched] = useState(!!product?.name);
  const initialOptions = (product?.options ?? []).filter(Boolean);
  const [hasOptions, setHasOptions] = useState(initialOptions.length > 0);
  // Comma-separated value text per option, as typed; the parsed lists drive the combinations.
  const [valuesText, setValuesText] = useState<string[]>(() => valuesFromRows(product?.variants ?? [], initialOptions.length).map((l) => l.join(", ")));
  const [skuWarnings, setSkuWarnings] = useState<Record<string, string[]>>({});
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const form = useForm<ProductFormInput>({
    resolver: zodResolver(productFormSchema),
    defaultValues: product
      ? { ...product, options: initialOptions, variants: product.variants.map((v) => ({ ...emptyVariant([]), ...v, optionValues: initialOptions.map((_, j) => v.optionValues?.[j] ?? "") })) }
      : { ownerId: owners.length === 1 ? owners[0].id : "", name: "", category: "", description: "", notes: "", status: "ACTIVE", options: [], variants: [emptyVariant([])] },
  });
  const variants = useFieldArray({ control: form.control, name: "variants" });
  const optionNames = (useWatch({ control: form.control, name: "options" }) ?? []) as string[];
  const watchedVariants = (useWatch({ control: form.control, name: "variants" }) ?? []) as VariantRow[];
  const setOptionNames = (next: string[]) => form.setValue("options", next, { shouldDirty: true });
  const { errors } = form.formState;
  const isLocked = (row: VariantRow) => !!row.id && lockedVariantIds.includes(row.id);

  // ---------------------------------------------------------------- Shopify store warnings (debounced)
  const skuKey = watchedVariants.map((v) => (v.sku ?? "").trim().toUpperCase()).filter(Boolean).sort().join("|");
  useEffect(() => {
    if (!skuKey) return;
    if (warnTimer.current) clearTimeout(warnTimer.current);
    warnTimer.current = setTimeout(async () => {
      const res = await checkSkuStoreConflictsAction(skuKey.split("|"), product?.id);
      if (res.ok) setSkuWarnings(res.data);
    }, 500);
    return () => {
      if (warnTimer.current) clearTimeout(warnTimer.current);
    };
  }, [skuKey, product?.id]);

  // ---------------------------------------------------------------- option builder
  /** Re-generate the variant rows from the current option names + values, preserving existing rows. */
  function regenerate(nextValues: string[][], namesOverride?: string[]) {
    const names = namesOverride ?? optionNames;
    const options = names.map((name, j) => ({ name, values: nextValues[j] ?? [] }));
    if (options.some((o) => o.values.length === 0)) return; // wait until every option has at least one value
    const current = form.getValues("variants") as VariantRow[];
    const merged = mergeVariantRows(current, options, (values) => emptyVariant(values), isLocked);
    variants.replace(merged.rows);
  }

  function onValuesChange(j: number, text: string) {
    const next = [...valuesText];
    next[j] = text;
    setValuesText(next);
    const prevList = parseOptionValues(valuesText[j] ?? "");
    const list = parseOptionValues(text);
    // Same count, exactly one value changed at the same position → treat as a rename so the row keeps its SKU.
    if (prevList.length === list.length && list.length > 0) {
      const changed = list.map((v, k) => (v.toLowerCase() !== (prevList[k] ?? "").toLowerCase() ? k : -1)).filter((k) => k >= 0);
      if (changed.length === 1) {
        const k = changed[0];
        variants.replace(renameOptionValue(form.getValues("variants") as VariantRow[], j, prevList[k], list[k]));
      }
    }
    regenerate(next.map((t) => parseOptionValues(t)));
  }

  function toggleOptions(on: boolean) {
    setHasOptions(on);
    if (on && optionNames.length === 0) {
      setOptionNames([""]);
      setValuesText([""]);
      form.getValues("variants").forEach((_, i) => form.setValue(`variants.${i}.optionValues`, [""]));
    }
  }

  function addOption() {
    if (optionNames.length >= MAX_OPTIONS) return;
    setOptionNames([...optionNames, ""]);
    setValuesText([...valuesText, ""]);
    form.getValues("variants").forEach((v, i) => form.setValue(`variants.${i}.optionValues`, [...(v.optionValues ?? []), ""]));
  }

  function removeOption(j: number) {
    const names = optionNames.filter((_, k) => k !== j);
    const texts = valuesText.filter((_, k) => k !== j);
    setOptionNames(names);
    setValuesText(texts);
    const current = (form.getValues("variants") as VariantRow[]).map((v) => ({ ...v, optionValues: (v.optionValues ?? []).filter((_, k) => k !== j) }));
    variants.replace(current);
    if (names.length === 0) {
      setHasOptions(false);
      return;
    }
    regenerate(texts.map((t) => parseOptionValues(t)), names);
  }

  function onSubmit(values: ProductFormInput) {
    setFormError(null);
    setStockError(null);
    const payload: ProductFormInput = hasOptions ? values : { ...values, options: [], variants: values.variants.map((v) => ({ ...v, optionValues: [] })) };
    const wantsStock = !product && payload.variants.some((v) => Number(v.initialQuantity ?? 0) > 0);
    if (wantsStock && (!stockWarehouseId || !stockLocationId)) {
      setStockError({ warehouseId: stockWarehouseId ? undefined : "Choose the warehouse that receives the initial stock", locationId: stockLocationId ? undefined : "Choose the location" });
      return;
    }
    startTransition(async () => {
      const result = product ? await updateProductAction(product.id, payload) : await createProductAction(payload, wantsStock ? { warehouseId: stockWarehouseId, locationId: stockLocationId } : null);
      if (!result.ok) {
        setFormError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
          if (field === "initialStock.warehouseId") setStockError((e) => ({ ...e, warehouseId: message }));
          else if (field === "initialStock.locationId") setStockError((e) => ({ ...e, locationId: message }));
          else form.setError(field as keyof ProductFormInput, { message });
        }
        return;
      }
      const stock = !product ? ((result.data as { stock?: { units: number; lines: number } | null }).stock ?? null) : null;
      toast.success(product ? "Product updated" : stock ? `Product created — ${stock.units} unit${stock.units === 1 ? "" : "s"} received across ${stock.lines} SKU${stock.lines === 1 ? "" : "s"}` : "Product created");
      router.push(`/admin/products/${result.data.id}`);
      router.refresh();
    });
  }

  /** Title defaults to the SKU of a simple product until the user types a title of their own. */
  function onSkuChange(i: number, value: string) {
    if (i !== 0) return;
    const title = suggestedTitle(value, { hasOptions, titleTouched, editing: !!product });
    if (title !== null || (!titleTouched && !product && !hasOptions)) form.setValue("name", title ?? "", { shouldValidate: false });
  }

  const reg = (name: keyof ProductFormInput) => ({ id: name, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });
  const variantErrors = errors.variants as unknown as Array<Record<string, { message?: string }> | undefined> | undefined;
  const optionErrors = errors.options as unknown as Array<{ message?: string } | undefined> | undefined;
  const vendors = owners.filter((o) => o.type === "VENDOR");
  const clients = owners.filter((o) => o.type === "THREEPL_CLIENT");
  const simple = !hasOptions;
  const parsedValues = valuesText.map((t) => parseOptionValues(t));
  const combinationCount = hasOptions && parsedValues.length === optionNames.length && parsedValues.every((l) => l.length > 0) ? parsedValues.reduce((n, l) => n * l.length, 1) : 0;
  const generatedKeys = new Set(hasOptions ? watchedVariants.filter((v) => (v.optionValues ?? []).every((x, j) => parsedValues[j]?.some((p) => p.toLowerCase() === (x ?? "").toLowerCase()))).map((_, i) => i) : []);
  const warningCount = Object.keys(skuWarnings).length;
  const err = (i: number, field: string) => variantErrors?.[i]?.[field]?.message;
  const numField = (i: number, field: "wholesalePrice" | "weightGrams" | "lengthCm" | "widthCm" | "heightCm" | "price", placeholder: string, width: string) => (
    <TableCell className="align-top">
      <Input {...form.register(`variants.${i}.${field}` as const)} inputMode="decimal" placeholder={placeholder} className={width} aria-invalid={!!err(i, field)} disabled={pending} />
      {err(i, field) && <p className="mt-1 text-xs text-destructive">{err(i, field)}</p>}
    </TableCell>
  );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Product</CardTitle>
          <CardDescription>Belongs to exactly one vendor or 3PL client. {simple ? "The title defaults to the SKU; change it any time." : ""}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="ownerId" label="Owner" required error={errors.ownerId?.message} hint={ownerLocked ? "Locked: this product already has inventory history." : undefined}>
            <NativeSelect {...reg("ownerId")} disabled={pending || ownerLocked}>
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
          <FormField id="status" label="Status" error={errors.status?.message}>
            <NativeSelect {...reg("status")}>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </NativeSelect>
          </FormField>
          <FormField id="name" label="Title" required error={errors.name?.message} className="sm:col-span-2">
            <Input
              {...reg("name")}
              placeholder={simple ? "Defaults to the SKU" : "e.g. T-Shirt"}
              onChange={(e) => {
                form.register("name").onChange(e);
                setTitleTouched(e.target.value.trim().length > 0);
              }}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{simple ? "SKU" : "Variants"}</CardTitle>
            <CardDescription>{simple ? "One sellable unit. SKUs are unique across the whole platform." : "Name each option and list its values; every combination becomes a variant with its own SKU, prices and stock."}</CardDescription>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Switch checked={hasOptions} onCheckedChange={toggleOptions} disabled={pending} aria-label="This product has variants" />
            Has variants
          </label>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasOptions && (
            <div className="space-y-3" data-slot="option-builder">
              <p className="text-sm font-medium">Options</p>
              <div className="grid gap-3 md:grid-cols-3">
                {optionNames.map((_, j) => (
                  <div key={j} className="space-y-1.5 rounded-lg border p-3">
                    <div className="flex items-start gap-1">
                      <div className="flex-1">
                        <Input {...form.register(`options.${j}` as const)} placeholder={j === 0 ? "Option name, e.g. Color" : j === 1 ? "e.g. Size" : "e.g. Material"} aria-invalid={!!optionErrors?.[j]} disabled={pending} />
                        {optionErrors?.[j]?.message && <p className="mt-1 text-xs text-destructive">{optionErrors[j]?.message}</p>}
                      </div>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove option" disabled={pending} onClick={() => removeOption(j)}>
                        <Trash2 />
                      </Button>
                    </div>
                    <Input value={valuesText[j] ?? ""} onChange={(e) => onValuesChange(j, e.target.value)} placeholder={j === 0 ? "Values, e.g. White, Black" : j === 1 ? "e.g. L, XL, XXL" : "e.g. Cotton, Linen"} aria-label={`${optionNames[j] || `Option ${j + 1}`} values`} disabled={pending} />
                    {parsedValues[j]?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {parsedValues[j].map((v) => (
                          <span key={v} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {optionNames.length < MAX_OPTIONS && (
                  <Button type="button" variant="outline" size="sm" disabled={pending} onClick={addOption}>
                    <Plus /> Add option
                  </Button>
                )}
                <span>{combinationCount > 0 ? `${combinationCount} combination${combinationCount === 1 ? "" : "s"} → ${watchedVariants.length} variant row${watchedVariants.length === 1 ? "" : "s"}` : "Enter values for every option to generate the variants."} Existing rows keep their SKU and prices; rows with stock history are never removed.</span>
              </div>
              {typeof errors.options?.message === "string" && <p className="text-sm text-destructive">{errors.options.message}</p>}
            </div>
          )}

          {warningCount > 0 && (
            <Alert data-slot="sku-store-warning">
              <AlertTriangle />
              <AlertTitle>Shopify store check</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {Object.values(skuWarnings)
                    .flat()
                    .map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                </ul>
                <p className="mt-1">You can still save; existing Shopify mappings are never changed by this form.</p>
              </AlertDescription>
            </Alert>
          )}

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {hasOptions && optionNames.map((name, j) => <TableHead key={j} className="min-w-28">{name?.trim() || `Option ${j + 1}`} *</TableHead>)}
                  <TableHead className="min-w-44">SKU *</TableHead>
                  <TableHead className="min-w-36">Barcode</TableHead>
                  <TableHead className="min-w-24">Retail</TableHead>
                  <TableHead className="min-w-24">Wholesale</TableHead>
                  <TableHead className="min-w-20">Weight g</TableHead>
                  <TableHead className="min-w-52">L × W × H cm</TableHead>
                  {product && <TableHead className="min-w-28 text-right">Inventory</TableHead>}
                  <TableHead className="min-w-28">Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {variants.fields.map((field, i) => {
                  const row = watchedVariants[i] ?? field;
                  const locked = isLocked(row);
                  const orphan = hasOptions && combinationCount > 0 && !generatedKeys.has(i);
                  const skuUpper = (row.sku ?? "").trim().toUpperCase();
                  const warnings = skuUpper ? skuWarnings[skuUpper] : undefined;
                  const valueErrors = variantErrors?.[i]?.optionValues as unknown as Array<{ message?: string } | undefined> | undefined;
                  const inv = row.id ? inventory[row.id] : undefined;
                  return (
                    <TableRow key={field.id} className={orphan ? "bg-amber-50/60" : undefined}>
                      {hasOptions &&
                        optionNames.map((_, j) => (
                          <TableCell key={j} className="align-top">
                            <Input {...form.register(`variants.${i}.optionValues.${j}` as const)} readOnly className="bg-muted/40" aria-invalid={!!valueErrors?.[j]} disabled={pending} />
                            {valueErrors?.[j]?.message && <p className="mt-1 text-xs text-destructive">{valueErrors[j]?.message}</p>}
                            {orphan && j === 0 && <p className="mt-1 text-xs text-amber-700">{locked ? "Value removed but this SKU has stock history — archive it or re-add the value." : "Value no longer listed."}</p>}
                          </TableCell>
                        ))}
                      <TableCell className="align-top">
                        <Input {...form.register(`variants.${i}.sku`, { onChange: (e) => onSkuChange(i, e.target.value) })} className="font-mono uppercase" placeholder={hasOptions ? "TS-BLK-S" : "SKU"} aria-invalid={!!err(i, "sku")} disabled={pending} />
                        {err(i, "sku") && <p className="mt-1 text-xs text-destructive">{err(i, "sku")}</p>}
                        {warnings && warnings.length > 0 && <p className="mt-1 text-xs text-amber-700">Exists in a connected Shopify store — see warning above.</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input {...form.register(`variants.${i}.barcode` as const)} className="w-36 font-mono" placeholder="Optional" aria-label={`Barcode for row ${i + 1}`} aria-invalid={!!err(i, "barcode")} disabled={pending} />
                        {err(i, "barcode") && <p className="mt-1 text-xs text-destructive">{err(i, "barcode")}</p>}
                      </TableCell>
                      {numField(i, "price", "0.00", "w-24")}
                      {numField(i, "wholesalePrice", "0.00", "w-24")}
                      {numField(i, "weightGrams", "g", "w-20")}
                      <TableCell className="align-top">
                        <div className="flex items-center gap-1">
                          <Input {...form.register(`variants.${i}.lengthCm` as const)} inputMode="decimal" placeholder="L" className="w-16" aria-invalid={!!err(i, "lengthCm")} disabled={pending} />
                          <span className="text-xs text-muted-foreground">×</span>
                          <Input {...form.register(`variants.${i}.widthCm` as const)} inputMode="decimal" placeholder="W" className="w-16" aria-invalid={!!err(i, "widthCm")} disabled={pending} />
                          <span className="text-xs text-muted-foreground">×</span>
                          <Input {...form.register(`variants.${i}.heightCm` as const)} inputMode="decimal" placeholder="H" className="w-16" aria-invalid={!!err(i, "heightCm")} disabled={pending} />
                        </div>
                        {(err(i, "lengthCm") || err(i, "widthCm") || err(i, "heightCm")) && <p className="mt-1 text-xs text-destructive">{err(i, "lengthCm") ?? err(i, "widthCm") ?? err(i, "heightCm")}</p>}
                      </TableCell>
                      {product && (
                        <TableCell className="align-top text-right text-sm tabular-nums">
                          {inv ? (
                            <>
                              <span className={inv.available > 0 ? "" : "text-muted-foreground"}>{inv.available} available</span>
                              <div className="text-xs text-muted-foreground">{inv.onHand} on hand</div>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">{row.id ? "No stock" : "New"}</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="align-top">
                        <NativeSelect {...form.register(`variants.${i}.status`)} disabled={pending}>
                          <option value="ACTIVE">Active</option>
                          <option value="ARCHIVED">Archived</option>
                        </NativeSelect>
                      </TableCell>
                      <TableCell className="align-top">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove variant"
                          disabled={pending || locked || variants.fields.length === 1 || (hasOptions && !orphan)}
                          title={locked ? "Has inventory history — archive instead" : hasOptions && !orphan ? "Generated from the option values — remove the value instead" : undefined}
                          onClick={() => variants.remove(i)}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {typeof errors.variants?.message === "string" && <p className="text-sm text-destructive">{errors.variants.message}</p>}
          {!hasOptions && variants.fields.length > 1 && <p className="text-xs text-muted-foreground">This product has several SKUs without option names. Turn on “Has variants” to name them.</p>}
        </CardContent>
      </Card>

      {!product && (
        <Card data-slot="initial-stock">
          <CardHeader>
            <CardTitle>Initial inventory (optional)</CardTitle>
            <CardDescription>Receive opening stock for the new SKUs without leaving this page. Leave quantities blank to create the product with zero stock. Booked as a receipt — it appears in Receiving and the inventory history like any other receipt.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="stockWarehouseId" label="Warehouse" error={stockError?.warehouseId}>
                <NativeSelect
                  id="stockWarehouseId"
                  value={stockWarehouseId}
                  disabled={pending || warehouses.length === 0}
                  aria-invalid={!!stockError?.warehouseId}
                  onChange={(e) => {
                    setStockWarehouseId(e.target.value);
                    setStockLocationId("");
                  }}
                >
                  <option value="">{warehouses.length === 0 ? "No active warehouse" : "Choose…"}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {w.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField id="stockLocationId" label="Location" error={stockError?.locationId} hint="Defaults to the warehouse's main location.">
                <LocationSelect id="stockLocationId" warehouseId={stockWarehouseId || null} value={stockLocationId} onChange={setStockLocationId} disabled={pending} invalid={!!stockError?.locationId} />
              </FormField>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {hasOptions && <TableHead>Variant</TableHead>}
                    <TableHead>SKU</TableHead>
                    <TableHead className="w-32">Quantity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variants.fields.map((field, i) => {
                    const row = watchedVariants[i] ?? field;
                    return (
                      <TableRow key={field.id}>
                        {hasOptions && <TableCell className="text-sm">{variantLabel({ optionValues: row.optionValues }) ?? <span className="text-muted-foreground">—</span>}</TableCell>}
                        <TableCell className="font-mono text-xs">{(row.sku ?? "").trim().toUpperCase() || <span className="font-sans text-muted-foreground">SKU not set</span>}</TableCell>
                        <TableCell>
                          <Input {...form.register(`variants.${i}.initialQuantity` as const)} inputMode="numeric" placeholder="0" className="w-24" aria-label={`Initial quantity for ${(row.sku ?? "").toUpperCase() || `row ${i + 1}`}`} aria-invalid={!!err(i, "initialQuantity")} disabled={pending} />
                          {err(i, "initialQuantity") && <p className="mt-1 text-xs text-destructive">{err(i, "initialQuantity")}</p>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              {(() => {
                const total = watchedVariants.reduce((n, v) => n + (Number(v.initialQuantity) > 0 ? Number(v.initialQuantity) : 0), 0);
                return total > 0 ? `${total} unit${total === 1 ? "" : "s"} will be received on save.` : "No initial stock — the product is created with zero stock.";
              })()}
            </p>
          </CardContent>
        </Card>
      )}

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {product ? "Save changes" : "Create product"}
        </Button>
      </div>
    </form>
  );
}
