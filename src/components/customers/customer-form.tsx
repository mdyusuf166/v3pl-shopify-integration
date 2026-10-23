"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { customerFormSchema, type CustomerFormInput } from "@/lib/validation/customers";
import { checkCustomerDuplicatesAction, createCustomerAction, updateCustomerAction } from "@/server/actions/customers";
import type { DuplicateMatch } from "@/server/services/customers";

export type CustomerOwnerOption = { id: string; code: string; businessName: string; type: "VENDOR" | "THREEPL_CLIENT" };

type Props = {
  /** Where the list lives for this audience (admin or a portal). */
  basePath: string;
  /** Staff only: owners selectable for the customer; portals never see this. */
  owners?: CustomerOwnerOption[];
  customer?: { id: string } & CustomerFormInput;
  /** Owner locked once the customer has orders. */
  ownerLocked?: boolean;
};

const EMPTY: CustomerFormInput = { ownerId: "", name: "", email: "", phone: "", shipName: "", shipCompany: "", shipAddress1: "", shipAddress2: "", shipCity: "", shipProvince: "", shipZip: "", shipCountry: "", shipPhone: "", billName: "", billCompany: "", billAddress1: "", billAddress2: "", billCity: "", billProvince: "", billZip: "", billCountry: "", notes: "" };

/** Shared create/edit form for the customer directory (admin + portals). Warns about likely duplicates, never blocks. */
export function CustomerForm({ basePath, owners, customer, ownerLocked = false }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [dupes, setDupes] = useState<DuplicateMatch[]>([]);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const form = useForm<CustomerFormInput>({ resolver: zodResolver(customerFormSchema), defaultValues: customer ?? EMPTY });
  const { errors } = form.formState;
  const [name, email, phone, ownerId] = useWatch({ control: form.control, name: ["name", "email", "phone", "ownerId"] }) as [string, string, string, string];

  // Likely duplicates in the same owner pool, debounced; staff pass the owner they are creating for.
  const probeKey = `${(name ?? "").trim().toLowerCase()}|${(email ?? "").trim().toLowerCase()}|${(phone ?? "").replace(/\D+/g, "")}|${ownerId ?? ""}`;
  useEffect(() => {
    if (!probeKey.replace(/\|/g, "")) return;
    if (dupTimer.current) clearTimeout(dupTimer.current);
    dupTimer.current = setTimeout(async () => {
      const res = await checkCustomerDuplicatesAction({ name, email, phone, ownerId: ownerId || null, excludeId: customer?.id });
      if (res.ok) setDupes(res.data);
    }, 450);
    return () => {
      if (dupTimer.current) clearTimeout(dupTimer.current);
    };
  }, [probeKey, name, email, phone, ownerId, customer?.id]);

  function onSubmit(values: CustomerFormInput) {
    setFormError(null);
    startTransition(async () => {
      const res = customer ? await updateCustomerAction(customer.id, values) : await createCustomerAction(values);
      if (!res.ok) {
        setFormError(res.error);
        for (const [f, m] of Object.entries(res.fieldErrors ?? {})) form.setError(f as keyof CustomerFormInput, { message: m });
        return;
      }
      toast.success(customer ? "Customer updated" : "Customer created");
      router.push(`${basePath}/${res.data.id}`);
      router.refresh();
    });
  }

  const reg = (n: keyof CustomerFormInput) => ({ id: n, "aria-invalid": !!errors[n], disabled: pending, ...form.register(n) });
  const copyShippingToBilling = () => {
    const v = form.getValues();
    form.setValue("billName", v.shipName ?? "");
    form.setValue("billCompany", v.shipCompany ?? "");
    form.setValue("billAddress1", v.shipAddress1 ?? "");
    form.setValue("billAddress2", v.shipAddress2 ?? "");
    form.setValue("billCity", v.shipCity ?? "");
    form.setValue("billProvince", v.shipProvince ?? "");
    form.setValue("billZip", v.shipZip ?? "");
    form.setValue("billCountry", v.shipCountry ?? "");
  };
  const address = (prefix: "ship" | "bill") => (
    <>
      <FormField id={`${prefix}Name`} label="Name" error={errors[`${prefix}Name`]?.message}>
        <Input {...reg(`${prefix}Name`)} />
      </FormField>
      <FormField id={`${prefix}Company`} label="Company" error={errors[`${prefix}Company`]?.message}>
        <Input {...reg(`${prefix}Company`)} />
      </FormField>
      <FormField id={`${prefix}Address1`} label="Address line 1" error={errors[`${prefix}Address1`]?.message} className="sm:col-span-2">
        <Input {...reg(`${prefix}Address1`)} />
      </FormField>
      <FormField id={`${prefix}Address2`} label="Address line 2" error={errors[`${prefix}Address2`]?.message} className="sm:col-span-2">
        <Input {...reg(`${prefix}Address2`)} />
      </FormField>
      <FormField id={`${prefix}City`} label="City" error={errors[`${prefix}City`]?.message}>
        <Input {...reg(`${prefix}City`)} />
      </FormField>
      <FormField id={`${prefix}Province`} label="State / Province" error={errors[`${prefix}Province`]?.message}>
        <Input {...reg(`${prefix}Province`)} />
      </FormField>
      <FormField id={`${prefix}Zip`} label="Postal code" error={errors[`${prefix}Zip`]?.message}>
        <Input {...reg(`${prefix}Zip`)} />
      </FormField>
      <FormField id={`${prefix}Country`} label="Country" error={errors[`${prefix}Country`]?.message}>
        <Input {...reg(`${prefix}Country`)} />
      </FormField>
    </>
  );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
          <CardDescription>Operational contact details only — no login, no marketing.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {owners && (
            <FormField id="ownerId" label="Belongs to" error={errors.ownerId?.message} hint={ownerLocked ? "Locked: this customer already has orders." : "Company = V3PL's own customers (manual orders)."} className="sm:col-span-2">
              <NativeSelect {...reg("ownerId")} disabled={pending || ownerLocked}>
                <option value="">Company (V3PL)</option>
                {owners.filter((o) => o.type === "VENDOR").length > 0 && (
                  <optgroup label="Vendors">
                    {owners
                      .filter((o) => o.type === "VENDOR")
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.businessName} ({o.code})
                        </option>
                      ))}
                  </optgroup>
                )}
                {owners.filter((o) => o.type === "THREEPL_CLIENT").length > 0 && (
                  <optgroup label="3PL clients">
                    {owners
                      .filter((o) => o.type === "THREEPL_CLIENT")
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.businessName} ({o.code})
                        </option>
                      ))}
                  </optgroup>
                )}
              </NativeSelect>
            </FormField>
          )}
          <FormField id="name" label="Name" required error={errors.name?.message}>
            <Input {...reg("name")} />
          </FormField>
          <FormField id="email" label="Email" error={errors.email?.message}>
            <Input {...reg("email")} type="email" />
          </FormField>
          <FormField id="phone" label="Phone" error={errors.phone?.message}>
            <Input {...reg("phone")} type="tel" />
          </FormField>
          <FormField id="notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea {...reg("notes")} rows={2} />
          </FormField>
        </CardContent>
      </Card>

      {dupes.length > 0 && (
        <Alert data-slot="customer-duplicates">
          <AlertTriangle />
          <AlertTitle>Possible duplicate{dupes.length === 1 ? "" : "s"}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link href={`${basePath}/${d.id}`} className="underline underline-offset-4">
                    {d.name}
                  </Link>
                  {d.email ? ` · ${d.email}` : ""}
                  {d.phone ? ` · ${d.phone}` : ""} — same {d.matchedBy.join(" and ")}
                </li>
              ))}
            </ul>
            <p className="mt-1">Open the existing record instead of creating another one, or save anyway if it really is a different customer.</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shipping address</CardTitle>
            <CardDescription>Default ship-to for new orders; each order keeps its own editable copy.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {address("ship")}
            <FormField id="shipPhone" label="Phone at address" error={errors.shipPhone?.message}>
              <Input {...reg("shipPhone")} type="tel" />
            </FormField>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Billing address</CardTitle>
              <CardDescription>Optional.</CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={copyShippingToBilling}>
              Same as shipping
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">{address("bill")}</CardContent>
        </Card>
      </div>

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
          {customer ? "Save changes" : "Create customer"}
        </Button>
      </div>
    </form>
  );
}
