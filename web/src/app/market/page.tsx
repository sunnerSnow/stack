import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { logoutAction } from "@/app/actions";
import { Brand } from "@/components/brand";
import { ModuleNav } from "@/app/(app)/module-nav";
import { logError } from "@/lib/api/http";
import { isLocalMode } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { type GroupLevel, getRotation, getStockScreens } from "@/lib/services/market";
import { getMarketOverview, type MarketOverviewDto } from "@/lib/services/market-overview";
import { BrickCity } from "./brick-city";
import { RotationView } from "./rotation-view";

export const metadata: Metadata = { title: "Explore 積木全景", description: "從大盤、族群到個股，探索台股輪動與法人資金。從產業底板、族群積木塔到成分股的公開積木城市。" };
const LEVELS = new Set<GroupLevel>(["theme", "industry", "sector"]);

export default async function MarketPage({ searchParams }: PageProps<"/market">) {
  const user = await getSessionUser();
  const { level: raw } = await searchParams;
  const level: GroupLevel = typeof raw === "string" && LEVELS.has(raw as GroupLevel) ? raw as GroupLevel : "theme";
  const db = await getDb();
  const results = await Promise.allSettled([getMarketOverview(db, user?.id ?? null), getRotation(db, user?.id ?? null, { level }), getStockScreens(db, user?.id ?? null)] as const);
  for (const result of results) if (result.status === "rejected") logError(result.reason);
  const overview: MarketOverviewDto = results[0].status === "fulfilled" ? results[0].value : { date: null, previousDate: null, stocks: 0, upCount: 0, downCount: 0, unchangedCount: 0, unclassifiedCount: 0, turnover: null, index: null, flow: { foreign: null, trust: null, dealer: null }, groups: [], exchanges: [], replay: [] };
  const rotation = results[1].status === "fulfilled" ? results[1].value : null;
  const screens = results[2].status === "fulfilled" ? results[2].value : null;
  return <>
    <header className="border-b-[3px] border-ink bg-cream">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" aria-label="STACK 首頁"><Brand /></Link><ModuleNav />
        {user ? <form action={logoutAction}><button type="submit" className="btn btn-quiet">登出</button></form> : <Link href="/login" className="btn btn-sun">登入我的組合 ↗</Link>}
      </div>
    </header>
    <main className="mx-auto w-full max-w-[1800px] px-2 pb-8 pt-4 sm:px-4">
      {results[0].status === "rejected" ? <p className="notice mb-3" role="alert">市場資料暫時無法讀取，請稍後重試。</p> : null}
      <BrickCity overview={overview} local={isLocalMode()} />
      <details id="market-reading" className="mt-5 border-b-2 border-ink/20 pb-4 text-xs text-ink-2">
        <summary className="cursor-pointer font-bold">如何閱讀這張全景？</summary>
        <div className="mt-3 grid gap-2 leading-relaxed sm:grid-cols-2">
          <p>每座島是一個產業，上面的積木塔是族群；點積木塔，成交額最大的成分股會拆到島旁的空地，右側卡片列出每檔的法人買賣超；點島或名牌展開整個產業。島的位置、大小只表分類與族群數，沒有價格或強弱座標含義。下方完整數據保留 RS／IS 輪動工具。</p>
          <p>占地代表成交額，層數代表法人淨買賣絕對幅度，按全分類（含整段回放）最大值分成 1–6 級。紅為買超、海綠為賣超，前兩級用淺色；零為奶油白，缺值為灰色虛線，不補成零。右上「法人」可改看外資、投信或自營商。</p>
          <p>使用盤後資料；休市保留最近有效行情。下方回放逐日重建最近幾個交易日的積木（各族群當天的成交額與法人買賣超），背景的粒子連線與成分股拆出的動畫只是裝飾，不代表實際資金移動。個股明細的當日與近 20 日法人期間不同，均有標示。</p>
          <p>市場摘要與各來源資料日：{overview.exchanges.map((e)=>`${e.exchange} ${e.date}`).join(" · ") || "尚未取得資料"}。族群可能包含相同個股，因此族群法人金額不能直接加總為全市場。</p>
        </div>
      </details>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-bold text-ink-2">完整數據與輪動工具</summary>
        <div className="mt-5">{rotation?.date && screens ? <RotationView data={rotation} level={level} screens={screens} signedIn={Boolean(user)} /> : <p className="notice">輪動歷史仍在回補／暖機中。最新收盤摘要已保留於中央。</p>}</div>
      </details>
    </main>
  </>;
}
