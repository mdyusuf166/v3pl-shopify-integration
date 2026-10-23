"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { OwnerType } from "@/generated/prisma/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { OWNER_TYPE_META, ownerFormSchema, type OwnerFormInput } from "@/lib/validation/owners";
import { createOwnerAction, updateOwnerAction } from "@/server/actions/owners";

type Props = {
  type: OwnerType;
  /** Present when editing. */
  owner?: { id: string } & OwnerFormInput;
};

const EMPTY: OwnerFormInput = {
  code: "",
  businessName: "",
  contactName: "",
  email: "",
  phone: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
  notes: "",
  chargesEnabled: false,
};

function toInput(owner: Props["owner"]): OwnerFormInput {
  if (!owner) return EMPTY;
  const out = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof OwnerFormInput)[]) {
    if (key === "chargesEnabled") out.chargesEnabled = owner.chargesEnabled ?? false;
    else out[key] = (owner[key] as string | null | undefined) ?? "";
  }
  return out;
}

export function OwnerForm({ type, owner }: Props) {
  const router = useRouter();
  const meta = OWNER_TYPE_META[type];
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<OwnerFormInput>({
    resolver: zodResolver(ownerFormSchema),
    defaultValues: toInput(owner),
  });
  const { errors } = form.formState;

  function onSubmit(values: OwnerFormInput) {
    setFormError(null);
    startTransition(async () => {
      const result = owner ? await updateOwnerAction(type, owner.id, values) : await createOwnerAction(type, values);
      if (!result.ok) {
        setFormError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
          form.setError(field as keyof OwnerFormInput, { message });
        }
        return;
      }
      toast.success(owner ? `${meta.singular} updated` : `${meta.singular} created`);
      router.push(`${meta.basePath}/${result.data.id}`);
      router.refresh();
    });
  }

  const field = (name: keyof OwnerFormInput) => ({
    id: name,
    "aria-invalid": !!errors[name],
    disabled: pending,
    ...form.register(name),
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Business</CardTitle>
          <CardDescription>How this {meta.singular.toLowerCase()} appears across the platform.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="code" label="Code" required error={errors.code?.message} hint="Short unique code used in imports, exports and reports. Letters, numbers, hyphens.">
            <Input {...field("code")} placeholder="e.g. ACME" className="uppercase" autoComplete="off" />
          </FormField>
          <FormField id="businessName" label="Business name" required error={errors.businessName?.message}>
            <Input {...field("businessName")} autoComplete="organization" />
          </FormField>
          <FormField id="contactName" label="Contact person" error={errors.contactName?.message}>
            <Input {...field("contactName")} autoComplete="off" />
          </FormField>
          <FormField id="email" label="Email" error={errors.email?.message}>
            <Input {...field("email")} type="email" autoComplete="off" />
          </FormField>
          <FormField id="phone" label="Phone" error={errors.phone?.message}>
            <Input {...field("phone")} type="tel" autoComplete="off" />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Address</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="addressLine1" label="Address line 1" error={errors.addressLine1?.message} className="sm:col-span-2">
            <Input {...field("addressLine1")} />
          </FormField>
          <FormField id="addressLine2" label="Address line 2" error={errors.addressLine2?.message} className="sm:col-span-2">
            <Input {...field("addressLine2")} />
          </FormField>
          <FormField id="city" label="City" error={errors.city?.message}>
            <Input {...field("city")} />
          </FormField>
          <FormField id="state" label="State / Province" error={errors.state?.message}>
            <Input {...field("state")} />
          </FormField>
          <FormField id="postalCode" label="Postal code" error={errors.postalCode?.message}>
            <Input {...field("postalCode")} />
          </FormField>
          <FormField id="country" label="Country" error={errors.country?.message}>
            <Input {...field("country")} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Internal notes</CardTitle>
          <CardDescription>Visible to staff only.</CardDescription>
        </CardHeader>
        <CardContent>
          <FormField id="notes" label="Notes" error={errors.notes?.message}>
            <Textarea {...field("notes")} rows={4} />
          </FormField>
          <label className="mt-4 flex items-start gap-3 text-sm" data-slot="charges-enabled">
            <input type="checkbox" id="chargesEnabled" className="mt-0.5 size-4 rounded border" disabled={pending} {...form.register("chargesEnabled")} />
            <span>
              <span className="font-medium">Apply operational charges</span>
              <span className="block text-muted-foreground">When enabled, the active charge rules (Settings → Charges) are applied to this business&apos;s shipments and recorded in its settlement ledger. Existing charges are never changed by this switch.</span>
            </span>
          </label>
        </CardContent>
      </Card>

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
          {owner ? "Save changes" : `Create ${meta.singular.toLowerCase()}`}
        </Button>
      </div>
    </form>
  );
}
