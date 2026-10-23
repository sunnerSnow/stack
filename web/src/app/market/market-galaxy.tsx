"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useRouter } from "next/navigation";
import { HomeBrick } from "@/components/bricks";
import { flowValue } from "@/lib/market/flows";
import { layoutGalaxy, type GalaxyLayoutNode } from "@/lib/market/galaxy-layout";
import { createDefaultViewport, panBy, zoomAt } from "@/lib/market/viewport";
import type { GroupDetailDto, GroupLevel, RotationDto } from "@/lib/services/market";
import type { MarketOverviewDto } from "@/lib/services/market-overview";

type Layer = "flow" | "ret" | "turnover";
type FlowKind = "total" | "foreign" | "trust" | "dealer";
type SceneNode = GalaxyLayoutNode & { name: string; ret: number | null; flow: number | null; held: boolean };
const UP = "#ff8d9f", DOWN = "#66d8ba", UNKNOWN = "#899eaf", GOLD = "#f5d548";
const pct = (n: number | null) => n === null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const yi = (n: number | null) => n === null ? "資料不足" : `${n > 0 ? "+" : ""}${(n / 1e8).toFixed(1)} 億`;

export function MarketGalaxy({ overview, rotation, level, signedIn }: { overview: MarketOverviewDto; rotation: RotationDto | null; level: GroupLevel; signedIn: boolean }) {
  const router = useRouter();
  const stage = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const pressedNode = useRef<string | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 760 });
  const [measured, setMeasured] = useState(false);
  const [viewport, setViewport] = useState(createDefaultViewport);
  const [mode, setMode] = useState<"rs" | "is">("rs");
  const [layer, setLayer] = useState<Layer>("flow");
  const [flowKind, setFlowKind] = useState<FlowKind>("total");
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ level: GroupLevel; id: string | null }>({ level, id: null });
  const selectedId = selection.level === level ? selection.id : null;
  const setSelectedId = (id: string | null) => setSelection({ level, id });
  const [stockId, setStockId] = useState<string | null>(null);
  const [response, setResponse] = useState<{ key: string; data?: GroupDetailDto; error?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [animated, setAnimated] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [frame, setFrame] = useState<number | null>(null);
  const [replayPaused, setReplayPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [full, setFull] = useState(false);
  const selectionKey = `${selectedId}:${overview.date}:${attempt}`;
  const detail = response?.key === selectionKey ? response.data : undefined;
  const detailError = response?.key === selectionKey && response.error;
  const selected = overview.groups.find((g) => g.id === selectedId);
  const playing = frame !== null;
  const motion = animated && !reduced;

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => { setSize({ width: Math.max(720, Math.round(entry.contentRect.width)), height: Math.max(560, Math.round(entry.contentRect.height)) }); setMeasured(true); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!selectedId || !overview.date) return;
    const controller = new AbortController();
    fetch(`/api/market/groups/${encodeURIComponent(selectedId)}?date=${overview.date}`, { signal: controller.signal })
      .then(async (res) => { if (!res.ok) throw new Error("Group fetch failed"); const body = await res.json(); if (!body.data) throw new Error("Missing group"); return body.data as GroupDetailDto; })
      .then((data) => { if (!controller.signal.aborted) setResponse({ key: selectionKey, data }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key: selectionKey, error: true }); });
    return () => controller.abort();
  }, [selectedId, overview.date, selectionKey]);

  const groups = useMemo(() => overview.groups.filter((g) => g.level === level), [overview.groups, level]);
  const rotationById = useMemo(() => new Map(rotation?.nodes.map((n) => [n.id, n]) ?? []), [rotation]);
  const dates = useMemo(() => [...new Set(rotation?.nodes.flatMap((n) => n.trail.map((t) => t.date)) ?? [])].sort(), [rotation]);
  const frameDate = frame === null ? null : dates[frame] ?? null;
  useEffect(() => {
    if (frame === null || replayPaused) return;
    const timer = setTimeout(() => setFrame(frame >= dates.length - 1 ? null : frame + 1), 1100 / speed);
    return () => clearTimeout(timer);
  }, [frame, dates.length, speed, replayPaused]);

  const sceneNodes = useMemo<SceneNode[]>(() => {
    const nodes: SceneNode[] = groups.flatMap((g) => {
      const r = rotationById.get(g.id);
      if (!r) return [];
      const historic = frameDate ? r.trail.find((t) => t.date === frameDate) : null;
      if (frameDate && !historic) return [];
      const x = mode === "rs" ? historic?.strength ?? r.strength : r.prevStrength;
      const y = mode === "rs" ? historic?.momentum ?? r.momentum : r.ret;
      if (x === null || y === null) return [];
      return [{ id: g.id, name: g.name, x, y, size: g.turnover ?? 0, ret: historic ? historic.ret : r.ret, flow: flowValue(g.flow, flowKind), kind: "group" as const, held: r.held }];
    });
    if (detail && detail.date === rotation?.date && !frameDate) for (const m of detail.members) {
      const x = mode === "rs" ? m.strength : m.prevStrength;
      const y = mode === "rs" ? m.momentum : m.ret;
      if (x !== null && y !== null) nodes.push({ id: `stock:${m.assetId}`, name: `${m.symbol} ${m.name}`, x, y, size: m.turnover ?? 0, ret: m.ret, flow: null, held: m.held, kind: "member" });
    }
    return nodes;
  }, [groups, rotationById, mode, frameDate, detail, rotation?.date, flowKind]);
  const layout = useMemo(() => layoutGalaxy(sceneNodes, size.width, size.height, mode), [sceneNodes, size, mode]);
  const nodesById = new Map(sceneNodes.map((n) => [n.id, n]));
  const pointsById = new Map(layout.points.map((p) => [p.id, p]));
  const maxTurnover = Math.max(1, ...sceneNodes.filter((n) => n.kind === "group").map((n) => n.size));
  const labelIds = useMemo(() => {
    const byId = new Map(sceneNodes.map((n) => [n.id, n]));
    const boxes: { x: number; y: number; w: number }[] = [];
    const ids = new Set<string>();
    const ordered = [...layout.points].sort((a, b) => {
      const priority = (id: string) => id === selectedId || id === `stock:${stockId}` || (query.length > 0 && byId.get(id)!.name.includes(query)) ? 1 : 0;
      return priority(b.id) - priority(a.id) || byId.get(b.id)!.size - byId.get(a.id)!.size;
    });
    for (const p of ordered) {
      const n = byId.get(p.id)!;
      const box = { x: p.x - n.name.length * 6, y: p.y + p.radius * .8 + 13, w: n.name.length * 12 };
      const forced = n.id === selectedId || n.id === `stock:${stockId}`;
      if (!forced && boxes.some((b) => box.x < b.x + b.w + 6 && box.x + box.w + 6 > b.x && Math.abs(box.y - b.y) < 18)) continue;
      boxes.push(box); ids.add(n.id);
    }
    return ids;
  }, [layout, sceneNodes, selectedId, stockId, query]);
  const ranked = [...groups].sort((a, b) => (flowValue(b.flow, flowKind) ?? -Infinity) - (flowValue(a.flow, flowKind) ?? -Infinity));
  const unknown = groups.length - sceneNodes.filter((n) => n.kind === "group").length;

  function localPoint(clientX: number, clientY: number) {
    const el = svg.current;
    const matrix = el?.getScreenCTM();
    if (!el || !matrix) return { x: 0, y: 0 };
    const point = el.createSVGPoint(); point.x = clientX; point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const p = localPoint(event.clientX, event.clientY);
      setViewport((v) => zoomAt(v, p, v.scale * Math.exp(-event.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const old = pointers.current.get(event.pointerId);
    if (!old) return;
    const point = localPoint(event.clientX, event.clientY);
    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(old.x - other.x, old.y - other.y), after = Math.hypot(point.x - other.x, point.y - other.y);
      if (before > 0) setViewport((v) => zoomAt(v, { x: (point.x + other.x) / 2, y: (point.y + other.y) / 2 }, v.scale * after / before));
    } else setViewport((v) => panBy(v, point.x - old.x, point.y - old.y));
    if (Math.hypot(point.x - old.x, point.y - old.y) > 1) moved.current = true;
    pointers.current.set(event.pointerId, point);
  }
  function pick(id: string) {
    if (id.startsWith("stock:")) { setStockId(id.slice(6)); return; }
    setSelectedId(id === selectedId ? null : id); setStockId(null);
  }
  function reset() { setViewport(createDefaultViewport()); setSelectedId(null); setStockId(null); }
  const centralFlow = flowValue(overview.flow, flowKind);

  return <section className={`galaxy-shell ${full ? "galaxy-full" : ""} ${motion ? "galaxy-motion" : ""}`} aria-label="全市場積木全景" onKeyDown={(e)=>{if(e.key==="Escape"){setFull(false);setSelectedId(null);setListOpen(false);setFrame(null);}}}>
    <div className="galaxy-topbar">
      <div className="galaxy-seg" role="group" aria-label="全景層級">{([['sector','板塊'],['industry','產業'],['theme','族群']] as const).map(([id,label]) => <Link key={id} href={`/market?level=${id}`} aria-current={level === id ? "page" : undefined}>{label}</Link>)}</div>
      <div className="galaxy-seg" role="group" aria-label="全景模式">{(["rs","is"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setFrame(null); reset(); }}>{m.toUpperCase()}</button>)}</div>
      <button type="button" className="galaxy-control" disabled={dates.length < 2 || mode !== "rs"} aria-pressed={playing} onClick={() => {setReplayPaused(false);setFrame(playing ? null : 0);}}>↶ 回放</button>
      <button type="button" className="galaxy-control" aria-pressed={motion} onClick={() => setAnimated(!animated)}>{motion ? "Ⅱ 動畫" : "▷ 動畫"}</button>
      <button type="button" className="galaxy-control hidden sm:block" onClick={() => setFull(!full)}>{full ? "退出全景" : "⛶ 全螢幕"}</button>
    </div>
    <div className="galaxy-layers">
      <div className="galaxy-seg" role="group" aria-label="資料圖層">{([['flow','法人'],['ret','漲跌'],['turnover','成交']] as const).map(([id,label]) => <button key={id} type="button" aria-pressed={layer === id} onClick={() => setLayer(id)}>{label}</button>)}</div>
      {layer === "flow" ? <><select aria-label="法人類別" className="galaxy-select" value={flowKind} onChange={(e) => setFlowKind(e.target.value as FlowKind)}><option value="total">法人合計</option><option value="foreign">外資</option><option value="trust">投信</option><option value="dealer">自營商</option></select><div className="galaxy-seg" role="group" aria-label="流向高亮">{([['all','全部'],['in','買超'],['out','賣超']] as const).map(([id,label]) => <button key={id} type="button" aria-pressed={direction === id} onClick={() => setDirection(id)}>{label}</button>)}</div></> : null}
      <input aria-label="搜尋全景族群" placeholder="搜尋族群…" value={query} onChange={(e) => setQuery(e.target.value)} className="galaxy-search" />
    </div>
    <div ref={stage} className="galaxy-stage">
      <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`${mode.toUpperCase()} 積木全景，${sceneNodes.length} 個節點`} tabIndex={0}
        onPointerDown={(e) => { moved.current = false; pressedNode.current = (e.target as Element).closest("[data-node-id]")?.getAttribute("data-node-id") ?? null; pointers.current.set(e.pointerId, localPoint(e.clientX,e.clientY)); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={pointerMove} onPointerUp={(e) => { pointers.current.delete(e.pointerId); if(!moved.current && pressedNode.current) {if(pressedNode.current === "__market__")reset();else pick(pressedNode.current);} pressedNode.current=null; }} onPointerCancel={(e) => {pointers.current.delete(e.pointerId);pressedNode.current=null;}} onDoubleClick={reset}
        onKeyDown={(e) => { if (e.key === "Escape" || e.key === "0") reset(); else if (["+","=","-"].includes(e.key)) setViewport((v) => zoomAt(v, layout.center, v.scale * (e.key === "-" ? 0.8 : 1.25))); else if (e.key.startsWith("Arrow")) { e.preventDefault(); setViewport((v) => panBy(v, e.key === "ArrowLeft" ? 50 : e.key === "ArrowRight" ? -50 : 0, e.key === "ArrowUp" ? 50 : e.key === "ArrowDown" ? -50 : 0)); } }}>
        <defs><radialGradient id="galaxy-glow"><stop stopColor="#245c71" stopOpacity=".25"/><stop offset="1" stopColor="#0a1524" stopOpacity="0"/></radialGradient><pattern id="galaxy-studs" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="18" cy="18" r="1.3" fill="#7395b0" opacity=".11"/></pattern></defs>
        <rect width={size.width} height={size.height} fill="url(#galaxy-studs)" />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          <ellipse cx={layout.center.x} cy={layout.center.y} rx={size.width * .45} ry={size.height * .48} fill="url(#galaxy-glow)" />
          <path d={`M 36 ${layout.center.y} H ${size.width-36} M ${layout.center.x} 45 V ${size.height-40}`} fill="none" stroke="#6c879e" opacity=".28" strokeDasharray="4 7" />
          <g fill="#879eae" fontSize="11" fontFamily="var(--font-mono)"><text x={size.width-42} y={layout.center.y-10} textAnchor="end">{mode === "rs" ? "相對強度 →" : "前日強度 →"}</text><text x={layout.center.x+12} y="65">{mode === "rs" ? "↑ 動能" : "↑ 當日漲跌"}</text><text x="50" y="65">{mode === "rs" ? "改善" : "弱勢上漲"}</text><text x={size.width-50} y="65" textAnchor="end">{mode === "rs" ? "領先" : "強勢上漲"}</text><text x="50" y={size.height-45}>{mode === "rs" ? "落後" : "弱勢下跌"}</text><text x={size.width-50} y={size.height-45} textAnchor="end">{mode === "rs" ? "轉弱" : "強勢下跌"}</text></g>
          {measured && layout.points.map((p) => {
            const n = nodesById.get(p.id)!;
            const member = n.kind === "member", active = selectedId === n.id || stockId === n.id.slice(6);
            const value = layer === "flow" && !member ? n.flow : n.ret;
            const volumeRatio = Math.sqrt(n.size / maxTurnover);
            const color = layer === "turnover" ? (n.size <= 0 ? UNKNOWN : volumeRatio > .65 ? GOLD : volumeRatio > .3 ? "#78c8be" : "#64839b") : value === null || value === 0 ? UNKNOWN : value > 0 ? UP : DOWN;
            const match = (!query || n.name.toLowerCase().includes(query.toLowerCase())) && (layer !== "flow" || direction === "all" || (n.flow !== null && (direction === "in" ? n.flow > 0 : n.flow < 0)));
            const dim = !match || (selectedId && !member && selectedId !== n.id);
            const parent = member && selectedId ? pointsById.get(selectedId) : null;
            const flowPath = `M ${layout.center.x} ${layout.center.y} Q ${(p.x+layout.center.x)/2} ${p.y} ${p.x} ${p.y}`;
            return <g key={n.id} opacity={dim ? .13 : 1} className="galaxy-node-wrap">
              {parent ? <path d={`M ${parent.x} ${parent.y} L ${p.x} ${p.y}`} stroke={GOLD} strokeWidth="1.2" opacity=".5"/> : null}
              {!member && layer === "flow" && n.flow !== null && !dim ? <><path d={flowPath} fill="none" stroke={color} strokeWidth={Math.min(8,1+Math.abs(n.flow)/1e10)} opacity=".055"/>{motion && n.flow !== 0 ? <circle r="2" fill={color} opacity=".6"><animateMotion dur={`${3.5+(n.id.length%5)}s`} repeatCount="indefinite" path={flowPath} keyPoints={n.flow > 0 ? "0;1" : "1;0"} keyTimes="0;1" calcMode="linear"/></circle> : null}</> : null}
              <line x1={p.anchorX} y1={p.anchorY} x2={p.x} y2={p.y} stroke={color} opacity=".2" strokeWidth=".7"/><circle cx={p.anchorX} cy={p.anchorY} r="1.5" fill={color} opacity=".35"/>
              <g transform={`translate(${p.x} ${p.y})`} style={{transition: motion ? "transform 800ms ease" : undefined}}>
                <g className={motion ? "galaxy-drift" : ""} style={{animationDelay:`-${n.id.length%7}s`,animationDuration:`${6+n.id.length%4}s`}}>
                  {active ? <circle r={p.radius+12} fill="none" stroke={GOLD} strokeWidth="1.5" strokeDasharray="4 5" className="galaxy-orbit"/> : null}
                  <ellipse rx={p.radius*1.4} ry={p.radius*.65} fill={color} opacity=".09"/>
                  <g data-node-id={n.id} role="button" tabIndex={0} aria-label={`${n.name}，${layer === "turnover" ? `成交 ${(n.size/1e8).toFixed(1)} 億` : layer === "flow" && !member ? `法人 ${yi(n.flow)}` : pct(n.ret)}`} aria-pressed={active} className="galaxy-brick" onClick={(e)=>{if(e.detail===0){e.stopPropagation();pick(n.id);}}} onKeyDown={(e) => {if(e.key === "Enter" || e.key === " "){e.preventDefault();e.stopPropagation();pick(n.id);}}}>
                    <title>{n.name} · 成交 {(n.size/1e8).toFixed(1)} 億 · 法人 {yi(n.flow)} · {pct(n.ret)}</title>
                    <circle r={p.radius+2} fill="transparent"/>
                    <HomeBrick scale={p.radius/64} color={color} line={n.held || active ? GOLD : "#d9e5e8"} lineWidth={active ? 2.2 : 1}/>
                    <text className={labelIds.has(n.id) ? "" : "galaxy-label-hidden"} y={p.radius*.8+13} textAnchor="middle" fill={active ? GOLD : "#dfebf1"} fontSize={member ? 11 : 12} fontWeight={active ? 800 : 500}>{n.name}</text>
                  </g>
                </g>
              </g>
            </g>;
          })}
          <g data-node-id="__market__" transform={`translate(${layout.center.x} ${layout.center.y})`} role="button" tabIndex={0} aria-label="大盤摘要，回到全貌" onClick={(e)=>{if(e.detail===0)reset();}} onKeyDown={(e) => {if(e.key === "Enter")reset();}} className="galaxy-hub">
            <circle r="84" fill="#0b192b" stroke="#4c7188" strokeWidth="1.5"/><circle r="90" fill="none" stroke={GOLD} strokeOpacity=".3" strokeDasharray="2 9" className="galaxy-orbit"/>
            <text y="-44" textAnchor="middle" fill="#91a9b7" fontSize="10" letterSpacing="3">TWSE · STACK</text>
            <text y="-10" textAnchor="middle" fill={overview.index?.change !== null && overview.index?.change !== undefined && overview.index.change < 0 ? DOWN : UP} fontSize="15">{pct(overview.index?.change ?? null)}</text>
            <text y="16" textAnchor="middle" fill="#f5f0e5" fontSize="25" fontWeight="800">{overview.index ? Number(overview.index.value).toLocaleString("en-US",{maximumFractionDigits:0}) : "大盤資料待更新"}</text>
            <text y="42" textAnchor="middle" fill="#aac1cf" fontSize="10">{overview.date ?? "尚無資料"}</text>
            <text y="66" textAnchor="middle" fill={centralFlow === null ? UNKNOWN : centralFlow >= 0 ? UP : DOWN} fontSize="12">法人 {yi(centralFlow)}</text>
            <text y="112" textAnchor="middle" fill="#8faab9" fontSize="11">成交 {overview.turnover ? `${(Number(overview.turnover)/1e8).toFixed(0)} 億` : "—"} · 漲 {overview.upCount}／跌 {overview.downCount}</text>
          </g>
        </g>
      </svg>
      {!sceneNodes.length ? <div className="galaxy-warming"><strong>{overview.date ? "正在建立真實輪動座標" : "尚未同步市場行情"}</strong><p>{overview.date ? "收盤資料已保留；最近 65 日價格補齊後，族群積木會出現在全景中。" : "取得交易所收盤資料後，就能開始探索。"}</p><button type="button" className="galaxy-control" onClick={() => router.refresh()}>更新資料</button></div> : null}
    </div>
    <div className="galaxy-footer"><span>{mode.toUpperCase()} 座標 {frameDate ?? rotation?.date ?? "暖機中"} · 法人／成交 {overview.date ?? "—"} · 大小＝成交額 · {layer === "flow" ? "紅＝淨買超，綠＝淨賣超" : layer === "turnover" ? "黃＝高成交額，藍綠＝較低" : "紅漲綠跌"}</span><span className="hidden lg:inline">拖曳移動 · 滾輪縮放 · 點積木展開 · 雙擊回全貌</span></div>
    <div className="galaxy-zoom"><button type="button" aria-label="放大全景" onClick={() => setViewport((v) => zoomAt(v,layout.center,v.scale*1.25))}>＋</button><button type="button" aria-label="縮小全景" onClick={() => setViewport((v) => zoomAt(v,layout.center,v.scale*.8))}>－</button><button type="button" aria-label="回到全貌" onClick={reset}>◎</button><button type="button" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>清單</button></div>
    <div className="galaxy-date">{playing ? `回放 ${frameDate}` : `收盤 ${overview.date ?? "—"}`}<br/>{unknown > 0 ? `${unknown} 個族群待座標` : `${groups.length} 個族群`} · <button type="button" onClick={() => router.refresh()}>更新</button></div>
    {listOpen ? <aside className="galaxy-ranking" aria-label="族群法人排行"><div className="flex justify-between"><strong>族群 · 當日法人</strong><button type="button" aria-label="關閉族群清單" onClick={() => setListOpen(false)}>✕</button></div>{ranked.filter((g) => !query || g.name.includes(query)).map((g,i) => <button key={g.id} type="button" onClick={() => {setSelectedId(g.id);setStockId(null);}}><span>{i+1}. {g.name}</span><span style={{color:(flowValue(g.flow,flowKind)??0)>=0?UP:DOWN}}>{yi(flowValue(g.flow,flowKind))}</span></button>)}</aside> : null}
    {selected ? <aside className="galaxy-detail" aria-label={`${selected.name} 族群明細`} aria-live="polite"><div className="flex items-center justify-between gap-3"><h2>{selected.name}</h2><button type="button" aria-label="關閉族群明細" onClick={() => {setSelectedId(null);setStockId(null);}}>✕</button></div><p className="galaxy-detail-value" style={{color:(flowValue(selected.flow,flowKind)??0)>=0?UP:DOWN}}>{yi(flowValue(selected.flow,flowKind))}</p><p className="galaxy-muted">當日法人 · {overview.date} · 漲跌 {pct(selected.ret)}</p>
      <dl className="galaxy-detail-stats"><div><dt>外資</dt><dd>{yi(selected.flow.foreign)}</dd></div><div><dt>投信</dt><dd>{yi(selected.flow.trust)}</dd></div><div><dt>自營商</dt><dd>{yi(selected.flow.dealer)}</dd></div></dl>
      {detail?.flowSeries.length ? <FlowHistory series={detail.flowSeries}/> : <p className="galaxy-muted my-4">歷史法人資料回補中</p>}
      <p className="galaxy-muted">成分股 · {selected.quoted}／{selected.members} 檔有行情</p>
      {!detail && !detailError ? <p role="status" className="my-5">載入成分股…</p> : detailError ? <p role="alert" className="my-5">暫時無法讀取 <button type="button" className="underline" onClick={() => setAttempt((n)=>n+1)}>重試</button></p> : <div className="galaxy-members">{detail?.members.map((m)=><button key={m.assetId} type="button" aria-pressed={stockId===m.assetId} onClick={()=>setStockId(m.assetId)}><span><small>{m.symbol}</small> {m.name}</span><span style={{color:(m.ret??0)>=0?UP:DOWN}}>{pct(m.ret)}</span></button>)}</div>}
      {stockId && detail ? (()=>{const m=detail.members.find((x)=>x.assetId===stockId);return m?<div className="galaxy-stock"><strong>{m.symbol} {m.name}</strong><p>收盤 {m.close?.toLocaleString("zh-TW")??"—"} · 成交 {m.turnover===null?"—":`${(m.turnover/1e8).toFixed(1)} 億`}</p><p>強度 {m.strength?.toFixed(2)??"暖機中"} · 動能 {m.momentum?.toFixed(2)??"暖機中"}</p></div>:null;})():null}
      {!signedIn ? <Link href="/login" className="galaxy-muted mt-4 inline-block underline">登入後可連結我的持股 ↗</Link> : null}
    </aside> : null}
    {playing ? <div className="galaxy-replay" role="group" aria-label="歷史回放"><button type="button" onClick={()=>setFrame(null)}>結束回放 ✕</button><button type="button" aria-label={replayPaused?"播放回放":"暫停回放"} onClick={()=>setReplayPaused(!replayPaused)}>{replayPaused?"▷":"Ⅱ"}</button><input type="range" aria-label="回放日期" min="0" max={Math.max(0,dates.length-1)} value={frame??0} onChange={(e)=>{setReplayPaused(true);setFrame(Number(e.target.value));}}/><select aria-label="回放速度" value={speed} onChange={(e)=>setSpeed(Number(e.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option></select><small>座標依歷史移動；法人與成交額固定為 {overview.date}</small></div> : null}
  </section>;
}

function FlowHistory({ series }: { series: GroupDetailDto["flowSeries"] }) {
  const last = series.slice(-20), values = last.map((s)=>flowValue(s,"total"));
  const max=Math.max(1,...values.map((v)=>Math.abs(v??0)));
  return <div className="my-4"><p className="galaxy-muted">每日法人淨買賣 · {values.filter((v)=>v!==null).length}／{last.length} 日有資料</p><svg viewBox="0 0 280 65" role="img" aria-label="每日法人淨買賣，缺值留空"><line x1="0" x2="280" y1="32" y2="32" stroke="#638197" opacity=".4"/>{values.map((v,i)=>v===null?null:<rect key={last[i].date} x={i*280/last.length+1} y={v>=0?32-Math.abs(v)/max*30:32} width={Math.max(2,280/last.length-3)} height={Math.max(1,Math.abs(v)/max*30)} fill={v>=0?UP:DOWN}/>)}</svg></div>;
}
