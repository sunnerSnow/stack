import { ok, withMarketSession } from "@/lib/api/http";
import { readDateQuery } from "@/lib/api/query";
import { getGroupDetail } from "@/lib/services/market";

/** 族群成員：每檔的強度、動能、漲跌、20 日法人金額，以及族群 60 日的每日法人金額。?date=YYYY-MM-DD */
export const GET = withMarketSession<RouteContext<"/api/market/groups/[id]">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await getGroupDetail(db, user?.id ?? null, id, readDateQuery(new URL(request.url).searchParams)));
});
