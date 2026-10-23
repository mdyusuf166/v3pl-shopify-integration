import { NextResponse, type NextRequest } from "next/server";
import "@/server/services/shopify/register";
import { cronSecret } from "@/server/services/shopify/env";
import { runDailyMaintenance } from "@/server/services/shopify/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/shopify-daily — the single daily Vercel cron (D-031). Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` automatically when the env var exists.
 */
export async function GET(req: NextRequest) {
  const secret = cronSecret();
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const summary = await runDailyMaintenance(240_000);
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
