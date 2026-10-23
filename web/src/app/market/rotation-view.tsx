"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { flowValue as flowOf } from "@/lib/market/flows";
import { QUADRANT_LABEL, type Quadrant } from "@/lib/market/rotation";
import type { GroupDetailDto, GroupLevel, RotationDto, RotationNode, StockScreensDto } from "@/lib/services/market";
import { BrickWall, WALL_METRICS, type WallMetric } from "./brick-wall";
import { type ChartNode, DOWN, FLAT, QuadrantChart, UP } from "./quadrant-chart";

const LEVELS: { id: GroupLevel; label: string }[] = [
  { id: "theme", label: "族群" },
  { id: "industry", label: "產業" },
  { id: "sector", label: "板塊" },
];
const PERIODS = [1, 5, 20, 60] as const;
type Period = (typeof PERIODS)[number];
type FlowKind = "total" | "foreign" | "trust" | "dealer";
const FLOW_LABEL: Record<FlowKind, string> = { total: "合計", foreign: "外資", trust: "投信", dealer: "自營商" };
type Tool = "strong" | "turning" | "flow" | "volume" | "change";

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
const pct = (n: number | null, d = 2) => (n === null ? "—" : `${sign(n)}${Math.abs(n * 100).toFixed(d)}%`);
const yi = (n: number | null) => n === null ? "資料不足" : `${sign(Math.round(n / 1e7) / 10)}${Math.abs(n / 1e8).toFixed(1)} 億`;
const fix = (n: number | null, d = 1) => (n === null ? "—" : n.toFixed(d));

function QuadrantTag({ q }: { q: Quadrant | null }) {
  if (!q) return <span className="text-on-navy-2">暖機中</span>;
  const tone = { leading: "bg-sea text-cream border-sea", weakening: "bg-sun text-ink border-sun", lagging: "border-on-navy-2 text-on-navy", improving: "border-sea-lt text-sea-lt" }[q];
  return <span className={`tag ${tone}`}>{QUADRANT_LABEL[q].slice(0, 2)}</span>;
}

/** 漲跌：顏色＋正負號（深色底） */
function Change({ v, d = 2 }: { v: number | null; d?: number }) {
  if (v === null) return <span className="text-on-navy-2">—</span>;
  const color = Math.abs(v) < 0.0005 ? FLAT : v > 0 ? UP : DOWN;
  return (
    <span className="num" style={{ color: v < 0 && Math.abs(v) >= 0.0005 ? "#5cc99a" : color }}>
      {pct(v, d)}
    </span>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function RotationView({ data, level, screens, signedIn = true }: { data: RotationDto; level: GroupLevel; screens: StockScreensDto; signedIn?: boolean }) {
  // 主畫面是積木牆；象限圖是第二個分頁
  const [view, setView] = useState<"wall" | "quadrant">("wall");
  const [metric, setMetric] = useState<WallMetric>("ret");
  const [mode, setMode] = useState<"rs" | "is">("rs");
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<Tool>("strong");
  const [period, setPeriod] = useState<Period>(5);
  const [flowKind, setFlowKind] = useState<FlowKind>("total");
  const [sortKey, setSortKey] = useState<"strength" | "momentum" | "ret" | "turnover" | "flow">("strength");
  // 回放：最近 10 個交易日，一天一格
  const replayDates = useMemo(() => [...new Set(data.nodes.flatMap((n) => n.trail.map((t) => t.date)))].sort(), [data.nodes]);
  const [frame, setFrame] = useState<number | null>(null);
  const playing = frame !== null;
  useEffect(() => {
    if (frame === null) return;
    const last = frame >= replayDates.length - 1;
    const id = setTimeout(() => setFrame(last ? null : frame + 1), last ? 1400 : 900);
    return () => clearTimeout(id);
  }, [frame, replayDates.length]);

  const nodesById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);
  const selectedGroup = selectedId && !selectedId.startsWith("m:") ? nodesById.get(selectedId) ?? null : null;

  useEffect(() => {
    if (!selectedGroup) return;
    let cancelled = false;
    // 換族群時先清掉舊的成員，等新的到了再畫
    queueMicrotask(() => !cancelled && setLoading(true));
    fetch(`/api/market/groups/${encodeURIComponent(selectedGroup.id)}?date=${data.date}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setDetail(j.data ?? null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedGroup, data.date]);
  const shownDetail = detail && selectedGroup && detail.id === selectedGroup.id ? detail : null;

  const coords = (n: { strength: number | null; momentum: number | null; prevStrength: number | null; ret: number | null }) =>
    mode === "rs" ? (n.strength !== null && n.momentum !== null ? { x: n.strength, y: n.momentum } : null) : n.prevStrength !== null && n.ret !== null ? { x: n.prevStrength, y: n.ret } : null;

  const chartNodes: ChartNode[] = useMemo(() => {
    const groups: ChartNode[] = data.nodes.flatMap((n) => {
      const c = coords(n);
      if (!c || (onlyHeld && !n.held)) return [];
      return [
        {
          id: n.id,
          label: n.name,
          ...c,
          size: n.turnover5Avg,
          ret: n.ret,
          held: n.held,
          trail: mode === "rs" ? n.trail.map((t) => ({ date: t.date, x: t.strength, y: t.momentum, ret: t.ret })) : undefined,
          kind: "group" as const,
        },
      ];
    });
    const members: ChartNode[] = (shownDetail?.members ?? []).flatMap((m) => {
      const c = coords(m);
      return c
        ? [
            {
              id: `m:${m.assetId}`,
              label: m.name,
              ...c,
              size: m.turnover ?? 0,
              ret: m.ret,
              held: m.held,
              trail: mode === "rs" ? m.trail.map((t) => ({ date: t.date, x: t.strength, y: t.momentum, ret: t.ret })) : undefined,
              kind: "member" as const,
            },
          ]
        : [];
    });
    return [...groups, ...members];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nodes, shownDetail, mode, onlyHeld]);

  const focusIds = shownDetail ? new Set([shownDetail.id, ...shownDetail.members.map((m) => `m:${m.assetId}`)]) : null;

  const describe = (c: ChartNode) => {
    if (c.kind === "member") {
      const m = shownDetail?.members.find((x) => `m:${x.assetId}` === c.id);
      if (!m) return [];
      return [`${m.symbol} · ${m.quadrant ? QUADRANT_LABEL[m.quadrant] : "暖機中"}`, `強度 ${fix(m.strength, 2)} · 動能 ${fix(m.momentum, 2)}`, `今天 ${pct(m.ret)}`];
    }
    const n = nodesById.get(c.id)!;
    return [
      n.quadrant ? QUADRANT_LABEL[n.quadrant] : "暖機中",
      `強度 ${fix(n.strength, 2)} · 動能 ${fix(n.momentum, 2)}`,
      `今天 ${pct(n.ret)} · 5 日 ${pct(n.ret5)}`,
      `成交 5 日均 ${(n.turnover5Avg / 1e8).toFixed(0)} 億 · 強勢 ${n.strongCount}／${n.members}`,
      ...(n.held ? ["含我的持股"] : []),
    ];
  };

  // 工具：續強（連 4 天領先）、轉強（5 天前不在領先、今天在）
  const leadDays = (n: RotationNode, k: number) => {
    const t = n.trail.slice(-k);
    return t.length === k && t.every((p) => p.strength >= 100 && p.momentum >= 100);
  };
  const strongGroups = data.nodes.filter((n) => leadDays(n, 4)).sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
  const turningGroups = data.nodes
    .filter((n) => n.quadrant === "leading" && n.trail.length >= 6 && !(n.trail.at(-6)!.strength >= 100 && n.trail.at(-6)!.momentum >= 100))
    .sort((a, b) => (b.momentum ?? 0) - (a.momentum ?? 0));
  const flowRank = data.nodes.filter((n) => flowOf(n.flows[period], flowKind) !== null).sort((a, b) => flowOf(b.flows[period], flowKind)! - flowOf(a.flows[period], flowKind)!);
  const volumeRank = [...data.nodes].sort((a, b) => b.turnover / Math.max(1, b.turnover5Avg) - a.turnover / Math.max(1, a.turnover5Avg));
  const changeOf = (n: RotationNode) => (period === 1 ? n.ret : period === 5 ? n.ret5 : n.ret20);
  const changeRank = [...data.nodes].sort((a, b) => (changeOf(b) ?? -9) - (changeOf(a) ?? -9));

  const table = [...data.nodes].sort((a, b) => {
    const v = (n: RotationNode) =>
      sortKey === "strength" ? n.strength ?? -1 : sortKey === "momentum" ? n.momentum ?? -1 : sortKey === "ret" ? n.ret ?? -9 : sortKey === "turnover" ? n.turnover5Avg : flowOf(n.flows[5], "total") ?? -Infinity;
    return v(b) - v(a);
  });

  const pick = (id: string) => {
    setSelectedId(id);
    document.getElementById("rotation-chart")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const GroupButton = ({ n }: { n: RotationNode }) => (
    <button type="button" onClick={() => pick(n.id)} className="text-left font-bold hover:underline">
      {n.held ? <span className="mr-1 text-sun" title="含我的持股">★</span> : null}
      {n.name}
    </button>
  );

  return (
    <div className="grid gap-8">
      {/* 控制列 */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-bold">檢視</span>
          <Seg
            label="檢視"
            value={view}
            onChange={(v) => {
              setFrame(null);
              setView(v);
            }}
            options={[
              { id: "wall", label: "積木牆" },
              { id: "quadrant", label: "輪動象限" },
            ]}
          />
        </div>
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-bold">層級</span>
          <div className="seg" role="group" aria-label="層級">
            {LEVELS.map((l) => (
              <Link key={l.id} href={`/market?level=${l.id}`} aria-current={l.id === level ? "page" : undefined} className={`px-2.5 py-[5px] font-mono text-xs ${l.id === level ? "bg-ink text-cream" : "hover:bg-cream"} border-l-2 border-ink first:border-l-0`}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        {signedIn ? <label className="flex items-center gap-2 pb-1 text-sm font-bold">
          <input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} />
          只看含我持股的{LEVELS.find((l) => l.id === level)!.label}
        </label> : <Link href="/login" className="pb-1 text-sm font-bold underline">登入後標記我的持股 ↗</Link>}
      </div>

      {/* 積木牆（或象限圖）＋右側明細 */}
      <section id="rotation-chart" className="navy-block grid gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-on-navy">
            <span>
              <span className="sh-n">01 — {view === "wall" ? "Wall" : "Rotation"}</span> ·{" "}
              {view === "wall" ? "積木寬度＝成交金額 · 紅＝漲（越深越多）、虛線綠＝跌 · 黃框＝含我的持股" : "積木越大成交金額越大 · 實心紅積木＝上漲、虛線綠積木＝下跌 · 黃框＝含我的持股"}
            </span>
            <span className="flex flex-wrap items-center gap-3">
              {view === "wall" ? (
                <label className="flex items-center gap-2">
                  <span className="font-bold text-cream">顏色</span>
                  <select
                    className="border-2 border-cream bg-ink px-2 py-1 text-xs font-bold text-cream"
                    value={metric}
                    onChange={(e) => {
                      setFrame(null);
                      setMetric(e.target.value as WallMetric);
                    }}
                  >
                    {WALL_METRICS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <Seg
                  label="模式"
                  value={mode}
                  onChange={(m) => {
                    setFrame(null);
                    setMode(m);
                  }}
                  options={[
                    { id: "rs", label: "RS 強度×動能" },
                    { id: "is", label: "IS 強度×今日漲跌" },
                  ]}
                />
              )}
              {(view === "wall" || mode === "rs") && replayDates.length > 1 ? (
                <button
                  type="button"
                  className="border-2 border-cream px-2.5 py-1 font-bold text-cream hover:bg-cream hover:text-ink"
                  onClick={() => {
                    // 積木牆的回放是每天的漲跌重新上色
                    if (view === "wall") setMetric("ret");
                    setFrame(playing ? null : 0);
                  }}
                  aria-pressed={playing}
                >
                  {playing ? `■ 停止（${replayDates[frame!]}）` : `▶ 回放 ${replayDates.length} 日`}
                </button>
              ) : null}
              {selectedId ? (
                <button type="button" className="font-bold text-cream hover:underline" onClick={() => setSelectedId(null)}>
                  {view === "wall" ? "取消選取" : "回到全貌"}
                </button>
              ) : null}
            </span>
          </div>
          {view === "wall" ? (
            <BrickWall data={data} metric={metric} selectedId={selectedId} onSelect={setSelectedId} frameDate={playing ? replayDates[frame!] : null} onlyHeld={onlyHeld} />
          ) : (
            <QuadrantChart
              nodes={chartNodes}
              mode={mode}
              baseline={data.market?.ret ?? null}
              selectedId={selectedId}
              focusIds={focusIds}
              frameDate={playing && mode === "rs" ? replayDates[frame!] : null}
              onSelect={(id) => setSelectedId(id && id.startsWith("m:") ? selectedId : id)}
              describe={describe}
            />
          )}
          {playing ? (
            <p className="mt-3 text-center font-display text-sm font-bold tracking-[0.12em] text-sun" aria-live="polite">
              {replayDates[frame!]}（{frame! + 1}／{replayDates.length}）
            </p>
          ) : null}
        </div>

        <aside className="min-w-0 text-sm" aria-live="polite">
          {selectedGroup ? (
            <div className="grid gap-4">
              <div>
                <p className="sh-n">02 — {LEVELS.find((l) => l.id === level)!.label}</p>
                <h2 className="mt-1 text-[22px] font-black">{selectedGroup.name}</h2>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-on-navy">
                  <QuadrantTag q={selectedGroup.quadrant} /> 強度 {fix(selectedGroup.strength, 2)} · 動能 {fix(selectedGroup.momentum, 2)}
                </p>
                <p className="mt-1 text-xs text-on-navy">
                  今天 <Change v={selectedGroup.ret} /> · 5 日 <Change v={selectedGroup.ret5} /> · 20 日 <Change v={selectedGroup.ret20} />
                </p>
              </div>
              <div className="mod-card c">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-bold text-on-navy">三大法人買賣超</p>
                  <Seg label="期間" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ id: p, label: `${p}日` }))} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {(["total", "foreign", "trust", "dealer"] as FlowKind[]).map((k) => (
                    <div key={k} className="flex justify-between gap-2">
                      <dt className="text-on-navy">{FLOW_LABEL[k]}</dt>
                      <dd className="num">{yi(flowOf(selectedGroup.flows[period], k))}</dd>
                    </div>
                  ))}
                </dl>
                {shownDetail ? <FlowBars series={shownDetail.flowSeries.slice(-Math.max(period, 20))} /> : null}
              </div>
              <div>
                <p className="mb-2 text-xs text-on-navy">
                  成員 · 強勢 {selectedGroup.strongCount}／{selectedGroup.members} 檔
                  {shownDetail && shownDetail.warmingUp > 0 ? ` · ${shownDetail.warmingUp} 檔上市不久或資料中斷，還沒有座標` : ""}
                </p>
                {loading && !shownDetail ? <p className="text-on-navy-2">載入中…</p> : null}
                {shownDetail ? (
                  <div className="max-h-[300px] overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="text-on-navy-2">
                        <tr>
                          <th className="py-1 text-left font-normal">股票</th>
                          <th className="py-1 text-right font-normal">強度</th>
                          <th className="py-1 text-right font-normal">動能</th>
                          <th className="py-1 text-right font-normal">今天</th>
                          <th className="py-1 text-right font-normal">法人 20 日</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownDetail.members.map((m) => (
                          <tr key={m.assetId} className="border-t border-white/10">
                            <td className="py-1">
                              {m.held ? <span className="mr-0.5 text-sun">★</span> : null}
                              <span className="num">{m.symbol}</span> {m.name}
                            </td>
                            <td className="num py-1 text-right">{fix(m.strength)}</td>
                            <td className="num py-1 text-right">{fix(m.momentum)}</td>
                            <td className="py-1 text-right">
                              <Change v={m.ret} d={1} />
                            </td>
                            <td className="num py-1 text-right">{yi(flowOf(m.flows20, "total"))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="grid gap-4">
              <div>
                <p className="sh-n">02 — Market</p>
                <h2 className="mt-1 text-[22px] font-black">全市場</h2>
                {data.market ? (
                  <p className="mt-1 text-xs text-on-navy">
                    上漲 {data.market.upCount}／{data.market.members} 檔 · 平均 <Change v={data.market.ret} />
                  </p>
                ) : null}
              </div>
              {(["leading", "improving", "weakening", "lagging"] as Quadrant[]).map((q) => {
                const list = data.nodes.filter((n) => n.quadrant === q).sort((a, b) => b.turnover5Avg - a.turnover5Avg);
                return (
                  <div key={q}>
                    <p className="flex items-center gap-2 text-xs text-on-navy">
                      <QuadrantTag q={q} /> {list.length} 個
                    </p>
                    <p className="mt-1 leading-relaxed">
                      {list.slice(0, 8).map((n, i) => (
                        <span key={n.id}>
                          {i > 0 ? "、" : ""}
                          <button type="button" className="hover:underline" onClick={() => setSelectedId(n.id)}>
                            {n.held ? "★" : ""}
                            {n.name}
                          </button>
                        </span>
                      ))}
                      {list.length > 8 ? ` 等 ${list.length} 個` : ""}
                    </p>
                  </div>
                );
              })}
              <p className="text-xs leading-relaxed text-on-navy-2">點圖上的點看成員與法人；完整數字在下面的表格。</p>
            </div>
          )}
        </aside>
      </section>

      {/* 工具 */}
      <section className="panel min-w-0">
        <div className="panel-head flex-wrap">
          <div>
            <p className="sh-n">03 — Tools</p>
            <h2>篩選工具</h2>
          </div>
          <Seg
            label="工具"
            value={tool}
            onChange={setTool}
            options={[
              { id: "strong", label: "續強" },
              { id: "turning", label: "轉強" },
              { id: "flow", label: "法人" },
              { id: "volume", label: "成交" },
              { id: "change", label: "漲跌" },
            ]}
          />
        </div>
        <div className="p-5">
          {tool === "strong" || tool === "turning" ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <p className="text-sm font-bold">{tool === "strong" ? "續強" : "轉強"}{LEVELS.find((l) => l.id === level)!.label}</p>
                <p className="mt-0.5 text-xs text-ink-3">{tool === "strong" ? "連續 4 個交易日都在領先象限，依強度排序" : "5 個交易日前不在領先象限、今天在，依動能排序"}</p>
                <RankList items={(tool === "strong" ? strongGroups : turningGroups).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: `強度 ${fix(n.strength, 2)} · 動能 ${fix(n.momentum, 2)}` }))} />
              </div>
              <div>
                <p className="text-sm font-bold">{tool === "strong" ? "續強" : "轉強"}個股</p>
                <p className="mt-0.5 text-xs text-ink-3">成交金額 5 日平均 {screens.minTurnover / 1e8} 億以上；★ 是我的持股</p>
                <RankList
                  items={(tool === "strong" ? screens.continuing : screens.turning).map((s) => ({
                    key: s.symbol,
                    label: (
                      <span>
                        {s.held ? <span className="mr-0.5 text-sea-dk">★</span> : null}
                        <span className="num font-bold">{s.symbol}</span> {s.name}
                        {s.themes.length ? <span className="ml-1 text-xs text-ink-3">{s.themes.join("、")}</span> : null}
                      </span>
                    ),
                    value: `強度 ${s.strength.toFixed(2)} · 動能 ${s.momentum.toFixed(2)}`,
                  }))}
                />
              </div>
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Seg label="期間" value={period} onChange={setPeriod} options={(tool === "change" ? ([1, 5, 20] as Period[]) : PERIODS).map((p) => ({ id: p, label: `${p} 日` }))} />
                {tool === "flow" ? <Seg label="法人" value={flowKind} onChange={setFlowKind} options={(Object.keys(FLOW_LABEL) as FlowKind[]).map((k) => ({ id: k, label: FLOW_LABEL[k] }))} /> : null}
                <span className="text-xs text-ink-3">
                  {tool === "flow" ? "買賣超金額＝每天的買賣超股數 × 當天收盤價，加總；資料不足者不參與排名" : tool === "volume" ? "今天成交金額 ÷ 近 5 日平均，越大代表量越增" : "等權重報酬（除權息已還原）"}
                </span>
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                {tool === "flow" ? (
                  <>
                    <RankList title="流入" items={flowRank.slice(0, 15).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: yi(flowOf(n.flows[period], flowKind)) }))} />
                    <RankList title="流出" items={[...flowRank].reverse().slice(0, 15).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: yi(flowOf(n.flows[period], flowKind)) }))} />
                  </>
                ) : tool === "volume" ? (
                  <>
                    <RankList title="量增" items={volumeRank.slice(0, 15).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: `${(n.turnover / Math.max(1, n.turnover5Avg)).toFixed(2)} 倍 · ${(n.turnover / 1e8).toFixed(0)} 億` }))} />
                    <RankList title="成交金額" items={[...data.nodes].sort((a, b) => b.turnover - a.turnover).slice(0, 15).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: `${(n.turnover / 1e8).toFixed(0)} 億` }))} />
                  </>
                ) : (
                  <>
                    <RankList title="漲幅" items={changeRank.slice(0, 15).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: pct(changeOf(n)) }))} />
                    <RankList title="跌幅" items={[...changeRank].reverse().filter((n) => changeOf(n) !== null).slice(0, 15).map((n) => ({ key: n.id, label: <GroupButton n={n} />, value: pct(changeOf(n)) }))} />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 完整表格（圖表的文字版） */}
      <section className="panel min-w-0">
        <div className="panel-head">
          <div>
            <p className="sh-n">04 — List</p>
            <h2>{LEVELS.find((l) => l.id === level)!.label}清單</h2>
          </div>
          <span className="tag">{data.nodes.length} 個</span>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>名稱</th>
                <th>象限</th>
                {(
                  [
                    ["strength", "強度"],
                    ["momentum", "動能"],
                    ["ret", "今天"],
                    ["turnover", "成交 5 日均"],
                    ["flow", "法人 5 日"],
                  ] as const
                ).map(([k, label]) => (
                  <th key={k} className="r">
                    <button type="button" className={`hover:underline ${sortKey === k ? "text-ink" : ""}`} onClick={() => setSortKey(k)} aria-pressed={sortKey === k}>
                      {label}
                      {sortKey === k ? " ▼" : ""}
                    </button>
                  </th>
                ))}
                <th className="r">5 日</th>
                <th className="r">強勢股</th>
              </tr>
            </thead>
            <tbody>
              {table.map((n) => (
                <tr key={n.id}>
                  <td className="whitespace-nowrap">
                    <GroupButton n={n} />
                  </td>
                  <td className="whitespace-nowrap">{n.quadrant ? <span className="tag">{QUADRANT_LABEL[n.quadrant].slice(0, 2)}</span> : <span className="text-ink-3">暖機中</span>}</td>
                  <td className="r num">{fix(n.strength, 2)}</td>
                  <td className="r num">{fix(n.momentum, 2)}</td>
                  <td className="r num">{pct(n.ret)}</td>
                  <td className="r num whitespace-nowrap">{(n.turnover5Avg / 1e8).toFixed(0)} 億</td>
                  <td className="r num whitespace-nowrap">{yi(flowOf(n.flows[5], "total"))}</td>
                  <td className="r num">{pct(n.ret5)}</td>
                  <td className="r num whitespace-nowrap">
                    {n.strongCount}／{n.members}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RankList({ items, title }: { items: { key: string; label: React.ReactNode; value: string }[]; title?: string }) {
  return (
    <div>
      {title ? <p className="mb-1 text-sm font-bold">{title}</p> : null}
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-ink-3">今天沒有符合的</p>
      ) : (
        <ol className="mt-2 grid gap-1 text-sm">
          {items.map((it, i) => (
            <li key={it.key} className="flex items-baseline justify-between gap-3 border-b border-line pb-1">
              <span className="flex items-baseline gap-2">
                <span className="num w-5 text-right text-xs text-ink-3">{i + 1}</span>
                {it.label}
              </span>
              <span className="num whitespace-nowrap text-xs">{it.value}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 族群每天的法人買賣超（合計），正的往上、負的往下 */
function FlowBars({ series }: { series: GroupDetailDto["flowSeries"] }) {
  if (series.length === 0) return null;
  const totals = series.map((s) => flowOf(s, "total"));
  const max = Math.max(1, ...totals.map((t) => t === null ? 0 : Math.abs(t)));
  const w = 300;
  const h = 64;
  const bw = Math.max(2, w / totals.length - 2);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-16 w-full" role="img" aria-label={`近 ${series.length} 日法人買賣超`}>
      <title>法人買賣超；資料不足的日期留空</title>
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} stroke="rgba(245,240,229,0.3)" />
      {totals.map((t, i) => {
        if (t === null) return null;
        const bh = (Math.abs(t) / max) * (h / 2 - 2);
        return <rect key={series[i].date} x={i * (w / totals.length) + 1} y={t >= 0 ? h / 2 - bh : h / 2} width={bw} height={Math.max(1, bh)} fill={t >= 0 ? UP : "#5cc99a"} rx={1} />;
      })}
    </svg>
  );
}
