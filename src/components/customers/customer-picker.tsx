"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { placeDropdown, type DropdownPlacement } from "@/lib/dropdown-position";
import { searchCustomersAction } from "@/server/actions/customers";

export type PickedCustomer = { id: string; name: string; email: string | null; phone: string | null; shipName: string | null; shipCompany: string | null; shipAddress1: string | null; shipAddress2: string | null; shipCity: string | null; shipProvince: string | null; shipZip: string | null; shipCountry: string | null; shipPhone: string | null };

type Props = { value: PickedCustomer | null; onChange: (c: PickedCustomer | null) => void; disabled?: boolean; id?: string };

/**
 * Directory customer search for order forms (name / e-mail / phone), scoped server-side to the session
 * (portal users only ever see their own owner's customers). Same portal-rendered dropdown as the SKU
 * picker so table/card overflow never clips it.
 */
export function CustomerPicker({ value, onChange, disabled, id }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [placement, setPlacement] = useState<DropdownPlacement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const active = open && query.trim().length > 0;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await searchCustomersAction(query);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setResults(res.data);
      else {
        setResults([]);
        setError(res.error);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, active]);

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
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [active, reposition, results.length, loading]);
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
      <div className="flex h-8 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 text-sm" data-slot="customer-picked">
        <span className="font-medium">{value.name}</span>
        <span className="truncate text-muted-foreground">{[value.email, value.phone].filter(Boolean).join(" · ")}</span>
        <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label="Clear customer" disabled={disabled} onClick={() => onChange(null)}>
          <X />
        </Button>
      </div>
    );
  }

  const list =
    active && placement ? (
      <ul ref={listRef} role="listbox" aria-busy={loading} data-slot="customer-picker-results" style={{ position: "fixed", top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }} className="z-50 overflow-auto rounded-lg border bg-popover p-1 text-sm shadow-md">
        {loading && (
          <li className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Searching…
          </li>
        )}
        {!loading && error && <li className="px-2 py-1.5 text-destructive">{error}</li>}
        {!loading && !error && results.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">No matching customer — fill in the details below and tick “Save as new customer”.</li>}
        {!loading &&
          results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  onChange(c);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-muted-foreground">{[c.email, c.phone, [c.shipCity, c.shipCountry].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</span>
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
        placeholder="Search customers by name, email or phone…"
        className="pl-8"
        autoComplete="off"
        aria-expanded={active}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
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
