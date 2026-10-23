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
import { SETTLEMENT_KINDS, SETTLEMENT_KIND_LABELS, settlementFormSchema, type SettlementFormInput, type SettlementFormValues } from "@/lib/validation/finance";
import { recordSettlementAction } from "@/server/actions/finance";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

/** Admin: record a payment or an authorised adjustment for one owner. One idempotency key per form instance. */
export function SettlementForm({ ownerId, ownerName }: { ownerId: string; ownerName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<SettlementFormInput, unknown, SettlementFormValues>({ resolver: zodResolver(settlementFormSchema), defaultValues: { kind: "PAYMENT_TO_OWNER", amount: "", occurredAt: "", reference: "", notes: "", idempotencyKey: newKey() } });
  const { errors } = form.formState;
  const kind = useWatch({ control: form.control, name: "kind" });

  function onSubmit(parsed: SettlementFormValues) {
    setFormError(null);
    const values = form.getValues(); // raw form input; the action re-validates server-side
    startTransition(async () => {
      const res = await recordSettlementAction(ownerId, values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof SettlementFormInput, { message: m });
        return;
      }
      toast.success(res.data.created ? "Entry recorded" : "This entry was already recorded — nothing duplicated");
      form.reset({ kind: parsed.kind, amount: "", occurredAt: "", reference: "", notes: "", idempotencyKey: newKey() });
      router.refresh();
    });
  }
  const reg = (name: keyof SettlementFormInput) => ({ id: name, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <Card data-slot="settlement-form">
      <CardHeader>
        <CardTitle className="text-base">Record payment / adjustment</CardTitle>
        <CardDescription>Manual settlement entry for {ownerName}. Entries are permanent; record a correcting entry rather than editing.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:grid-cols-2">
          {formError && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <FormField id="kind" label="Entry" required error={errors.kind?.message} hint={SETTLEMENT_KIND_LABELS[kind ?? "PAYMENT_TO_OWNER"].hint} className="sm:col-span-2">
            <select {...reg("kind")} className={selectClass}>
              {SETTLEMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SETTLEMENT_KIND_LABELS[k].label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="amount" label="Amount" required error={errors.amount?.message}>
            <Input {...reg("amount")} inputMode="decimal" placeholder="0.00" />
          </FormField>
          <FormField id="occurredAt" label="Date" error={errors.occurredAt?.message} hint="Leave blank for now.">
            <Input {...reg("occurredAt")} type="datetime-local" />
          </FormField>
          <FormField id="reference" label="Payment reference" error={errors.reference?.message} className="sm:col-span-2">
            <Input {...reg("reference")} placeholder="Bank reference, cheque or document number" />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea {...reg("notes")} rows={2} />
          </FormField>
          <input type="hidden" {...form.register("idempotencyKey")} />
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Record entry
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
