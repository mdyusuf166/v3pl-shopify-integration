import { NextResponse, type NextRequest } from "next/server";
import { authorizeApi } from "@/server/auth/guards";
import { failedRowsCsvForJob } from "@/server/services/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/imports/:id/failed-rows → CSV of rows that did not import, with an Error column. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApi("ADMIN", "SALES");
  if (auth.error) return auth.error;
  const { id } = await ctx.params;
  const report = await failedRowsCsvForJob(id);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new NextResponse(report.csv, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${report.fileName}"`, "Cache-Control": "no-store" },
  });
}
