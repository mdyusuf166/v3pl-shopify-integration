"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Eye, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProductDeleteButton } from "@/components/products/product-delete-button";
import { setProductStatusAction } from "@/server/actions/products";

type Props = { id: string; name: string; status: "ACTIVE" | "ARCHIVED"; blockers: string[]; canEdit: boolean };

/** Row menu for the product list: view, edit, archive/reactivate, delete (with history guard). */
export function ProductRowActions({ id, name, status, blockers, canEdit }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  function toggleStatus() {
    startTransition(async () => {
      const next = status === "ACTIVE" ? "ARCHIVED" : "ACTIVE";
      const res = await setProductStatusAction(id, next);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(next === "ARCHIVED" ? `${name} archived` : `${name} reactivated`);
        router.refresh();
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} disabled={pending} />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem render={<Link href={`/admin/products/${id}`} />}>
            <Eye /> View
          </DropdownMenuItem>
          {canEdit && (
            <>
              <DropdownMenuItem render={<Link href={`/admin/products/${id}/edit`} />}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleStatus}>
                {status === "ACTIVE" ? (
                  <>
                    <Archive /> Archive
                  </>
                ) : (
                  <>
                    <ArchiveRestore /> Reactivate
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canEdit && <ProductDeleteButton id={id} name={name} status={status} blockers={blockers} open={deleteOpen} onOpenChange={setDeleteOpen} trigger={<span className="hidden" />} />}
    </>
  );
}
