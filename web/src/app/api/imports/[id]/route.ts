import { ok, withSession } from "@/lib/api/http";
import { getImport } from "@/lib/services/imports";

export const GET = withSession<RouteContext<"/api/imports/[id]">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await getImport(db, user.id, id));
});
