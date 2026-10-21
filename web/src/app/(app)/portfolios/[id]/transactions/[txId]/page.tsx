import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Amount, Pnl } from "@/components/money";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { formatDateTime, MARKET_LABEL } from "@/lib/format";
import { describeFee, describeTax } from "@/lib/ledger/costs";
import { getTransaction } from "@/lib/services/transactions";
import { ReverseForm } from "./reverse-form";

export const metadata: Metadata = { title: "交易明細" };

const TAX_KIND: Record<string, string> = { transaction_tax: "交易稅", withholding_tax: "扣繳稅", other: "其他稅" };
const AUDIT_ACTION: Record<string, string> = { reverse: "沖銷", correct: "更正" };

export default async function TransactionPage({ params, searchParams }: PageProps<"/portfolios/[id]/transactions/[txId]">) {
  const user = await requireUser();
  const { id, txId } = await params;
  const { reversed, recalc } = await searchParams;
  let detail;
  try {
    detail = await getTransaction(await getDb(), user.id, txId);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { transaction: t, disposals, audit } = detail;
  const href = (transactionId: string) => `/portfolios/${id}/transactions/${transactionId}`;
  const recalculated = typeof recalc === "string" ? Number.parseInt(recalc, 10) : 0;
  // 這筆被沖銷（或更正）的那次紀錄、這筆是哪一次更正的結果
  const reversal = audit.find((a) => a.transactionId === t.id);
  const correction = audit.find((a) => a.replacementId === t.id);
  const effective = !t.reversalOfId && !t.reversedById;

  const rows: [string, React.ReactNode][] = [
    ["交易日", <span key="d" className="num">{t.tradeDate}</span>],
    ["交割日", <span key="s" className="num">{t.settlementDate ?? "—"}</span>],
    ["帳戶", t.accountName],
    ["資產", t.asset ? `${t.asset.symbol} ${t.asset.name}（${MARKET_LABEL[t.asset.market] ?? t.asset.market}）` : "—"],
    ["數量", <Amount key="q" value={t.quantity} maxFraction={10} />],
    ["單價", <Amount key="p" value={t.unitPrice} maxFraction={10} />],
    [t.type === "buy" || t.type === "sell" ? "成交金額" : "金額", <Amount key="g" value={t.grossAmount} currency={t.currency} maxFraction={10} />],
    ["手續費", <span key="f">{t.costEstimate?.fee ? <span className="tag mr-2">估算</span> : null}<Amount value={t.fee} maxFraction={10} /></span>],
    [
      t.taxKind ? TAX_KIND[t.taxKind] : t.type === "sell" ? "交易稅" : "稅",
      <span key="t">{t.costEstimate?.tax ? <span className="tag mr-2">估算</span> : null}<Amount value={t.tax} maxFraction={10} /></span>,
    ],
    ["其他費用", <Amount key="o" value={t.otherCost} maxFraction={10} />],
    ["現金影響", <Amount key="c" value={t.cashAmount} currency={t.currency} maxFraction={10} signed />],
    ["外部現金流", t.externalFlowType === "contribution" ? "入金（外部投入）" : t.externalFlowType === "withdrawal" ? "出金（外部提領）" : "否"],
    ...(t.type === "sell" ? ([["現股當沖", t.dayTrade ? "是（證交稅 0.15%）" : "否"]] as [string, React.ReactNode][]) : []),
    ["來源", t.source === "manual" ? "手動輸入" : t.source],
    ["備註", t.notes ?? "—"],
    ["建立時間", <span key="ca" className="num">{formatDateTime(t.createdAt)}</span>],
  ];

  return (
    <div className="mx-auto grid max-w-[860px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            回投資組合
          </Link>
        </p>
        <h1 className="page-title flex flex-wrap items-center gap-3">
          <span>
            {t.typeLabel} {t.asset ? <span className="num">{t.asset.symbol}</span> : null}
          </span>
          {t.reversedById ? <span className="tag tag-warn">{t.replacedById ? "已更正" : "已沖銷"}</span> : null}
          {t.correctionOfId ? <span className="tag tag-sea">更正後</span> : null}
        </h1>
        <p className="mt-1 text-xs text-ink-3 num">ID {t.id}</p>
      </div>

      {reversed ? (
        <p className="success">
          已沖銷：這筆不再計入現金與持倉，原交易與沖銷交易都保留在紀錄裡。
          {recalculated > 0 ? `依 FIFO 重新計算了 ${recalculated} 筆既有賣出的已實現損益。` : ""}
        </p>
      ) : null}

      {t.reversalOfId ? (
        <p className="notice">
          這是沖銷交易，用來抵銷 <Link href={href(t.reversalOfId)} className="font-bold underline">原交易</Link>
          ：內容相同、現金反向入帳，兩筆都不再計入持倉。
        </p>
      ) : null}
      {t.reversedById ? (
        <p className="notice">
          這筆已在 <span className="num">{reversal ? formatDateTime(reversal.createdAt) : "—"}</span> {t.replacedById ? "更正" : "沖銷"}
          ，不再計入現金與持倉（見 <Link href={href(t.reversedById)} className="font-bold underline">沖銷交易</Link>
          {t.replacedById ? (
            <>
              、<Link href={href(t.replacedById)} className="font-bold underline">更正後的交易</Link>
            </>
          ) : null}
          ）。{reversal?.reason ? `原因：${reversal.reason}` : ""}
        </p>
      ) : null}
      {t.correctionOfId ? (
        <p className="success">
          這筆是更正後的交易，取代 <Link href={href(t.correctionOfId)} className="font-bold underline">原交易</Link>。
          {correction?.reason ? `原因：${correction.reason}` : ""}
        </p>
      ) : null}

      <section className={`panel ${effective ? "" : "opacity-75"}`}>
        <dl className="grid sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3 sm:odd:border-r">
              <dt className="text-xs font-bold text-ink-2">{label}</dt>
              <dd className="text-right text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {t.costEstimate ? (
        <p className="border-2 border-dashed border-line bg-paper px-4 py-3 text-xs leading-relaxed text-ink-2">
          <span className="tag mr-2">估算</span>
          這筆有費用是入帳時依規則估算的，不是券商對帳單上的金額：
          {t.costEstimate.fee ? ` 手續費 ${t.costEstimate.fee.amount}（${describeFee(t.costEstimate.fee)}）` : ""}
          {t.costEstimate.fee && t.costEstimate.tax ? "；" : ""}
          {t.costEstimate.tax ? (
            <>
              {" "}證交稅 {t.costEstimate.tax.amount}（{describeTax(t.costEstimate.tax)}，
              <a href={t.costEstimate.tax.source} target="_blank" rel="noreferrer" className="underline">
                依據
              </a>
              ）
            </>
          ) : null}
          。金額不一樣的話，用下方的「更正這筆」改成實際金額。
        </p>
      ) : null}

      {t.type === "sell" && effective ? (
        <section className="panel min-w-0">
          <div className="panel-head">
            <h2>FIFO 消耗的批次</h2>
            <span className="text-sm">
              已實現 <Pnl value={t.realizedPnl} currency={t.currency} />
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>批次取得日</th>
                  <th className="r">數量</th>
                  <th className="r">分配成本</th>
                  <th className="r">分配收入</th>
                  <th className="r">手續費</th>
                  <th className="r">交易稅</th>
                  <th className="r">其他</th>
                  <th className="r">已實現</th>
                </tr>
              </thead>
              <tbody>
                {disposals.map((d) => (
                  <tr key={d.lotId}>
                    <td className="num">{d.lotAcquiredDate}</td>
                    <td className="r"><Amount value={d.quantity} maxFraction={4} /></td>
                    <td className="r"><Amount value={d.allocatedCost} /></td>
                    <td className="r"><Amount value={d.allocatedProceeds} /></td>
                    <td className="r"><Amount value={d.allocatedFee} /></td>
                    <td className="r"><Amount value={d.allocatedTax} /></td>
                    <td className="r"><Amount value={d.allocatedOtherCost} /></td>
                    <td className="r"><Pnl value={d.realizedPnl} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t-2 border-ink px-5 py-3 text-xs text-ink-2">
            賣出損益 ＝ 分配收入 − 手續費 − 交易稅 − 其他費用 − 分配成本。費用依數量比例分配到各批次。
          </p>
        </section>
      ) : null}

      {effective ? (
        <section className="panel">
          <div className="panel-head">
            <h2>更正或沖銷</h2>
            <span className="text-xs text-ink-2">原交易會保留，不會被改寫</span>
          </div>
          <div className="grid divide-y-2 divide-ink sm:grid-cols-2 sm:divide-x-2 sm:divide-y-0">
            <div className="p-5">
              <h3 className="font-bold">內容記錯了</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">填入正確的內容。系統會沖銷這筆、新增一筆更正後的交易，並依 FIFO 重算持倉與已實現損益。</p>
              <Link href={`${href(t.id)}/correct`} className="btn btn-sun mt-3">
                更正這筆
              </Link>
            </div>
            <div className="p-5">
              <h3 className="font-bold">這筆不該存在</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">例如重複記了。沖銷後現金與持倉還原；如果之後的賣出會因此持倉不足，會被拒絕。</p>
              <details className="group mt-3">
                <summary className="btn cursor-pointer list-none">
                  <span className="group-open:hidden">沖銷這筆…</span>
                  <span className="hidden group-open:inline">取消</span>
                </summary>
                <ReverseForm portfolioId={id} transactionId={t.id} />
              </details>
            </div>
          </div>
        </section>
      ) : null}

      {audit.length > 0 ? (
        <section className="panel min-w-0">
          <div className="panel-head">
            <h2>稽核紀錄</h2>
            <span className="text-xs text-ink-2">只能新增，不會被改寫</span>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>動作</th>
                  <th>原因</th>
                  <th className="r">重算賣出</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.reversalId}>
                    <td className="num whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                    <td className="whitespace-nowrap">{AUDIT_ACTION[a.action] ?? a.action}</td>
                    <td className="text-ink-2">{a.reason ?? "—"}</td>
                    <td className="r num">{a.recalculatedSells}</td>
                    <td className="r whitespace-nowrap text-xs font-bold">
                      {[
                        a.transactionId !== t.id ? <Link key="o" href={href(a.transactionId)} className="hover:underline">原交易</Link> : null,
                        a.reversalId !== t.id ? <Link key="r" href={href(a.reversalId)} className="hover:underline">沖銷交易</Link> : null,
                        a.replacementId && a.replacementId !== t.id ? <Link key="n" href={href(a.replacementId)} className="hover:underline">更正後</Link> : null,
                      ]
                        .filter(Boolean)
                        .flatMap((link, i) => (i === 0 ? [link] : [" · ", link]))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
