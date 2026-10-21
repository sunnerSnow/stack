import { ok, readJson, withSession } from "@/lib/api/http";
import { createTdccImport } from "@/lib/services/imports";

/**
 * 建立匯入批次。目前只有集保 e 存摺：body 為瀏覽器解析好的
 * { accountId, fileName, fileHash, header, movements }（PDF 與密碼不要送來）。
 * data 是待確認的批次（含伺服器推算的持股）；用 POST /api/positions/snapshots 帶 importBatchId 確認。
 */
export const POST = withSession(async ({ request, user, db }) => {
  return ok(await createTdccImport(db, user.id, await readJson(request)), { status: 201 });
});
