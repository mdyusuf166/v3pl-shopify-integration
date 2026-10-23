import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MOVEMENT_TYPE_LABELS, formatDateTime, formatSigned } from "@/lib/format";
import type { listMovements } from "@/server/services/inventory";

type Row = Awaited<ReturnType<typeof listMovements>>["items"][number];

type Props = {
  rows: Row[];
  /** Hide columns that are constant in the current context. */
  hideOwner?: boolean;
  hideSku?: boolean;
  /** Portal views link nowhere admin-only. */
  linkBase?: string | null;
};

const TYPE_TONE: Record<string, string> = {
  RECEIVE: "border-emerald-200 bg-emerald-50 text-emerald-700",
  RETURN: "border-emerald-200 bg-emerald-50 text-emerald-700",
  TRANSFER_IN: "border-sky-200 bg-sky-50 text-sky-700",
  TRANSFER_OUT: "border-sky-200 bg-sky-50 text-sky-700",
  MOVE: "border-sky-200 bg-sky-50 text-sky-700",
  RESERVE: "border-amber-200 bg-amber-50 text-amber-800",
  RELEASE: "border-amber-200 bg-amber-50 text-amber-800",
  SHIP: "border-violet-200 bg-violet-50 text-violet-700",
  DAMAGE: "border-red-200 bg-red-50 text-red-700",
  MISSING: "border-red-200 bg-red-50 text-red-700",
  ADJUSTMENT: "border-border bg-muted text-foreground",
};

/** Ledger rows — used by the admin movement browser, product detail and portals. */
export function MovementsTable({ rows, hideOwner, hideSku, linkBase = "/admin/products" }: Props) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Type</TableHead>
            {!hideSku && <TableHead>SKU</TableHead>}
            {!hideOwner && <TableHead className="hidden lg:table-cell">Owner</TableHead>}
            <TableHead>Warehouse · location</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="hidden text-right md:table-cell">Before → after</TableHead>
            <TableHead className="hidden xl:table-cell">Reason</TableHead>
            <TableHead className="hidden lg:table-cell">By</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
              <TableCell>
                <Badge variant="outline" className={TYPE_TONE[r.type] ?? ""}>
                  {MOVEMENT_TYPE_LABELS[r.type] ?? r.type}
                  {r.bucket === "RESERVED" ? " · reserved" : ""}
                </Badge>
              </TableCell>
              {!hideSku && (
                <TableCell>
                  {linkBase ? (
                    <Link href={`${linkBase}/${r.variant.product.id}`} className="font-mono text-xs hover:underline">
                      {r.variant.sku}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{r.variant.sku}</span>
                  )}
                  <div className="max-w-56 truncate text-xs text-muted-foreground">{r.variant.product.name}</div>
                </TableCell>
              )}
              {!hideOwner && <TableCell className="hidden text-muted-foreground lg:table-cell">{r.owner.businessName}</TableCell>}
              <TableCell className="whitespace-nowrap">
                {r.warehouse.code}
                {r.location ? <span className="text-muted-foreground"> · {r.location.label}</span> : null}
              </TableCell>
              <TableCell className={`text-right font-medium tabular-nums ${r.quantity > 0 ? "text-emerald-700" : "text-red-700"}`}>{formatSigned(r.quantity)}</TableCell>
              <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
                {r.beforeQty} → {r.afterQty}
              </TableCell>
              <TableCell className="hidden max-w-64 truncate text-muted-foreground xl:table-cell" title={[r.reason, r.notes].filter(Boolean).join(" — ")}>
                {r.reason ?? "—"}
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">{r.user.name}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
