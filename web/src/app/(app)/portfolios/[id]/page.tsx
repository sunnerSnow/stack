import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Amount, Pnl } from "@/components/money";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { ACCOUNT_TYPE_LABEL, MARKET_LABEL } from "@/lib/format";
import { D } from "@/lib/money/decimal";
import { type CurrencyAmount, getCashBalances, getHoldings, getLedgerSummary } from "@/lib/services/positions";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { getTransaction, listTransactions } from "@/lib/services/transactions";
import { CreateAccountForm } from "./create-account-form";

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
  const { posted, duplicate, recalc } = await searchParams;
  const db = await getDb();

  const portfolio = await loadOrNotFound(getPortfolio(db, user.id, id));
  const [accounts, summary, cash, holdings, transactions] = await Promise.all([
    listAccounts(db, user.id, id),
    getLedgerSummary(db, user.id, id),
    getCashBalances(db, user.id, id),
    getHoldings(db, user.id, id),
    listTransactions(db, user.id, { portfolioId: id, limit: 100 }),
  ]);
  // 剛記錄的那筆直接用 ID 查：補登很早的交易不一定在最近 100 筆裡
  const postedTx = typeof posted === "string" ? await getTransaction(db, user.id, posted).then((d) => d.transaction, () => undefined) : undefined;
  const recalculated = typeof recalc === "string" ? Number.parseInt(recalc, 10) : 0;

  return (
    <div className="grid grid-cols-1 gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kicker">
            <Link href="/portfolios" className="hover:underline">
              投資組合
            </Link>
          </p>
          <h1 className="mt-2 text-[28px] font-black">{portfolio.name}</h1>
          <p className="mt-1 text-sm text-ink-2">
            基準幣別 <span className="num">{portfolio.baseCurrency}</span> · 逐筆交易 · {accounts.length} 個帳戶 · {summary.transactionCount} 筆交易
          </p>
        </div>
        {accounts.length > 0 ? (
          <Link href={`/portfolios/${id}/transactions/new`} className="btn btn-sun">
            ＋ 新增交易
          </Link>
        ) : null}
      </div>

      {postedTx ? (
        <p className="success">
          {duplicate ? "這筆已經送出過，沒有重複入帳：" : "已記錄："}
          {postedTx.tradeDate} {postedTx.typeLabel} {postedTx.asset ? `${postedTx.asset.symbol} ${postedTx.asset.name}` : ""}
          {postedTx.quantity ? ` ${postedTx.quantity} 股` : ""}
          {recalculated > 0 ? `。補登這筆後，依 FIFO 重新計算了 ${recalculated} 筆既有賣出的已實現損益。` : ""}
        </p>
      ) : null}

      {/* 帳本彙總：各幣別分開列，不做匯率換算 */}
      <section className="panel">
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
        <p className="border-t-2 border-ink px-5 py-3 text-xs leading-relaxed text-ink-2">
          <span className="tag tag-warn mr-2">尚無行情</span>
          還沒接上行情與匯率，所以這裡不顯示市值、未實現損益、總淨值與報酬率（XIRR、TWR），也不會用估計值代替。各幣別分開列，沒有換算。
        </p>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section className="panel min-w-0">
          <div className="panel-head">
            <h2>持倉</h2>
            <span className="text-xs text-ink-2">FIFO 批次彙總</span>
          </div>
          {holdings.length === 0 ? (
            <p className="p-6 text-sm text-ink-2">目前沒有持倉。記一筆「買進」後，這裡會顯示數量與成本。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>資產</th>
                    <th>帳戶</th>
                    <th className="r">數量</th>
                    <th className="r">平均成本</th>
                    <th className="r">持倉成本</th>
                    <th className="r">已實現</th>
                    <th className="r">批次</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => (
                    <tr key={`${h.accountId}:${h.assetId}`}>
                      <td>
                        <span className="font-bold num">{h.symbol}</span> <span className="text-ink-2">{h.name}</span>
                        <span className="tag ml-2">{MARKET_LABEL[h.market] ?? h.market}</span>
                      </td>
                      <td className="text-ink-2 whitespace-nowrap">{h.accountName}</td>
                      <td className="r">
                        <Amount value={h.quantity} maxFraction={4} />
                      </td>
                      <td className="r">
                        <Amount value={h.averageCost} maxFraction={4} />
                      </td>
                      <td className="r">
                        <Amount value={h.costBasis} currency={h.currency} />
                      </td>
                      <td className="r">
                        <Pnl value={h.realizedPnl} />
                      </td>
                      <td className="r num">{h.openLots}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>帳戶</h2>
            <span className="tag">{accounts.length} 個</span>
          </div>
          {accounts.length === 0 ? (
            <p className="px-5 pt-5 text-sm text-ink-2">先建立一個券商或現金帳戶，才能記交易。</p>
          ) : (
            <ul>
              {accounts.map((a) => {
                const balances = cash.filter((c) => c.accountId === a.id);
                return (
                  <li key={a.id} className="border-b border-line px-5 py-3.5">
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
          <h2>交易紀錄</h2>
          <span className="text-xs text-ink-2">最近 {transactions.length} 筆 · 只能新增，不會被改寫</span>
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
                  <tr key={t.id}>
                    <td className="num whitespace-nowrap">{t.tradeDate}</td>
                    <td>
                      <span className={`tag ${t.type === "buy" ? "tag-sea" : t.type === "sell" ? "tag-sun" : ""}`}>{t.typeLabel}</span>
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
                    <td className="r">
                      <Amount value={totalCosts(t.fee, t.tax, t.otherCost)} />
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

/** 手續費＋稅＋其他費用；全為 0 時回 null（顯示 —） */
function totalCosts(...values: string[]): string | null {
  const sum = values.reduce((acc, v) => acc.plus(v), new D(0));
  return sum.isZero() ? null : sum.toFixed();
}
