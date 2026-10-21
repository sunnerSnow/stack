import { ok, withSession } from "@/lib/api/http";
import { listBenchmarks } from "@/lib/services/benchmarks";

/** 可選的比較基準：returnBasis 區分價格報酬（price）與總報酬（total_return，含息再投入） */
export const GET = withSession(async ({ user, db }) => ok(await listBenchmarks(db, user.id)));
