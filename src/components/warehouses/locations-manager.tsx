"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MoreHorizontal, Pencil, Plus, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FormField } from "@/components/common/form-field";
import { locationFormSchema, type LocationFormInput } from "@/lib/validation/warehouses";
import { createLocationAction, deleteLocationAction, setDefaultLocationAction, setLocationActiveAction, updateLocationAction } from "@/server/actions/warehouses";

export type LocationRow = { id: string; label: string; zone: string | null; rack: string | null; shelf: string | null; bin: string | null; isDefault: boolean; isActive: boolean; notes: string | null };

type Props = { warehouseId: string; locations: LocationRow[]; canEdit: boolean; warehouseActive: boolean; canDelete?: boolean; /** Per location: reasons it cannot be hard-deleted (D-054). */ locationBlockers?: Record<string, string[]> };

const EMPTY: LocationFormInput = { label: "", zone: "", rack: "", shelf: "", bin: "", notes: "" };

export function LocationsManager({ warehouseId, locations, canEdit, warehouseActive, canDelete = false, locationBlockers = {} }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<LocationRow | null | "new">(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<LocationFormInput>({ resolver: zodResolver(locationFormSchema), defaultValues: EMPTY });
  const { errors } = form.formState;

  function openNew() {
    form.reset(EMPTY);
    setEditing("new");
  }
  function openEdit(loc: LocationRow) {
    form.reset({ label: loc.label, zone: loc.zone ?? "", rack: loc.rack ?? "", shelf: loc.shelf ?? "", bin: loc.bin ?? "", notes: loc.notes ?? "" });
    setEditing(loc);
  }

  function onSubmit(values: LocationFormInput) {
    startTransition(async () => {
      const res = editing === "new" ? await createLocationAction(warehouseId, values) : await updateLocationAction((editing as LocationRow).id, warehouseId, values);
      if (!res.ok) {
        for (const [field, message] of Object.entries(res.fieldErrors ?? {})) form.setError(field as keyof LocationFormInput, { message });
        if (!res.fieldErrors) toast.error(res.error);
        return;
      }
      toast.success(editing === "new" ? "Location added" : "Location updated");
      setEditing(null);
      router.refresh();
    });
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Failed");
      else {
        toast.success(success);
        router.refresh();
      }
    });
  }

  const reg = (name: keyof LocationFormInput) => ({ id: `loc-${name}`, "aria-invalid": !!errors[name], disabled: pending, ...form.register(name) });

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Locations</h2>
          <p className="text-sm text-muted-foreground">Zone → rack → shelf → bin. Stock is always placed at a location; MAIN is the fallback.</p>
        </div>
        {canEdit && warehouseActive && (
          <Button onClick={openNew}>
            <Plus /> Add location
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead className="hidden md:table-cell">Zone</TableHead>
              <TableHead className="hidden md:table-cell">Rack</TableHead>
              <TableHead className="hidden md:table-cell">Shelf</TableHead>
              <TableHead className="hidden md:table-cell">Bin</TableHead>
              <TableHead>Status</TableHead>
              {canEdit && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.map((l) => (
              <TableRow key={l.id} className={l.isActive ? "" : "opacity-60"}>
                <TableCell className="font-mono text-xs">
                  {l.label}
                  {l.isDefault && (
                    <Badge variant="secondary" className="ml-2 gap-1">
                      <Star className="size-3" /> default
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell">{l.zone ?? "—"}</TableCell>
                <TableCell className="hidden md:table-cell">{l.rack ?? "—"}</TableCell>
                <TableCell className="hidden md:table-cell">{l.shelf ?? "—"}</TableCell>
                <TableCell className="hidden md:table-cell">{l.bin ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{l.isActive ? "Active" : "Inactive"}</Badge>
                </TableCell>
                {canEdit && (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${l.label}`} />}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => openEdit(l)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        {!l.isDefault && l.isActive && (
                          <DropdownMenuItem onClick={() => run(() => setDefaultLocationAction(l.id, warehouseId), `${l.label} is now the default`)}>
                            <Star /> Make default
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {l.isActive ? (
                          <DropdownMenuItem disabled={l.isDefault} variant="destructive" onClick={() => run(() => setLocationActiveAction(l.id, warehouseId, false), `${l.label} deactivated`)}>
                            Deactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => run(() => setLocationActiveAction(l.id, warehouseId, true), `${l.label} reactivated`)}>Reactivate</DropdownMenuItem>
                        )}
                        {canDelete && (
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={l.isDefault}
                            onClick={() => {
                              const blockers = locationBlockers[l.id] ?? [];
                              if (blockers.length) {
                                toast.error(`${l.label} cannot be deleted: ${blockers.join("; ")}. Deactivate it instead.`);
                                return;
                              }
                              if (window.confirm(`Delete location ${l.label}? Nothing references it, so no history is lost.`)) run(() => deleteLocationAction(l.id, warehouseId), `${l.label} deleted`);
                            }}
                          >
                            Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editing === "new" ? "Add location" : "Edit location"}</DialogTitle>
              <DialogDescription>Fill in the parts you use; the label is built from them unless you set it explicitly.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-4">
              <FormField id="loc-zone" label="Zone" error={errors.zone?.message}>
                <Input {...reg("zone")} placeholder="A" />
              </FormField>
              <FormField id="loc-rack" label="Rack" error={errors.rack?.message}>
                <Input {...reg("rack")} placeholder="01" />
              </FormField>
              <FormField id="loc-shelf" label="Shelf" error={errors.shelf?.message}>
                <Input {...reg("shelf")} placeholder="3" />
              </FormField>
              <FormField id="loc-bin" label="Bin" error={errors.bin?.message}>
                <Input {...reg("bin")} placeholder="B2" />
              </FormField>
              <FormField id="loc-label" label="Label (optional override)" error={errors.label?.message} className="sm:col-span-2">
                <Input {...reg("label")} placeholder="A-01-3-B2" className="uppercase" />
              </FormField>
              <FormField id="loc-notes" label="Notes" error={errors.notes?.message} className="sm:col-span-2">
                <Input {...reg("notes")} />
              </FormField>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {editing === "new" ? "Add" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
