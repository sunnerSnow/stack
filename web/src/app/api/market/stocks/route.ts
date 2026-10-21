import { ok, withSession } from "@/lib/api/http";
import { getStockScreens } from "@/lib/services/market";

/** 個股篩選：續強（連續 4 天在領先象限）與轉強（5 天前不在、今天在），只列成交金額夠大的。?date=YYYY-MM-DD */
export const GET = withSession(async ({ request, user, db }) => {
  const date = new URL(request.url).searchParams.get("date");
  return ok(await getStockScreens(db, user.id, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}));
});
