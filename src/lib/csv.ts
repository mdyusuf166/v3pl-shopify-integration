/**
 * Minimal RFC 4180 CSV reader/writer (no dependency). Handles quoted fields,
 * embedded quotes/newlines, CRLF, UTF-8 BOM and Excel-friendly output.
 */

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): { headers: string[]; rows: CsvRow[]; rawRows: string[][] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else field += ch;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [], rawRows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = (r[i] ?? "").trim();
    });
    return row;
  });
  return { headers, rows, rawRows: nonEmpty.slice(1) };
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) || s.startsWith(" ") || s.endsWith(" ") ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows to CSV text (CRLF, UTF-8 BOM so Excel opens it correctly). */
export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => escapeCell(row[h])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Case/whitespace-insensitive header lookup: "lineitem sku" ≙ "Lineitem sku". */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}
