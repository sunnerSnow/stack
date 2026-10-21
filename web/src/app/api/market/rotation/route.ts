import { ok, withSession } from "@/lib/api/http";
import { type GroupLevel, getRotation } from "@/lib/services/market";

const LEVELS = new Set(["sector", "industry", "theme"]);

/** 族群輪動：每個族群（或產業、板塊）的強度、動能、漲跌、成交金額、法人金額與 10 日軌跡。?level=theme|industry|sector&date=YYYY-MM-DD */
export const GET = withSession(async ({ request, user, db }) => {
  const q = new URL(request.url).searchParams;
  const level = LEVELS.has(q.get("level") ?? "") ? (q.get("level") as GroupLevel) : "theme";
  const date = q.get("date");
  return ok(await getRotation(db, user.id, { level, ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}) }));
});
