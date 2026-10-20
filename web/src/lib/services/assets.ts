import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { validationFailed } from "@/lib/errors";
import { type TaxAsset, taxCategory } from "@/lib/ledger/costs";
import { MARKET_CURRENCY, type NormalizedTransaction } from "@/lib/ledger/input";

export type AssetRow = typeof assets.$inferSelect;

export interface AssetDto {
  id: string;
  market: string;
  symbol: string;
  name: string;
  assetType: string;
  currency: string;
  /** TWSE、TPEx、NASDAQ、NYSE… */
  exchange: string | null;
  /** false：已下市（共用主檔的來源裡已經沒有這個代號） */
  active: boolean;
  /** false：使用者自己新增的代號（只有本人看得到） */
  shared: boolean;
  /** 細分類（stock／preferred／tdr／etf），證交稅率用；私人代號為 null */
  kind: string | null;
  /** 台股債券 ETF（目前免徵證交稅） */
  bondEtf: boolean;
}

const metaOf = (a: AssetRow) => (a.metadata ?? {}) as { kind?: string; bondEtf?: boolean };

export const toAssetDto = (a: AssetRow): AssetDto => ({
  id: a.id,
  market: a.market,
  symbol: a.symbol,
  name: a.name,
  assetType: a.assetType,
  currency: a.currency,
  exchange: a.exchange,
  active: a.isActive,
  shared: a.createdBy === null,
  kind: metaOf(a).kind ?? null,
  bondEtf: taxCategory(taxAssetOf(a)) === "bond_etf",
});

/** 估算證交稅需要的資產資訊；私人代號沒有 metadata，就依 assetType 與代號判斷 */
export function taxAssetOf(a: AssetRow | AssetDto): TaxAsset {
  const meta = "metadata" in a ? metaOf(a) : { kind: a.kind, bondEtf: a.bondEtf };
  return { market: a.market, symbol: a.symbol, assetType: a.assetType, kind: meta.kind ?? null, bondEtf: meta.bondEtf ?? null };
}

/** 這個使用者看得到的資產：共用主檔＋自己新增的 */
const visibleTo = (userId: string) => or(isNull(assets.createdBy), eq(assets.createdBy, userId));

/**
 * 依「市場＋代號」找資產：先找自己新增過的，再找共用主檔；都沒有就建立一筆只有自己看得到的。
 * 自己新增過的優先：如果那個代號後來才進共用主檔，繼續用原本的私人資產，
 * 同一檔的持倉才不會被拆成兩個資產、FIFO 分開算。
 * 使用者輸入的名稱與類別只影響自己，不會改到別人看到的資料。
 * 報價幣別由市場決定（TW → TWD、US → USD），不讓使用者自填。
 */
export async function resolveAsset(tx: Tx, userId: string, input: NonNullable<NormalizedTransaction["asset"]>): Promise<AssetRow> {
  const candidates = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.market, input.market), eq(assets.symbol, input.symbol), visibleTo(userId)));
  const found = candidates.find((a) => a.createdBy === userId) ?? candidates.find((a) => a.createdBy === null);
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

/**
 * 搜尋代號或名稱。共用主檔有上萬筆，所以一定要帶關鍵字才查（沒帶回空陣列）。
 * 排序：代號完全相同 → 代號開頭相同 → 名稱包含；同一層裡自己新增的、還在交易的排前面。
 */
export async function searchAssets(db: Db, userId: string, q: string | null, opts: { market?: string; limit?: number } = {}): Promise<AssetDto[]> {
  const term = q?.trim().replace(/[%_\\]/g, "") ?? "";
  if (!term) return [];
  const upper = term.toUpperCase();
  return withUser(db, userId, async (tx) => {
    const rows = await tx
      .select()
      .from(assets)
      .where(
        and(
          visibleTo(userId),
          opts.market ? eq(assets.market, opts.market) : undefined,
          or(ilike(assets.symbol, `${term}%`), ilike(assets.name, `%${term}%`)),
        ),
      )
      .orderBy(
        sql`case when ${assets.symbol} = ${upper} then 0 when ${assets.symbol} like ${`${upper}%`} then 1 else 2 end`,
        sql`${assets.createdBy} is null`,
        desc(assets.isActive),
        sql`char_length(${assets.symbol})`,
        asc(assets.symbol),
      )
      .limit(Math.min(Math.max(opts.limit ?? 20, 1), 50));
    // 同一個代號同時有私人與共用的：只留私人那筆（跟 resolveAsset 一致）
    const mine = new Set(rows.filter((r) => r.createdBy === userId).map((r) => `${r.market}:${r.symbol}`));
    return rows.filter((r) => r.createdBy !== null || !mine.has(`${r.market}:${r.symbol}`)).map(toAssetDto);
  });
}
