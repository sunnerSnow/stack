import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { todayInTaipei } from "@/lib/ledger/input";
import { searchAssets } from "@/lib/services/assets";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { TransactionForm } from "../transaction-form";

export const metadata: Metadata = { title: "新增交易" };

export default async function NewTransactionPage({ params }: PageProps<"/portfolios/[id]/transactions/new">) {
  const user = await requireUser();
  const { id } = await params;
  const db = await getDb();
  let portfolio;
  try {
    portfolio = await getPortfolio(db, user.id, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const [accounts, assets] = await Promise.all([listAccounts(db, user.id, id), searchAssets(db, user.id, null)]);
  if (accounts.length === 0) redirect(`/portfolios/${id}`);

  return (
    <div className="mx-auto grid max-w-[760px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name}
          </Link>
        </p>
        <h1 className="mt-2 text-[28px] font-black">新增交易</h1>
        <p className="mt-1 text-sm text-ink-2">金額一律填正數，現金增減由交易類型決定。買賣的成交金額由「數量 × 單價」自動計算。</p>
      </div>
      <section className="panel">
        <TransactionForm
          portfolioId={id}
          today={todayInTaipei()}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
          assets={assets.map((a) => ({ market: a.market, symbol: a.symbol, name: a.name }))}
        />
      </section>
    </div>
  );
}
