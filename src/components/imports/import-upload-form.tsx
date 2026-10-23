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
import { previewOrderImportAction } from "@/server/actions/imports";

type Warehouse = { id: string; code: string; name: string };

export function ImportUploadForm({ warehouses }: { warehouses: Warehouse[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await previewOrderImportAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success("File read — review the preview");
      router.push(`/admin/imports/${res.data.jobId}`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import orders from CSV</CardTitle>
        <CardDescription>
          Upload → Preview → Validate → Fix errors → Confirm → Results. Accepts Shopify order exports and V3PL order exports. Required columns: <code>Name</code>, <code>Lineitem sku</code>,{" "}
          <code>Lineitem quantity</code>. One row per line item; rows with the same Name form one order.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="file">CSV file</Label>
            <Input id="file" name="file" type="file" accept=".csv,text/csv" required disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="defaultWarehouseId">Default warehouse</Label>
            <NativeSelect id="defaultWarehouseId" name="defaultWarehouseId" required disabled={pending} defaultValue={warehouses.length === 1 ? warehouses[0].id : ""}>
              <option value="">Choose…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">Used unless a row sets “V3PL Warehouse”.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reserve">Reserve stock on import</Label>
            <NativeSelect id="reserve" name="reserve" defaultValue="true" disabled={pending}>
              <option value="true">Yes — reserve available stock for every line</option>
              <option value="false">No — create orders without reservations</option>
            </NativeSelect>
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
