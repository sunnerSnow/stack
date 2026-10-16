import { ok, withSession } from "@/lib/api/http";
import { getHoldings } from "@/lib/services/positions";

export const GET = withSession<RouteContext<"/api/portfolios/[id]/holdings">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  // Phase 1 還沒有行情：只回持倉數量與成本，不估算市值
  return ok(await getHoldings(db, user.id, id), { meta: { valuation: "unavailable", reason: "尚未接上行情資料" } });
});
