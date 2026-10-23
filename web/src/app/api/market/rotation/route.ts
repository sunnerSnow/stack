import { ok, withMarketSession } from "@/lib/api/http";
import { readDateQuery } from "@/lib/api/query";
import { type GroupLevel, getRotation } from "@/lib/services/market";

const LEVELS = new Set(["sector", "industry", "theme"]);

/** 族群輪動：每個族群（或產業、板塊）的強度、動能、漲跌、成交金額、法人金額與 10 日軌跡。?level=theme|industry|sector&date=YYYY-MM-DD */
export const GET = withMarketSession(async ({ request, user, db }) => {
  const q = new URL(request.url).searchParams;
  const level = LEVELS.has(q.get("level") ?? "") ? (q.get("level") as GroupLevel) : "theme";
  return ok(await getRotation(db, user?.id ?? null, { level, ...readDateQuery(q) }));
});
