"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/common/form-field";
import { addStoreSchema, type AddStoreInput } from "@/lib/validation/shopify";
import { beginInstallAction } from "@/server/actions/shopify";

const EMPTY: AddStoreInput = { shopDomain: "", name: "" };

/**
 * “Add Shopify Store”: collects the myshopify domain, then sends the browser to Shopify's
 * authorization page. The store appears as “Waiting for authorization” until Shopify calls back.
 */
export function AddStoreDialog({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<AddStoreInput>({ resolver: zodResolver(addStoreSchema), defaultValues: EMPTY });
  const { errors } = form.formState;

  function close() {
    setOpen(false);
    setFormError(null);
    form.reset(EMPTY);
  }

  function onSubmit(values: AddStoreInput) {
    setFormError(null);
    startTransition(async () => {
      const result = await beginInstallAction(values);
      if (!result.ok) {
        setFormError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) form.setError(field as keyof AddStoreInput, { message });
        return;
      }
      window.location.assign(result.data.url);
    });
  }

  const reg = (name: keyof AddStoreInput) => ({ id: `as-${name}`, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger render={<Button disabled={disabled} />}>
        <Plus /> Add Shopify Store
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add Shopify Store</DialogTitle>
            <DialogDescription>You will be taken to Shopify to approve access. Sign in to the Shopify Admin of that store first if you are not already.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <FormField id="as-shopDomain" label="Store domain" required error={errors.shopDomain?.message} hint="e.g. casabella.myshopify.com — the .myshopify.com address, not the custom domain.">
              <Input {...reg("shopDomain")} placeholder="your-store.myshopify.com" autoComplete="off" autoFocus />
            </FormField>
            <FormField id="as-name" label="Display name" error={errors.name?.message} hint="Optional. How the store is shown in V3PL.">
              <Input {...reg("name")} placeholder="Casabella Store" autoComplete="off" />
            </FormField>
          </div>
          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Continue to Shopify
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
