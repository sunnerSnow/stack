import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Amount, Pnl } from "@/components/money";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { MARKET_LABEL } from "@/lib/format";
import { getTransaction } from "@/lib/services/transactions";

export const metadata: Metadata = { title: "交易明細" };

const TAX_KIND: Record<string, string> = { transaction_tax: "交易稅", withholding_tax: "扣繳稅", other: "其他稅" };

export default async function TransactionPage({ params }: PageProps<"/portfolios/[id]/transactions/[txId]">) {
  const user = await requireUser();
  const { id, txId } = await params;
  let detail;
  try {
    detail = await getTransaction(await getDb(), user.id, txId);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { transaction: t, disposals } = detail;

  const rows: [string, React.ReactNode][] = [
    ["交易日", <span key="d" className="num">{t.tradeDate}</span>],
    ["交割日", <span key="s" className="num">{t.settlementDate ?? "—"}</span>],
    ["帳戶", t.accountName],
    ["資產", t.asset ? `${t.asset.symbol} ${t.asset.name}（${MARKET_LABEL[t.asset.market] ?? t.asset.market}）` : "—"],
    ["數量", <Amount key="q" value={t.quantity} maxFraction={10} />],
    ["單價", <Amount key="p" value={t.unitPrice} maxFraction={10} />],
    [t.type === "buy" || t.type === "sell" ? "成交金額" : "金額", <Amount key="g" value={t.grossAmount} currency={t.currency} maxFraction={10} />],
    ["手續費", <Amount key="f" value={t.fee} maxFraction={10} />],
    [t.taxKind ? TAX_KIND[t.taxKind] : "稅", <Amount key="t" value={t.tax} maxFraction={10} />],
    ["其他費用", <Amount key="o" value={t.otherCost} maxFraction={10} />],
    ["現金影響", <Amount key="c" value={t.cashAmount} currency={t.currency} maxFraction={10} signed />],
    ["外部現金流", t.externalFlowType === "contribution" ? "入金（外部投入）" : t.externalFlowType === "withdrawal" ? "出金（外部提領）" : "否"],
    ["來源", t.source === "manual" ? "手動輸入" : t.source],
    ["備註", t.notes ?? "—"],
    ["建立時間", <span key="ca" className="num">{t.createdAt}</span>],
  ];

  return (
    <div className="mx-auto grid max-w-[860px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            回投資組合
          </Link>
        </p>
        <h1 className="mt-2 text-[28px] font-black">
          {t.typeLabel} {t.asset ? <span className="num">{t.asset.symbol}</span> : null}
        </h1>
        <p className="mt-1 text-xs text-ink-3 num">ID {t.id}</p>
      </div>

      <section className="panel">
        <dl className="grid sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3 sm:odd:border-r">
              <dt className="text-xs font-bold text-ink-2">{label}</dt>
              <dd className="text-right text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {t.type === "sell" ? (
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
    </div>
  );
}
