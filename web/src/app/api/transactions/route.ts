import { ok, readJson, withSession } from "@/lib/api/http";
import { validationFailed } from "@/lib/errors";
import { listTransactions, postTransaction } from "@/lib/services/transactions";

export const GET = withSession(async ({ request, user, db }) => {
  const params = new URL(request.url).searchParams;
  const portfolioId = params.get("portfolioId");
  if (!portfolioId) throw validationFailed([{ field: "portfolioId", message: "請指定 portfolioId" }]);
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 200) || 200, 1), 500);
  return ok(await listTransactions(db, user.id, { portfolioId, accountId: params.get("accountId") ?? undefined, limit }));
});

/** 新增交易：重複送出同一個 clientRequestId 會回 200 與原本那筆（meta.duplicate = true） */
export const POST = withSession(async ({ request, user, db }) => {
  const { transaction, duplicate } = await postTransaction(db, user.id, await readJson(request));
  return ok(transaction, { status: duplicate ? 200 : 201, meta: { duplicate } });
});
