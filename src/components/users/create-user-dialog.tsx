"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import type { UserRole } from "@/generated/prisma/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/common/form-field";
import { NativeSelect } from "@/components/common/native-select";
import { ROLE_LABELS } from "@/lib/roles";
import { STAFF_ROLE_VALUES, userCreateSchema, type UserCreateInput } from "@/lib/validation/users";
import { createUserAction } from "@/server/actions/users";

type Props =
  | { mode: "staff" }
  | { mode: "portal"; role: "VENDOR" | "THREEPL_CLIENT"; ownerId: string; ownerName: string };

export function CreateUserDialog(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const defaults: UserCreateInput = {
    name: "",
    email: "",
    password: "",
    phone: "",
    notes: "",
    role: props.mode === "portal" ? props.role : "WAREHOUSE",
    ownerId: props.mode === "portal" ? props.ownerId : null,
  };

  const form = useForm<UserCreateInput>({ resolver: zodResolver(userCreateSchema), defaultValues: defaults });
  const { errors } = form.formState;

  function close() {
    setOpen(false);
    setFormError(null);
    form.reset(defaults);
  }

  function onSubmit(values: UserCreateInput) {
    setFormError(null);
    startTransition(async () => {
      const result = await createUserAction(values);
      if (!result.ok) {
        setFormError(result.error);
        for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
          form.setError(field as keyof UserCreateInput, { message });
        }
        return;
      }
      toast.success(`Account created for ${values.name}. Share the password securely.`);
      close();
      router.refresh();
    });
  }

  const reg = (name: keyof UserCreateInput) => ({ id: `cu-${name}`, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger render={<Button />}>
        <Plus /> {props.mode === "staff" ? "New staff user" : "Add user"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{props.mode === "staff" ? "New staff user" : `Add user to ${props.ownerName}`}</DialogTitle>
            <DialogDescription>
              {props.mode === "staff"
                ? "Creates the sign-in account and platform profile. Staff sign in at /admin."
                : `The user will only see ${props.ownerName}'s data. Portal users sign in at /user.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="cu-name" label="Full name" required error={errors.name?.message} className="sm:col-span-2">
              <Input {...reg("name")} autoComplete="off" />
            </FormField>
            <FormField id="cu-email" label="Email" required error={errors.email?.message}>
              <Input {...reg("email")} type="email" autoComplete="off" />
            </FormField>
            <FormField id="cu-password" label="Initial password" required error={errors.password?.message} hint="10+ characters, a letter and a number.">
              <Input {...reg("password")} type="password" autoComplete="new-password" />
            </FormField>
            {props.mode === "staff" ? (
              <FormField id="cu-role" label="Role" required error={errors.role?.message}>
                <NativeSelect {...reg("role")}>
                  {STAFF_ROLE_VALUES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r as UserRole]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            ) : (
              <input type="hidden" {...form.register("role")} />
            )}
            <FormField id="cu-phone" label="Phone" error={errors.phone?.message}>
              <Input {...reg("phone")} type="tel" autoComplete="off" />
            </FormField>
            <FormField id="cu-notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
              <Textarea {...reg("notes")} rows={2} />
            </FormField>
            {props.mode === "portal" && <input type="hidden" {...form.register("ownerId")} />}
          </div>

          {(formError || errors.ownerId) && (
            <Alert variant="destructive">
              <AlertDescription>{errors.ownerId?.message ?? formError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
