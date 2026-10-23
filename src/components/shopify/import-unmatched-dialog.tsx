"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Loader2, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/common/native-select";
import { confirmImportAction, listUnmatchedForImportAction, previewImportAction, type UnmatchedOption } from "@/server/actions/shopify";
import type { ImportPreview, ImportResult } from "@/server/services/shopify/catalog-import";

export type OwnerOption = { id: string; label: string; group: "Vendors" | "3PL clients" };
/** V3PL warehouse with its active locations — the only places imported stock may go (D-067). */
export type DestinationOption = { id: string; label: string; locations: { id: string; label: string; isDefault: boolean }[] };

type Step = "select" | "preview" | "done";

/**
 * Import unmatched Shopify products into V3PL — explicit flow only:
 * select variants → owner → Preview (per Shopify product, owner editable) → Confirm → Results.
 */
export function ImportUnmatchedDialog({ storeId, owners, unmatchedCount, destinations, defaultWarehouseId }: { storeId: string; owners: OwnerOption[]; unmatchedCount: number; destinations: DestinationOption[]; defaultWarehouseId?: string | null }) {
  const router = useRouter();
  const initialWh = destinations.find((d) => d.id === defaultWarehouseId)?.id ?? destinations[0]?.id ?? "";
  const defaultLoc = (whId: string) => {
    const d = destinations.find((x) => x.id === whId);
    return d?.locations.find((l) => l.isDefault)?.id ?? d?.locations[0]?.id ?? "";
  };
  const [whId, setWhId] = useState(initialWh);
  const [locId, setLocId] = useState(defaultLoc(initialWh));
  /** Initial quantity per mapping id as typed (blank = data-only for that SKU). */
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("select");
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<UnmatchedOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ownerId, setOwnerId] = useState(owners[0]?.id ?? "");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || step !== "select") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await listUnmatchedForImportAction(storeId, q);
      if (!cancelled && r.ok) setRows(r.data);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, step, q, storeId]);

  const byProduct = useMemo(() => {
    const m = new Map<string, UnmatchedOption[]>();
    for (const r of rows) {
      const list = m.get(r.shopifyProductId);
      if (list) list.push(r);
      else m.set(r.shopifyProductId, [r]);
    }
    return [...m.entries()];
  }, [rows]);

  function reset() {
    setStep("select");
    setSelected(new Set());
    setOverrides({});
    setPreview(null);
    setResult(null);
    setError(null);
    setQ("");
    setQuantities({});
  }
  const qtyOf = (mappingId: string) => {
    const n = Number(quantities[mappingId] ?? "");
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const totalUnits = preview ? preview.products.filter((p) => p.ok).reduce((s, p) => s + p.variants.reduce((t, v) => t + qtyOf(v.mappingId), 0), 0) : 0;
  const whOption = destinations.find((d) => d.id === whId);
  const locOption = whOption?.locations.find((l) => l.id === locId);

  function toggle(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  }

  function runPreview(nextOverrides = overrides) {
    setError(null);
    start(async () => {
      const r = await previewImportAction(storeId, { mappingIds: [...selected], ownerId, ownerOverrides: nextOverrides });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPreview(r.data);
      setStep("preview");
    });
  }

  function changeOwner(shopifyProductId: string, id: string) {
    const next = { ...overrides, [shopifyProductId]: id };
    setOverrides(next);
    runPreview(next);
  }

  function confirm() {
    if (!preview) return;
    const items = preview.products.filter((p) => p.ok).map((p) => ({ shopifyProductId: p.shopifyProductId, ownerId: p.ownerId, mappingIds: p.variants.map((v) => v.mappingId), quantities: Object.fromEntries(p.variants.map((v) => [v.mappingId, qtyOf(v.mappingId)]).filter(([, q]) => (q as number) > 0)) }));
    if (items.length === 0) {
      setError("Nothing importable — fix the errors first.");
      return;
    }
    if (totalUnits > 0 && (!whId || !locId)) {
      setError("Choose the V3PL warehouse and location that receive the initial stock, or clear the quantities for a data-only import.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await confirmImportAction(storeId, { items, destination: totalUnits > 0 ? { warehouseId: whId, locationId: locId } : null });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResult(r.data);
      setStep("done");
      const units = r.data.created.reduce((s, c) => s + (c.stock?.units ?? 0), 0);
      toast.success(`${r.data.created.length} product${r.data.created.length === 1 ? "" : "s"} imported${units ? `, ${units} unit${units === 1 ? "" : "s"} received into ${r.data.destination?.warehouseLabel ?? "V3PL"} / ${r.data.destination?.locationLabel ?? ""}` : ""}${r.data.failed.length ? `, ${r.data.failed.length} failed` : ""}`);
      router.refresh();
    });
  }

  const okCount = preview?.products.filter((p) => p.ok).length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" disabled={unmatchedCount === 0 || owners.length === 0} />}>
        <PackagePlus /> Import unmatched into V3PL
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{step === "select" ? "Import Shopify products into V3PL" : step === "preview" ? "Preview import" : "Import results"}</DialogTitle>
          <DialogDescription>
            {step === "select" && "Choose the Shopify variants to create as V3PL products. A Shopify store never decides ownership: you assign the vendor or 3PL client. SKUs are taken from Shopify; nothing is created until you confirm."}
            {step === "preview" && "One V3PL product per Shopify product. Adjust the owner per product where needed. Rows with errors are skipped. Stock is only booked for SKUs where you enter an initial quantity — into the V3PL warehouse / location chosen below (a Shopify location is never a V3PL warehouse)."}
            {step === "done" && (result?.destination ? `Imported products are now mapped. Initial stock was received into ${result.destination.warehouseLabel} / ${result.destination.locationLabel}.` : "Imported products are now mapped. Stock is not affected — receive inventory as usual.")}
          </DialogDescription>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by product, variant or SKU…" disabled={pending} />
              <NativeSelect value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={pending} aria-label="Default owner">
                {(["Vendors", "3PL clients"] as const).map((g) => (
                  <optgroup key={g} label={g}>
                    {owners
                      .filter((o) => o.group === g)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-md border">
              {rows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No unmatched Shopify variants{q ? " match the filter" : ""}.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {byProduct.map(([pid, variants]) => {
                    const ids = variants.map((v) => v.id);
                    const all = ids.every((id) => selected.has(id));
                    return (
                      <li key={pid} className="p-2">
                        <label className="flex items-center gap-2 font-medium">
                          <input type="checkbox" className="size-4 accent-primary" checked={all} onChange={(e) => toggle(ids, e.target.checked)} disabled={pending} />
                          {variants[0].productTitle}
                          <span className="text-xs text-muted-foreground">
                            {variants.length} variant{variants.length === 1 ? "" : "s"}
                          </span>
                        </label>
                        <ul className="mt-1 ml-6 space-y-0.5">
                          {variants.map((v) => (
                            <li key={v.id}>
                              <label className="flex items-center gap-2 text-muted-foreground">
                                <input type="checkbox" className="size-3.5 accent-primary" checked={selected.has(v.id)} onChange={(e) => toggle([v.id], e.target.checked)} disabled={pending} />
                                <span className="font-mono text-xs text-foreground">{v.sku ?? "— no SKU —"}</span>
                                {v.variantTitle && <span className="truncate">{v.variantTitle}</span>}
                              </label>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {selected.size} selected · {rows.length} shown (max 200). Variants without a SKU cannot be imported until a SKU is set in Shopify.
            </p>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">Initial stock destination (V3PL)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    value={whId}
                    onChange={(e) => {
                      setWhId(e.target.value);
                      setLocId(defaultLoc(e.target.value));
                    }}
                    disabled={pending || destinations.length === 0}
                    className="w-52"
                    aria-label="V3PL warehouse"
                  >
                    {destinations.length === 0 && <option value="">No active warehouse</option>}
                    {destinations.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect value={locId} onChange={(e) => setLocId(e.target.value)} disabled={pending || !whOption} className="w-44" aria-label="V3PL location">
                    {(whOption?.locations ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {totalUnits > 0
                    ? `${totalUnits} unit${totalUnits === 1 ? "" : "s"} will be received into ${whOption?.label ?? "—"} / ${locOption?.label ?? "—"} as “Initial stock”.`
                    : "No quantities entered — products are imported without stock (receive inventory later as usual)."}
                </span>
                <button
                  type="button"
                  className="underline hover:text-foreground disabled:opacity-50"
                  disabled={pending}
                  onClick={() => setQuantities(Object.fromEntries(preview.products.flatMap((p) => p.variants.filter((v) => !v.error && (v.shopifyQuantity ?? 0) > 0).map((v) => [v.mappingId, String(v.shopifyQuantity)]))))}
                >
                  Use Shopify quantities
                </button>
              </div>
            </div>
            {preview.products.map((p) => (
              <div key={p.shopifyProductId} className={`rounded-md border p-3 text-sm ${p.ok ? "" : "border-destructive/50 bg-destructive/5"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{p.title}</p>
                  <NativeSelect value={p.ownerId} onChange={(e) => changeOwner(p.shopifyProductId, e.target.value)} disabled={pending} className="w-56" aria-label="Owner">
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {p.errors.map((e) => (
                  <p key={e} className="mt-1 text-xs text-destructive">
                    {e}
                  </p>
                ))}
                <table className="mt-2 w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left font-normal">SKU</th>
                      <th className="text-left font-normal">Variant</th>
                      <th className="text-left font-normal">Barcode</th>
                      <th className="text-right font-normal">Price</th>
                      <th className="text-right font-normal">Shopify qty</th>
                      <th className="text-right font-normal">Initial qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.variants.map((v) => (
                      <tr key={v.mappingId} className={v.error ? "text-destructive" : ""}>
                        <td className="py-0.5 font-mono">{v.sku || "—"}</td>
                        <td className="py-0.5">{v.name ?? "—"}</td>
                        <td className="py-0.5 font-mono">{v.barcode ?? "—"}</td>
                        <td className="py-0.5 text-right tabular-nums">{v.price ?? "—"}</td>
                        <td className="py-0.5 text-right tabular-nums text-muted-foreground">{v.shopifyQuantity ?? "—"}</td>
                        <td className="py-0.5 text-right">
                          {!v.error && (
                            <Input type="number" min={0} step={1} inputMode="numeric" value={quantities[v.mappingId] ?? ""} onChange={(e) => setQuantities((q) => ({ ...q, [v.mappingId]: e.target.value }))} disabled={pending} className="ml-auto h-7 w-20 text-right" aria-label={`Initial quantity for ${v.sku}`} />
                          )}
                        </td>
                      </tr>
                    ))}
                    {p.variants
                      .filter((v) => v.error)
                      .map((v) => (
                        <tr key={`${v.mappingId}-err`}>
                          <td colSpan={6} className="pb-1 text-destructive">
                            {v.sku || v.shopifySku || "?"}: {v.error}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))}
            {preview.skipped.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {preview.skipped.length} selected variant{preview.skipped.length === 1 ? "" : "s"} skipped: {[...new Set(preview.skipped.map((s) => s.reason))].join("; ")}
              </p>
            )}
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-3 text-sm">
            {result.created.length > 0 && (
              <div>
                <p className="font-medium">Created ({result.created.length})</p>
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {result.created.map((c) => (
                    <li key={c.productId}>
                      {c.title} — <span className="font-mono text-xs">{c.skus.join(", ")}</span>
                      {c.stock && <span className="text-xs"> · {c.stock.units} unit{c.stock.units === 1 ? "" : "s"} received</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.failed.length > 0 && (
              <div>
                <p className="font-medium text-destructive">Not imported ({result.failed.length})</p>
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {result.failed.map((f) => (
                    <li key={f.shopifyProductId}>
                      {f.title}: {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {step === "select" && (
            <>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" onClick={() => runPreview()} disabled={pending || selected.size === 0 || !ownerId}>
                {pending && <Loader2 className="animate-spin" />} Preview
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("select")} disabled={pending}>
                Back
              </Button>
              <Button type="button" onClick={confirm} disabled={pending || okCount === 0}>
                {pending && <Loader2 className="animate-spin" />} Import {okCount} product{okCount === 1 ? "" : "s"}
                {totalUnits > 0 ? ` · receive ${totalUnits} unit${totalUnits === 1 ? "" : "s"}` : ""}
              </Button>
            </>
          )}
          {step === "done" && (
            <>
              <Button type="button" variant="outline" render={<Link href="/admin/products" />}>
                <Download className="rotate-180" /> Open products
              </Button>
              <Button type="button" onClick={() => setOpen(false)}>
                Close
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
