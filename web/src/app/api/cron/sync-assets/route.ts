import { timingSafeEqual } from "node:crypto";
import { logError, ok } from "@/lib/api/http";
import { syncAssets } from "@/lib/assets/sync";
import { getDb } from "@/lib/db/client";

// 台股 8 個查詢＋美股 2 個檔案，約 1.4 萬筆寫入
export const maxDuration = 60;

/** 只接受 Vercel Cron（帶 Authorization: Bearer <CRON_SECRET>）；沒設 CRON_SECRET 就一律拒絕 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 每天同步一次共用資產主檔（排程在 vercel.json） */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ data: null, meta: {}, errors: [{ code: "unauthorized", message: "只接受排程呼叫" }] }, { status: 401 });
  }
  try {
    const reports = await syncAssets(await getDb());
    const failed = reports.filter((r) => r.error);
    for (const r of failed) logError(new Error(`asset sync ${r.source}: ${r.error}`));
    return ok(reports, { status: failed.length > 0 ? 502 : 200 });
  } catch (error) {
    logError(error);
    return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "同步失敗" }] }, { status: 500 });
  }
}
