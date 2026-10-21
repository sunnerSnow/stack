import { ok, withSession } from "@/lib/api/http";
import { getRecentSnapshots } from "@/lib/services/snapshots";

/** 帳戶最新的快照與上一份（依基準日） */
export const GET = withSession<RouteContext<"/api/accounts/[id]/snapshots">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await getRecentSnapshots(db, user.id, id));
});
