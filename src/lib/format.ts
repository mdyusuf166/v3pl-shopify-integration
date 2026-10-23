/** Presentation helpers shared by server and client components. */

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const integer = new Intl.NumberFormat("en-US");

/** Accepts Prisma Decimal (via toString), string or number; null → "—". */
export function formatMoney(value: { toString(): string } | string | number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value.toString());
  if (Number.isNaN(n)) return "—";
  return currency === "USD" ? money.format(n) : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dateTime.format(typeof d === "string" ? new Date(d) : d);
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dateOnly.format(typeof d === "string" ? new Date(d) : d);
}

export function formatInt(n: number): string {
  return integer.format(n);
}

/** Signed quantity for ledger rows: "+100" / "−20". */
export function formatSigned(n: number): string {
  return n > 0 ? `+${integer.format(n)}` : `−${integer.format(Math.abs(n))}`;
}

export const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  RECEIVE: "Received",
  RESERVE: "Reserved",
  RELEASE: "Reservation released",
  SHIP: "Shipped",
  TRANSFER_OUT: "Transfer out",
  TRANSFER_IN: "Transfer in",
  MOVE: "Location move",
  RETURN: "Return",
  DAMAGE: "Damaged",
  MISSING: "Missing",
  ADJUSTMENT: "Adjustment",
};
