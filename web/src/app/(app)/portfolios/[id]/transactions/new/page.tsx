import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { todayInTaipei } from "@/lib/ledger/input";
import { isPhase1Type } from "@/lib/ledger/rules";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { TransactionForm } from "../transaction-form";

export const metadata: Metadata = { title: "新增交易" };

export default async function NewTransactionPage({ params, searchParams }: PageProps<"/portfolios/[id]/transactions/new">) {
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
  // 快照模式的帳戶也列出來，但只能記入金與出金（表單會限制）
  const accounts = await listAccounts(db, user.id, id);
  if (accounts.length === 0) redirect(`/portfolios/${id}`);
  // 從帳戶卡片的「記入金／出金」連過來時，帶入帳戶與類型
  const query = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const wantedAccount = one(query.account);
  const wantedType = one(query.type);
  const initial = {
    accountId: accounts.some((a) => a.id === wantedAccount) ? wantedAccount : accounts.find((a) => a.trackingMode === "transaction")?.id,
    type: wantedType && isPhase1Type(wantedType) ? wantedType : undefined,
  };

  return (
    <div className="mx-auto grid max-w-[760px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name}
          </Link>
        </p>
        <h1 className="page-title">新增交易</h1>
        <p className="mt-1 text-sm text-ink-2">金額一律填正數，現金增減由交易類型決定。買賣的成交金額由「數量 × 單價」自動計算。</p>
      </div>
      <section className="panel">
        <TransactionForm
          portfolioId={id}
          today={todayInTaipei()}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, fees: a.fees, snapshot: a.trackingMode === "snapshot" }))}
          initial={initial}
        />
      </section>
    </div>
  );
}
