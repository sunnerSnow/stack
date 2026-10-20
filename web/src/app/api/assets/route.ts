import { ok, withSession } from "@/lib/api/http";
import { searchAssets } from "@/lib/services/assets";

/** 搜尋資產主檔：?q=代號或名稱（必填）&market=TW|US&limit=1~50 */
export const GET = withSession(async ({ request, user, db }) => {
  const params = new URL(request.url).searchParams;
  const market = params.get("market")?.toUpperCase();
  return ok(
    await searchAssets(db, user.id, params.get("q"), {
      market: market === "TW" || market === "US" ? market : undefined,
      limit: Number(params.get("limit") ?? 20) || 20,
    }),
  );
});
