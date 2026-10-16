import { ok, readJson, withSession } from "@/lib/api/http";
import { createAccount, listAccounts } from "@/lib/services/portfolios";

type Ctx = RouteContext<"/api/portfolios/[id]/accounts">;

export const GET = withSession<Ctx>(async ({ ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await listAccounts(db, user.id, id));
});

export const POST = withSession<Ctx>(async ({ request, ctx, user, db }) => {
  const { id } = await ctx.params;
  return ok(await createAccount(db, user.id, id, await readJson(request)), { status: 201 });
});
