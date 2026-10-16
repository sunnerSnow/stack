import { ok, withSession } from "@/lib/api/http";
import { getCashBalances, getLedgerSummary } from "@/lib/services/positions";

export const GET = withSession<RouteContext<"/api/portfolios/[id]/summary">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  const [summary, cashBalances] = await Promise.all([getLedgerSummary(db, user.id, id), getCashBalances(db, user.id, id)]);
  return ok(
    { ...summary, cashBalances },
    // 各幣別分開列，不做匯率換算；總淨值、XIRR、TWR 待行情與績效引擎（Phase 3、4）
    { meta: { valuation: "unavailable", currencyConversion: "none", reason: "尚未接上行情與匯率資料" } },
  );
});
