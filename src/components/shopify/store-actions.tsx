"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, PlugZap, RefreshCw, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import type { ShopifyStoreStatus } from "@/generated/prisma/client";
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
import { disconnectStoreAction, reconnectStoreAction, removePendingStoreAction, runPendingAction, testConnectionAction } from "@/server/actions/shopify";

type Props = { id: string; name: string; status: ShopifyStoreStatus };

export function StoreActions({ id, name, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const run = (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    startTransition(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  const connected = status === "CONNECTED";
  const canReconnect = status !== "PENDING_INSTALL";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {connected && (
        <>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run("test", async () => {
                const r = await testConnectionAction(id);
                if (r.ok) toast.success(`Connected to ${r.data.shopName} (${r.data.locations} location${r.data.locations === 1 ? "" : "s"})`);
                else toast.error(r.error);
                router.refresh();
              })
            }
          >
            {busy === "test" ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run("drain", async () => {
                const r = await runPendingAction(id);
                if (r.ok) toast.success(`Processed ${r.data.events} event${r.data.events === 1 ? "" : "s"} and ${r.data.jobs} job${r.data.jobs === 1 ? "" : "s"}`);
                else toast.error(r.error);
                router.refresh();
              })
            }
          >
            {busy === "drain" ? <Loader2 className="animate-spin" /> : <Play />} Run pending now
          </Button>
        </>
      )}

      {canReconnect && (
        <Button
          variant={connected ? "outline" : "default"}
          disabled={pending}
          onClick={() =>
            run("reconnect", async () => {
              const r = await reconnectStoreAction(id);
              if (!r.ok) {
                toast.error(r.error);
                return;
              }
              window.location.assign(r.data.url);
            })
          }
        >
          {busy === "reconnect" ? <Loader2 className="animate-spin" /> : <RefreshCw />} {connected ? "Reconnect" : "Connect"}
        </Button>
      )}

      {(connected || status === "NEEDS_REAUTH") && (
        <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
          <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>
            <Unplug /> Disconnect
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                V3PL forgets the access tokens for this store and stops synchronising. Existing orders and history are kept. To revoke access completely, also remove the app in the Shopify Admin of the store.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  run("disconnect", async () => {
                    const r = await disconnectStoreAction(id);
                    if (r.ok) toast.success(`${name} disconnected`);
                    else toast.error(r.error);
                    setDisconnectOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy === "disconnect" && <Loader2 className="animate-spin" />} Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {status === "PENDING_INSTALL" && (
        <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
          <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>
            <Trash2 /> Remove
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
              <AlertDialogDescription>This store never completed authorization, so nothing else is affected.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  run("remove", async () => {
                    const r = await removePendingStoreAction(id);
                    if (!r.ok) {
                      toast.error(r.error);
                      return;
                    }
                    toast.success("Store removed");
                    router.push("/admin/settings/shopify");
                    router.refresh();
                  })
                }
              >
                {busy === "remove" && <Loader2 className="animate-spin" />} Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
