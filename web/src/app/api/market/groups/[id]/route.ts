import { ok, withSession } from "@/lib/api/http";
import { getGroupDetail } from "@/lib/services/market";

/** 族群成員：每檔的強度、動能、漲跌、20 日法人金額，以及族群 60 日的每日法人金額。?date=YYYY-MM-DD */
export const GET = withSession<RouteContext<"/api/market/groups/[id]">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  const date = new URL(request.url).searchParams.get("date");
  return ok(await getGroupDetail(db, user.id, id, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}));
});
