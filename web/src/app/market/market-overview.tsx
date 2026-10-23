"use client";

import { useState } from "react";
import { RowBrick } from "@/components/bricks";
import { flowValue } from "@/lib/market/flows";
import type { MarketGroupQuote, MarketOverviewDto } from "@/lib/services/market-overview";
import type { GroupDetailDto } from "@/lib/services/market";

const pct = (n: number | null) => n === null ? "資料不足" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const yi = (n: number | null) => n === null ? "資料不足" : `${(n / 1e8).toFixed(2)} 億`;
const LEVELS = [{ id: "theme", label: "族群" }, { id: "industry", label: "產業" }, { id: "sector", label: "板塊" }] as const;

export function MarketOverview({ data }: { data: MarketOverviewDto }) {
  const [level, setLevel] = useState<MarketGroupQuote["level"]>("theme");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"turnover" | "ret">("turnover");
  const [selection, setSelection] = useState<{ id: string; state: "loading" | "error" | "ready"; detail?: GroupDetailDto } | null>(null);
  const groups = data.groups.filter((g) => g.level === level && g.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity));
  const selected = data.groups.find((g) => g.id === selection?.id);

  async function select(id: string) {
    setSelection({ id, state: "loading" });
    try {
      const response = await fetch(`/api/market/groups/${encodeURIComponent(id)}?date=${data.date}`);
      if (!response.ok) throw new Error("Group request failed");
      const body = await response.json();
      if (!body.data) throw new Error("Missing group data");
      // 舊請求較晚回來時，不覆蓋使用者後來選的族群。
      setSelection((current) => current?.id === id ? { id, state: "ready", detail: body.data } : current);
    } catch {
      setSelection((current) => current?.id === id ? { id, state: "error" } : current);
    }
  }

  return (
    <section aria-labelledby="quote-wall-title" className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kicker">01 — Market blocks</p>
          <h2 id="quote-wall-title" className="mt-2 text-2xl font-black">市場，一塊一塊看。</h2>
          <p className="mt-2 text-sm text-ink-2">積木上的數字是當日等權重漲跌；點一塊，看成分股與法人資料。</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="field"><span className="sr-only">搜尋族群</span><input className="input max-w-48" placeholder="搜尋族群、產業…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <label className="field"><span className="sr-only">積木排序</span><select className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="turnover">成交額優先</option><option value="ret">漲幅優先</option></select></label>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-[3px] border-ink pb-4">
        <div className="seg" role="group" aria-label="行情層級">
          {LEVELS.map((l) => <button key={l.id} type="button" aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>{l.label}</button>)}
        </div>
        <p className="text-xs text-ink-2">紅漲 · 綠跌 · 灰色表示資料不足或平盤 · 未含除權息還原</p>
      </div>
      {data.date === null ? (
        <div className="grid min-h-56 place-content-center gap-3 border-[3px] border-dashed border-ink/30 bg-cream p-8 text-center">
          <p className="text-xl font-black">第一塊行情，還在路上。</p>
          <p className="max-w-lg text-sm leading-relaxed text-ink-2">目前尚未取得交易所收盤行情。資料同步完成後，會顯示最近有效交易日；休市不會清空既有行情。</p>
        </div>
      ) : groups.length === 0 ? (
        <p className="notice">{query ? "沒有符合搜尋的族群，試試其他名稱。" : "這個層級的分類尚未準備好；已有的市場摘要會繼續保留。"}</p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="grid content-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => {
              const color = g.ret === null || g.ret === 0 ? "#B9C7D6" : g.ret > 0 ? "#F79C91" : "#8ED6AF";
              return (
                <button key={g.id} type="button" aria-pressed={selection?.id === g.id} onClick={() => void select(g.id)} className={`group relative min-w-0 border-[3px] border-ink bg-paper p-4 text-left shadow-[4px_4px_0_#173451] transition-transform hover:-translate-y-1 focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-sea ${selection?.id === g.id ? "!bg-sun/20" : ""}`}>
                  <div className="mb-2 h-16 w-36" aria-hidden="true"><RowBrick studs={6} color={color} line="#173451" lineWidth={1.5} /></div>
                  <div className="flex items-baseline justify-between gap-2"><h3 className="truncate text-lg font-black">{g.name}</h3><span aria-hidden="true">↗</span></div>
                  <p className={`num mt-2 text-2xl font-black ${g.ret !== null && g.ret > 0 ? "text-[#b83b35]" : g.ret !== null && g.ret < 0 ? "text-[#18734f]" : "text-ink-2"}`}>{pct(g.ret)}</p>
                  <div className="mt-4 flex justify-between gap-2 border-t-2 border-ink/15 pt-3 text-xs text-ink-2"><span>成交 {yi(g.turnover)}</span><span>{g.quoted}／{g.members} 檔有行情</span></div>
                </button>
              );
            })}
          </div>
          <aside aria-live="polite" className={`navy-block h-fit p-5 lg:sticky lg:top-24 ${selected ? "fixed inset-x-3 bottom-3 z-40 max-h-[65dvh] overflow-y-auto lg:inset-x-auto lg:bottom-auto lg:z-auto lg:max-h-none" : "hidden lg:block"}`}>
            <p className="sh-n">Inside the block</p>
            {selected ? <>
              <button type="button" className="absolute right-4 top-4 text-xs font-bold text-cream underline" onClick={() => setSelection(null)}>關閉明細</button>
              <h3 className="mt-3 text-2xl font-black text-cream">{selected.name}</h3>
              <p className="num mt-2 text-3xl text-sun">{pct(selected.ret)}</p>
              <p className="mt-2 text-xs text-on-navy">資料日 {data.date} · 成交 {yi(selected.turnover)}</p>
              <dl className="mt-5 grid gap-2 border-y border-white/20 py-4 text-sm text-on-navy">
                {(["foreign", "trust", "dealer", "total"] as const).map((key, i) => <div key={key} className="flex justify-between gap-2"><dt>{["外資", "投信", "自營商", "法人合計"][i]}</dt><dd className="num">{yi(flowValue(selected.flow, key))}</dd></div>)}
              </dl>
              <h4 className="mt-5 font-bold text-cream">成分股</h4>
              {selection?.state === "loading" ? <p className="mt-3 text-sm text-on-navy" role="status">讀取中…</p> : selection?.state === "error" ? <p className="mt-3 text-sm text-on-navy" role="alert">暫時無法讀取。<button type="button" className="ml-2 underline" onClick={() => void select(selected.id)}>重試</button></p> : <ul className="mt-3 max-h-80 overflow-auto text-sm text-on-navy">
                {selection?.detail?.members.map((m) => <li key={m.assetId} className="flex justify-between gap-2 border-b border-white/10 py-2"><span><span className="num mr-2 text-xs">{m.symbol}</span>{m.name}</span><span className="num shrink-0">{pct(m.ret)}</span></li>)}
              </ul>}
            </> : <div className="py-10"><h3 className="text-xl font-black text-cream">從一塊開始探索</h3><p className="mt-3 text-sm leading-relaxed text-on-navy">選擇左側的族群，拆開看它的成分股、成交量能與法人買賣超。輪動指標未完成暖機，也能先看收盤行情。</p></div>}
          </aside>
        </div>
      )}
    </section>
  );
}
