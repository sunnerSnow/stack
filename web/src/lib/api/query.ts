import { validationFailed } from "@/lib/errors";
import { isoDate } from "@/lib/ledger/input";

/** 省略日期表示最新資料；有提供就必須是有效日期，不能靜默改查最新。 */
export function readDateQuery(query: URLSearchParams): { date?: string } {
  const raw = query.get("date");
  if (raw === null) return {};
  const parsed = isoDate.safeParse(raw);
  if (!parsed.success) throw validationFailed([{ field: "date", message: parsed.error.issues[0].message }]);
  return { date: parsed.data };
}
