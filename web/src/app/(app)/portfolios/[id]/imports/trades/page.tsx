import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { TradeImporter } from "./trade-importer";

export const metadata: Metadata = { title: "匯入券商成交明細" };

export default async function TradeImportPage({ params, searchParams }: PageProps<"/portfolios/[id]/imports/trades">) {
  const user = await requireUser();
  const { id } = await params;
  const { account } = await searchParams;
  const db = await getDb();
  let portfolio;
  try {
    portfolio = await getPortfolio(db, user.id, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  // 成交明細記成逐筆交易：只能匯入台幣的逐筆記帳帳戶（也可以在下面新建一個）
  const accounts = (await listAccounts(db, user.id, id)).filter((a) => a.trackingMode === "transaction" && a.currency === "TWD");

  return (
    <div className="mx-auto grid max-w-[860px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name}
          </Link>
        </p>
        <h1 className="page-title">匯入券商成交明細</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          上傳券商的「客戶交易明細表」PDF（目前支援國泰證券的格式），每一筆成交會記成逐筆交易，手續費與交易稅用明細上的實際金額。
          PDF 只在你的瀏覽器裡打開，伺服器只收到解析好的成交列；客戶代號、帳號與姓名都不會被讀取或上傳。
        </p>
      </div>
      <section className="panel">
        <TradeImporter
          portfolioId={id}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          defaultAccountId={typeof account === "string" ? account : undefined}
        />
      </section>
    </div>
  );
}
