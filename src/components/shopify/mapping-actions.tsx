"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Link2, Link2Off, Loader2, Search, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { ShopifyMappingStatus } from "@/generated/prisma/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { mapVariantAction, searchInternalVariantsAction, setIgnoredAction, unmapAction, type InternalVariantOption } from "@/server/actions/shopify";

type Props = {
  storeId: string;
  mappingId: string;
  status: ShopifyMappingStatus;
  shopifyLabel: string;
  shopifySku: string | null;
};

export function MappingActions({ storeId, mappingId, status, shopifyLabel, shopifySku }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(shopifySku ?? "");
  const [options, setOptions] = useState<InternalVariantOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      if (term.length < 2) {
        setOptions([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      const r = await searchInternalVariantsAction(term);
      if (cancelled) return;
      setSearching(false);
      if (r.ok) setOptions(r.data);
      else setError(r.error);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  function choose(variantId: string, sku: string) {
    setError(null);
    start(async () => {
      const r = await mapVariantAction(storeId, { mappingId, variantId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(`Mapped to V3PL SKU ${sku}`);
      setOpen(false);
      router.refresh();
    });
  }

  const simple = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(done);
      else toast.error(r.error ?? label);
      router.refresh();
    });

  return (
    <div className="flex items-center justify-end gap-1">
      {status !== "MATCHED" && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>
            <Link2 /> Map
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Map to a V3PL SKU</DialogTitle>
              <DialogDescription>
                Shopify: <span className="font-medium text-foreground">{shopifyLabel}</span>
                {shopifySku ? (
                  <>
                    {" "}
                    · SKU <span className="font-mono">{shopifySku}</span>
                  </>
                ) : (
                  " · no SKU"
                )}
                . Search by SKU, barcode or product name. Only active V3PL SKUs are offered.
              </DialogDescription>
            </DialogHeader>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 characters…" className="pl-8" autoFocus disabled={pending} />
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border">
              {searching ? (
                <p className="p-3 text-sm text-muted-foreground">Searching…</p>
              ) : options.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{q.trim().length < 2 ? "Enter a search term." : "No active V3PL SKU matches."}</p>
              ) : (
                <ul className="divide-y">
                  {options.map((o) => (
                    <li key={o.id}>
                      <button type="button" disabled={pending} onClick={() => choose(o.id, o.sku)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
                        <span className="min-w-0">
                          <span className="font-mono text-xs">{o.sku}</span>
                          <span className="block truncate text-muted-foreground">
                            {o.productName}
                            {o.name ? ` / ${o.name}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{o.ownerLabel}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {status === "MATCHED" && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => simple("Unmap failed", () => unmapAction(storeId, mappingId), "Mapping removed")}>
          {pending ? <Loader2 className="animate-spin" /> : <Link2Off />} Unmap
        </Button>
      )}
      {(status === "UNMATCHED" || status === "CONFLICT") && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => simple("Ignore failed", () => setIgnoredAction(storeId, mappingId, true), "Variant ignored")}>
          <EyeOff /> Ignore
        </Button>
      )}
      {status === "IGNORED" && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => simple("Failed", () => setIgnoredAction(storeId, mappingId, false), "Variant is unmatched again")}>
          <Undo2 /> Unignore
        </Button>
      )}
    </div>
  );
}
