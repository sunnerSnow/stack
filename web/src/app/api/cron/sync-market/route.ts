import { timingSafeEqual } from "node:crypto";
import { logError, ok } from "@/lib/api/http";
import { getDb } from "@/lib/db/client";
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
 * 族群輪動：同步族群清單 → 抓上市櫃收盤行情與三大法人（有時間預算，回補時分好幾次）→ 算強度與動能。
 * 排程在 vercel.json（平日台北 18:00，法人資料公布之後）；回補時可以手動多呼叫幾次。
 * ?budget=秒數 可以拉長抓資料的時間（只在沒有 60 秒限制的環境有用，例如在本機回補）。
 */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ data: null, meta: {}, errors: [{ code: "unauthorized", message: "只接受排程呼叫" }] }, { status: 401 });
  }
  const started = Date.now();
  const budgetSec = Number(new URL(request.url).searchParams.get("budget"));
  const fetchMs = Number.isFinite(budgetSec) && budgetSec > 0 ? Math.min(budgetSec, 3600) * 1000 : 32_000;
  try {
    const db = await getDb();
    const groups = await syncGroups(db);
    const market = await syncMarket(db, undefined, { budgetMs: fetchMs });
    const remaining = fetchMs + 20_000 - (Date.now() - started);
    const rotation = remaining > 8_000 ? await computeRotation(db, { maxDates: fetchMs > 32_000 ? 200 : remaining > 20_000 ? 20 : 5 }) : null;
    const failed = market.errors.length > 0;
    if (failed) logError(new Error(`market sync: ${JSON.stringify(market.errors.slice(0, 5))}`));
    // 族群清單的問題（代號找不到、名稱對不上）整份列出，改清單時用得到
    return ok({ groups, market, rotation }, { status: failed ? 502 : 200 });
  } catch (error) {
    logError(error);
    return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "同步失敗" }] }, { status: 500 });
  }
}
