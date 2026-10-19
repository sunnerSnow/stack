import { ok, readJson, withSession } from "@/lib/api/http";
import { reverseTransaction } from "@/lib/services/transactions";

/**
 * 沖銷交易：body 為 { clientRequestId, reason? }。
 * data 是沖銷交易；重複送出同一個 clientRequestId 回 200、meta.duplicate = true。
 */
export const POST = withSession<RouteContext<"/api/transactions/[id]/reversal">>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  const { original, reversal, duplicate, recalculatedSells } = await reverseTransaction(db, user.id, id, await readJson(request));
  return ok(reversal, { status: duplicate ? 200 : 201, meta: { duplicate, originalId: original.id, recalculatedSells } });
});
