import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Amount, Pnl } from "@/components/money";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { formatDateTime, formatDecimal, MARKET_LABEL } from "@/lib/format";
import { aiProvider } from "@/lib/research/generator";
import type { FactKind, ResearchFact } from "@/lib/research/input";
import { REPORT_SECTIONS, SECTION_LABEL } from "@/lib/research/report";
import { getPortfolio } from "@/lib/services/portfolios";
import { getHoldingOverview, getHoldingReport, getResearchQuota, listHoldingReports, type ResearchReportDto } from "@/lib/services/research";
import { GenerateResearchButton } from "./generate-button";

export const metadata: Metadata = { title: "持股研究" };
// 產生研究摘要的 Server Action 在這個頁面執行：AI 逾時 90 秒、重試 1 次，加上抓新聞與資料庫，留到 240 秒（Vercel Hobby 上限 300）
export const maxDuration = 240;

const KIND_LABEL: Record<FactKind, string> = { position: "持股", technical: "技術面", flow: "資金面", news: "新聞" };
const DROP_REASON: Record<string, string> = { no_refs: "沒有引用資料", unknown_refs: "引用的資料不存在", too_long: "句子太長", too_many: "超過句數上限" };

export default async function HoldingPage({ params, searchParams }: PageProps<"/portfolios/[id]/holdings/[assetId]">) {
  const user = await requireUser();
  const { id, assetId } = await params;
  const { report: reportParam } = await searchParams;
  const db = await getDb();
  let portfolio, overview, reports, quota, report: ResearchReportDto | null = null;
  try {
    [portfolio, overview, reports, quota] = await Promise.all([
      getPortfolio(db, user.id, id),
      getHoldingOverview(db, user.id, id, assetId),
      listHoldingReports(db, user.id, id, assetId),
      getResearchQuota(db, user.id),
    ]);
    const selected = typeof reportParam === "string" ? reportParam : reports[0]?.id;
    if (selected) report = await getHoldingReport(db, user.id, id, assetId, selected);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { asset } = overview;
  const provider = aiProvider();
  const disabledReason = !overview.supported
    ? "AI 研究摘要目前只支援台股。"
    : !provider
      ? "還沒有設定 AI 服務（伺服器缺少 GROQ_API_KEY 或 ANTHROPIC_API_KEY）。"
      : quota.used >= quota.limit
        ? `今天已經產生 ${quota.limit} 份，明天再試。`
        : null;

  return (
    <div className="mx-auto grid max-w-[1000px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name}
          </Link>
        </p>
        <h1 className="page-title">
          <span className="num">{asset.symbol}</span> {asset.name}
          <span className="tag ml-3 align-middle">{MARKET_LABEL[asset.market] ?? asset.market}</span>
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          估值日 <span className="num">{overview.valuationDate}</span>
          {overview.weightPct !== null ? (
            <>
              {" "}
              · 占投資組合 <span className="num">{overview.weightPct.toFixed(2)}%</span>
            </>
          ) : null}
          {overview.unrealizedPct !== null ? (
            <>
              {" "}
              · 未實現報酬率 <Pnl value={overview.unrealizedPct.toFixed(2)} />%
            </>
          ) : null}
        </p>
      </div>

      <section className="panel min-w-0">
        <div className="panel-head">
          <h2>持股</h2>
          <span className="text-xs text-ink-2">各帳戶的數量、市值與成本</span>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>帳戶</th>
                <th className="r">數量</th>
                <th className="r">價格</th>
                <th className="r">市值</th>
                <th className="r">持倉成本</th>
                <th className="r">未實現</th>
              </tr>
            </thead>
            <tbody>
              {overview.rows.map((h) => (
                <tr key={h.accountId}>
                  <td className="whitespace-nowrap">
                    {h.accountName}
                    {h.source === "snapshot" ? <span className="tag ml-2">快照 {h.snapshotDate?.slice(5)}</span> : null}
                  </td>
                  <td className="r">
                    <Amount value={h.quantity} maxFraction={4} />
                  </td>
                  <td className="r whitespace-nowrap">
                    <Amount value={h.price} maxFraction={4} />
                    {h.priceDate ? <span className={`block text-[11px] num ${h.stale ? "text-warn" : "text-ink-3"}`}>{h.priceDate}</span> : null}
                  </td>
                  <td className="r">
                    <Amount value={h.marketValue} currency={h.currency} />
                  </td>
                  <td className="r">{h.costBasis === null ? <span className="tag tag-warn">成本未完整</span> : <Amount value={h.costBasis} currency={h.currency} />}</td>
                  <td className="r">
                    <Pnl value={h.unrealizedPnl} />
                    {h.unrealizedPct !== null ? <span className="block text-[11px] text-ink-3 num">{formatDecimal((Number(h.unrealizedPct) * 100).toFixed(2), { signed: true })}%</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel min-w-0">
        <div className="panel-head">
          <div>
            <p className="sh-n">DISCOVER — AI 研究</p>
            <h2>AI 研究摘要</h2>
          </div>
          <span className="text-xs text-ink-2 num">
            今天已產生 {quota.used}／{quota.limit} 份
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5">
          <GenerateResearchButton portfolioId={id} assetId={asset.id} disabledReason={disabledReason} hasReport={reports.length > 0} />
          <p className="text-xs leading-relaxed text-ink-2">
            AI 只根據下方「用到的資料」整理，每句結論都標出引用的資料編號；這不是投資建議。法人買超或族群資金流入是觀察訊號，不代表股價會上漲。
            {provider ? `產生時會把這些資料送到 ${provider.label} 處理：` : "產生時會把這些資料送到外部的 AI 服務處理："}持股只送比重與報酬率，不含金額、股數與帳戶。
          </p>
          {report ? <ReportView report={report} /> : <p className="text-sm text-ink-2">還沒有研究摘要。{disabledReason === null ? "按上方的按鈕產生第一份。" : ""}</p>}
        </div>
      </section>

      {reports.length > 1 ? (
        <section className="panel min-w-0">
          <div className="panel-head">
            <h2>歷史版本</h2>
            <span className="text-xs text-ink-2">每次產生都另存一份，不會覆寫</span>
          </div>
          <ul className="divide-y divide-line">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                <Link href={`/portfolios/${id}/holdings/${asset.id}?report=${r.id}`} className={`num hover:underline ${r.id === report?.id ? "font-bold" : ""}`}>
                  {formatDateTime(r.createdAt)}
                </Link>
                {r.status === "failed" ? <span className="tag tag-warn">失敗</span> : null}
                <span className="text-xs text-ink-3">{r.model}</span>
                {r.id === report?.id ? <span className="tag tag-sea">目前顯示</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ReportView({ report }: { report: ResearchReportDto }) {
  const facts = new Map(report.input.facts.map((f) => [f.id, f]));
  const usage = report.usage;
  return (
    <article className="grid min-w-0 grid-cols-1 gap-5 border-t border-line pt-4">
      <p className="text-xs leading-relaxed text-ink-2">
        <span className="num">{formatDateTime(report.createdAt)}</span> 產生 · 模型 <span className="num">{report.model}</span>
        {report.validation.fallbackUsed ? "（原模型拒絕，由備援模型完成）" : ""} · 提示 <span className="num">{report.promptVersion}</span> · 輸入快照{" "}
        <span className="num" title={report.inputHash}>
          #{report.inputHash.slice(0, 8)}
        </span>
        {usage.inputTokens !== undefined ? (
          <>
            {" "}
            · token <span className="num">{usage.inputTokens.toLocaleString("en-US")}</span> 入／<span className="num">{(usage.outputTokens ?? 0).toLocaleString("en-US")}</span> 出
          </>
        ) : null}
      </p>

      {report.status === "failed" ? (
        <p className="alert" role="alert">
          這次沒有產生可用的摘要：{report.error}
        </p>
      ) : null}

      {report.content
        ? REPORT_SECTIONS.filter((s) => report.content![s].length > 0).map((s) => (
            <section key={s}>
              <h3 className="mb-2 text-sm font-bold">{SECTION_LABEL[s]}</h3>
              <ul className="grid gap-1.5 text-sm leading-relaxed">
                {report.content![s].map((c, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <span>{c.text}</span>
                    <span className="inline-flex flex-wrap gap-1">
                      {c.refs.map((r) => (
                        <a key={r} href={`#fact-${r}`} className="tag num no-underline" title={facts.get(r) ? `${facts.get(r)!.label}：${facts.get(r)!.value}` : r}>
                          {r}
                        </a>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        : null}

      {report.content && report.content.dataGaps.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-bold">資料缺口</h3>
          <ul className="list-disc pl-5 text-sm leading-relaxed text-ink-2">
            {report.content.dataGaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.validation.dropped?.length > 0 ? (
        <details className="text-xs text-ink-2">
          <summary className="cursor-pointer">有 {report.validation.dropped.length} 句因為引用對不上而沒有顯示</summary>
          <ul className="mt-2 list-disc pl-5">
            {report.validation.dropped.map((d, i) => (
              <li key={i}>
                {SECTION_LABEL[d.section]}：{d.text.slice(0, 120)}（{DROP_REASON[d.reason] ?? d.reason}{d.refs.length > 0 ? `：${d.refs.join("、")}` : ""}）
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <FactsTable facts={report.input.facts} gaps={report.input.gaps} asOf={report.input.asOf} />
    </article>
  );
}

function FactsTable({ facts, gaps, asOf }: { facts: ResearchFact[]; gaps: string[]; asOf: string }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-bold">用到的資料（輸入快照）</h3>
      <p className="mb-2 text-xs text-ink-2">
        資料整理日期 <span className="num">{asOf}</span>。AI 只看得到這些資料；新聞只有標題，沒有內文。
      </p>
      {facts.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="table text-sm">
            <thead>
              <tr>
                <th>編號</th>
                <th>類別</th>
                <th className="min-w-[10rem]">項目</th>
                <th>數值</th>
                <th>日期</th>
                <th className="min-w-[12rem]">來源</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => (
                <tr key={f.id} id={`fact-${f.id}`} className="target:bg-warn-bg">
                  <td className="num font-bold">{f.id}</td>
                  <td className="whitespace-nowrap text-ink-2">{KIND_LABEL[f.kind]}</td>
                  <td>
                    {f.url && /^https?:\/\//i.test(f.url) ? (
                      <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                        {f.label}
                      </a>
                    ) : (
                      f.label
                    )}
                  </td>
                  <td className="whitespace-nowrap">{f.value}</td>
                  <td className="num whitespace-nowrap text-ink-2">{f.date ?? "—"}</td>
                  <td className="text-xs text-ink-3">{f.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {gaps.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs leading-relaxed text-ink-2">
          {gaps.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
