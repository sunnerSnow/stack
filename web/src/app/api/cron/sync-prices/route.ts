import { timingSafeEqual } from "node:crypto";
import { logError, ok } from "@/lib/api/http";
import { getDb } from "@/lib/db/client";
import { syncPrices } from "@/lib/market/sync";
import { recordValuations } from "@/lib/services/valuations";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 每天收盤後：抓持股的收盤價與匯率，再替每個投資組合記一筆當天的淨值快照（排程在 vercel.json） */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ data: null, meta: {}, errors: [{ code: "unauthorized", message: "只接受排程呼叫" }] }, { status: 401 });
  }
  try {
    const db = await getDb();
    const prices = await syncPrices(db);
    const valuations = await recordValuations(db);
    const failed = Boolean(prices.twse.error || prices.tpex.error || prices.fx.error || prices.us.errors.length);
    if (failed) logError(new Error(`price sync: ${JSON.stringify({ twse: prices.twse.error, tpex: prices.tpex.error, fx: prices.fx.error, us: prices.us.errors })}`));
    return ok({ prices, valuations }, { status: failed ? 502 : 200 });
  } catch (error) {
    logError(error);
    return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "同步失敗" }] }, { status: 500 });
  }
}
