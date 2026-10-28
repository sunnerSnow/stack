"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import Link from "next/link";
import "./brick-city.css";
import { buildCityDistricts, cityScale, OVERVIEW_TOWERS, type CityBuilding, type CityDistrict, type FlowKind } from "@/lib/market/city-layout";
import { flowValue } from "@/lib/market/flows";
import type { GroupDetailDto, MemberRow } from "@/lib/services/market";
import type { MarketOverviewDto } from "@/lib/services/market-overview";

const INK = "#173451", SUN = "#F5D548", SEA = "#187F7C", CREAM = "#F5F0E5", PAPER = "#FFFDF8";
const BUY = "#D9534F", BUY_LT = "#F2A79E", SEA_LT = "#8ED6CF", MISSING = "#C9D0D8", TREE = "#5E8C61", ACTIVE_GROUND = "#F8E7A0";
/** Brick depth ÷ width: the city's isometric slope. */
const R = 0.578;
const CELL = 520, SLOT = 130, FOCUS_SLOT = 190, LAYER = 28, PAGE = 9;
const plateOf = (slotSize: number) => slotSize * 3 + 50;
const KINDS = [["total", "合計"], ["foreign", "外資"], ["trust", "投信"], ["dealer", "自營商"]] as const;
const NO_FLOW = { foreign: null, trust: null, dealer: null };
const kindLabel = (kind: FlowKind) => KINDS.find(([k]) => k === kind)![1];

const money = (n: number | null, signed = true) => {
  if (n === null) return "—";
  const small = n !== 0 && Math.abs(n) < 1e7;
  return `${signed && n > 0 ? "+" : ""}${(n / (small ? 1e4 : 1e8)).toLocaleString("zh-TW", { maximumFractionDigits: 1 })} ${small ? "萬" : "億"}`;
};
const pct = (n: number | null) => n === null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const signClass = (n: number | null) => n === null ? "" : n > 0 ? "city-gain" : n < 0 ? "city-loss" : "";
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const indexText = (value: string | undefined) => value ? Number(value).toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "—";
const press = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };
/** 紅＝法人買超、海綠＝賣超，幅度在前兩級用淺色；零是奶油白，缺值是灰色虛線。 */
const tone = (flow: number | null, layers = 6) => flow === null ? MISSING : flow === 0 ? CREAM : flow > 0 ? (layers >= 3 ? BUY : BUY_LT) : (layers >= 3 ? SEA : SEA_LT);

// Fixed category blocks on an isometric grid around the market square; location and ground colour
// encode categories only. The empty cell to the left of the square is where a group's stocks fly out.
const ADDRESSES: Record<string, { cell: [number, number]; ground: string; icon: keyof typeof ICONS }> = {
  "電子科技": { cell: [-1, 0], ground: "#E6E1D3", icon: "chip" },
  "民生消費": { cell: [0, -1], ground: "#E8DCCB", icon: "bag" },
  "金融": { cell: [1, -1], ground: "#D8DEE6", icon: "bank" },
  "生技醫療": { cell: [1, 0], ground: "#D3E3D2", icon: "cross" },
  "原物料": { cell: [1, 1], ground: "#DDD8C6", icon: "ore" },
  "工業與運輸": { cell: [0, 1], ground: "#CFDDEA", icon: "ship" },
  "其他": { cell: [-1, -1], ground: "#E3DED3", icon: "dots" },
};
const SPARE: [number, number][] = [[2, -1], [-1, 2], [2, 0], [0, 2], [2, 1], [1, 2]];
const ICONS = {
  chip: "M8 8h8v8H8z M10 4v4 M14 4v4 M10 16v4 M14 16v4 M4 10h4 M4 14h4 M16 10h4 M16 14h4",
  bag: "M5 9h14l-1.2 11H6.2z M9 9V7a3 3 0 0 1 6 0v2",
  bank: "M3 9 12 4l9 5z M6 11v6 M10 11v6 M14 11v6 M18 11v6 M3 20h18",
  cross: "M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z",
  ore: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5 12 12l8-4.5 M12 12v9",
  ship: "M3 15h18l-3 5H6z M6 15V9h7v6 M13 12h5v3 M9 9V5",
  dots: "M5 5h5v5H5z M14 5h5v5h-5z M5 14h5v5H5z M14 14h5v5h-5z",
};
const GROUNDS = [...new Set([...Object.values(ADDRESSES).map((a) => a.ground), CREAM, ACTIVE_GROUND])];
const studsId = (ground: string) => `city-studs-${ground.slice(1)}`;
type Address = { cell: [number, number]; ground: string; icon: keyof typeof ICONS };

function addresses(districts: CityDistrict[]) {
  let spare = 0;
  return new Map<string, Address>(districts.map((d) => [d.id, ADDRESSES[d.name] ?? { cell: SPARE[spare++ % SPARE.length], ground: CREAM, icon: "dots" }]));
}
/** Isometric grid → screen; `size` is one cell's diamond width. */
const at = ([u, v]: readonly [number, number], size = CELL) => ({ x: (u - v) * size / 2, y: (u + v) * size * R / 2 });
/** Slot i of a district's 3×3 tower grid, measured from the plate centre. */
const slot = (i: number, size: number) => at([i % 3 - 1, Math.floor(i / 3) - 1], size);
const diamond = (w: number) => `${-w / 2},0 0,${-w * R / 2} ${w / 2},0 0,${w * R / 2}`;
const towerHeight = (b: CityBuilding) => b.layers === 0 ? 12 : Math.max(1, b.layers ?? 1) * LAYER;
/** Hang a district's sign on a front face whose neighbouring cell is empty, so it never covers another block. */
function signSpot([u, v]: [number, number], taken: Set<string>, plate: number) {
  const free = (c: [number, number]) => !taken.has(c.join());
  const { x } = at([u, v]);
  const left = free([u, v + 1]), right = free([u + 1, v]);
  const side = left && !right ? -1 : right && !left ? 1 : left && right ? (x < 0 ? -1 : 1) : x < 0 ? -1 : x > 0 ? 1 : 0;
  return side === 0 ? `translate(0 ${plate * R / 2 + 26}) rotate(-10)` : `translate(${side * plate / 4} ${plate * R / 4 + 22}) rotate(${side * -18})`;
}

/** A studded isometric brick. Origin is the centre of its top; depth and height are separate. */
function Block({ w, d, h, fill, studs = true, ghost = false }: { w: number; d: number; h: number; fill: string; studs?: boolean; ghost?: boolean }) {
  const points = `${-w/2},0 0,${-d/2} ${w/2},0 0,${d/2}`;
  return <g stroke={INK} strokeWidth="1.5" strokeLinejoin="round" strokeDasharray={ghost ? "4 3" : undefined}>
    <polygon points={`${-w/2},0 0,${d/2} 0,${d/2+h} ${-w/2},${h}`} fill={fill}/>
    <polygon points={`${-w/2},0 0,${d/2} 0,${d/2+h} ${-w/2},${h}`} fill={INK} opacity=".18" stroke="none"/>
    <polygon points={`0,${d/2} ${w/2},0 ${w/2},${h} 0,${d/2+h}`} fill={fill}/>
    <polygon points={`0,${d/2} ${w/2},0 ${w/2},${h} 0,${d/2+h}`} fill={INK} opacity=".32" stroke="none"/>
    <polygon points={points} fill={fill}/>
    <polygon points={points} fill="url(#city-top-light)" stroke="none"/>
    <path d={`M ${-w/2+2} 1 L 0 ${-d/2+2} L ${w/2-2} 1`} fill="none" stroke="#fffdf8" strokeOpacity=".55" strokeWidth="1.2"/>
    {studs && [-1,1].flatMap((u) => [-1,1].map((v) => <g key={`${u}:${v}`} transform={`translate(${(u-v)*w/8} ${(u+v)*d/8})`}>
      <path d={`M ${-w*.085} 0 v -6 a ${w*.085} ${d*.085} 0 0 1 ${w*.17} 0 v 4`} fill={fill}/>
      <ellipse cy="-6" rx={w*.085} ry={d*.085} fill={fill}/>
      <ellipse cy="-6" rx={w*.085} ry={d*.085} fill="url(#city-top-light)" stroke="none"/>
    </g>))}
  </g>;
}

/** Studs on a plate, as an isometric lattice: a centred rectangular tile. */
function StudPattern({ id, fill }: { id: string; fill: string }) {
  const s = 24, h = s * R;
  return <pattern id={id} width={s} height={h} patternUnits="userSpaceOnUse">
    {[[0, 0], [s, 0], [0, h], [s, h], [s / 2, h / 2]].map(([x, y], i) => <g key={i} transform={`translate(${x} ${y})`}>
      <path d="M -5 0 v -3 a 5 2.9 0 0 0 10 0 v 3 a 5 2.9 0 0 1 -10 0" fill={INK} opacity=".18"/>
      <ellipse cy="-3" rx="5" ry="2.9" fill={fill} stroke={INK} strokeOpacity=".3" strokeWidth=".7"/>
    </g>)}
  </pattern>;
}

function Tree({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${s})`} aria-hidden="true">
    <ellipse cy="1" rx="11" ry="5" fill={INK} opacity=".14"/>
    <path d="M -2 1 V -12 H 2 V 1 Z" fill={INK}/>
    <circle cy="-21" r="11" fill={TREE} stroke={INK} strokeWidth="1.3"/>
    <circle cx="-4" cy="-25" r="4" fill={PAPER} opacity=".2"/>
  </g>;
}

function Tower({ building, selected, delay, pick }: { building: CityBuilding; selected: boolean; delay: number; pick: () => void }) {
  const layers = Math.max(1, building.layers ?? 0);
  const w = 74 * building.footprint, d = w * R;
  const h = building.layers === 0 ? 12 : LAYER;
  const fill = tone(building.flow, building.layers ?? 0);
  return <g className={`city-tower ${selected ? "is-selected" : ""}`} role="button" tabIndex={0} aria-label={`查看族群 ${building.name}`} aria-pressed={selected}
    onClick={pick} onKeyDown={press(pick)} data-city-action="true">
    <title>{`${building.name} · 法人 ${money(building.flow)} · 成交額 ${money(building.turnover, false)}`}</title>
    <ellipse cy={d * .2} rx={w * .62} ry={d * .42} fill={INK} opacity=".14"/>
    {selected ? <polygon points={diamond(w + 18)} fill="none" stroke={SUN} strokeWidth="5"/> : null}
    {Array.from({ length: layers }, (_, i) => <g key={i} transform={`translate(0 ${-(i + 1) * h})`}><g className="city-assemble" style={{ animationDelay: `${delay + i * 55}ms` }}>
      <Block w={w} d={d} h={h} fill={fill} studs={i === layers - 1} ghost={building.flow === null}/>
    </g></g>)}
    <text y={-layers * h - d / 2 - 14} textAnchor="middle" className="city-tower-name">{building.name}</text>
  </g>;
}

function DistrictSign({ district, icon, note }: { district: CityDistrict; icon: keyof typeof ICONS; note: string }) {
  const w = 74 + district.name.length * 29, pill = 22 + note.length * 9.5;
  return <g aria-hidden="true">
    <rect x={-w / 2} y="-27" width={w} height="54" rx="13" fill={INK} stroke={PAPER} strokeWidth="2.5"/>
    <rect x={-w / 2 + 5} y="-22" width={w - 10} height="44" rx="10" fill="none" stroke="#35587e" strokeWidth="1.5"/>
    <path transform={`translate(${-w / 2 + 16} -13) scale(1.1)`} d={ICONS[icon]} fill="none" stroke={CREAM} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
    <text x={-w / 2 + 54} y="10" fill={CREAM} fontSize="29" fontWeight="900">{district.name}</text>
    <g transform={`translate(${w / 2 - pill + 14} 18)`}>
      <rect width={pill} height="26" rx="13" fill={SUN} stroke={INK} strokeWidth="2"/>
      <text x={pill / 2} y="18" textAnchor="middle" fill={INK} fontSize="15" fontWeight="800">{note}</text>
    </g>
  </g>;
}

function District({ district, address, slotSize, selectedId, delay, onFocus, onPick }: {
  district: CityDistrict; address: Address; slotSize: number; selectedId: string | null; delay: number; onFocus: () => void; onPick: (id: string) => void;
}) {
  const plate = plateOf(slotSize);
  const active = district.groups.some((b) => b.id === selectedId);
  const ground = active ? ACTIVE_GROUND : address.ground;
  const items = Array.from({ length: PAGE }, (_, i) => ({ i, building: district.groups[i] as CityBuilding | undefined, ...slot(i, slotSize) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return <g>
    <g role="button" tabIndex={0} aria-label={`展開 ${district.name}`} onClick={onFocus} onKeyDown={press(onFocus)} data-city-action="true" className="city-base">
      <ellipse cy={plate * R / 2 + 34} rx={plate / 2 + 14} ry="26" fill={INK} opacity=".08"/>
      <Block w={plate} d={plate * R} h={34} fill={INK} studs={false}/>
      <g transform="translate(0 -6)"><Block w={plate - 18} d={(plate - 18) * R} h={6} fill={ground} studs={false}/></g>
      <polygon transform="translate(0 -6)" points={diamond(plate - 30)} fill={`url(#${studsId(ground)})`}/>
      {active ? <polygon transform="translate(0 -6)" points={diamond(plate - 10)} fill="none" stroke={SUN} strokeWidth="7" className="city-plate-glow"/> : null}
    </g>
    {items.map(({ i, building, x, y }) => <g key={building?.id ?? `tree:${i}`} transform={`translate(${x} ${y - 6})`}>
      {building ? <Tower building={building} selected={selectedId === building.id} delay={delay + i * 45} pick={() => onPick(building.id)}/>
        : i % 2 ? <Tree x={0} y={4} s={1.1}/> : <><Tree x={-16} y={-2}/><Tree x={14} y={8} s={.85}/></>}
    </g>)}
  </g>;
}

function Walkway({ from, to }: { from: [number, number]; to: [number, number] }) {
  const a = at(from), b = at(to);
  const half = 36;
  const off = to[0] !== from[0] ? { x: -half / 2, y: half * R / 2 } : { x: half / 2, y: half * R / 2 };
  const quad = (dy: number) => [[a.x + off.x, a.y + off.y], [b.x + off.x, b.y + off.y], [b.x - off.x, b.y - off.y], [a.x - off.x, a.y - off.y]].map(([x, y]) => `${x},${y + dy}`).join(" ");
  return <g aria-hidden="true">
    <polygon points={quad(30)} fill={INK}/>
    <polygon points={quad(16)} fill="#EADFC8" stroke={INK} strokeWidth="1.5"/>
    {Array.from({ length: 13 }, (_, k) => {
      const t = .2 + k * .05, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t + 16;
      return <path key={k} d={`M ${x + off.x * .9} ${y + off.y * .9} L ${x - off.x * .9} ${y - off.y * .9}`} stroke="#B5A27F" strokeWidth="2"/>;
    })}
  </g>;
}

function Plaza({ value, change, onClick }: { value: string | undefined; change: number | null; onClick: () => void }) {
  return <g className="city-market" role="button" tabIndex={0} aria-label="查看大盤摘要" onClick={onClick} onKeyDown={press(onClick)} data-city-action="true">
    <ellipse cy="122" rx="185" ry="28" fill={INK} opacity=".1"/>
    <Block w={340} d={340 * R} h={30} fill={INK} studs={false}/>
    <polygon points={diamond(322)} fill={`url(#${studsId(INK)})`}/>
    {[[-130, 4], [130, 4], [0, -74], [-62, 60], [64, 60]].map(([x, y]) => <g key={`${x}:${y}`} transform={`translate(${x} ${y - 12})`}><Block w={36} d={36 * R} h={12} fill={SUN}/></g>)}
    <text y="-4" textAnchor="middle" fill={CREAM} stroke="#0d2136" strokeWidth="9" paintOrder="stroke" fontSize="60" fontWeight="900" letterSpacing="4">大盤</text>
    <text y="36" textAnchor="middle" fill={SUN} fontSize="22" fontWeight="700" className="city-mono">{indexText(value)} · {pct(change)}</text>
  </g>;
}

function Flyout({ anchor, members, kind, stockId, x, onPick }: { anchor: { x: number; y: number }; members: MemberRow[]; kind: FlowKind; stockId: string | null; x: number; onPick: (id: string) => void }) {
  const shown = members.slice(0, 4).map((m, i, list) => ({ m, y: (i - (list.length - 1) / 2) * 118 }));
  const bx = x + 228;
  return <g className="city-flyout">
    {shown.map(({ m, y }) => {
      const d = `M ${bx + 30} ${y - 8} C ${bx + 150} ${y - 8}, ${anchor.x - 170} ${anchor.y - 30}, ${anchor.x - 14} ${anchor.y}`;
      return <g key={`path:${m.assetId}`} aria-hidden="true"><path d={d} className="city-flyout-glow"/><path d={d} className="city-flyout-path" markerEnd="url(#city-arrow)"/></g>;
    })}
    {shown.map(({ m, y }, i) => {
      const value = flowValue(m.flow, kind);
      const pick = () => onPick(m.assetId);
      return <g key={m.assetId} transform={`translate(${x} ${y})`}>
        <g className="city-stock city-fly" style={{ "--dx": `${anchor.x - x}px`, "--dy": `${anchor.y - y}px`, animationDelay: `${i * 90}ms` } as CSSProperties}
          role="button" tabIndex={0} aria-label={`查看個股 ${m.symbol} ${m.name}`} aria-pressed={stockId === m.assetId} onClick={pick} onKeyDown={press(pick)} data-city-action="true">
          <rect y="-32" width="156" height="64" rx="11" fill={PAPER} stroke={stockId === m.assetId ? INK : "#D9CDB8"} strokeWidth={stockId === m.assetId ? 2.5 : 1.5}/>
          <text x="16" y="-4" fontSize="23" fontWeight="900" fill={INK}>{m.name}</text>
          <text x="16" y="20" fontSize="16" fill="#4a5f75" className="city-mono">{m.symbol}</text>
          <path d={`M 156 0 H ${bx - x - 40}`} stroke="#8A9AAB" strokeWidth="1.5" strokeDasharray="2 4"/>
          <g transform={`translate(${bx - x} -12)`}><Block w={70} d={70 * R} h={24} fill={stockId === m.assetId ? SUN : tone(value)} ghost={value === null}/></g>
        </g>
      </g>;
    })}
  </g>;
}

/** Diverging bars around zero: buying extends right, selling left. */
function FlowBars({ rows, activeId, onPick, label }: { rows: { id: string; name: string; sub?: string; value: number | null }[]; activeId?: string | null; onPick: (id: string) => void; label: string }) {
  const sorted = [...rows].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const pos = Math.max(0, ...rows.map((r) => r.value ?? 0)), neg = Math.max(0, ...rows.map((r) => -(r.value ?? 0)));
  const span = pos + neg || 1, axis = neg / span * 100;
  return <div className="city-bars" role="group" aria-label={label}>{sorted.map((r) => {
    const width = r.value === null ? 0 : Math.abs(r.value) / span * 100;
    return <button key={r.id} aria-pressed={activeId === r.id} onClick={() => onPick(r.id)}>
      <span className="city-bar-name"><b>{r.name}</b>{r.sub ? <small>{r.sub}</small> : null}</span>
      <span className="city-bar-track" style={{ "--axis": `${axis}%` } as CSSProperties}>
        {r.value === null ? <i className="is-missing"/> : <i className={r.value >= 0 ? "is-buy" : "is-sell"} style={{ left: `${r.value < 0 ? axis - width : axis}%`, width: `${Math.max(width, .6)}%` }}/>}
      </span>
      <b className={`city-bar-value ${signClass(r.value)}`}>{money(r.value)}</b>
    </button>;
  })}</div>;
}

function FlowChart({ series, kind, date }: { series: GroupDetailDto["flowSeries"]; kind: FlowKind; date: string }) {
  const recent = series.filter((r) => r.date <= date).slice(-20);
  if (!recent.length) return <p className="city-caption">法人每日紀錄仍在累積。</p>;
  const values = recent.map((r) => flowValue(r, kind));
  const max = Math.max(...values.map((v) => Math.abs(v ?? 0))) || 1;
  const W = 250, H = 66, bw = W / recent.length;
  return <svg className="city-chart" viewBox={`0 0 ${W + 22} ${H}`} role="img" aria-label={`近 ${recent.length} 個交易日法人${kindLabel(kind)}買賣超`}>
    <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#C9BFAE"/>
    {values.map((v, i) => {
      const h = v === null ? 0 : Math.max(1, Math.abs(v) / max * (H / 2 - 3));
      return v === null ? <rect key={recent[i].date} x={i * bw + bw * .2} width={bw * .6} y={H / 2 - 1} height="2" fill={MISSING}/>
        : <rect key={recent[i].date} x={i * bw + bw * .15} width={bw * .7} y={v >= 0 ? H / 2 - h : H / 2} height={h} fill={v >= 0 ? BUY : SEA} stroke={recent[i].date === date ? INK : "none"} strokeWidth="1.5"><title>{`${recent[i].date} ${money(v)}`}</title></rect>;
    })}
    <text x={W + 9} y="10" className="city-chart-axis">+</text><text x={W + 8} y={H / 2 + 4} className="city-chart-axis">0</text><text x={W + 9} y={H - 3} className="city-chart-axis">−</text>
  </svg>;
}

export function BrickCity({ overview, local = false }: { overview: MarketOverviewDto; local?: boolean }) {
  const last = Math.max(0, overview.replay.length - 1);
  const [level, setLevel] = useState<"theme" | "industry">("theme");
  const [kind, setKind] = useState<FlowKind>("total");
  const [step, setStep] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [focus, setFocus] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [stockId, setStockId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [animated, setAnimated] = useState(true);
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; data?: GroupDetailDto; error?: boolean } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  const day = overview.replay[step];
  const date = day?.date ?? overview.date;
  // Replayed days keep today's tower order and only swap turnover and flow; the scale spans the
  // whole replay so a tower's height can be compared from one day to the next.
  const groups = useMemo(() => overview.groups.map((g) => g.days[step] ? { ...g, ...g.days[step], rank: g.turnover } : g), [overview.groups, step]);
  const scale = useMemo(() => cityScale(overview.groups.flatMap((g) => g.days.length ? g.days.map((d) => ({ ...g, ...d })) : [g]), level, kind), [overview.groups, level, kind]);
  const districts = useMemo(() => buildCityDistricts(groups, level, focus, selectedId, { kind, scale }), [groups, level, focus, selectedId, kind, scale]);
  const places = useMemo(() => addresses(districts), [districts]);
  const focused = districts.find((d) => d.id === focus);
  const selected = groups.find((g) => g.id === selectedId);
  const key = `${selectedId}:${date}:${retry}`;
  const detail = response?.key === key ? response.data : undefined;
  const failed = response?.key === key && response.error;
  const focusedIds = new Set(focused?.groups.map((g) => g.id));
  const candidates = groups.filter((g) => g.level === level && (!focused || focusedIds.has(g.id)) && g.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => (b.turnover ?? -1) - (a.turnover ?? -1));
  const members = useMemo(() => [...(detail?.members ?? [])].sort((a, b) => (b.turnover ?? -1) - (a.turnover ?? -1)), [detail]);
  const selectedStock = members.find((m) => m.assetId === stockId);
  const groupFlow = selected ? flowValue(selected.flow, kind) : null;
  const visibleDistrict = focused ? { ...focused, groups: focused.groups.slice(page * PAGE, page * PAGE + PAGE) } : null;
  const overviewDistricts = districts.map((d) => ({ ...d, groups: d.groups.slice(0, OVERVIEW_TOWERS) }));
  const host = visibleDistrict ?? overviewDistricts.find((d) => d.groups.some((b) => b.id === selectedId));
  const hostIndex = host ? host.groups.findIndex((b) => b.id === selectedId) : -1;
  const anchor = host && hostIndex >= 0 ? (() => {
    const base = visibleDistrict ? { x: 0, y: 0 } : at(places.get(host.id)!.cell);
    const s = slot(hostIndex, visibleDistrict ? FOCUS_SLOT : SLOT);
    return { x: base.x + s.x, y: base.y + s.y - 6 - towerHeight(host.groups[hostIndex]) };
  })() : null;
  const cells = [[0, 0] as [number, number], ...overviewDistricts.map((d) => places.get(d.id)!.cell)];
  const taken = new Set(cells.map((c) => c.join()));
  const walkways = cells.flatMap((a, i) => cells.slice(i + 1).filter((b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1).map((b) => [a, b] as const));
  // Frame the overview by its tallest tower on any replayed day, so playback never rescales the city.
  const skyline = useMemo(() => Math.min(-430, ...overview.replay.map((_, s) => {
    const daily = overview.groups.map((g) => g.days[s] ? { ...g, ...g.days[s], rank: g.turnover } : g);
    const built = buildCityDistricts(daily, level, null, null, { kind, scale });
    const cellOf = addresses(built);
    return Math.min(...built.flatMap((d) => d.groups.slice(0, OVERVIEW_TOWERS).map((b, i) => at(cellOf.get(d.id)!.cell).y + slot(i, SLOT).y - towerHeight(b) - 50)));
  })), [overview.groups, overview.replay, level, kind, scale]);
  const cityViewBox = focused ? "-730 -350 1090 660" : `-830 ${Math.floor(skyline)} 1600 ${Math.ceil(525 - skyline)}`;

  useEffect(() => {
    if (!selectedId || !date) return;
    const controller = new AbortController();
    fetch(`/api/market/groups/${encodeURIComponent(selectedId)}?date=${date}`, { signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error("request"); const body = await r.json(); if (!body.data) throw new Error("data"); return body.data as GroupDetailDto; })
      .then((data) => { if (!controller.signal.aborted) setResponse({ key, data }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key, error: true }); });
    return () => controller.abort();
  }, [selectedId, date, key]);

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => { setSelectedId(null); setStockId(null); setClosing(false); }, 240);
    return () => clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => { setStep(step + 1); if (step + 1 >= last) setPlaying(false); }, 1700 / speed);
    return () => clearTimeout(timer);
  }, [playing, step, last, speed]);

  function closeGroup() {
    if (animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) setClosing(true);
    else { setSelectedId(null); setStockId(null); }
  }
  function reset() { setClosing(false); setFocus(null); setSelectedId(null); setStockId(null); setPage(0); setQuery(""); setView({ x: 0, y: 0, scale: 1 }); }
  function focusDistrict(id: string) { setClosing(false); setFocus(id); setSelectedId(null); setStockId(null); setPage(0); setQuery(""); setView({ x: 0, y: 0, scale: 1 }); }
  function pick(id: string) {
    setClosing(false); setStockId(null);
    // Select in place when the tower stands in the overview; otherwise open its district at the right page.
    const home = buildCityDistricts(groups, level, null, id).find((d) => d.groups.some((b) => b.id === id));
    if (!home) return;
    if (!focus && home.groups.findIndex((b) => b.id === id) < OVERVIEW_TOWERS) { setSelectedId(id); return; }
    const full = buildCityDistricts(groups, level, home.id, id).find((d) => d.id === home.id)!;
    setPage(Math.floor(full.groups.findIndex((b) => b.id === id) / PAGE)); setFocus(home.id); setSelectedId(id); setView({ x: 0, y: 0, scale: 1 });
  }
  function play() {
    if (playing) { setPlaying(false); return; }
    if (step >= last) setStep(0);
    setPlaying(true);
  }
  function jump(i: number) { setPlaying(false); setStep(i); }
  function point(e: PointerEvent<SVGSVGElement>) { const matrix = svg.current?.getScreenCTM(); return matrix ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse()) : { x: 0, y: 0 }; }
  function zoom(factor: number) { setView((v) => ({ ...v, scale: Math.max(.65, Math.min(2.5, v.scale * factor)) })); }
  // Market-wide and sector totals are almost always partial (stocks without institutional trades have no
  // row), so the overview lists the groups with the largest known buying and selling instead.
  const ranked = groups.filter((g) => g.level === level).map((g) => ({ id: g.id, name: g.name, sub: `成交 ${money(g.turnover, false)}`, value: flowValue(g.flow, kind) }));
  const leaders = [
    ...ranked.filter((r) => r.value !== null && r.value > 0).sort((a, b) => b.value! - a.value!).slice(0, 5),
    ...ranked.filter((r) => r.value !== null && r.value < 0).sort((a, b) => a.value! - b.value!).slice(0, 5),
  ];
  const turnPage = (delta: number) => { setSelectedId(null); setStockId(null); setClosing(false); setPage((p) => p + delta); setView({ x: 0, y: 0, scale: 1 }); };
  const levelName = level === "theme" ? "族群" : "產業";

  return <section className={`brick-city ${animated ? "city-motion" : ""} ${closing ? "city-closing" : ""}`} aria-label="市場積木城市" onKeyDown={(e) => { if (e.key === "Escape") { if (selectedId) closeGroup(); else reset(); } }}>
    <header className="city-head">
      <div className="city-title">
        <h1>立體積木城市</h1>
        <p>以堆疊與拆解，看見市場結構。</p>
        <div className="city-chips"><span className="city-chip">{local ? "本機資料 · " : ""}收盤 {overview.date ?? "尚未同步"}</span><span className="city-note">公開瀏覽 · 資金流向是線索，不是買賣訊號</span></div>
      </div>
      <div className="city-controls">
        <div className="city-tabs" role="group" aria-label="積木分類與法人">
          {([["theme", "族群"], ["industry", "產業"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={level === value} onClick={() => { setLevel(value); reset(); }}>{label}</button>)}
          <label className={`city-tab-select ${kind !== "total" ? "is-on" : ""}`}><span>法人</span>
            <select aria-label="積木依哪個法人的買賣超" value={kind} onChange={(e) => setKind(e.target.value as FlowKind)}>{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </label>
        </div>
        {overview.replay.length ? <label className="city-date">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v14H4z M4 10h16 M8 3v5 M16 3v5 M8 14h2 M12 14h2 M16 14h2 M8 17h2 M12 17h2" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>
          <select aria-label="資料日期" value={step} onChange={(e) => jump(Number(e.target.value))}>{overview.replay.map((d, i) => <option key={d.date} value={i}>{i === last ? "收盤" : "回放"} {d.date}</option>)}</select>
        </label> : null}
      </div>
    </header>

    <div className="city-stage">
      <div className="city-scene-wrap">
        <div className="city-mobile-nav"><div><small>TAIEX · 大盤 {date ? shortDate(date) : ""}</small><strong>{indexText(day?.index?.value)}</strong><b className={signClass(day?.index?.change ?? null)}>{pct(day?.index?.change ?? null)}</b></div><label>選擇產業底板<select aria-label="選擇產業底板" value={focus ?? ""} onChange={(e) => e.target.value ? focusDistrict(e.target.value) : reset()}><option value="">全市場總覽</option>{districts.map((d) => <option value={d.id} key={d.id}>{d.name} · {d.totalGroups} 群</option>)}</select></label></div>
        <nav className="city-breadcrumb" aria-label="城市導覽"><button onClick={reset} aria-current={!focus && !selectedId ? "page" : undefined}>全市場</button>{focused ? <><span>/</span><button onClick={() => focusDistrict(focused.id)} aria-current={!selectedId ? "page" : undefined}>{focused.name}</button></> : null}{selected ? <><span>/</span><span>{selected.name}</span></> : null}</nav>
        <div className="city-scene">
          {overview.groups.length ? <svg ref={svg} role="group" viewBox={cityViewBox} className={`city-svg ${focused ? "city-svg-focused" : ""}`} aria-label={focused ? `${focused.name}的${levelName}積木` : "全市場產業積木城市"}
            onPointerDown={(e) => { if (e.button !== 0 || (e.target as Element).closest("[data-city-action]")) return; const p = point(e); drag.current = { id: e.pointerId, ...p }; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { const prev = drag.current; if (!prev || prev.id !== e.pointerId) return; const p = point(e); setView((v) => ({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y })); drag.current = { id: e.pointerId, ...p }; }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <defs>
              <linearGradient id="city-top-light" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fffdf8" stopOpacity=".34"/><stop offset="1" stopColor="#fffdf8" stopOpacity="0"/></linearGradient>
              {[...GROUNDS, INK].map((g) => <StudPattern key={g} id={studsId(g)} fill={g === INK ? "#2B4C70" : g}/>)}
              <marker id="city-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#E2B21B"/></marker>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {!focused ? <>
                {walkways.map(([a, b]) => <Walkway key={`${a}:${b}`} from={a} to={b}/>)}
                {[...overviewDistricts.map((d) => ({ d, ...at(places.get(d.id)!.cell) })), { d: null, x: 0, y: 0 }].sort((a, b) => a.y - b.y || a.x - b.x).map((p, i) => p.d
                  ? <g key={p.d.id} transform={`translate(${p.x} ${p.y})`}><District district={p.d} address={places.get(p.d.id)!} slotSize={SLOT} selectedId={selectedId} delay={i * 70} onFocus={() => focusDistrict(p.d!.id)} onPick={pick}/></g>
                  : <Plaza key="market" value={day?.index?.value} change={day?.index?.change ?? null} onClick={reset}/>)}
                {overviewDistricts.map((d) => <g key={`sign:${d.id}`} transform={`translate(${at(places.get(d.id)!.cell).x} ${at(places.get(d.id)!.cell).y}) ${signSpot(places.get(d.id)!.cell, taken, plateOf(SLOT))}`}
                  className="city-district-sign" onClick={() => focusDistrict(d.id)} data-city-action="true">
                  <DistrictSign district={d} icon={places.get(d.id)!.icon} note={d.totalGroups > d.groups.length ? `${d.groups.length}/${d.totalGroups} 群 ›` : `${d.totalGroups} 群 ›`}/>
                </g>)}
                {!selectedId ? <g className="city-flyout-hint" aria-hidden="true">
                  <rect x="-815" y="-82" width="236" height="164" rx="18"/>
                  {[-40, 0, 40].map((dx, k) => <g key={dx} transform={`translate(${-697 + dx} ${-22 + (k % 2) * 8})`}><Block w={36} d={36 * R} h={14} fill={PAPER} ghost/></g>)}
                  <text x="-697" y="30" textAnchor="middle" className="city-flyout-hint-title">點一座積木塔</text>
                  <text x="-697" y="56" textAnchor="middle">成分股會拆到這裡</text>
                </g> : null}
              </> : visibleDistrict ? <>
                <District district={visibleDistrict} address={places.get(focused.id)!} slotSize={FOCUS_SLOT} selectedId={selectedId} delay={0} onFocus={() => focusDistrict(focused.id)} onPick={pick}/>
                <g transform={`translate(0 ${plateOf(FOCUS_SLOT) * R / 2 + 30}) rotate(-10)`} className="city-district-sign" onClick={() => focusDistrict(focused.id)} data-city-action="true">
                  <DistrictSign district={focused} icon={places.get(focused.id)!.icon} note={focused.groups.length > PAGE ? `${page * PAGE + 1}–${page * PAGE + visibleDistrict.groups.length} / ${focused.totalGroups} 群` : `${focused.totalGroups} 群`}/>
                </g>
              </> : null}
              {selectedId && anchor ? (detail && members.length
                ? <Flyout anchor={anchor} members={members} kind={kind} stockId={stockId} x={focused ? -720 : -815} onPick={setStockId}/>
                : <text x={focused ? -560 : -650} y="0" textAnchor="middle" className="city-flyout-status">{failed ? "資料讀取失敗，請於右側重試" : !detail ? "正在拆開成分股…" : "目前沒有成分股資料"}</text>) : null}
            </g>
          </svg> : <div className="city-empty">尚未取得市場行情，資料同步後將自動建立積木城市。</div>}
        </div>
        <div className="city-zoom"><button onClick={() => zoom(.8)} aria-label="縮小城市">−</button><button onClick={() => setView({ x: 0, y: 0, scale: 1 })} aria-label="重設城市視角">{Math.round(view.scale * 100)}%</button><button onClick={() => zoom(1.25)} aria-label="放大城市">＋</button></div>
        {focused && focused.groups.length > PAGE ? <div className="city-pagination"><button disabled={page === 0} onClick={() => turnPage(-1)}>← 上一組</button><span>{page * PAGE + 1}–{Math.min((page + 1) * PAGE, focused.groups.length)} / {focused.groups.length} {levelName}</span><button disabled={(page + 1) * PAGE >= focused.groups.length} onClick={() => turnPage(1)}>下一組 →</button></div> : null}
      </div>

      <aside className="city-panel" aria-label="市場與族群詳細資料"><div className="city-panel-inner">
        <div className="city-card">
          {selected ? <>
            <div className="city-card-head"><h2>{selected.name}</h2><span>{levelName}詳情</span><button aria-label="合攏族群" onClick={closeGroup}>×</button></div>
            <p className="city-caption">{date} 收盤 · {selected.quoted} / {selected.members} 檔有行情</p>
            <div className="city-stat-pair"><div><small>法人{kindLabel(kind)}</small><strong className={signClass(groupFlow)}>{money(groupFlow)}</strong></div><div><small>總成交額</small><strong>{money(selected.turnover, false)}</strong></div></div>
            <div className="city-panel-subhead"><h3>成分股 · 法人買賣超</h3><span>{kindLabel(kind)} · 依金額排序</span></div>
            <div aria-live="polite">{failed ? <div className="city-empty">讀取失敗 <button onClick={() => setRetry((n) => n + 1)}>重新載入</button></div> : !detail ? <p className="city-caption" role="status">正在載入成分股…</p> : <>
              {detail.date !== date ? <p className="city-caption">成分股資料日：{detail.date ?? "尚無行情"}</p> : null}
              {members.length ? <FlowBars label="成分股法人買賣超" rows={members.map((m) => ({ id: m.assetId, name: m.name, sub: `${m.symbol}${m.held ? " · 我的持股" : ""}`, value: flowValue(m.flow, kind) }))} activeId={stockId} onPick={setStockId}/> : <p className="city-caption">目前沒有成分股資料。</p>}
              {selectedStock ? <div className="city-stock-detail"><div className="city-panel-subhead"><h3>{selectedStock.symbol} {selectedStock.name}</h3><button onClick={() => setStockId(null)} aria-label="關閉個股明細">×</button></div>
                <p>收盤 <b>{selectedStock.close ?? "—"}</b> · <b className={signClass(selectedStock.ret)}>{pct(selectedStock.ret)}</b> · 成交 {money(selectedStock.turnover, false)}</p>
                <div className="city-flow-breakdown">{([["foreign", "外資"], ["trust", "投信"], ["dealer", "自營商"]] as const).map(([k, label]) => <div key={k}><span>{label} · 當日／近 20 日</span><b><span className={signClass(selectedStock.flow[k])}>{money(selectedStock.flow[k])}</span> ／ <span className={signClass(selectedStock.flows20[k])}>{money(selectedStock.flows20[k])}</span></b></div>)}</div>
                <small>近 20 日資料不足時顯示 —。</small></div> : null}
              <div className="city-panel-subhead"><h3>{levelName}法人買賣超</h3><span>{detail.flowSeries.length ? "近 20 個交易日" : "回放期間"} · {kindLabel(kind)}</span></div>
              <FlowChart series={detail.flowSeries.length ? detail.flowSeries : overview.replay.map((d, i) => ({ date: d.date, ...(overview.groups.find((g) => g.id === selectedId)?.days[i]?.flow ?? NO_FLOW) }))} kind={kind} date={date ?? ""}/>
            </>}</div>
            <button className="city-back" onClick={closeGroup}>← 合攏，返回{focused?.name ?? "全市場"}</button>
          </> : focused ? <>
            <div className="city-card-head"><h2>{focused.name}</h2><span>產業底板</span><button aria-label="返回全市場" onClick={reset}>×</button></div>
            <p className="city-caption">{date} 收盤 · 共 {focused.totalGroups} 個{levelName}，點積木或下方名稱拆開。</p>
            <div className="city-panel-subhead"><h3>{levelName} · 法人買賣超</h3><span>{kindLabel(kind)}</span></div>
            <FlowBars label={`${focused.name}的${levelName}法人買賣超`} rows={focused.groups.map((b) => ({ id: b.id, name: b.name, sub: `成交 ${money(b.turnover, false)}`, value: b.flow }))} onPick={pick}/>
          </> : <>
            <div className="city-card-head"><h2>大盤</h2><span>TAIEX 加權指數</span></div>
            <div className="city-index">{indexText(day?.index?.value)}<b className={signClass(day?.index?.change ?? null)}>{pct(day?.index?.change ?? null)}</b></div>
            <p className="city-caption">{date ?? "尚未同步"} 收盤{step < last ? " · 回放中" : ""}</p>
            <div className="city-stat-pair"><div><small>市場成交額</small><strong>{money(day?.turnover ?? null, false)}</strong></div><div><small>漲／跌家數</small><strong><span className="city-gain">{day?.upCount ?? 0}</span>／<span className="city-loss">{day?.downCount ?? 0}</span></strong></div></div>
            <div className="city-panel-subhead"><h3>法人買賣超前 5 名{levelName}</h3><span>{kindLabel(kind)}</span></div>
            {leaders.length ? <FlowBars label={`法人買賣超前 5 名${levelName}`} rows={leaders} onPick={pick}/> : <p className="city-caption">這一天的法人資料不足。</p>}
          </>}
        </div>
        <div className="city-search"><label htmlFor="city-search">搜尋{levelName}{focused ? ` · ${focused.name}` : " · 全市場"}</label><input id="city-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="輸入名稱，找到那塊積木…"/>
          {query.trim() ? <div className="city-search-results">{candidates.length ? candidates.map((g) => <button key={g.id} onClick={() => pick(g.id)}><span>{g.name}</span><small>{money(g.turnover, false)} ↗</small></button>) : <p>沒有符合的積木</p>}</div> : null}
        </div>
        <p className="city-panel-note">族群可能重疊，金額不能直接加總成全市場。— 表示資料不足。<Link href="/market#market-reading">閱讀方式 ↗</Link></p>
      </div></aside>
    </div>

    {overview.replay.length > 1 ? <div className="city-timeline">
      <button type="button" className="city-play" onClick={play} aria-label={playing ? "暫停回放" : "播放最近交易日回放"}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{playing ? <path d="M7 5h3.5v14H7z M13.5 5H17v14h-3.5z" fill="currentColor"/> : <path d="M8 5l11 7-11 7z" fill="currentColor"/>}</svg>
      </button>
      <div className="city-timeline-title"><b>回放</b><small>最近 {overview.replay.length} 個交易日</small></div>
      <ol className="city-steps" style={{ "--steps": overview.replay.length - 1 } as CSSProperties}>{overview.replay.map((d, i) => <li key={d.date}><button type="button" aria-current={i === step ? "step" : undefined} onClick={() => jump(i)} aria-label={`${d.date}${i === last ? "（最新收盤）" : ""}`}>
        <i/><span><b>{String(i + 1).padStart(2, "0")}</b>{i === last ? "現在" : shortDate(d.date)}</span>
      </button></li>)}</ol>
      <div className="city-timeline-tools">
        <label><span className="sr-only">回放速度</span><select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[0.5, 1, 2].map((s) => <option key={s} value={s}>{s}x</option>)}</select></label>
        <button type="button" aria-pressed={animated} onClick={() => setAnimated(!animated)}>動畫{animated ? "開" : "關"}</button>
      </div>
    </div> : null}
    <div className="city-legend" aria-label="積木資料圖例">
      <span><i className="city-key city-key-in"/>法人買超</span><span><i className="city-key city-key-out"/>法人賣超</span><span><i className="city-key city-key-light"/>淺色＝幅度小</span><span><i className="city-key city-key-zero"/>零</span><span><i className="city-key city-key-missing"/>缺值</span>
      <p><b>底板</b>＝產業　<b>積木塔</b>＝{levelName}　<b>占地</b>＝成交額　<b>層數</b>＝法人{kindLabel(kind)}幅度（相對 1–6 級，整段回放同一比例）</p>
    </div>
  </section>;
}
