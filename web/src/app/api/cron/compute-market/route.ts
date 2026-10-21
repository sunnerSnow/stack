import { timingSafeEqual } from "node:crypto";
import { logError, ok } from "@/lib/api/http";
import { getDb } from "@/lib/db/client";
import { computeRotation } from "@/lib/market/rotation-compute";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 族群輪動：只算強度與動能（抓資料在 /api/cron/sync-market）。
 * 分成兩個排程，各自有 60 秒：台北 18:00 抓資料、19:00 計算（Vercel Hobby 的排程時間誤差在一小時內，兩個不會重疊）。
 */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ data: null, meta: {}, errors: [{ code: "unauthorized", message: "只接受排程呼叫" }] }, { status: 401 });
  }
  try {
    return ok({ rotation: await computeRotation(await getDb(), { maxDates: 10 }) });
  } catch (error) {
    logError(error);
    return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "計算失敗" }] }, { status: 500 });
  }
}
