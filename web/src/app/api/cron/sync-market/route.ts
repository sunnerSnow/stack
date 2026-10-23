import { timingSafeEqual } from "node:crypto";
import { logError, ok } from "@/lib/api/http";
import { getDb } from "@/lib/db/client";
import { syncBenchmarks } from "@/lib/market/benchmarks";
import { syncGroups } from "@/lib/market/groups-sync";
import { syncMarket } from "@/lib/market/market-sync";
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
 * 族群輪動：同步台股基準與交易日曆 → 同步族群清單 → 抓上市櫃收盤行情與三大法人（有時間預算，回補時分好幾次）。
 * 排程在 vercel.json（平日台北 18:00，法人資料公布之後）；強度與動能在 19:00 的 /api/cron/compute-market 算。
 * ?budget=秒數 可以拉長抓資料的時間並在最後一起算完（只在沒有 60 秒限制的環境有用，例如在本機回補）。
 */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ data: null, meta: {}, errors: [{ code: "unauthorized", message: "只接受排程呼叫" }] }, { status: 401 });
  }
  const budgetSec = Number(new URL(request.url).searchParams.get("budget"));
  const fetchMs = Number.isFinite(budgetSec) && budgetSec > 0 ? Math.min(budgetSec, 3600) * 1000 : 32_000;
  try {
    const started = Date.now();
    const db = await getDb();
    const benchmarks = await syncBenchmarks(db, undefined, { benchmarkIds: ["taiex", "taiex_tr"] });
    const groups = await syncGroups(db);
    // 基準與族群同步共用抓取預算，避免首次回補再疊上一整段行情預算。
    const remainingMs = Math.max(1, fetchMs - (Date.now() - started));
    const market = await syncMarket(db, undefined, { budgetMs: remainingMs });
    // 平常的排程到這裡就停，計算交給 /api/cron/compute-market（另一個 60 秒）；拉長預算回補時順便算完
    const rotation = fetchMs > 32_000 ? await computeRotation(db, { maxDates: 200 }) : null;
    const failed = benchmarks.errors.length > 0 || market.errors.length > 0;
    if (failed) logError(new Error(`market sync: ${JSON.stringify({ benchmarks: benchmarks.errors.slice(0, 5), market: market.errors.slice(0, 5) })}`));
    // 族群清單的問題（代號找不到、名稱對不上）整份列出，改清單時用得到
    return ok({ benchmarks, groups, market, rotation }, { status: failed ? 502 : 200 });
  } catch (error) {
    logError(error);
    return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "同步失敗" }] }, { status: 500 });
  }
}
