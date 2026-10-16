import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { listPortfolios } from "@/lib/services/portfolios";
import { CreatePortfolioForm } from "./create-portfolio-form";

export const metadata: Metadata = { title: "投資組合" };

export default async function PortfoliosPage() {
  const user = await requireUser();
  const portfolios = await listPortfolios(await getDb(), user.id);

  return (
    <div className="grid grid-cols-1 gap-8">
      <div>
        <p className="kicker">Build — 組合資產</p>
        <h1 className="mt-2 text-[28px] font-black">投資組合</h1>
        <p className="mt-1 text-sm text-ink-2">一個組合可以放多個券商或現金帳戶，例如「台股長期」「美股」「ETF」。</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section className="panel">
          <div className="panel-head">
            <h2>我的投資組合</h2>
            <span className="tag">{portfolios.length} 個</span>
          </div>
          {portfolios.length === 0 ? (
            <div className="p-8 text-center">
              <p className="font-bold">還沒有投資組合</p>
              <p className="mt-1 text-sm text-ink-2">先在右邊建立第一個，再加入帳戶、記第一筆交易。</p>
            </div>
          ) : (
            <ul>
              {portfolios.map((p) => (
                <li key={p.id} className="border-b border-line last:border-b-0">
                  <Link href={`/portfolios/${p.id}`} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-cream">
                    <span>
                      <span className="block font-bold">{p.name}</span>
                      <span className="mt-0.5 block text-xs text-ink-2">
                        基準幣別 <span className="num">{p.baseCurrency}</span> · 逐筆交易 · {p.accountCount} 個帳戶
                      </span>
                    </span>
                    <span aria-hidden="true" className="display text-sm">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>新增投資組合</h2>
          </div>
          <CreatePortfolioForm />
        </section>
      </div>
    </div>
  );
}
