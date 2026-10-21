import { ok, withSession } from "@/lib/api/http";
import { listValuations } from "@/lib/services/valuations";

/** 淨值歷史：每天收盤後記的淨值快照（新到舊），含資料完整度 */
export const GET = withSession<RouteContext<"/api/portfolios/[id]/history">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await listValuations(db, user.id, id));
});
