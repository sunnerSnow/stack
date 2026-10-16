import { ok, withSession } from "@/lib/api/http";
import { searchAssets } from "@/lib/services/assets";

export const GET = withSession(async ({ request, user, db }) => {
  return ok(await searchAssets(db, user.id, new URL(request.url).searchParams.get("q")));
});
