"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { warehouseFormSchema, type WarehouseFormInput } from "@/lib/validation/warehouses";
import { createWarehouseAction, updateWarehouseAction } from "@/server/actions/warehouses";

const EMPTY: WarehouseFormInput = { code: "", name: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "", notes: "" };

export function WarehouseForm({ warehouse }: { warehouse?: { id: string } & WarehouseFormInput }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<WarehouseFormInput>({ resolver: zodResolver(warehouseFormSchema), defaultValues: warehouse ?? EMPTY });
  const { errors } = form.formState;

  function onSubmit(values: WarehouseFormInput) {
    setFormError(null);
    startTransition(async () => {
      const result = warehouse ? await updateWarehouseAction(warehouse.id, values) : await createWarehouseAction(values);
      if (!result.ok) {
        setFormError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) form.setError(field as keyof WarehouseFormInput, { message });
        return;
      }
      toast.success(warehouse ? "Warehouse updated" : "Warehouse created");
      router.push(`/admin/warehouses/${result.data.id}`);
      router.refresh();
    });
  }
  const reg = (name: keyof WarehouseFormInput) => ({ id: name, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Warehouse</CardTitle>
          <CardDescription>{warehouse ? "Update the warehouse details." : "A default MAIN location is created automatically; add zones, racks, shelves and bins afterwards."}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="code" label="Code" required error={errors.code?.message} hint="Short unique code, e.g. WH-A.">
            <Input {...reg("code")} className="uppercase" autoComplete="off" />
          </FormField>
          <FormField id="name" label="Name" required error={errors.name?.message}>
            <Input {...reg("name")} />
          </FormField>
          <FormField id="addressLine1" label="Address line 1" error={errors.addressLine1?.message} className="sm:col-span-2">
            <Input {...reg("addressLine1")} />
          </FormField>
          <FormField id="addressLine2" label="Address line 2" error={errors.addressLine2?.message} className="sm:col-span-2">
            <Input {...reg("addressLine2")} />
          </FormField>
          <FormField id="city" label="City" error={errors.city?.message}>
            <Input {...reg("city")} />
          </FormField>
          <FormField id="state" label="State / Province" error={errors.state?.message}>
            <Input {...reg("state")} />
          </FormField>
          <FormField id="postalCode" label="Postal code" error={errors.postalCode?.message}>
            <Input {...reg("postalCode")} />
          </FormField>
          <FormField id="country" label="Country" error={errors.country?.message}>
            <Input {...reg("country")} />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea {...reg("notes")} rows={3} />
          </FormField>
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
          {warehouse ? "Save changes" : "Create warehouse"}
        </Button>
      </div>
    </form>
  );
}
