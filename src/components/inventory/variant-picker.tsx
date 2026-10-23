"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { placeDropdown, type DropdownPlacement } from "@/lib/dropdown-position";
import { cn } from "@/lib/utils";
import { searchVariantsAction } from "@/server/actions/products";

export type PickedVariant = {
  id: string;
  sku: string;
  label: string;
  ownerId: string;
  ownerName: string;
  /** Saved catalogue price (decimal string) and currency, so forms can default their unit price. */
  price: string | null;
  currency: string;
  barcode: string | null;
};

type Props = {
  value: PickedVariant | null;
  onChange: (v: PickedVariant | null) => void;
  /** Restrict results to one owner (e.g. the receipt's vendor). Portal users are scoped server-side regardless. */
  ownerId?: string;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  invalid?: boolean;
};

/**
 * Debounced SKU / barcode / product-name search. The result list is rendered in a document-level
 * portal with `position: fixed`, positioned from the input's rectangle, so it is never clipped by
 * table wrappers (`overflow-x-auto`) and never widens the table (QA UI-07). Searching shows an
 * explicit loading state and never leaves the page (QA UI-06).
 */
export function VariantPicker({ value, onChange, ownerId, disabled, placeholder = "Search SKU, barcode or product…", id, invalid }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PickedVariant[]>([]);
  const [placement, setPlacement] = useState<DropdownPlacement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const active = open && query.trim().length > 0;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await searchVariantsAction(query, ownerId);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setResults(
          res.data.map((v) => ({
            id: v.id,
            sku: v.sku,
            label: [v.product.name, v.name].filter(Boolean).join(" · "),
            ownerId: v.product.ownerId,
            ownerName: v.product.owner.businessName,
            price: v.price === null || v.price === undefined ? null : String(v.price),
            currency: v.currency,
            barcode: v.barcode ?? null,
          })),
        );
      } else {
        setResults([]);
        setError(res.error);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, active, ownerId]);
  const visibleResults = active ? results : [];

  const reposition = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlacement(placeDropdown({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, { width: window.innerWidth, height: window.innerHeight }));
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true); // capture: scrollable containers too
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [active, reposition, visibleResults.length, loading]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (value) {
    return (
      <div className={cn("flex h-8 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 text-sm", invalid && "border-destructive")}>
        <span className="font-mono text-xs">{value.sku}</span>
        <span className="truncate text-muted-foreground">{value.label}</span>
        <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label="Clear SKU" disabled={disabled} onClick={() => onChange(null)}>
          <X />
        </Button>
      </div>
    );
  }

  const list =
    active && placement ? (
      <ul
        ref={listRef}
        data-slot="variant-picker-results"
        role="listbox"
        aria-busy={loading}
        style={{ position: "fixed", top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
        className="z-50 overflow-auto rounded-lg border bg-popover p-1 text-sm shadow-md"
      >
        {loading && (
          <li className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3.5 animate-spin" /> Searching…
          </li>
        )}
        {!loading && error && <li className="px-2 py-1.5 text-destructive">{error}</li>}
        {!loading && !error && visibleResults.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">No matching SKU</li>}
        {!loading &&
          visibleResults.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  onChange(r);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="font-mono text-xs">{r.sku}</span>
                <span className="truncate">{r.label}</span>
                {r.barcode && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.barcode}</span>}
                {r.price !== null && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{r.price}</span>}
                <span className={cn("truncate text-xs text-muted-foreground", r.price === null && "ml-auto")}>{r.ownerName}</span>
              </button>
            </li>
          ))}
      </ul>
    ) : null;

  return (
    <div ref={wrapRef} className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        value={query}
        disabled={disabled}
        aria-invalid={invalid}
        aria-expanded={active}
        placeholder={placeholder}
        className="pl-8"
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // Loading state starts with the keystroke so the user sees feedback before the debounce fires.
          setLoading(e.target.value.trim().length > 0);
          setError(null);
        }}
        onFocus={() => {
          setOpen(true);
          if (query.trim().length > 0) setLoading(true);
        }}
      />
      {loading && active && <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      {list && typeof document !== "undefined" ? createPortal(list, document.body) : null}
    </div>
  );
}
