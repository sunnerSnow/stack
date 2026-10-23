import { ok, withMarketSession } from "@/lib/api/http";
import { readDateQuery } from "@/lib/api/query";
import { getStockScreens } from "@/lib/services/market";

/** 個股篩選：續強（連續 4 天在領先象限）與轉強（5 天前不在、今天在），只列成交金額夠大的。?date=YYYY-MM-DD */
export const GET = withMarketSession(async ({ request, user, db }) => {
  return ok(await getStockScreens(db, user?.id ?? null, readDateQuery(new URL(request.url).searchParams)));
});
