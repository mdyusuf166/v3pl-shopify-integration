"use client";

import { useEffect, useState } from "react";
import { NativeSelect } from "@/components/common/native-select";
import { listLocationsAction } from "@/server/actions/inventory";

export type LocationOption = { id: string; label: string; isDefault: boolean };

type Props = {
  warehouseId: string | null | undefined;
  value: string;
  onChange: (locationId: string) => void;
  /** Pre-loaded options (skip fetching). */
  options?: LocationOption[];
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  /** Select the warehouse's default location automatically when options load and no value is set. */
  autoDefault?: boolean;
};

/** Location <select> that loads the chosen warehouse's active locations. */
export function LocationSelect({ warehouseId, value, onChange, options, disabled, id, invalid, autoDefault = true }: Props) {
  const [fetched, setFetched] = useState<{ warehouseId: string; list: LocationOption[] } | null>(null);

  useEffect(() => {
    if (options || !warehouseId) return;
    let cancelled = false;
    void listLocationsAction(warehouseId).then((res) => {
      if (cancelled) return;
      setFetched({ warehouseId, list: res.ok ? res.data : [] });
    });
    return () => {
      cancelled = true;
    };
  }, [warehouseId, options]);

  const list: LocationOption[] = options ?? (fetched && fetched.warehouseId === warehouseId ? fetched.list : []);

  useEffect(() => {
    if (autoDefault && !value && list.length > 0) {
      onChange((list.find((l) => l.isDefault) ?? list[0]).id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, autoDefault, value]);

  const isLoading = !options && !!warehouseId && fetched?.warehouseId !== warehouseId;

  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || !warehouseId || isLoading} aria-invalid={invalid}>
      <option value="">{!warehouseId ? "Choose a warehouse first" : isLoading ? "Loading…" : "Choose a location"}</option>
      {list.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
          {l.isDefault ? " (default)" : ""}
        </option>
      ))}
    </NativeSelect>
  );
}
