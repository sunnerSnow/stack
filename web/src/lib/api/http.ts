import "server-only";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { type Db, getDb } from "@/lib/db/client";
import { AppError, unauthorized, validationFailed } from "@/lib/errors";

/** API 回應格式一律是 { data, meta, errors }；金額以十進位字串傳輸 */
export function ok(data: unknown, init: { status?: number; meta?: Record<string, unknown> } = {}): Response {
  return Response.json({ data, meta: init.meta ?? {}, errors: [] }, { status: init.status ?? 200 });
}

export function fail(error: unknown): Response {
  if (error instanceof AppError) {
    const errors = error.issues.length
      ? error.issues.map((i) => ({ code: error.code, message: i.message, field: i.field }))
      : [{ code: error.code, message: error.message }];
    return Response.json({ data: null, meta: {}, errors }, { status: error.status });
  }
  logError(error);
  return Response.json({ data: null, meta: {}, errors: [{ code: "internal_error", message: "系統發生錯誤，請稍後再試" }] }, { status: 500 });
}

/**
 * 日誌不記錄交易內容：Drizzle 的錯誤訊息會附上 SQL 參數（金額、數量），
 * 所以只記錯誤類型、Postgres 錯誤碼與驅動本身的訊息。
 */
export function logError(error: unknown): void {
  const e = error as { name?: string; cause?: { code?: string; message?: string }; message?: string };
  const detail = e?.cause?.code ? `${e.cause.code} ${e.cause.message ?? ""}` : (e?.message ?? String(error)).split("\n")[0];
  console.error(`[stack] ${e?.name ?? "Error"}: ${detail.slice(0, 300)}`);
}

export async function readJson(request: Request): Promise<unknown> {
  // 只收 application/json：瀏覽器跨站送出的 text/plain 表單不會被當成 JSON 處理
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new AppError("unsupported_media_type", "請以 Content-Type: application/json 送出", 415);
  }
  try {
    return await request.json();
  } catch {
    throw validationFailed([{ field: "_", message: "請送出 JSON 格式的內容" }]);
  }
}

/**
 * 會改資料的請求要同源：瀏覽器送 POST 一定帶 Origin，不同網站就拒絕。
 * 沒有 Origin 的請求不是瀏覽器發出的（跨站偽造請求只會來自瀏覽器），所以放行，例如 curl 或伺服器對伺服器。
 */
function assertSameOrigin(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new AppError("forbidden_origin", "不接受來自其他網站的請求", 403);
  }
}

/** 包一層：驗證登入、取得資料庫、統一錯誤格式 */
export function withSession<Ctx>(fn: (args: { request: Request; ctx: Ctx; user: SessionUser; db: Db }) => Promise<Response>) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    try {
      assertSameOrigin(request);
      const user = await getSessionUser();
      if (!user) throw unauthorized();
      return await fn({ request, ctx, user, db: await getDb() });
    } catch (error) {
      return fail(error);
    }
  };
}
