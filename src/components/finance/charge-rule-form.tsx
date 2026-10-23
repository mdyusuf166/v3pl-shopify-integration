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
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { CHARGE_BASES, CHARGE_BASIS_LABELS, CHARGE_TYPES, CHARGE_TYPE_LABELS, chargeRuleFormSchema, type ChargeRuleFormInput, type ChargeRuleFormValues } from "@/lib/validation/finance";
import { createChargeRuleAction, updateChargeRuleAction } from "@/server/actions/finance";

export type OwnerOption = { id: string; businessName: string; code: string; type: "VENDOR" | "THREEPL_CLIENT" };

const EMPTY: ChargeRuleFormInput = { name: "", chargeType: "PICKING", basis: "PER_UNIT", amount: "", active: true, ownerType: "", ownerId: "", minWeightGrams: "", maxWeightGrams: "", minLongestCm: "", maxLongestCm: "", notes: "" };
const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

/** Admin: create / edit one charge rule. Editing never touches charges already applied. */
export function ChargeRuleForm({ rule, owners, appliedCount = 0 }: { rule?: { id: string } & ChargeRuleFormInput; owners: OwnerOption[]; appliedCount?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<ChargeRuleFormInput, unknown, ChargeRuleFormValues>({ resolver: zodResolver(chargeRuleFormSchema), defaultValues: rule ?? EMPTY });
  const { errors } = form.formState;
  const basis = useWatch({ control: form.control, name: "basis" });
  const ownerId = useWatch({ control: form.control, name: "ownerId" });

  function onSubmit(values: ChargeRuleFormValues) {
    setFormError(null);
    startTransition(async () => {
      const res = rule ? await updateChargeRuleAction(rule.id, values) : await createChargeRuleAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof ChargeRuleFormInput, { message: m });
        return;
      }
      toast.success(rule ? "Charge rule updated" : "Charge rule created");
      router.push("/admin/settings/charges");
      router.refresh();
    });
  }
  const reg = (name: keyof ChargeRuleFormInput) => ({ id: name, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });
  const scopeHint = basis === "PER_UNIT" ? "Ranges are checked against each unit's own weight / longest side." : "Ranges are checked against the total weight of the owner's units in the shipment and the largest unit's longest side.";

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      {rule && appliedCount > 0 && (
        <Alert>
          <AlertDescription>This rule has been applied {appliedCount} time(s). Changing it affects future shipments only; recorded charges keep their original amounts.</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Charge</CardTitle>
          <CardDescription>What is charged and how the amount is multiplied.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="name" label="Name" required error={errors.name?.message} className="sm:col-span-2">
            <Input {...reg("name")} placeholder="e.g. Standard pick fee" />
          </FormField>
          <FormField id="chargeType" label="Charge type" required error={errors.chargeType?.message}>
            <select {...reg("chargeType")} className={selectClass}>
              {CHARGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CHARGE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="basis" label="Applies" required error={errors.basis?.message}>
            <select {...reg("basis")} className={selectClass}>
              {CHARGE_BASES.map((b) => (
                <option key={b} value={b}>
                  {CHARGE_BASIS_LABELS[b]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="amount" label="Amount" required error={errors.amount?.message} hint={basis === "PER_UNIT" ? "Charged for every unit shipped." : basis === "PER_SHIPMENT" ? "Charged once per shipment, per owner." : "Charged once per order, per owner (at its first shipment)."}>
            <Input {...reg("amount")} inputMode="decimal" placeholder="0.00" />
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" className="size-4 rounded border" disabled={pending} {...form.register("active")} /> Active
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who it applies to</CardTitle>
          <CardDescription>Charges are only ever recorded for businesses with “Apply operational charges” enabled on their profile.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="ownerId" label="Specific business" error={errors.ownerId?.message} hint="Leave empty to use the owner-type filter.">
            <select {...reg("ownerId")} className={selectClass}>
              <option value="">All businesses</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.businessName} ({o.code}) · {o.type === "VENDOR" ? "Vendor" : "3PL client"}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ownerType" label="Owner type" error={errors.ownerType?.message}>
            <select {...reg("ownerType")} className={selectClass} disabled={pending || !!ownerId}>
              <option value="">Vendors and 3PL clients</option>
              <option value="VENDOR">Vendors only</option>
              <option value="THREEPL_CLIENT">3PL clients only</option>
            </select>
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Optional ranges</CardTitle>
          <CardDescription>Uses each SKU&apos;s weight (g) and dimensions (cm) from the product. A unit without the needed data never matches a ranged rule. {scopeHint}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="minWeightGrams" label="Min weight (g)" error={errors.minWeightGrams?.message}>
            <Input {...reg("minWeightGrams")} inputMode="numeric" />
          </FormField>
          <FormField id="maxWeightGrams" label="Max weight (g)" error={errors.maxWeightGrams?.message}>
            <Input {...reg("maxWeightGrams")} inputMode="numeric" />
          </FormField>
          <FormField id="minLongestCm" label="Min longest side (cm)" error={errors.minLongestCm?.message}>
            <Input {...reg("minLongestCm")} inputMode="decimal" />
          </FormField>
          <FormField id="maxLongestCm" label="Max longest side (cm)" error={errors.maxLongestCm?.message}>
            <Input {...reg("maxLongestCm")} inputMode="decimal" />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea {...reg("notes")} rows={2} />
          </FormField>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} {rule ? "Save changes" : "Create rule"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => router.push("/admin/settings/charges")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
