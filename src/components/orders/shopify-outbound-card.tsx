"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requestShopifyOrderAction } from "@/server/actions/shopify-order";
import type { shopifyOutboundSummary } from "@/server/services/shopify-order-request";

type Summary = Awaited<ReturnType<typeof shopifyOutboundSummary>>;

const STATE_LABEL: Record<Summary["state"], { label: string; tone: string }> = {
  NOT_SENT: { label: "Not sent", tone: "border-border bg-muted text-muted-foreground" },
  PENDING: { label: "Pending", tone: "border-amber-200 bg-amber-50 text-amber-800" },
  CREATED: { label: "Created in Shopify", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  RETRYABLE: { label: "Failed — will retry", tone: "border-amber-200 bg-amber-50 text-amber-800" },
  FAILED: { label: "Failed — needs attention", tone: "border-red-200 bg-red-50 text-red-700" },
};

/** Order page card (staff): outbound V3PL → Shopify state, eligibility reason, and the idempotent "Send to Shopify" action. */
export function ShopifyOutboundCard({ orderId, summary, canSend }: { orderId: string; summary: Summary; canSend: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const meta = STATE_LABEL[summary.state];
  const eligible = summary.eligibility?.ok === true;
  const canAct = canSend && (summary.state === "NOT_SENT" || summary.state === "RETRYABLE" || summary.state === "FAILED") && eligible;

  function send() {
    startTransition(async () => {
      const res = await requestShopifyOrderAction(orderId);
      if (!res.ok) toast.error(res.error);
      else toast.success(res.data.reused ? `Already queued for ${res.data.storeName} — nothing new created` : `Queued for creation in ${res.data.storeName}`);
      router.refresh();
    });
  }

  return (
    <Card data-slot="shopify-outbound">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Shopify</CardTitle>
        <Badge variant="outline" className={meta.tone}>
          {meta.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {summary.state === "CREATED" && (
          <p>
            Shopify order <span className="font-medium">{summary.shopifyOrderName ?? summary.shopifyOrderId}</span>
            {summary.storeName ? ` in ${summary.storeName}` : ""}.
          </p>
        )}
        {summary.state === "PENDING" && <p className="text-muted-foreground">Queued for {summary.storeName ?? "the mapped store"}. The store connection creates the order and records its reference here.</p>}
        {(summary.state === "RETRYABLE" || summary.state === "FAILED") && summary.error && <p className="text-destructive">{summary.error}</p>}
        {summary.state !== "CREATED" && summary.state !== "PENDING" && summary.eligibility && (summary.eligibility.ok ? <p className="text-muted-foreground">All lines map to {summary.eligibility.storeName}; the order can be sent.</p> : <p className="text-amber-700">{summary.eligibility.message}</p>)}
        {canSend && summary.state !== "CREATED" && summary.state !== "PENDING" && (
          <Button size="sm" variant="outline" disabled={pending || !canAct} onClick={send} title={!eligible ? "Fix the mapping issue above first" : undefined}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />}
            {summary.state === "NOT_SENT" ? "Send to Shopify" : "Retry"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
