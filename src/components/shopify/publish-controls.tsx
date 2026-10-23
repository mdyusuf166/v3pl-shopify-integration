"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { forcePublishAction, forcePublishAllAction, publishAllAction } from "@/server/actions/shopify";

export function PublishAllButton({ storeId, disabled }: { storeId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending || disabled}
      onClick={() =>
        start(async () => {
          const r = await publishAllAction(storeId);
          if (r.ok) toast.success(`${r.data.queued} SKU${r.data.queued === 1 ? "" : "s"} queued, ${r.data.ran} processed now`);
          else toast.error(r.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <UploadCloud />} Publish all now
    </Button>
  );
}

export function ForcePublishButton({ storeId, variantId, sku }: { storeId: string; variantId: string; sku: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>
        <AlertTriangle /> Force publish
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Overwrite Shopify quantity for {sku}?</AlertDialogTitle>
          <AlertDialogDescription>Shopify&apos;s current available quantity for this SKU will be replaced with V3PL&apos;s available quantity, ignoring the safety check that protects manual changes made in Shopify.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await forcePublishAction(storeId, variantId);
                if (r.ok) toast.success(r.data.message);
                else toast.error(r.error);
                setOpen(false);
                router.refresh();
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Overwrite
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ForcePublishAllButton({ storeId, count, disabled }: { storeId: string; count: number; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" disabled={pending || disabled} />}>
        <AlertTriangle /> Force publish all
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Overwrite Shopify quantities for {count} SKUs?</AlertDialogTitle>
          <AlertDialogDescription>Every matched SKU is set to V3PL&apos;s available quantity, ignoring the safety check. Use this after reviewing the conflicts in the sync log.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await forcePublishAllAction(storeId);
                if (r.ok) toast.success(`${r.data.published} published, ${r.data.skipped} unchanged, ${r.data.failed} failed`);
                else toast.error(r.error);
                setOpen(false);
                router.refresh();
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Overwrite all
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
