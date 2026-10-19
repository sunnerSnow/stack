import { ok, readJson, withSession } from "@/lib/api/http";
import { correctTransaction, getTransaction } from "@/lib/services/transactions";

export const GET = withSession<RouteContext<"/api/transactions/[id]">>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await getTransaction(db, user.id, id));
});

/**
 * 更正交易：原交易不會被改寫，而是沖銷後依送出的內容新增一筆（內容格式同 POST /api/transactions，另可帶 reason）。
 * data 是更正後的新交易；重複送出同一個 clientRequestId 回 200、meta.duplicate = true。
 */
export const PATCH = withSession<RouteContext<"/api/transactions/[id]">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  const { original, reversal, replacement, duplicate, recalculatedSells } = await correctTransaction(db, user.id, id, await readJson(request));
  return ok(replacement, {
    status: duplicate ? 200 : 201,
    meta: { duplicate, originalId: original.id, reversalId: reversal.id, recalculatedSells },
  });
});
