import type { Metadata } from "next";
import Link from "next/link";
import { BRICK, MiniBrick } from "@/components/bricks";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { listPortfolios } from "@/lib/services/portfolios";
import { CreatePortfolioForm } from "./create-portfolio-form";

export const metadata: Metadata = { title: "投資組合" };

// 卡片的硬陰影輪流用品牌色（只是裝飾，不代表任何數值）
const SHADOWS = ["shadow-[8px_8px_0_var(--color-sea)]", "shadow-[8px_8px_0_var(--color-sun)]", "shadow-[8px_8px_0_var(--color-ink)]"];
const BRICKS = [BRICK.tw, BRICK.cash, BRICK.us];

export default async function PortfoliosPage() {
  const user = await requireUser();
  const portfolios = await listPortfolios(await getDb(), user.id);

  return (
    <div className="grid grid-cols-1 gap-10">
      <div>
        <p className="kicker">Build — 組合資產</p>
        <h1 className="page-title">投資組合</h1>
        <p className="mt-3 max-w-[40em] text-[15px] leading-relaxed text-ink-2">一個組合可以放多個券商或現金帳戶，例如「台股長期」「美股」「ETF」。一塊一塊放上去，不用一次蓋完。</p>
      </div>

      <div className="grid grid-cols-1 gap-7 md:grid-cols-2 lg:grid-cols-3">
        {portfolios.map((p, i) => (
          <Link
            key={p.id}
            href={`/portfolios/${p.id}`}
            className={`group flex min-h-[220px] flex-col border-[3px] border-ink bg-paper p-6 transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 ${SHADOWS[i % 3]}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="sh-n">
                {String(i + 1).padStart(2, "0")} — {p.baseCurrency}
              </span>
              <span aria-hidden="true" className="font-display text-lg font-black transition-transform group-hover:translate-x-1">
                →
              </span>
            </div>
            <h2 className="mt-4 text-[24px] font-black leading-tight">{p.name}</h2>
            <p className="mt-1.5 flex-1 text-sm text-ink-2">
              基準幣別 <span className="num">{p.baseCurrency}</span> · {p.accountCount} 個帳戶
            </p>
            <MiniBrick color={BRICKS[i % 3]} className="mt-4 h-11 w-16" />
          </Link>
        ))}

        {/* 「下一塊」：新增投資組合 */}
        <section className="border-[3px] border-dashed border-ink bg-paper/60 p-6">
          <p className="sh-n">{portfolios.length === 0 ? "01 — 第一塊" : "＋ — 下一塊"}</p>
          <h2 className="mb-4 mt-4 text-[24px] font-black leading-tight">新增投資組合</h2>
          <CreatePortfolioForm />
        </section>
      </div>
    </div>
  );
}
