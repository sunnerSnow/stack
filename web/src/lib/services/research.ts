import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/local";
import { aiResearchReports, assets, marketDaily, marketExRights, marketGroupMembers, marketGroups } from "@/lib/db/schema";
import { withUser } from "@/lib/db/with-user";
import { AppError, notFound } from "@/lib/errors";
import { todayInTaipei } from "@/lib/ledger/input";
import { D } from "@/lib/money/decimal";
import { generateWithClaude, type GeneratedReport, type ResearchGenerator } from "@/lib/research/claude";
import { computeIndicators } from "@/lib/research/indicators";
import { assembleResearchInput, type GroupContext, type GroupLevel, INPUT_VERSION, type ResearchInput, type StockFlowContext } from "@/lib/research/input";
import { fetchNews } from "@/lib/research/news";
import { hasClaims, type ReportContent, type ReportValidation, validateReport } from "@/lib/research/report";
import { getRotation } from "@/lib/services/market";
import { getPortfolioValuation } from "@/lib/services/valuations";
import type { ValuedHolding } from "@/lib/valuation/value";

/**
 * AI 研究：單一持股的研究摘要（Phase 6 第一步，只做台股）。
 * 使用者按下按鈕才產生；每人每天最多 DAILY_REPORT_LIMIT 份（成功、失敗都算，失敗的也有花到 token）。
 * 額度是軟性上限：在呼叫 AI 之前數、AI 回來之後才寫入，同一個人開多個分頁同時送出可能多出幾份
 * （按鈕在產生中會停用；報告表只能新增，沒辦法先寫一筆「進行中」再改）。
 */
export const DAILY_REPORT_LIMIT = 10;
const SUPPORTED_MARKETS = new Set(["TW"]);
const BARS = 300;
const MAX_GROUPS = 6;
const LEVEL_ORDER: GroupLevel[] = ["theme", "industry", "sector"];

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const uuid = z.uuid();

export interface HoldingOverview {
  asset: { id: string; symbol: string; name: string; market: string; exchange: string | null; assetType: string; currency: string };
  portfolioId: string;
  valuationDate: string;
  baseCurrency: string;
  /** 各帳戶的持股（含估值） */
  rows: ValuedHolding[];
  /** 占投資組合總淨值（%）；缺價格或匯率時 null */
  weightPct: number | null;
  /** 未實現報酬率（%）；有帳戶缺成本或價格時 null */
  unrealizedPct: number | null;
  /** 目前只支援台股 */
  supported: boolean;
}

export async function getHoldingOverview(db: Db, userId: string, portfolioId: string, assetId: string): Promise<HoldingOverview> {
  if (!uuid.safeParse(assetId).success) throw notFound("這檔持股");
  const valuation = await getPortfolioValuation(db, userId, portfolioId);
  const rows = valuation.holdings.filter((h) => h.assetId === assetId);
  if (rows.length === 0) throw notFound("這檔持股");
  const [asset] = await withUser(db, userId, (tx) =>
    tx
      .select({ id: assets.id, symbol: assets.symbol, name: assets.name, market: assets.market, exchange: assets.exchange, assetType: assets.assetType, currency: assets.currency })
      .from(assets)
      .where(eq(assets.id, assetId)),
  );
  if (!asset) throw notFound("這檔持股");

  const total = new D(valuation.totalValue);
  const weightPct = rows.every((r) => r.marketValueBase !== null) && total.greaterThan(0)
    ? rows.reduce((a, r) => a.plus(r.marketValueBase!), new D(0)).dividedBy(total).times(100).toNumber()
    : null;
  const cost = rows.every((r) => r.costBasis !== null && r.unrealizedPnl !== null) ? rows.reduce((a, r) => a.plus(r.costBasis!), new D(0)) : null;
  const unrealizedPct = cost && cost.greaterThan(0) ? rows.reduce((a, r) => a.plus(r.unrealizedPnl!), new D(0)).dividedBy(cost).times(100).toNumber() : null;
  return {
    asset,
    portfolioId,
    valuationDate: valuation.asOf,
    baseCurrency: valuation.baseCurrency,
    rows,
    weightPct,
    unrealizedPct,
    supported: SUPPORTED_MARKETS.has(asset.market),
  };
}

const num = (v: string | number | null) => (v === null ? null : Number(v));

/** 最近 n 個交易日的加總；天數不夠或有缺值就是 null */
function sumRecent(rows: { foreignNet: number | null; trustNet: number | null }[], n: number, key: "foreignNet" | "trustNet"): number | null {
  const recent = rows.slice(0, n);
  if (recent.length < n || recent.some((r) => r[key] === null)) return null;
  return recent.reduce((a, r) => a + r[key]!, 0);
}

async function loadGroups(db: Db, userId: string, assetId: string): Promise<GroupContext[]> {
  const memberships = await withUser(db, userId, (tx) =>
    tx
      .select({ id: marketGroups.id, level: marketGroups.level })
      .from(marketGroupMembers)
      .innerJoin(marketGroups, eq(marketGroups.id, marketGroupMembers.groupId))
      .where(and(eq(marketGroupMembers.assetId, assetId), eq(marketGroups.isActive, true), inArray(marketGroups.level, LEVEL_ORDER))),
  );
  if (memberships.length === 0) return [];
  const ids = new Set(memberships.map((m) => m.id));
  const groups: GroupContext[] = [];
  for (const level of LEVEL_ORDER) {
    if (!memberships.some((m) => m.level === level)) continue;
    const rotation = await getRotation(db, userId, { level });
    if (!rotation.date) continue;
    for (const n of rotation.nodes) {
      if (!ids.has(n.id)) continue;
      groups.push({
        id: n.id,
        name: n.name,
        level,
        date: rotation.date,
        strength: n.strength,
        momentum: n.momentum,
        ret5: n.ret5,
        ret20: n.ret20,
        foreign5: n.flows[5].foreign,
        trust5: n.flows[5].trust,
        foreign20: n.flows[20].foreign,
        trust20: n.flows[20].trust,
      });
    }
  }
  return groups.slice(0, MAX_GROUPS);
}

/** 整理一檔持股的輸入快照（持股比重、技術指標、族群資金、新聞） */
export async function buildResearchInput(db: Db, userId: string, overview: HoldingOverview, opts: { fetcher?: Fetcher } = {}): Promise<ResearchInput> {
  const assetId = overview.asset.id;
  const { bars, exRights } = await withUser(db, userId, async (tx) => ({
    bars: await tx
      .select({ date: marketDaily.tradeDate, close: marketDaily.close, volume: marketDaily.volume, foreignNet: marketDaily.foreignNet, trustNet: marketDaily.trustNet, strength: marketDaily.strength, momentum: marketDaily.momentum })
      .from(marketDaily)
      .where(eq(marketDaily.assetId, assetId))
      .orderBy(desc(marketDaily.tradeDate))
      .limit(BARS),
    exRights: await tx.select().from(marketExRights).where(eq(marketExRights.assetId, assetId)),
  }));
  const technical = computeIndicators(
    bars.map((b) => ({ date: b.date, close: num(b.close), volume: b.volume })),
    exRights.map((e) => ({ exDate: e.exDate, prevClose: Number(e.prevClose), refPrice: Number(e.refPrice) })),
  );
  const stockFlow: StockFlowContext | null = bars.length === 0
    ? null
    : {
        date: bars[0].date,
        strength: num(bars[0].strength),
        momentum: num(bars[0].momentum),
        foreign5: sumRecent(bars, 5, "foreignNet"),
        trust5: sumRecent(bars, 5, "trustNet"),
        foreign20: sumRecent(bars, 20, "foreignNet"),
        trust20: sumRecent(bars, 20, "trustNet"),
      };
  const asOf = todayInTaipei();
  const [groups, news] = await Promise.all([loadGroups(db, userId, assetId), fetchNews(overview.asset.symbol, asOf, opts.fetcher)]);
  const { symbol, name, market, exchange, assetType } = overview.asset;
  return assembleResearchInput({
    asset: { symbol, name, market, exchange, assetType },
    asOf,
    position: { valuationDate: overview.valuationDate, weightPct: overview.weightPct, unrealizedPct: overview.unrealizedPct },
    technical,
    stockFlow,
    groups,
    news,
  });
}

/** 台北時間今天 0 點起產生的報告數 */
export async function getResearchQuota(db: Db, userId: string): Promise<{ used: number; limit: number }> {
  const start = new Date(`${todayInTaipei()}T00:00:00+08:00`).toISOString();
  const [row] = await withUser(db, userId, (tx) =>
    tx.select({ n: count() }).from(aiResearchReports).where(and(eq(aiResearchReports.userId, userId), gte(aiResearchReports.createdAt, start))),
  );
  return { used: Number(row?.n ?? 0), limit: DAILY_REPORT_LIMIT };
}

export async function generateHoldingReport(
  db: Db,
  userId: string,
  portfolioId: string,
  assetId: string,
  opts: { generator?: ResearchGenerator; fetcher?: Fetcher } = {},
): Promise<{ id: string; status: "completed" | "failed" }> {
  const overview = await getHoldingOverview(db, userId, portfolioId, assetId);
  if (!overview.supported) throw new AppError("unsupported_market", "AI 研究摘要目前只支援台股", 400);
  const quota = await getResearchQuota(db, userId);
  if (quota.used >= quota.limit) throw new AppError("quota_exceeded", `今天已經產生 ${quota.limit} 份研究摘要，明天再試`, 429);

  const input = await buildResearchInput(db, userId, overview, { fetcher: opts.fetcher });
  const generated: GeneratedReport = await (opts.generator ?? generateWithClaude)(input);

  let status = generated.status;
  let error = generated.error;
  let content: ReportContent | null = null;
  let validation: ReportValidation = { dropped: [] };
  if (generated.status === "completed" && generated.content) {
    ({ content, validation } = validateReport(generated.content, input));
    if (!hasClaims(content)) {
      status = "failed";
      error = "AI 產出的句子引用都對不上，沒有可以顯示的結論";
      content = null;
    }
  }
  const [row] = await withUser(db, userId, (tx) =>
    tx
      .insert(aiResearchReports)
      .values({
        userId,
        portfolioId,
        assetId,
        scope: "holding",
        status,
        model: generated.model.slice(0, 100),
        promptVersion: generated.promptVersion,
        inputVersion: INPUT_VERSION,
        inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        inputSnapshot: input,
        content,
        validation: { ...validation, fallbackUsed: generated.fallbackUsed, stopReason: generated.stopReason },
        usage: generated.usage,
        error: error ? error.slice(0, 500) : null,
      })
      .returning({ id: aiResearchReports.id }),
  );
  return { id: row.id, status };
}

export interface ReportListItem {
  id: string;
  status: "completed" | "failed";
  model: string;
  createdAt: string;
}

export async function listHoldingReports(db: Db, userId: string, portfolioId: string, assetId: string): Promise<ReportListItem[]> {
  if (!uuid.safeParse(portfolioId).success || !uuid.safeParse(assetId).success) return [];
  return withUser(db, userId, (tx) =>
    tx
      .select({ id: aiResearchReports.id, status: aiResearchReports.status, model: aiResearchReports.model, createdAt: aiResearchReports.createdAt })
      .from(aiResearchReports)
      .where(and(eq(aiResearchReports.userId, userId), eq(aiResearchReports.portfolioId, portfolioId), eq(aiResearchReports.assetId, assetId)))
      .orderBy(desc(aiResearchReports.createdAt))
      .limit(50),
  );
}

export interface ResearchReportDto extends ReportListItem {
  promptVersion: string;
  inputVersion: string;
  inputHash: string;
  input: ResearchInput;
  content: ReportContent | null;
  validation: ReportValidation & { fallbackUsed?: boolean; stopReason?: string | null };
  usage: Partial<GeneratedReport["usage"]>;
  error: string | null;
}

export async function getHoldingReport(db: Db, userId: string, portfolioId: string, assetId: string, reportId: string): Promise<ResearchReportDto> {
  if (![reportId, portfolioId, assetId].every((v) => uuid.safeParse(v).success)) throw notFound("這份研究摘要");
  const [row] = await withUser(db, userId, (tx) =>
    tx
      .select()
      .from(aiResearchReports)
      .where(and(eq(aiResearchReports.id, reportId), eq(aiResearchReports.userId, userId), eq(aiResearchReports.portfolioId, portfolioId), eq(aiResearchReports.assetId, assetId))),
  );
  if (!row) throw notFound("這份研究摘要");
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    createdAt: row.createdAt,
    promptVersion: row.promptVersion,
    inputVersion: row.inputVersion,
    inputHash: row.inputHash,
    input: row.inputSnapshot as ResearchInput,
    content: row.content as ReportContent | null,
    validation: row.validation as ResearchReportDto["validation"],
    usage: row.usage as ResearchReportDto["usage"],
    error: row.error,
  };
}
