import { ok, withSession } from "@/lib/api/http";
import { getPortfolioPerformance } from "@/lib/services/performance";

/**
 * 績效（逐筆記帳的帳戶）：整體損益、簡單報酬率、XIRR、TWR、損益拆解與每日淨值。
 * 算不出來的指標回傳 status 與 reason，不會是 0。?asOf=YYYY-MM-DD 可指定截止日。
 */
export const GET = withSession<RouteContext<"/api/portfolios/[id]/performance">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  const asOf = new URL(request.url).searchParams.get("asOf");
  return ok(await getPortfolioPerformance(db, user.id, id, asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? { asOf } : {}));
});
