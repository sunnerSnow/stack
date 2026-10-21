import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets } from "@/lib/db/schema";
import {
  type AssetRecord,
  type AssetSource,
  dedupeRecords,
  parseNasdaqListed,
  parseOtherListed,
  parseTwClassPage,
  TW_CLASSES,
  twClassUrl,
  US_LIST_URLS,
} from "@/lib/assets/sources";

/**
 * 同步共用資產主檔（created_by 為 null 的那些）。
 *
 * - 以資料庫擁有者身分執行（系統工作，不是某個使用者的操作），不會碰到任何人的私人代號。
 * - 每個來源各自一個資料庫交易：新增或更新名稱／類別，並記下這次同步的 ID。
 * - 來源裡已經不存在的代號標成 is_active = false（下市），不刪除：舊交易仍然指向它們。
 * - 來源抓取失敗或筆數突然少很多時，不做下市標記，避免一次把整個市場停用。
 */

export interface SyncReport {
  source: AssetSource;
  fetched: number;
  upserted: number;
  deactivated: number;
  /** 沒有做下市標記的原因 */
  skippedDeactivation?: string;
  error?: string;
}

type Fetcher = (url: string) => Promise<Response>;

const TIMEOUT_MS = 20_000;
const BATCH = 1000;
/** 這次筆數低於目前有效筆數的這個比例，就不標下市 */
const MIN_RATIO = 0.8;

const defaultFetcher: Fetcher = (url) =>
  fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "STACK asset sync (+https://stack-gtmd.vercel.app)" } });

async function get(fetcher: Fetcher, url: string): Promise<Response> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`);
  return res;
}

/** 台股：證券編碼查詢的頁面是 Big5（MS950） */
export async function fetchTwRecords(fetcher: Fetcher = defaultFetcher): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  for (const cls of TW_CLASSES) {
    const html = new TextDecoder("big5").decode(await (await get(fetcher, twClassUrl(cls))).arrayBuffer());
    records.push(...parseTwClassPage(html, cls));
  }
  return dedupeRecords(records);
}

export async function fetchUsRecords(fetcher: Fetcher = defaultFetcher): Promise<AssetRecord[]> {
  const [nasdaq, other] = await Promise.all([get(fetcher, US_LIST_URLS.nasdaq), get(fetcher, US_LIST_URLS.other)]);
  return dedupeRecords([...parseNasdaqListed(await nasdaq.text()), ...parseOtherListed(await other.text())]);
}

/** 把一個來源的資料寫進共用主檔；records 必須是這個來源「完整」的清單 */
export async function applyAssetRecords(db: Db, source: AssetSource, records: AssetRecord[], runId = randomUUID()): Promise<SyncReport> {
  return db.transaction(async (tx) => {
    const fromSource = and(isNull(assets.createdBy), sql`${assets.metadata}->>'source' = ${source}`);
    const [{ active }] = await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(fromSource, eq(assets.isActive, true)));

    let upserted = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const rows = records.slice(i, i + BATCH).map((r) => ({
        market: r.market,
        symbol: r.symbol,
        name: r.name,
        assetType: r.assetType,
        exchange: r.exchange,
        currency: r.currency,
        isActive: true,
        metadata: { ...r.metadata, syncId: runId },
        createdBy: null,
      }));
      const result = await tx
        .insert(assets)
        .values(rows)
        .onConflictDoUpdate({
          target: [assets.market, assets.symbol],
          targetWhere: isNull(assets.createdBy),
          set: {
            name: sql`excluded.name`,
            assetType: sql`excluded.asset_type`,
            exchange: sql`excluded.exchange`,
            isActive: true,
            // 保留行情回補的進度（priceBackfillFrom），其他欄位以來源為準
            metadata: sql`excluded.metadata || jsonb_strip_nulls(jsonb_build_object('priceBackfillFrom', ${assets.metadata}->'priceBackfillFrom'))`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: assets.id });
      upserted += result.length;
    }

    if (records.length < active * MIN_RATIO) {
      return {
        source,
        fetched: records.length,
        upserted,
        deactivated: 0,
        skippedDeactivation: `這次只有 ${records.length} 筆，少於目前有效的 ${active} 筆的 ${MIN_RATIO * 100}%，可能是來源異常，暫不標記下市`,
      };
    }
    const gone = await tx
      .update(assets)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(and(fromSource, eq(assets.isActive, true), sql`${assets.metadata}->>'syncId' is distinct from ${runId}`))
      .returning({ id: assets.id });
    return { source, fetched: records.length, upserted, deactivated: gone.length };
  });
}

/** 依序同步台股與美股；一個來源失敗不影響另一個 */
export async function syncAssets(db: Db, fetcher: Fetcher = defaultFetcher): Promise<SyncReport[]> {
  const jobs: [AssetSource, () => Promise<AssetRecord[]>][] = [
    ["twse-isin", () => fetchTwRecords(fetcher)],
    ["nasdaq-trader", () => fetchUsRecords(fetcher)],
  ];
  const reports: SyncReport[] = [];
  for (const [source, load] of jobs) {
    try {
      reports.push(await applyAssetRecords(db, source, await load()));
    } catch (error) {
      reports.push({ source, fetched: 0, upserted: 0, deactivated: 0, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  return reports;
}
