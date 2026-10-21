import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { TdccImporter } from "./tdcc-importer";

export const metadata: Metadata = { title: "匯入集保 e 存摺" };

export default async function TdccImportPage({ params, searchParams }: PageProps<"/portfolios/[id]/imports/tdcc">) {
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
  // 集保只有台股：只能匯入台幣的快照模式帳戶
  const accounts = (await listAccounts(db, user.id, id)).filter((a) => a.trackingMode === "snapshot" && a.currency === "TWD");

  return (
    <div className="mx-auto grid max-w-[860px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name}
          </Link>
        </p>
        <h1 className="mt-2 text-[28px] font-black">匯入集保 e 存摺</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          上傳 e 存摺匯出的「證券存摺登摺資料」PDF，系統依異動明細推算目前每一檔的股數，你確認（或補上缺的）之後存成庫存快照。
          PDF 與密碼只在你的瀏覽器裡打開，伺服器只收到解析好的異動列；戶名、帳號、身分證字號都不會被讀取或上傳。
        </p>
      </div>
      <section className="panel">
        <TdccImporter
          portfolioId={id}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          defaultAccountId={typeof account === "string" ? account : undefined}
        />
      </section>
    </div>
  );
}
