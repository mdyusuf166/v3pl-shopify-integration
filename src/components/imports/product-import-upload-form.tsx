"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/common/native-select";
import { previewProductImportAction } from "@/server/actions/imports";

type Warehouse = { id: string; code: string; name: string };
type Owner = { id: string; code: string; businessName: string };

/** Shopify product CSV → V3PL products (D-053): upload, preview, confirm. */
export function ProductImportUploadForm({ warehouses, owners }: { warehouses: Warehouse[]; owners: Owner[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await previewProductImportAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success("File read — review the preview");
      router.push(`/admin/imports/${res.data.jobId}`);
    });
  }

  return (
    <Card id="products">
      <CardHeader>
        <CardTitle>Import products from CSV</CardTitle>
        <CardDescription>
          Accepts a Shopify product export or a V3PL product export. Rows with the same <code>Handle</code> become one product with its variants; <code>Variant SKU</code> is required on every row and stays globally unique. Existing SKUs are updated (title, options, price), new SKUs are created.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="product-file">CSV file</Label>
            <Input id="product-file" name="file" type="file" accept=".csv,text/csv" required disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ownerId">Owner for the products</Label>
            <NativeSelect id="ownerId" name="ownerId" disabled={pending} defaultValue={owners.length === 1 ? owners[0].id : ""}>
              <option value="">— use the V3PL Owner Code column —</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.businessName} ({o.code})
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">A “V3PL Owner Code” column on a row wins over this choice.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stockWarehouseId">Initial stock for new SKUs</Label>
            <NativeSelect id="stockWarehouseId" name="stockWarehouseId" disabled={pending} defaultValue="">
              <option value="">Do not import quantities</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  Receive “Variant Inventory Qty” into {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">Booked as a receipt into the warehouse’s default location. Existing SKUs keep their stock.</p>
          </div>
          {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Upload />}
              {pending ? "Reading file…" : "Upload and preview"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
