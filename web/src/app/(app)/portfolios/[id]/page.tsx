import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BRICK, BrickWall, type WallBrick } from "@/components/bricks";
import { Amount, Pnl } from "@/components/money";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { ACCOUNT_TYPE_LABEL, formatDecimal, MARKET_LABEL } from "@/lib/format";
import { listBenchmarks } from "@/lib/services/benchmarks";
import { getLatestSnapshots } from "@/lib/services/snapshots";
import { getPortfolioPerformance, type PerformanceDto } from "@/lib/services/performance";
import { getPortfolioValuation } from "@/lib/services/valuations";
import { D } from "@/lib/money/decimal";
import { type CurrencyAmount, getCashBalances, getHoldings, getLedgerSummary } from "@/lib/services/positions";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { getTransaction, listTransactions } from "@/lib/services/transactions";
import { describeFeeSettings } from "@/lib/ledger/costs";
import { AccountFeesForm } from "./account-fees-form";
import { CreateAccountForm } from "./create-account-form";
import { PerformanceCharts } from "./performance-charts";

export const metadata: Metadata = { title: "投資組合" };

async function loadOrNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
}

function CurrencyLines({ items, pnl = false }: { items: CurrencyAmount[]; pnl?: boolean }) {
  if (items.length === 0) return <span className="num text-ink-3">—</span>;
  return (
    <span className="grid gap-0.5">
      {items.map((i) => (
        <span key={i.currency} className="text-[19px] font-medium">
          {pnl ? <Pnl value={i.amount} currency={i.currency} /> : <Amount value={i.amount} currency={i.currency} />}
        </span>
      ))}
    </span>
  );
}

export default async function PortfolioPage({ params, searchParams }: PageProps<"/portfolios/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const { posted, duplicate, recalc, corrected, snapshot: savedSnapshot } = await searchParams;
  const db = await getDb();

  const portfolio = await loadOrNotFound(getPortfolio(db, user.id, id));
  const [accounts, summary, cash, holdings, transactions, snapshots, valuation, performance, benchmarkOptions] = await Promise.all([
    listAccounts(db, user.id, id),
    getLedgerSummary(db, user.id, id),
    getCashBalances(db, user.id, id),
    getHoldings(db, user.id, id),
    listTransactions(db, user.id, { portfolioId: id, limit: 100 }),
    getLatestSnapshots(db, user.id, id),
    getPortfolioValuation(db, user.id, id),
    getPortfolioPerformance(db, user.id, id),
    listBenchmarks(db, user.id),
  ]);
  const valued = new Map(valuation.holdings.map((h) => [`${h.accountId}:${h.assetId}`, h]));
  const base = valuation.baseCurrency;
  // 剛記錄的那筆直接用 ID 查：補登很早的交易不一定在最近 100 筆裡
  const postedTx = typeof posted === "string" ? await getTransaction(db, user.id, posted).then((d) => d.transaction, () => undefined) : undefined;
  const recalculated = typeof recalc === "string" ? Number.parseInt(recalc, 10) : 0;
  const tradingAccounts = accounts.filter((a) => a.trackingMode === "transaction");
  const snapshotOf = new Map(snapshots.map((s) => [s.accountId, s]));
  const justSaved = typeof savedSnapshot === "string" ? snapshots.find((s) => s.id === savedSnapshot) : undefined;
  const snapshotHoldings = snapshots.flatMap((s) => s.positions.map((p) => ({ ...p, accountId: s.accountId, accountName: s.accountName, asOfDate: s.asOfDate })));
  const wall = holdingBricks(valuation.holdings, summary.cash);

  return (
    <div className="grid grid-cols-1 gap-10">
      {/* 主視覺：左邊組合名稱與動作，右邊是持倉疊成的積木牆（最上面虛線那塊是「下一塊」） */}
      <header className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="kicker">
            <Link href="/portfolios" className="hover:underline">
              Build — 投資組合
            </Link>
          </p>
          <h1 className="page-title">{portfolio.name}</h1>
          <p className="mt-3 text-sm text-ink-2">
            基準幣別 <span className="num">{portfolio.baseCurrency}</span> · {accounts.length} 個帳戶 · {summary.transactionCount} 筆交易
            {summary.snapshotAccounts > 0 ? ` · ${summary.snapshotAccounts} 個帳戶用庫存快照` : ""}
          </p>
          <div className="mt-6 flex flex-wrap gap-3.5">
            {tradingAccounts.length > 0 ? (
              <Link href={`/portfolios/${id}/transactions/new`} className="btn btn-sun">
                ＋ 新增交易
              </Link>
            ) : null}
            <Link href={`/portfolios/${id}/imports/tdcc`} className="btn">
              匯入集保 e 存摺
            </Link>
          </div>
        </div>
        <div className="relative">
          <BrickWall bricks={wall} ghostLabel={wall.length === 0 ? "＋第一塊" : "＋下一塊"} className="mx-auto h-auto max-h-[380px] w-full max-w-[460px]" />
          <div className="absolute left-0 top-2 border-2 border-ink bg-paper px-2 py-1 font-mono text-[11.5px] tracking-[0.08em] text-ink-2 shadow-[3px_3px_0_var(--color-ink)]">
            <b className="font-medium text-ink">
              {base} {formatDecimal(valuation.totalValue, { maxFraction: 0 })}
            </b>{" "}
            總淨值
          </div>
          {performance.twr.status === "ok" ? (
            <div className="absolute right-0 top-1/3 border-2 border-ink bg-paper px-2 py-1 font-mono text-[11.5px] tracking-[0.08em] text-ink-2 shadow-[3px_3px_0_var(--color-ink)]">
              {pct(performance.twr.cumulative)} <b className="font-medium text-ink">TWR</b>
            </div>
          ) : null}
        </div>
      </header>

      {justSaved ? (
        <p className="success">
          已建立「{justSaved.accountName}」{justSaved.asOfDate} 的庫存快照：{justSaved.positions.length} 檔
          {justSaved.cashBalance !== null ? `、現金 ${formatDecimal(justSaved.cashBalance)}` : "（沒填現金）"}。之前的快照都保留著。
        </p>
      ) : null}

      {postedTx ? (
        <p className="success">
          {corrected ? "已更正（原交易已沖銷並保留）：" : duplicate ? "這筆已經送出過，沒有重複入帳：" : "已記錄："}
          {postedTx.tradeDate} {postedTx.typeLabel} {postedTx.asset ? `${postedTx.asset.symbol} ${postedTx.asset.name}` : ""}
          {postedTx.quantity ? ` ${postedTx.quantity} 股` : ""}
          {recalculated > 0 ? `。${corrected ? "更正" : "補登"}這筆後，依 FIFO 重新計算了 ${recalculated} 筆既有賣出的已實現損益。` : ""}
        </p>
      ) : null}

      {/* 估值：換算成基準幣別；缺價格或匯率的部分不計入，並標示不完整 */}
      <section aria-label="估值">
        <div className="band grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <div className="border-ink max-sm:border-b-[3px] sm:max-lg:border-b-[3px] sm:max-lg:border-r-[3px]">
            <div className="v">
              <small>{base}</small>
              <BandNumber value={valuation.totalValue} />
            </div>
            <div className="k flex flex-wrap items-center justify-between gap-2">
              總淨值 <QualityTag quality={valuation.quality} />
            </div>
          </div>
          <div className="border-ink max-sm:border-b-[3px] sm:max-lg:border-b-[3px] lg:border-l-[3px]">
            <div className="v">
              <BandNumber value={valuation.securitiesValue} />
            </div>
            <div className="k">證券市值</div>
          </div>
          <div className="border-ink max-sm:border-b-[3px] sm:max-lg:border-r-[3px] lg:border-l-[3px]">
            <div className="v">
              <BandNumber value={valuation.cashValue} />
            </div>
            <div className="k">現金</div>
          </div>
          <div className="border-ink lg:border-l-[3px]">
            <div className="v">
              <BandNumber value={valuation.unrealizedPnl} pnl />
            </div>
            <div className="k">未實現損益{valuation.costIncomplete ? "（只含有成本的持股）" : ""}</div>
          </div>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-2">
          估值日 <span className="num">{valuation.asOf}</span>：每檔用當天或之前最近的收盤價（台股證交所／櫃買中心、美股 FinMind），價格日期見持倉表。
          {valuation.fxUsed.map((r) => ` ${r.base}/${r.quote} ${r.rate}（${r.date} 臺銀即期中價）。`)}
          {valuation.missingPrices.length > 0 ? ` 還沒有價格、未計入市值：${valuation.missingPrices.join("、")}（每天收盤後更新）。` : ""}
          {valuation.stalePrices.length > 0 ? ` 價格超過 7 天沒更新：${valuation.stalePrices.join("、")}。` : ""}
          {valuation.missingFx.length > 0 ? ` 缺少 ${valuation.missingFx.join("、")} 匯率，這些幣別的部分未換算計入。` : ""}
          {valuation.cashIncomplete ? " 有快照帳戶沒填現金。" : ""}
          {valuation.costIncomplete ? " 有持股沒有成本（成本未完整），未實現損益只算有成本的部分。" : ""}
        </p>
      </section>

      <PerformancePanel p={performance} />

      {performance.series.length > 1 ? (
        <PerformanceCharts
          portfolioId={id}
          baseCurrency={performance.baseCurrency}
          asOf={performance.asOf}
          series={performance.series}
          benchmark={performance.benchmark}
          options={benchmarkOptions}
        />
      ) : null}

      {/* 帳本彙總：各幣別分開列，不做匯率換算 */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="sh-n">04 — Ledger</p>
            <h2>帳本</h2>
          </div>
          <span className="text-xs text-ink-2">各幣別分開，未換算</span>
        </div>
        <div className="grid divide-y-2 divide-ink sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-5 lg:divide-x-2">
          <div className="p-5">
            <p className="kicker">現金</p>
            <div className="mt-2">
              <CurrencyLines items={summary.cash} />
            </div>
          </div>
          <div className="p-5">
            <p className="kicker">持倉成本</p>
            <div className="mt-2">
              <CurrencyLines items={summary.costBasis} />
            </div>
          </div>
          <div className="p-5">
            <p className="kicker">已實現損益</p>
            <div className="mt-2">
              <CurrencyLines items={summary.realizedPnl} pnl />
            </div>
          </div>
          <div className="p-5">
            <p className="kicker">股息利息（稅後）</p>
            <div className="mt-2">
              <CurrencyLines items={summary.incomeNet} />
            </div>
          </div>
          <div className="p-5">
            <p className="kicker">淨入金</p>
            <div className="mt-2">
              <CurrencyLines items={summary.netContributions} />
            </div>
          </div>
        </div>
        {summary.cashIncomplete || summary.costIncomplete ? (
          <p className="border-t-2 border-ink px-5 py-3 text-xs leading-relaxed text-ink-2">
            {summary.cashIncomplete ? "有快照帳戶沒填現金，現金只含已知的部分。" : ""}
            {summary.costIncomplete ? "有快照持股沒填成本，持倉成本只含已知的部分（成本未完整）。" : ""}
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-6">
        <section className="panel min-w-0">
          <div className="panel-head">
            <div>
              <p className="sh-n">05 — Holdings</p>
              <h2>持倉</h2>
            </div>
            <span className="text-xs text-ink-2">逐筆帳戶依 FIFO 批次；快照帳戶取最新快照</span>
          </div>
          {holdings.length === 0 && snapshotHoldings.length === 0 ? (
            <p className="p-6 text-sm text-ink-2">目前沒有持倉。記一筆「買進」，或匯入集保 e 存摺建立庫存快照後，這裡會顯示數量與成本。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>資產</th>
                    <th>帳戶</th>
                    <th className="r">數量</th>
                    <th className="r">價格</th>
                    <th className="r">市值</th>
                    <th className="r">持倉成本</th>
                    <th className="r">未實現</th>
                    <th className="r">已實現</th>
                    <th className="r">來源</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => {
                    const v = valued.get(`${h.accountId}:${h.assetId}`);
                    return (
                      <tr key={`${h.accountId}:${h.assetId}`}>
                        <td>
                          <span className="font-bold num">{h.symbol}</span> <span className="text-ink-2">{h.name}</span>
                          <span className="tag ml-2">{MARKET_LABEL[h.market] ?? h.market}</span>
                        </td>
                        <td className="text-ink-2 whitespace-nowrap">{h.accountName}</td>
                        <td className="r">
                          <Amount value={h.quantity} maxFraction={4} />
                        </td>
                        <PriceCell price={v?.price ?? null} date={v?.priceDate ?? null} stale={v?.stale ?? false} />
                        <td className="r">
                          <Amount value={v?.marketValue ?? null} currency={h.currency} />
                        </td>
                        <td className="r">
                          <Amount value={h.costBasis} currency={h.currency} />
                          <span className="block text-[11px] text-ink-3">
                            均價 <Amount value={h.averageCost} maxFraction={4} />
                          </span>
                        </td>
                        <UnrealizedCell pnl={v?.unrealizedPnl ?? null} pct={v?.unrealizedPct ?? null} />
                        <td className="r">
                          <Pnl value={h.realizedPnl} />
                        </td>
                        <td className="r num whitespace-nowrap text-xs text-ink-2">{h.openLots} 批</td>
                      </tr>
                    );
                  })}
                  {snapshotHoldings.map((h) => {
                    const v = valued.get(`${h.accountId}:${h.asset.id}`);
                    return (
                      <tr key={`${h.accountId}:${h.asset.id}`}>
                        <td>
                          <span className="font-bold num">{h.asset.symbol}</span> <span className="text-ink-2">{h.asset.name}</span>
                          <span className="tag ml-2">{MARKET_LABEL[h.asset.market] ?? h.asset.market}</span>
                        </td>
                        <td className="text-ink-2 whitespace-nowrap">{h.accountName}</td>
                        <td className="r">
                          <Amount value={h.quantity} maxFraction={4} />
                        </td>
                        <PriceCell price={v?.price ?? null} date={v?.priceDate ?? null} stale={v?.stale ?? false} />
                        <td className="r">
                          <Amount value={v?.marketValue ?? null} currency={h.currency} />
                        </td>
                        <td className="r">
                          {h.costBasis === null ? (
                            <span className="tag tag-warn">成本未完整</span>
                          ) : (
                            <>
                              <Amount value={h.costBasis} currency={h.currency} />
                              <span className="block text-[11px] text-ink-3">
                                均價 <Amount value={h.unitCost} maxFraction={4} />
                              </span>
                            </>
                          )}
                        </td>
                        <UnrealizedCell pnl={v?.unrealizedPnl ?? null} pct={v?.unrealizedPct ?? null} />
                        <td className="r text-ink-3">—</td>
                        <td className="r whitespace-nowrap">
                          <span className="tag" title="快速淨值帳戶：取最新的庫存快照">
                            快照 {h.asOfDate.slice(5)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="sh-n">06 — Accounts</p>
              <h2>帳戶</h2>
            </div>
            <span className="tag">{accounts.length} 個</span>
          </div>
          {accounts.length === 0 ? (
            <p className="px-5 pt-5 text-sm text-ink-2">先建立一個券商或現金帳戶，才能記交易。</p>
          ) : (
            <ul className="grid sm:grid-cols-2 lg:grid-cols-3">
              {accounts.map((a) => {
                const balances = cash.filter((c) => c.accountId === a.id);
                if (a.trackingMode === "snapshot") {
                  const s = snapshotOf.get(a.id);
                  return (
                    <li key={a.id} className="border-b border-line px-5 py-3.5 sm:border-r">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">{a.name}</span>
                        <span className="tag tag-sea">快照 · {a.currency}</span>
                      </div>
                      {a.brokerName ? <p className="text-xs text-ink-3">{a.brokerName}</p> : null}
                      <div className="mt-1.5 grid gap-0.5 text-sm">
                        {s ? (
                          <>
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-xs text-ink-2">{s.asOfDate} 快照</span>
                              <span className="text-xs">{s.positions.length} 檔</span>
                            </span>
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-xs text-ink-2">現金</span>
                              {s.cashBalance === null ? <span className="text-xs text-ink-3">未提供</span> : <Amount value={s.cashBalance} currency={a.currency} />}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-ink-3">還沒有快照</span>
                        )}
                      </div>
                      <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs font-bold">
                        <Link href={`/portfolios/${id}/accounts/${a.id}/snapshot`} className="hover:underline">
                          更新庫存
                        </Link>
                        {a.currency === "TWD" ? (
                          <Link href={`/portfolios/${id}/imports/tdcc?account=${a.id}`} className="hover:underline">
                            匯入集保 e 存摺
                          </Link>
                        ) : null}
                      </p>
                    </li>
                  );
                }
                return (
                  <li key={a.id} className="border-b border-line px-5 py-3.5 sm:border-r">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold">{a.name}</span>
                      <span className="tag">
                        {ACCOUNT_TYPE_LABEL[a.accountType]} · {a.currency}
                      </span>
                    </div>
                    {a.brokerName ? <p className="text-xs text-ink-3">{a.brokerName}</p> : null}
                    <div className="mt-1.5 grid gap-0.5 text-sm">
                      {balances.length === 0 ? (
                        <span className="text-xs text-ink-3">尚無現金紀錄</span>
                      ) : (
                        balances.map((b) => (
                          <span key={b.currency} className="flex items-center justify-between gap-2">
                            <span className="text-xs text-ink-2">現金</span>
                            <span className="flex items-center gap-2">
                              {b.amount.startsWith("-") ? (
                                <span className="tag tag-warn" title="可能少記了入金">
                                  現金為負
                                </span>
                              ) : null}
                              <Amount value={b.amount} currency={b.currency} />
                            </span>
                          </span>
                        ))
                      )}
                    </div>
                    {a.accountType === "brokerage" ? (
                      <details className="group mt-1.5">
                        <summary className="cursor-pointer list-none text-xs text-ink-2 hover:underline">
                          手續費：{describeFeeSettings(a.fees) ?? "不自動估算"}
                          <span className="ml-1 font-bold group-open:hidden">設定</span>
                        </summary>
                        <AccountFeesForm portfolioId={id} accountId={a.id} currency={a.currency} fees={a.fees} />
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <details className="group" open={accounts.length === 0}>
            <summary className="cursor-pointer list-none px-5 py-3.5 text-sm font-bold hover:bg-cream">
              <span className="group-open:hidden">＋ 新增帳戶</span>
              <span className="hidden group-open:inline">新增帳戶</span>
            </summary>
            <CreateAccountForm portfolioId={id} />
          </details>
        </section>
      </div>

      <section className="panel min-w-0">
        <div className="panel-head">
          <div>
            <p className="sh-n">07 — Transactions</p>
            <h2>交易紀錄</h2>
          </div>
          <span className="text-xs text-ink-2">最近 {transactions.length} 筆 · 只能新增，記錯了用沖銷更正</span>
        </div>
        {transactions.length === 0 ? (
          <p className="p-6 text-sm text-ink-2">還沒有交易。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>交易日</th>
                  <th>類型</th>
                  <th>資產</th>
                  <th>帳戶</th>
                  <th className="r">數量</th>
                  <th className="r">單價</th>
                  <th className="r">金額</th>
                  <th className="r">費用＋稅</th>
                  <th className="r">現金影響</th>
                  <th className="r">已實現</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  // 已沖銷的原交易與沖銷交易都不計入現金與持倉：淡化顯示
                  <tr key={t.id} className={t.reversalOfId || t.reversedById ? "opacity-60" : undefined}>
                    <td className="num whitespace-nowrap">{t.tradeDate}</td>
                    <td className="whitespace-nowrap">
                      <span className={`tag ${t.reversalOfId ? "" : t.type === "buy" ? "tag-sea" : t.type === "sell" ? "tag-sun" : ""}`}>{t.typeLabel}</span>
                      {t.reversedById ? <span className="tag tag-warn ml-1">{t.replacedById ? "已更正" : "已沖銷"}</span> : null}
                    </td>
                    <td>{t.asset ? <span className="num font-bold">{t.asset.symbol}</span> : <span className="text-ink-3">—</span>}</td>
                    <td className="text-ink-2 whitespace-nowrap">{t.accountName}</td>
                    <td className="r">
                      <Amount value={t.quantity} maxFraction={4} />
                    </td>
                    <td className="r">
                      <Amount value={t.unitPrice} maxFraction={4} />
                    </td>
                    <td className="r">
                      <Amount value={t.grossAmount} currency={t.currency} />
                    </td>
                    <td className="r whitespace-nowrap">
                      <Amount value={totalCosts(t.fee, t.tax, t.otherCost)} />
                      {t.costEstimate ? (
                        <span className="tag ml-1" title="含系統估算的手續費或證交稅">
                          估
                        </span>
                      ) : null}
                    </td>
                    <td className="r">
                      <Amount value={t.cashAmount} signed />
                    </td>
                    <td className="r">
                      <Pnl value={t.realizedPnl} />
                    </td>
                    <td className="r">
                      <Link href={`/portfolios/${id}/transactions/${t.id}`} className="text-xs font-bold hover:underline whitespace-nowrap">
                        明細
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** 比率（0.1234）→「+12.34%」 */
function pct(ratio: string | null): string {
  return ratio === null ? "—" : `${formatDecimal(new D(ratio).times(100).toFixed(), { maxFraction: 2, signed: true })}%`;
}

/** 績效（海軍藍區塊，同首頁的模組區）：算不出來的指標顯示「無法計算」與原因，不顯示 0% */
function PerformancePanel({ p }: { p: PerformanceDto }) {
  const base = p.baseCurrency;
  const unavailable = (reason: string | null) => (
    <>
      <span className="tag tag-warn">無法計算</span>
      <span className="mt-1.5 block text-xs font-normal leading-relaxed text-on-navy">{reason}</span>
    </>
  );
  const b = p.breakdown;
  const cards: { label: string; value: React.ReactNode; note?: React.ReactNode; tone: string }[] = [
    {
      label: `整體投資損益（${base}）`,
      value: p.totalPnl === null ? unavailable("缺少淨投入或期末淨值") : <Pnl value={p.totalPnl} currency={base} />,
      note: p.netContributions !== null ? <>總淨值 − 淨投入 {formatDecimal(p.netContributions, { maxFraction: 0 })}</> : undefined,
      tone: "",
    },
    {
      label: "簡單報酬率",
      value: p.simpleReturn === null ? <span className="text-on-navy-2">不適用</span> : <span className="num">{pct(p.simpleReturn)}</span>,
      note: "整體損益 ÷ 淨投入",
      tone: "y",
    },
    {
      label: "XIRR（年化）",
      value: p.xirr.status === "ok" ? <span className="num">{pct(p.xirr.rate)}</span> : unavailable(p.xirr.reason),
      note: p.xirr.status === "ok" ? "資金加權：入金為負、出金為正、期末淨值為正" : undefined,
      tone: "c",
    },
    {
      label: "TWR（累積）",
      value: p.twr.status === "ok" ? <span className="num">{pct(p.twr.cumulative)}</span> : unavailable(p.twr.reason),
      note: p.twr.status === "ok" ? (p.twr.annualized !== null ? `年化 ${pct(p.twr.annualized)}` : "期間不滿一年，不年化") : undefined,
      tone: "",
    },
  ];
  return (
    <section className="navy-block px-5 py-6 sm:px-7 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="sh-n">02 — Performance</p>
          <h2 className="mt-1 text-[22px] font-black tracking-[0.04em]">績效</h2>
        </div>
        <span className="text-xs text-on-navy">
          {p.from ? (
            <>
              逐筆記帳的帳戶 · <span className="num">{p.from}</span> ～ <span className="num">{p.asOf}</span>（{p.days} 天）
            </>
          ) : (
            "逐筆記帳的帳戶"
          )}
        </span>
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className={`mod-card ${c.tone}`}>
            <p className="text-xs font-bold tracking-[0.06em] text-on-navy">{c.label}</p>
            <div className="mt-2 font-display text-[22px] font-black leading-tight [&_.num]:font-display">{c.value}</div>
            {c.note ? <p className="mt-2 text-xs leading-relaxed text-on-navy-2">{c.note}</p> : null}
          </div>
        ))}
      </div>
      <dl className="mt-7 grid gap-x-8 gap-y-1.5 border-t-[3px] border-cream pt-4 text-sm sm:grid-cols-3">
        {(
          [
            ["已實現", <Pnl key="r" value={b.realized} currency={base} />],
            ["未實現", <Pnl key="u" value={b.unrealized} currency={base} />],
            ["股息利息（稅後）", <Amount key="i" value={b.incomeNet} currency={base} />],
            ["單獨記的費用稅費", <Amount key="c" value={b.standaloneCosts} currency={base} />],
            ["交易成本（已含在損益裡）", <Amount key="t" value={b.tradingCosts} currency={base} />],
            ["匯率影響（估算）", b.fxEffect === null ? <span key="f" className="text-on-navy-2">—</span> : <Pnl key="f" value={b.fxEffect} currency={base} />],
          ] as [string, React.ReactNode][]
        ).map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 [&_.text-ink-3]:text-on-navy-2">
            <dt className="text-xs text-on-navy">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-on-navy">
        <QualityTag quality={p.quality === "complete" ? "complete" : "partial"} />{" "}
        每天用當天或之前最近的收盤價與匯率重建淨值；持股與現金都以成交日計。TWR 的入金／出金視為當天開盤前發生（先入金才下單）；各項損益以發生日匯率換算，未實現用今天的價格與匯率；匯率影響是整體損益減去各項損益的差額。
        {p.issues.map((issue) => ` ${issue}。`)}
      </p>
    </section>
  );
}

function QualityTag({ quality }: { quality: "complete" | "partial" | "stale" }) {
  if (quality === "complete") return <span className="tag tag-sea text-[11px] font-normal">完整</span>;
  return <span className="tag tag-warn text-[11px] font-normal">{quality === "stale" ? "價格過期" : "不完整"}</span>;
}

/** 價格與價格日期；還沒有價格顯示「尚無行情」 */
function PriceCell({ price, date, stale }: { price: string | null; date: string | null; stale: boolean }) {
  if (price === null) {
    return (
      <td className="r">
        <span className="tag tag-warn">尚無行情</span>
      </td>
    );
  }
  return (
    <td className="r whitespace-nowrap">
      <Amount value={price} maxFraction={4} />
      <span className={`block text-[11px] num ${stale ? "text-warn" : "text-ink-3"}`}>
        {date}
        {stale ? " 過期" : ""}
      </span>
    </td>
  );
}

function UnrealizedCell({ pnl, pct }: { pnl: string | null; pct: string | null }) {
  return (
    <td className="r whitespace-nowrap">
      <Pnl value={pnl} />
      {pct !== null ? <span className="block text-[11px] text-ink-3 num">{formatDecimal(new D(pct).times(100).toFixed(), { maxFraction: 2, signed: true })}%</span> : null}
    </td>
  );
}

/** 手續費＋稅＋其他費用；全為 0 時回 null（顯示 —） */
function totalCosts(...values: string[]): string | null {
  const sum = values.reduce((acc, v) => acc.plus(v), new D(0));
  return sum.isZero() ? null : sum.toFixed();
}

/** 黃色數字帶上的大數字：用 Unbounded、沒有小數；損益要顏色＋正負號＋文字 */
function BandNumber({ value, pnl = false }: { value: string | null; pnl?: boolean }) {
  if (value === null) return <span className="text-sun-ink">—</span>;
  const text = formatDecimal(value, { maxFraction: 0, signed: pnl });
  if (!pnl) return <span title={value}>{text}</span>;
  const tone = new D(value).isZero() ? "" : new D(value).isNegative() ? "loss" : "gain";
  return (
    <span className={tone} title={value}>
      {text}
      <span className="sr-only">（{tone === "gain" ? "獲利" : tone === "loss" ? "虧損" : "持平"}）</span>
    </span>
  );
}

/**
 * 積木牆的積木：每檔持股一塊（跨帳戶合併、依基準幣別市值由大到小，大的在底層），每個幣別的現金一塊；
 * 顏色：青綠＝台股、海軍藍＝美股、黃＝現金。最多 9 塊，其餘併成「其他 N 檔」。
 */
function holdingBricks(holdings: { market: string; symbol: string; marketValueBase: string | null }[], cash: CurrencyAmount[]): WallBrick[] {
  const bySymbol = new Map<string, { market: string; symbol: string; value: number }>();
  for (const h of holdings) {
    const key = `${h.market}:${h.symbol}`;
    const cur = bySymbol.get(key) ?? { market: h.market, symbol: h.symbol, value: 0 };
    cur.value += h.marketValueBase === null ? 0 : Number(h.marketValueBase);
    bySymbol.set(key, cur);
  }
  const stocks = [...bySymbol.values()].sort((x, y) => y.value - x.value);
  const cashBricks = cash.filter((c) => new D(c.amount).greaterThan(0)).map((c) => ({ label: `現金 ${c.currency}`, color: BRICK.cash, title: `現金 ${c.currency} ${c.amount}` }));
  const room = Math.max(0, 9 - cashBricks.length);
  const shown = stocks.length > room ? stocks.slice(0, room - 1) : stocks;
  const rest = stocks.length - shown.length;
  // 現金放最底層（跟首頁一樣），持股由大到小往上疊
  return [
    ...cashBricks,
    ...shown.map((h) => ({ label: h.symbol, color: h.market === "US" ? BRICK.us : BRICK.tw, title: `${h.symbol} ${MARKET_LABEL[h.market] ?? h.market}` })),
    ...(rest > 0 ? [{ label: `其他 ${rest} 檔`, color: BRICK.tw }] : []),
  ];
}
