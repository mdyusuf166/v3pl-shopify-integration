"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Ban, KeyRound, Loader2, MoreHorizontal, RotateCcw, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import type { UserStatus } from "@/generated/prisma/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/common/form-field";
import { passwordResetSchema } from "@/lib/validation/users";
import { deleteUserAction, resetUserPasswordAction, setUserStatusAction } from "@/server/actions/users";

export type ActionUser = { id: string; name: string; email: string; status: UserStatus };

type Confirm = { kind: "DISABLED" | "BANNED" | "ACTIVE" | "DELETE" } | null;

const CONFIRM_COPY: Record<NonNullable<Confirm>["kind"], { title: (n: string) => string; body: string; cta: string; destructive: boolean }> = {
  DISABLED: {
    title: (n) => `Disable ${n}?`,
    body: "The user is signed out immediately and cannot sign in until reactivated. Use this for temporary suspension.",
    cta: "Disable",
    destructive: false,
  },
  BANNED: {
    title: (n) => `Ban ${n}?`,
    body: "The user is signed out immediately and blocked from signing in. Use this for policy violations. Can be reversed by an administrator.",
    cta: "Ban",
    destructive: true,
  },
  ACTIVE: {
    title: (n) => `Reactivate ${n}?`,
    body: "The user can sign in again with their existing password.",
    cta: "Reactivate",
    destructive: false,
  },
  DELETE: {
    title: (n) => `Delete ${n}?`,
    body: "The sign-in account is permanently removed and the e-mail address becomes available again. Activity history is kept for auditing. This cannot be undone.",
    cta: "Delete",
    destructive: true,
  },
};

type ResetValues = z.infer<typeof passwordResetSchema>;

export function UserActionsMenu({ user, isSelf }: { user: ActionUser; isSelf: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const resetForm = useForm<ResetValues>({ resolver: zodResolver(passwordResetSchema), defaultValues: { password: "" } });

  function runConfirm() {
    if (!confirm) return;
    startTransition(async () => {
      const result =
        confirm.kind === "DELETE" ? await deleteUserAction(user.id) : await setUserStatusAction(user.id, confirm.kind);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${user.name}: ${CONFIRM_COPY[confirm.kind].cta.toLowerCase()}d`);
      setConfirm(null);
      router.refresh();
    });
  }

  function runReset(values: ResetValues) {
    startTransition(async () => {
      const result = await resetUserPasswordAction(user.id, values);
      if (!result.ok) {
        if (result.fieldErrors?.password) resetForm.setError("password", { message: result.fieldErrors.password });
        else toast.error(result.error);
        return;
      }
      toast.success(`Password reset for ${user.name}. Share the new password securely.`);
      resetForm.reset();
      setResetOpen(false);
    });
  }

  const copy = confirm ? CONFIRM_COPY[confirm.kind] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.name}`} />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => setResetOpen(true)}>
            <KeyRound /> Reset password
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {user.status === "ACTIVE" ? (
            <>
              <DropdownMenuItem disabled={isSelf} onClick={() => setConfirm({ kind: "DISABLED" })}>
                <UserX /> Disable
              </DropdownMenuItem>
              <DropdownMenuItem disabled={isSelf} variant="destructive" onClick={() => setConfirm({ kind: "BANNED" })}>
                <Ban /> Ban
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onClick={() => setConfirm({ kind: "ACTIVE" })}>
              <RotateCcw /> Reactivate
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={isSelf} variant="destructive" onClick={() => setConfirm({ kind: "DELETE" })}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title(user.name)}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={copy?.destructive ? "destructive" : "default"} onClick={runConfirm} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {copy?.cta}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <form onSubmit={resetForm.handleSubmit(runReset)} noValidate className="space-y-4">
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Set a new password for {user.name} ({user.email}). Existing sessions are signed out.
              </DialogDescription>
            </DialogHeader>
            <FormField id={`reset-${user.id}`} label="New password" required error={resetForm.formState.errors.password?.message} hint="At least 10 characters with a letter and a number.">
              <Input id={`reset-${user.id}`} type="password" autoComplete="new-password" disabled={pending} {...resetForm.register("password")} />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setResetOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                Set password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
