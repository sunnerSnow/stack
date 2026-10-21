import { ok, readJson, withSession } from "@/lib/api/http";
import { setPortfolioBenchmark } from "@/lib/services/benchmarks";

/** 設定投資組合的比較基準：{ benchmarkId }（例如 taiex_tr、voo_tr）；data 是選定的基準 */
export const PUT = withSession<RouteContext<"/api/portfolios/[id]/benchmark">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await setPortfolioBenchmark(db, user.id, id, await readJson(request)));
});
