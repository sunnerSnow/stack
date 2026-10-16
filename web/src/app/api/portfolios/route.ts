import { ok, readJson, withSession } from "@/lib/api/http";
import { createPortfolio, listPortfolios } from "@/lib/services/portfolios";

export const GET = withSession(async ({ user, db }) => ok(await listPortfolios(db, user.id)));

export const POST = withSession(async ({ request, user, db }) => ok(await createPortfolio(db, user.id, await readJson(request)), { status: 201 }));
