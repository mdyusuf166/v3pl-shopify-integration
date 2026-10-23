"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { formatDate, formatMoney } from "@/lib/format";
import { vendorPayableFormSchema, type VendorPayableFormInput, type VendorPayableFormValues } from "@/lib/validation/finance";
import { createVendorPayableAction } from "@/server/actions/finance";

export type AllocationRow = { receivingItemId: string; reference: string | null; receivedAt: string; warehouse: string; sku: string; title: string; received: number; allocated: number; remaining: number; wholesalePrice: string | null };

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

/** Admin: create a vendor payable by allocating units from a received line (D-064). The server re-checks the remaining quantity inside a row lock. */
export function VendorPayableForm({ ownerId, ownerName, rows }: { ownerId: string; ownerName: string; rows: AllocationRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const open = rows.filter((r) => r.remaining > 0);
  const form = useForm<VendorPayableFormInput, unknown, VendorPayableFormValues>({ resolver: zodResolver(vendorPayableFormSchema), defaultValues: { receivingItemId: open[0]?.receivingItemId ?? "", quantity: "", unitAmount: "", reference: "", notes: "", idempotencyKey: newKey() } });
  const { errors } = form.formState;
  const receivingItemId = useWatch({ control: form.control, name: "receivingItemId" });
  const quantity = useWatch({ control: form.control, name: "quantity" });
  const unitAmount = useWatch({ control: form.control, name: "unitAmount" });
  const line = useMemo(() => rows.find((r) => r.receivingItemId === receivingItemId) ?? null, [rows, receivingItemId]);
  const unit = unitAmount ? Number(unitAmount) : line?.wholesalePrice ? Number(line.wholesalePrice) : null;
  const qty = Number(quantity);
  const total = unit !== null && qty > 0 ? unit * qty : null;
  const over = !!line && qty > line.remaining;

  function onSubmit() {
    setFormError(null);
    const values = form.getValues();
    startTransition(async () => {
      const res = await createVendorPayableAction(ownerId, values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof VendorPayableFormInput, { message: m });
        return;
      }
      toast.success(res.data.created ? "Payable recorded" : "This payable was already recorded — nothing duplicated");
      form.reset({ receivingItemId: values.receivingItemId, quantity: "", unitAmount: "", reference: "", notes: "", idempotencyKey: newKey() });
      router.refresh();
    });
  }
  const reg = (name: keyof VendorPayableFormInput) => ({ id: name, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <Card data-slot="vendor-payable-form">
      <CardHeader>
        <CardTitle className="text-base">Create payable from received inventory</CardTitle>
        <CardDescription>Record what V3PL owes {ownerName} for units it received. Receiving and shipping never create this automatically; each received unit can be allocated to a payable once.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No receipts recorded for this vendor yet.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-md border">
            <Table data-slot="receiving-allocations">
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Allocated</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right">Wholesale</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.receivingItemId} className={r.remaining === 0 ? "text-muted-foreground" : undefined} data-remaining={r.remaining}>
                    <TableCell className="whitespace-nowrap">{formatDate(r.receivedAt)}</TableCell>
                    <TableCell>
                      <span className="font-medium">{r.sku}</span> <span className="text-xs text-muted-foreground">{r.title}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.reference ?? "—"} · {r.warehouse}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.received}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.allocated}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{r.remaining}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.wholesalePrice ? formatMoney(r.wholesalePrice) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {open.length > 0 && (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:grid-cols-2">
            {formError && (
              <Alert variant="destructive" className="sm:col-span-2">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <FormField id="receivingItemId" label="Received line" required error={errors.receivingItemId?.message} className="sm:col-span-2">
              <select {...reg("receivingItemId")} className={selectClass}>
                {open.map((r) => (
                  <option key={r.receivingItemId} value={r.receivingItemId}>
                    {formatDate(r.receivedAt)} · {r.sku} · {r.remaining} of {r.received} remaining{r.reference ? ` · ${r.reference}` : ""}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="quantity" label="Quantity" required error={errors.quantity?.message ?? (over ? `Only ${line?.remaining} remaining` : undefined)} hint={line ? `${line.received} received · ${line.allocated} already allocated · ${line.remaining} remaining` : undefined}>
              <Input {...reg("quantity")} inputMode="numeric" min={1} max={line?.remaining ?? undefined} aria-invalid={!!errors.quantity || over} />
            </FormField>
            <FormField id="unitAmount" label="Unit cost" error={errors.unitAmount?.message} hint={line?.wholesalePrice ? `Blank = current wholesale price ${formatMoney(line.wholesalePrice)}; the value used is frozen on the entry.` : "This SKU has no wholesale price — enter the unit cost."}>
              <Input {...reg("unitAmount")} inputMode="decimal" placeholder={line?.wholesalePrice ?? "0.00"} />
            </FormField>
            <FormField id="reference" label="Reference" error={errors.reference?.message}>
              <Input {...reg("reference")} placeholder="Supplier invoice / PO number" />
            </FormField>
            <FormField id="notes" label="Notes" error={errors.notes?.message}>
              <Textarea {...reg("notes")} rows={1} />
            </FormField>
            <input type="hidden" {...form.register("idempotencyKey")} />
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={pending || over || !line || qty < 1 || unit === null}>
                {pending && <Loader2 className="animate-spin" />} Record payable{total !== null ? ` · ${formatMoney(total)}` : ""}
              </Button>
              {total !== null && !over && (
                <span className="text-sm text-muted-foreground">
                  {qty} × {formatMoney(unit!)}
                </span>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
