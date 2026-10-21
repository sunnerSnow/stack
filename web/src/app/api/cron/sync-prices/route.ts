import { timingSafeEqual } from "node:crypto";
import { logError, ok } from "@/lib/api/http";
import { getDb } from "@/lib/db/client";
import { syncBenchmarks } from "@/lib/market/benchmarks";
import { backfillHistory, syncPrices } from "@/lib/market/sync";
import { recordValuations } from "@/lib/services/valuations";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 每天收盤後：抓持股的收盤價與匯率、比較基準，再替每個投資組合記一筆當天的淨值快照（排程在 vercel.json） */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ data: null, meta: {}, errors: [{ code: "unauthorized", message: "只接受排程呼叫" }] }, { status: 401 });
  }
  try {
    const db = await getDb();
    const prices = await syncPrices(db);
    // 逐筆帳戶交易過的股票補歷史價格（算 TWR 用）；一次最多 40 檔，其餘明天再補
    const backfill = await backfillHistory(db);
    const benchmarks = await syncBenchmarks(db);
    const valuations = await recordValuations(db);
    const failed = Boolean(
      prices.twse.error || prices.tpex.error || prices.fx.error || prices.us.errors.length || backfill.errors.length || backfill.fx.error || benchmarks.errors.length,
    );
    if (failed) {
      logError(
        new Error(
          `price sync: ${JSON.stringify({ twse: prices.twse.error, tpex: prices.tpex.error, fx: prices.fx.error, us: prices.us.errors, backfill: backfill.errors, backfillFx: backfill.fx.error, benchmarks: benchmarks.errors })}`,
        ),
      );
    }
    return ok({ prices, backfill, benchmarks, valuations }, { status: failed ? 502 : 200 });
  } catch (error) {
    logError(error);
    return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "同步失敗" }] }, { status: 500 });
  }
}
