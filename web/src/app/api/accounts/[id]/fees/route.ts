import { ok, readJson, withSession } from "@/lib/api/http";
import { updateAccountFees } from "@/lib/services/portfolios";

/**
 * 更新帳戶的手續費設定：{ enabled, ratePercent, discount（折）, min, minOddLot, max, rounding }。
 * 只影響之後新增的交易；data 是更新後的帳戶。
 */
export const PATCH = withSession<RouteContext<"/api/accounts/[id]/fees">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await updateAccountFees(db, user.id, id, await readJson(request)));
});
