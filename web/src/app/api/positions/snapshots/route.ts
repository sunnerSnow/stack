import { ok, readJson, withSession } from "@/lib/api/http";
import { createSnapshot } from "@/lib/services/snapshots";

/**
 * 建立庫存快照：{ clientRequestId, accountId, asOfDate, cashBalance?, notes?, importBatchId?, positions: [...] }。
 * 只能用在快照模式的帳戶；每次都是新的一份，不會改寫舊的。重複送出同一個 clientRequestId 回 200、meta.duplicate = true。
 */
export const POST = withSession(async ({ request, user, db }) => {
  const { snapshot, duplicate } = await createSnapshot(db, user.id, await readJson(request));
  return ok(snapshot, { status: duplicate ? 200 : 201, meta: { duplicate } });
});
