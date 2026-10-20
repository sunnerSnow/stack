import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { todayInTaipei } from "@/lib/ledger/input";
import { isPhase1Type, TRANSACTION_RULES } from "@/lib/ledger/rules";
import { D } from "@/lib/money/decimal";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { getTransaction } from "@/lib/services/transactions";
import { TransactionForm } from "../../transaction-form";

export const metadata: Metadata = { title: "更正交易" };

/** 費用為 0 時留白，表單會顯示 placeholder */
const blankIfZero = (value: string) => (new D(value).isZero() ? "" : value);

export default async function CorrectTransactionPage({ params }: PageProps<"/portfolios/[id]/transactions/[txId]/correct">) {
  const user = await requireUser();
  const { id, txId } = await params;
  const db = await getDb();
  let portfolio, detail;
  try {
    [portfolio, detail] = await Promise.all([getPortfolio(db, user.id, id), getTransaction(db, user.id, txId)]);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const t = detail.transaction;
  const accounts = await listAccounts(db, user.id, id);
  if (!accounts.some((a) => a.id === t.accountId)) notFound();
  // 沖銷交易、已沖銷或已更正過的交易不能再更正
  if (t.reversalOfId || t.reversedById || !isPhase1Type(t.type)) redirect(`/portfolios/${id}/transactions/${txId}`);
  const rule = TRANSACTION_RULES[t.type];

  return (
    <div className="mx-auto grid max-w-[760px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}/transactions/${txId}`} className="hover:underline">
            {portfolio.name} · 交易明細
          </Link>
        </p>
        <h1 className="mt-2 text-[28px] font-black">更正交易</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          原本那筆（<span className="num">{t.tradeDate}</span> {t.typeLabel} {t.asset ? <span className="num">{t.asset.symbol}</span> : null}
          ）不會被改寫：送出後會先沖銷它，再依下面的內容新增一筆，兩筆都留在交易紀錄裡。持倉與已實現損益會依 FIFO 重新計算。
        </p>
      </div>
      <section className="panel">
        <TransactionForm
          portfolioId={id}
          today={todayInTaipei()}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, fees: a.fees }))}
          correctionOf={t.id}
          initial={{
            type: t.type,
            accountId: t.accountId,
            tradeDate: t.tradeDate,
            settlementDate: t.settlementDate ?? "",
            symbol: t.asset?.symbol ?? "",
            quantity: t.quantity ?? "",
            unitPrice: t.unitPrice ?? "",
            amount: rule.trade ? "" : t.grossAmount,
            // 原本是系統估算的費用留空：送出時依新內容重新估算
            fee: t.costEstimate?.fee ? "" : blankIfZero(t.fee),
            tax: t.costEstimate?.tax ? "" : blankIfZero(t.tax),
            otherCost: blankIfZero(t.otherCost),
            notes: t.notes ?? "",
            dayTrade: t.dayTrade,
          }}
        />
      </section>
    </div>
  );
}
