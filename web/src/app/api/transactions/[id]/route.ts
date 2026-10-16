import { ok, withSession } from "@/lib/api/http";
import { getTransaction } from "@/lib/services/transactions";

export const GET = withSession<RouteContext<"/api/transactions/[id]">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await getTransaction(db, user.id, id));
});
