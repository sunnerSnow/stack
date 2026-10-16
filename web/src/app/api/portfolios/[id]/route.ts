import { ok, withSession } from "@/lib/api/http";
import { getPortfolio } from "@/lib/services/portfolios";

export const GET = withSession<RouteContext<"/api/portfolios/[id]">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await getPortfolio(db, user.id, id));
});
