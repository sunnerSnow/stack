import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { validationFailed } from "@/lib/errors";
import { MARKET_CURRENCY, type NormalizedTransaction } from "@/lib/ledger/input";

export type AssetRow = typeof assets.$inferSelect;

export interface AssetDto {
  id: string;
  market: string;
  symbol: string;
  name: string;
  assetType: string;
  currency: string;
  /** false：使用者自己新增的代號（只有本人看得到） */
  shared: boolean;
}

export const toAssetDto = (a: AssetRow): AssetDto => ({
  id: a.id,
  market: a.market,
  symbol: a.symbol,
  name: a.name,
  assetType: a.assetType,
  currency: a.currency,
  shared: a.createdBy === null,
});

/** 這個使用者看得到的資產：共用主檔＋自己新增的 */
const visibleTo = (userId: string) => or(isNull(assets.createdBy), eq(assets.createdBy, userId));

/**
 * 依「市場＋代號」找資產：先找共用主檔，再找自己新增過的；都沒有就建立一筆只有自己看得到的。
 * 使用者輸入的名稱與類別只影響自己，不會改到別人看到的資料。
 * 報價幣別由市場決定（TW → TWD、US → USD），不讓使用者自填。
 */
export async function resolveAsset(tx: Tx, userId: string, input: NonNullable<NormalizedTransaction["asset"]>): Promise<AssetRow> {
  const candidates = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.market, input.market), eq(assets.symbol, input.symbol), visibleTo(userId)));
  const found = candidates.find((a) => a.createdBy === null) ?? candidates.find((a) => a.createdBy === userId);
  if (found) return found;

  const issues = [];
  if (!input.name) issues.push({ field: "asset.name", message: `${input.symbol} 不在資產清單裡，請輸入名稱` });
  if (!input.assetType) issues.push({ field: "asset.assetType", message: "請選擇股票或 ETF" });
  if (issues.length > 0) throw validationFailed(issues);

  const [created] = await tx
    .insert(assets)
    .values({
      market: input.market,
      symbol: input.symbol,
      name: input.name!,
      assetType: input.assetType!,
      currency: MARKET_CURRENCY[input.market],
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // 同一個使用者的兩個請求同時建立了同一檔
  const [raced] = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.market, input.market), eq(assets.symbol, input.symbol), eq(assets.createdBy, userId)));
  return raced;
}

export async function searchAssets(db: Db, userId: string, q: string | null): Promise<AssetDto[]> {
  return withUser(db, userId, async (tx) => {
    const term = q?.trim().replace(/[%_\\]/g, "");
    const rows = await tx
      .select()
      .from(assets)
      .where(and(visibleTo(userId), term ? or(ilike(assets.symbol, `${term}%`), ilike(assets.name, `%${term}%`)) : undefined))
      .orderBy(asc(assets.market), asc(assets.symbol))
      .limit(50);
    return rows.map(toAssetDto);
  });
}
