import { ok, withSession } from "@/lib/api/http";
import { getPortfolioValuation } from "@/lib/services/valuations";

/** 投資組合目前的估值（換算成基準幣別，附各持股的價格日期、使用的匯率與缺漏清單）；?asOf=YYYY-MM-DD 可指定估值日 */
export const GET = withSession<RouteContext<"/api/portfolios/[id]/valuation">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  const asOf = new URL(request.url).searchParams.get("asOf");
  return ok(await getPortfolioValuation(db, user.id, id, asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? { asOf } : {}));
});
