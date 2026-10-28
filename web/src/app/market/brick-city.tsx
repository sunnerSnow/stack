"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import Link from "next/link";
import "./brick-city.css";
import { buildCityDistricts, cityScale, OVERVIEW_TOWERS, type CityBuilding, type CityDistrict, type FlowKind } from "@/lib/market/city-layout";
import { flowValue } from "@/lib/market/flows";
import { replayMembers, type FlyoutMember } from "@/lib/market/replay-members";
import type { GroupDetailDto } from "@/lib/services/market";
import type { MarketOverviewDto } from "@/lib/services/market-overview";
import { arrangeIslands, corners, flyoutSpots, grid, ITEM, iso, islandBox, islandSilhouettes, PLATE_H, plates, R, shift, slotAt, union, type Box, type Point, type Rect, type Shape } from "./islands";

const INK = "#173451", SUN = "#F5D548", SEA = "#187F7C", CREAM = "#F5F0E5", PAPER = "#FFFDF8";
const BUY = "#D9534F", BUY_LT = "#F2A79E", SEA_LT = "#8ED6CF", MISSING = "#C9D0D8", TREE = "#5E8C61", ACTIVE_GROUND = "#F8E7A0", TERRACE_GROUND = "#EFE5CF";
const SLOT = 130, LAYER = 28, PAGE = 9, TOWER_ROOM = 90, MOVE = 700, MARKET = "market";
type Place = Point & { s: number; back: boolean };
/** The market square in the middle, and its screen bounds with the index line and flag. */
const PLAZA = 430;
const HUB: Box = { x0: -PLAZA / 2 - 6, y0: -PLAZA * R / 2 - 40, x1: PLAZA / 2 + 6, y1: PLAZA * R / 2 + 50 };
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

const ICONS = {
  chip: "M8 8h8v8H8z M10 4v4 M14 4v4 M10 16v4 M14 16v4 M4 10h4 M4 14h4 M16 10h4 M16 14h4",
  bag: "M5 9h14l-1.2 11H6.2z M9 9V7a3 3 0 0 1 6 0v2",
  bank: "M3 9 12 4l9 5z M6 11v6 M10 11v6 M14 11v6 M18 11v6 M3 20h18",
  cross: "M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z",
  ore: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5 12 12l8-4.5 M12 12v9",
  ship: "M3 15h18l-3 5H6z M6 15V9h7v6 M13 12h5v3 M9 9V5",
  dots: "M5 5h5v5H5z M14 5h5v5h-5z M5 14h5v5H5z M14 14h5v5h-5z",
};
type Address = { angle: number; reach: number; ground: string; icon: keyof typeof ICONS };
// Each category has its own bearing and distance from the market square (degrees, 0 = right, clockwise), so
// the islands form a loose ring rather than a grid. Bearing and ground colour encode category only.
const ADDRESSES: Record<string, Address> = {
  "電子科技": { angle: -146, reach: 1, ground: "#E6E1D3", icon: "chip" },
  "其他": { angle: -88, reach: .82, ground: "#E3DED3", icon: "dots" },
  "民生消費": { angle: -34, reach: 1.04, ground: "#E8DCCB", icon: "bag" },
  "金融": { angle: 8, reach: .9, ground: "#D8DEE6", icon: "bank" },
  "原物料": { angle: 56, reach: 1.02, ground: "#DDD8C6", icon: "ore" },
  "生技醫療": { angle: 104, reach: .86, ground: "#D3E3D2", icon: "cross" },
  "工業與運輸": { angle: 158, reach: 1.06, ground: "#CFDDEA", icon: "ship" },
};
const SPARE_ANGLES = [205, 250, -190, 290];
const GROUNDS = [...new Set([...Object.values(ADDRESSES).map((a) => a.ground), CREAM, ACTIVE_GROUND])];
const studsId = (ground: string) => `city-studs-${ground.slice(1)}`;
const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const towerHeight = (b: CityBuilding) => b.layers === 0 ? 12 : Math.max(1, b.layers ?? 1) * LAYER;
const diamond = (w: number) => `${-w / 2},0 0,${-w * R / 2} ${w / 2},0 0,${w * R / 2}`;
const poly = (points: Point[]) => points.map((p) => `${p.x},${p.y}`).join(" ");
const inset = (r: Rect, d: number): Rect => ({ s0: r.s0 + d, s1: r.s1 - d, t0: r.t0 + d, t1: r.t1 - d });

type Island = { id: string; address: Address; shape: Shape; at: Point };
/** Size each island by its towers, turn some of them, put the terrace on the outer side, then place them on the ring. */
function planIslands(districts: CityDistrict[]): Map<string, Island> {
  let spare = 0;
  const entries = districts.map((d) => {
    const address = ADDRESSES[d.name] ?? { angle: SPARE_ANGLES[spare++ % SPARE_ANGLES.length], reach: 1.1, ground: CREAM, icon: "dots" as const };
    const seed = hash(d.id), lean = Math.cos(address.angle * Math.PI / 180);
    const shape: Shape = { ...grid(Math.min(OVERVIEW_TOWERS, d.totalGroups), (seed & 1) === 1), slot: SLOT, terrace: lean < -.2 ? "left" : lean > .2 ? "right" : seed & 2 ? "left" : "right" };
    return { id: d.id, address, shape, box: islandBox(shape, TOWER_ROOM) };
  });
  const placed = arrangeIslands(entries.map((e) => ({ id: e.id, angle: e.address.angle, reach: e.address.reach, box: e.box })), HUB, { x: 540, y: 330 }, 14);
  return new Map(entries.map((e) => [e.id, { id: e.id, address: e.address, shape: e.shape, at: placed.get(e.id)! }]));
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

/** A rectangular slab in the isometric plane; its top sits at y = 0 and its sides drop by h. */
function Slab({ rect, h, fill }: { rect: Rect; h: number; fill: string }) {
  const [n, e, s, w] = corners(rect);
  const down = (p: Point) => ({ x: p.x, y: p.y + h });
  return <g stroke={INK} strokeWidth="1.5" strokeLinejoin="round">
    <polygon points={poly([w, s, down(s), down(w)])} fill={fill}/>
    <polygon points={poly([w, s, down(s), down(w)])} fill={INK} opacity=".18" stroke="none"/>
    <polygon points={poly([s, e, down(e), down(s)])} fill={fill}/>
    <polygon points={poly([s, e, down(e), down(s)])} fill={INK} opacity=".32" stroke="none"/>
    <polygon points={poly([n, e, s, w])} fill={fill}/>
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

function Tower({ building, selected, pick }: { building: CityBuilding; selected: boolean; pick: () => void }) {
  const layers = Math.max(1, building.layers ?? 0);
  const w = 74 * building.footprint, d = w * R;
  const h = building.layers === 0 ? 12 : LAYER;
  const fill = tone(building.flow, building.layers ?? 0);
  return <g className={`city-tower ${selected ? "is-selected" : ""}`} role="button" tabIndex={0} aria-label={`查看族群 ${building.name}`} aria-pressed={selected}
    onClick={pick} onKeyDown={press(pick)} data-city-action="true">
    <title>{`${building.name} · 法人 ${money(building.flow)} · 成交額 ${money(building.turnover, false)}`}</title>
    <ellipse cy={d * .2} rx={w * .62} ry={d * .42} fill={INK} opacity=".14"/>
    {selected ? <polygon points={diamond(w + 18)} fill="none" stroke={SUN} strokeWidth="5"/> : null}
    {Array.from({ length: layers }, (_, i) => <g key={i} transform={`translate(0 ${-(i + 1) * h})`}>
      <Block w={w} d={d} h={h} fill={fill} studs={i === layers - 1} ghost={building.flow === null}/>
    </g>)}
    <text y={-layers * h - d / 2 - 14} textAnchor="middle" className="city-tower-name">{building.name}</text>
  </g>;
}

/** The island's low name plate, standing on its terrace so it never hides the towers behind. */
function Signboard({ name, icon, note }: { name: string; icon: keyof typeof ICONS; note: string }) {
  const w = 76 + name.length * 29, pill = 22 + note.length * 9.5;
  return <g aria-hidden="true">
    <ellipse cy="2" rx={w / 2 - 10} ry="7" fill={INK} opacity=".16"/>
    {[-1, 1].map((side) => <path key={side} d={`M ${side * (w / 2 - 28)} 2 V -10`} stroke={INK} strokeWidth="5" strokeLinecap="round"/>)}
    <g transform="translate(0 -34)">
      <rect x={-w / 2} y="-25" width={w} height="50" rx="12" fill={INK} stroke={PAPER} strokeWidth="2.5"/>
      <rect x={-w / 2 + 5} y="-20" width={w - 10} height="40" rx="9" fill="none" stroke="#35587e" strokeWidth="1.5"/>
      <path transform={`translate(${-w / 2 + 15} -13) scale(1.1)`} d={ICONS[icon]} fill="none" stroke={CREAM} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      <text x={-w / 2 + 52} y="10" fill={CREAM} fontSize="29" fontWeight="900">{name}</text>
      <g transform={`translate(${w / 2 - pill + 14} 13)`}>
        <rect width={pill} height="25" rx="12.5" fill={SUN} stroke={INK} strokeWidth="2"/>
        <text x={pill / 2} y="17.5" textAnchor="middle" fill={INK} fontSize="14.5" fontWeight="800">{note}</text>
      </g>
    </g>
  </g>;
}

function IslandView({ district, shape, address, selectedId, note, onFocus, onPick }: {
  district: CityDistrict; shape: Shape; address: Address; selectedId: string | null; note: string; onFocus: () => void; onPick: (id: string) => void;
}) {
  const { main, terrace } = plates(shape);
  const active = district.groups.some((b) => b.id === selectedId);
  const ground = active ? ACTIVE_GROUND : address.ground;
  const outline = [...corners(main), ...corners(terrace)];
  const x0 = Math.min(...outline.map((p) => p.x)), x1 = Math.max(...outline.map((p) => p.x));
  const y0 = Math.min(...outline.map((p) => p.y)), y1 = Math.max(...outline.map((p) => p.y));
  const items = Array.from({ length: shape.cols * shape.rows }, (_, i) => ({ i, building: district.groups[i] as CityBuilding | undefined, ...slotAt(shape, i) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const deck = { s: (terrace.s0 + terrace.s1) / 2, t: (terrace.t0 + terrace.t1) / 2 };
  const trees = (shape.terrace === "right" ? [iso(deck.s, terrace.t0 + 30), iso(deck.s, terrace.t1 - 30)] : [iso(terrace.s0 + 30, deck.t), iso(terrace.s1 - 30, deck.t)]);
  const sign = iso(deck.s, deck.t);
  return <g>
    <g role="button" tabIndex={0} aria-label={`展開 ${district.name}`} onClick={onFocus} onKeyDown={press(onFocus)} data-city-action="true" className="city-base">
      <ellipse cx={(x0 + x1) / 2} cy={y1 + 18} rx={(x1 - x0) * .42} ry={(y1 - y0) * .22} fill={INK} opacity=".07"/>
      <Slab rect={main} h={PLATE_H} fill={INK}/>
      <g transform="translate(0 -5)">
        <Slab rect={inset(main, 9)} h={5} fill={ground}/>
        <polygon points={poly(corners(inset(main, 16)))} fill={`url(#${studsId(ground)})`}/>
      </g>
      <g transform="translate(0 10)">
        <Slab rect={terrace} h={PLATE_H - 10} fill={INK}/>
        <g transform="translate(0 -5)"><Slab rect={inset(terrace, 8)} h={5} fill={TERRACE_GROUND}/></g>
      </g>
      {active ? <polygon transform="translate(0 -5)" points={poly(corners(inset(main, 4)))} fill="none" stroke={SUN} strokeWidth="7" className="city-plate-glow"/> : null}
    </g>
    {items.map(({ i, building, x, y }) => <g key={building?.id ?? `tree:${i}`} transform={`translate(${x} ${y - 5})`}>
      {building ? <Tower building={building} selected={selectedId === building.id} pick={() => onPick(building.id)}/>
        : i % 2 ? <Tree x={0} y={4} s={1.1}/> : <><Tree x={-16} y={-2}/><Tree x={14} y={8} s={.85}/></>}
    </g>)}
    <g transform="translate(0 5)">{trees.map((p) => <Tree key={`${p.x}:${p.y}`} x={p.x} y={p.y} s={.9}/>)}</g>
    <g transform={`translate(${sign.x} ${sign.y + 5})`} className="city-district-sign" onClick={onFocus} data-city-action="true">
      <Signboard name={district.name} icon={address.icon} note={note}/>
    </g>
  </g>;
}

/**
 * A dashed footpath between two blocks. It is one unit-long curve stretched onto its ends by a single
 * transform, so it glides along with the blocks when they move; strokes keep their width while stretched.
 */
function Trail({ from, to, bend }: { from: Point; to: Point; bend: number }) {
  const dx = to.x - from.x, dy = to.y - from.y, gone = Math.hypot(dx, dy) < 1;
  const d = `M 0 0 Q .5 ${bend} 1 0`;
  return <g aria-hidden="true" className="city-trail-run" opacity={gone ? 0 : 1}
    style={{ transform: gone ? `matrix(1, 0, 0, 1, ${from.x}, ${from.y})` : `matrix(${dx}, ${dy}, ${-dy}, ${dx}, ${from.x}, ${from.y})` }}>
    <path d={d} className="city-trail" vectorEffect="non-scaling-stroke"/><path d={d} className="city-trail-dash" vectorEffect="non-scaling-stroke"/>
  </g>;
}

function Plaza({ value, change, onClick }: { value: string | undefined; change: number | null; onClick: () => void }) {
  return <g className="city-market" role="button" tabIndex={0} aria-label="查看大盤摘要" onClick={onClick} onKeyDown={press(onClick)} data-city-action="true">
    <ellipse cy={PLAZA * R / 2 + 40} rx={PLAZA * .56} ry="32" fill={INK} opacity=".1"/>
    <Block w={PLAZA} d={PLAZA * R} h={36} fill={INK} studs={false}/>
    <polygon points={diamond(PLAZA - 20)} fill={`url(#${studsId(INK)})`}/>
    {[[-166, 4], [166, 4], [0, -92], [-80, 76], [82, 76], [-118, -40], [120, -42]].map(([x, y]) => <g key={`${x}:${y}`} transform={`translate(${x} ${y - 12})`}><Block w={38} d={38 * R} h={13} fill={SUN}/></g>)}
    <path d="M 118 -40 V -122" stroke={INK} strokeWidth="3.5" strokeLinecap="round"/><path d="M 120 -122 L 158 -110 L 120 -98 Z" fill={SUN} stroke={INK} strokeWidth="2" strokeLinejoin="round"/>
    <text y="-2" textAnchor="middle" fill={CREAM} stroke="#0d2136" strokeWidth="11" paintOrder="stroke" fontSize="76" fontWeight="900" letterSpacing="6">大盤</text>
    <text y="46" textAnchor="middle" fill={SUN} fontSize="27" fontWeight="700" className="city-mono">{indexText(value)} · {pct(change)}</text>
  </g>;
}

const EXPAND = 850, STAGGER = 120, BURST = 1400, COLLAPSE = 240, SPARK_LINK = 130, BRICK_LINK = 340;
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Seeded random numbers, so a group always bursts the same way. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const reducedMotion = (onChange: () => void) => {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * A group opening up, played once per selection: a burst of particles leaves the tower while its stocks travel
 * out to the free space beside the island, and anything within reach links up — the nearer, the clearer the
 * line. Once settled only the tower and its stocks stay linked; on close the stocks fold back into the tower.
 */
function Constellation({ seed, anchor, members, spots, kind, stockId, motion, closing, startAt, pending, onPick }: {
  seed: number; anchor: Point; members: FlyoutMember[]; pending: boolean; spots: Point[]; kind: FlowKind; stockId: string | null; motion: boolean; closing: boolean;
  /** performance.now() at which the island has reached centre stage; the burst waits for it. */
  startAt: number; onPick: (id: string) => void;
}) {
  const settled = BURST + STAGGER * spots.length;
  const [elapsed, setElapsed] = useState(0);
  const [folding, setFolding] = useState(0);
  useEffect(() => {
    if (!motion) return;
    const begin = closing ? performance.now() : Math.max(performance.now(), startAt);
    let frame = 0;
    const tick = (now: number) => {
      const time = now - begin;
      if (closing) setFolding(Math.min(1, time / COLLAPSE)); else setElapsed(Math.max(0, time));
      if (time < (closing ? COLLAPSE : settled)) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [motion, closing, settled, startAt]);
  const sparks = useMemo(() => {
    const next = seeded(seed);
    return Array.from({ length: 26 }, () => ({ angle: next() * Math.PI * 2, reach: 70 + next() * 200, size: 1.8 + next() * 2, life: BURST * (.6 + next() * .4), tint: next() }));
  }, [seed]);
  const t = motion ? elapsed : settled;
  const fold = motion && closing ? folding ** 2 : 0;
  const bricks = members.slice(0, spots.length).map((m, i) => {
    const p = easeOut(clamp01((t - i * STAGGER) / EXPAND)) * (1 - fold);
    const s = .35 + .65 * p;
    const x = anchor.x + (spots[i].x - anchor.x) * p, y = anchor.y + (spots[i].y - anchor.y) * p - Math.sin(Math.PI * p) * 60;
    return { m, p, s, x, y, node: { x, y: y + 18 * s } };
  });
  const dust = sparks.map((k) => {
    const age = clamp01(t / k.life), drift = easeOut(age);
    return { ...k, x: anchor.x + Math.cos(k.angle) * k.reach * drift, y: anchor.y + Math.sin(k.angle) * k.reach * .7 * drift, alpha: (1 - age) * Math.min(1, t / 90) * (1 - fold) };
  }).filter((k) => k.alpha > .02);
  const links: { a: Point; b: Point; alpha: number; width: number }[] = [];
  for (const b of bricks) {
    if (b.p <= 0) continue;
    const d = Math.hypot(b.node.x - anchor.x, b.node.y - anchor.y);
    links.push({ a: anchor, b: b.node, alpha: Math.max(.22, Math.min(.75, 1 - d / 900)) * clamp01(b.p * 3), width: 2 });
  }
  bricks.forEach((a, i) => bricks.slice(i + 1).forEach((b) => {
    const d = Math.hypot(a.node.x - b.node.x, a.node.y - b.node.y);
    if (d < BRICK_LINK && a.p > 0 && b.p > 0) links.push({ a: a.node, b: b.node, alpha: (1 - d / BRICK_LINK) * .55 * Math.min(a.p, b.p), width: 1.4 });
  }));
  const nodes = [anchor, ...bricks.filter((b) => b.p > 0).map((b) => b.node)];
  dust.forEach((k, i) => {
    for (const other of [...dust.slice(i + 1), ...nodes]) {
      const d = Math.hypot(k.x - other.x, k.y - other.y);
      if (d < SPARK_LINK) links.push({ a: k, b: other, alpha: (1 - d / SPARK_LINK) * .5 * k.alpha, width: 1 });
    }
  });
  return <g className="city-constellation">
    <g aria-hidden="true">
      {links.map((l, i) => <line key={i} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} stroke={INK} strokeOpacity={l.alpha} strokeWidth={l.width} strokeLinecap="round"/>)}
      {dust.map((k, i) => <circle key={i} cx={k.x} cy={k.y} r={k.size} fill={k.tint < .5 ? INK : k.tint < .8 ? SEA : SUN} fillOpacity={k.alpha} stroke={k.tint >= .8 ? INK : "none"} strokeOpacity={k.alpha * .6}/>)}
      {t > 0 ? <circle cx={anchor.x} cy={anchor.y} r="7" fill={SUN} stroke={INK} strokeWidth="2" opacity={1 - fold}/> : null}
    </g>
    {bricks.map(({ m, p, s, x, y }) => {
      const value = flowValue(m.flow, kind);
      const pick = () => onPick(m.assetId);
      const on = stockId === m.assetId;
      return <g key={m.assetId} transform={`translate(${x} ${y}) scale(${s})`} opacity={clamp01(p * 2.5)} className="city-stock"
        role="button" tabIndex={0} aria-label={`查看個股 ${m.symbol} ${m.name}`} aria-pressed={on} onClick={pick} onKeyDown={press(pick)} data-city-action="true">
        <rect x={-ITEM.w / 2} y="-66" width={ITEM.w} height="56" rx="12" fill={PAPER} stroke={on ? INK : "#D9CDB8"} strokeWidth={on ? 2.5 : 1.5}/>
        <text y="-40" textAnchor="middle" fontSize="25" fontWeight="900" fill={INK}>{m.name}</text>
        <text y="-18" textAnchor="middle" fontSize="16" fill="#4a5f75" className="city-mono">{m.symbol} · {pending ? "載入中" : money(value)}</text>
        <g transform="translate(0 18)"><Block w={84} d={84 * R} h={28} fill={on ? SUN : tone(value)} ghost={value === null}/></g>
      </g>;
    })}
  </g>;
}

/** Diverging bars around zero: buying extends right, selling left. */
export function FlowBars({ rows, activeId, onPick, label }: { rows: { id: string; name: string; sub?: string; value: number | null }[]; activeId?: string | null; onPick: (id: string) => void; label: string }) {
  const sorted = [...rows].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const pos = Math.max(0, ...rows.map((r) => r.value ?? 0)), neg = Math.max(0, ...rows.map((r) => -(r.value ?? 0)));
  const span = pos + neg || 1, axis = neg / span * 100;
  return <div className="city-bars" role="group" aria-label={label}>{sorted.map((r) => {
    const width = r.value === null ? 0 : Math.abs(r.value) / span * 100;
    return <button key={r.id} aria-pressed={activeId === r.id} onClick={() => onPick(r.id)}>
      <span className="city-bar-name"><b>{r.name}</b>{r.sub ? <small>{r.sub}</small> : null}</span>
      <span className="city-bar-track" style={{ "--axis": `${axis}%` } as CSSProperties}>
        {r.value === null ? <i className="is-missing"/> : r.value === 0 ? null : <i className={r.value >= 0 ? "is-buy" : "is-sell"} style={{ left: `${r.value < 0 ? axis - width : axis}%`, width: `${Math.max(width, .6)}%` }}/>}
      </span>
      <b className={`city-bar-value ${signClass(r.value)}`}>{money(r.value)}</b>
    </button>;
  })}</div>;
}

export function FlowChart({ series, kind, date }: { series: GroupDetailDto["flowSeries"]; kind: FlowKind; date: string }) {
  const recent = series.filter((r) => r.date <= date).slice(-20);
  if (!recent.length) return <p className="city-caption">法人每日紀錄仍在累積。</p>;
  const values = recent.map((r) => flowValue(r, kind));
  const max = Math.max(...values.map((v) => Math.abs(v ?? 0))) || 1;
  const W = 250, H = 66, bw = W / recent.length;
  return <svg className="city-chart" viewBox={`0 0 ${W + 22} ${H}`} role="img" aria-label={`近 ${recent.length} 個交易日法人${kindLabel(kind)}買賣超`}>
    <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#C9BFAE"/>
    {values.map((v, i) => {
      const h = v === null ? 0 : Math.max(1, Math.abs(v) / max * (H / 2 - 3));
      return v === 0 ? null : v === null ? <rect key={recent[i].date} x={i * bw + bw * .2} width={bw * .6} y={H / 2 - 1} height="2" fill={MISSING}/>
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
  // The focus the draw order has caught up with, and when the last island set off for the middle.
  const [stackFocus, setStackFocus] = useState<string | null>(null);
  const [movedAt, setMovedAt] = useState(0);
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
  // Island shapes and places depend only on the categories and how many towers each carries.
  const islands = useMemo(() => planIslands(buildCityDistricts(overview.groups, level)), [overview.groups, level]);
  const focused = districts.find((d) => d.id === focus);
  const selected = groups.find((g) => g.id === selectedId);
  const key = `${selectedId}:${date}:${retry}`;
  const detail = response?.key === key ? response.data : undefined;
  const failed = response?.key === key && response.error;
  const focusedIds = new Set(focused?.groups.map((g) => g.id));
  const candidates = groups.filter((g) => g.level === level && (!focused || focusedIds.has(g.id)) && g.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => (b.turnover ?? -1) - (a.turnover ?? -1));
  const members = useMemo(() => [...(detail?.members ?? [])].sort((a, b) => (b.turnover ?? -1) - (a.turnover ?? -1)), [detail]);
  // While another replay day loads, the opened group keeps its previous stocks instead of folding and reopening.
  const earlier = response?.key.startsWith(`${selectedId}:`) ? response.data : undefined;
  const flyout = useMemo(() => replayMembers(selectedId, date, detail, earlier), [selectedId, date, detail, earlier]);
  const reduced = useSyncExternalStore(reducedMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
  const motion = animated && !reduced;
  const selectedStock = members.find((m) => m.assetId === stockId);
  const groupFlow = selected ? flowValue(selected.flow, kind) : null;
  const visibleDistrict = focused ? { ...focused, groups: focused.groups.slice(page * PAGE, page * PAGE + PAGE) } : null;
  const overviewDistricts = districts.map((d) => ({ ...d, groups: d.groups.slice(0, OVERVIEW_TOWERS) }));
  const focusIsland = focused ? islands.get(focused.id) : undefined;

  // Each island's outline including its tallest tower on any replayed day, so playback never reframes the city.
  const outlines = useMemo(() => {
    const tops = new Map<string, number>();
    overview.replay.forEach((_, s) => {
      const daily = overview.groups.map((g) => g.days[s] ? { ...g, ...g.days[s], rank: g.turnover } : g);
      for (const d of buildCityDistricts(daily, level, null, null, { kind, scale })) {
        const island = islands.get(d.id);
        if (!island) continue;
        d.groups.slice(0, OVERVIEW_TOWERS).forEach((b, i) => tops.set(d.id, Math.min(tops.get(d.id) ?? 0, slotAt(island.shape, i).y - 5 - towerHeight(b) - 48)));
      }
    });
    return new Map([...islands.values()].map((island) => {
      const box = islandBox(island.shape, 0);
      const top = Math.min(box.y0 - 60, tops.get(island.id) ?? 0);
      return [island.id, { box: shift({ ...box, y0: top }, island.at), room: box.y0 - top }];
    }));
  }, [overview.groups, overview.replay, level, kind, scale, islands]);
  // One frame for every state, so opening an island moves blocks around instead of cutting to another view.
  const frame: Box = (() => { const b = union([HUB, ...[...outlines.values()].map((o) => o.box)]); return { x0: b.x0 - 130, y0: b.y0 - 20, x1: b.x1 + 130, y1: b.y1 + 50 }; })();
  const cityViewBox = `${Math.floor(frame.x0)} ${Math.floor(frame.y0)} ${Math.ceil(frame.x1 - frame.x0)} ${Math.ceil(frame.y1 - frame.y0)}`;

  // The stage. On the ring every block stands at its own place; once an island is opened it takes the market
  // square's place as the protagonist, enlarged, and the rest — square included — step back into a row behind it.
  const stageFor = (lead: string | null) => {
    const stage = new Map<string, Place>();
    const hero = lead ? islands.get(lead) : undefined;
    if (!hero) {
      for (const island of islands.values()) stage.set(island.id, { ...island.at, s: 1, back: false });
      stage.set(MARKET, { x: 0, y: 0, s: 1, back: false });
      return stage;
    }
    const relOf = (id: string) => id === MARKET ? HUB : shift(outlines.get(id)!.box, { x: -islands.get(id)!.at.x, y: -islands.get(id)!.at.y });
    const rel = relOf(hero.id);
    const width = frame.x1 - frame.x0, height = frame.y1 - frame.y0;
    // The hero stands on the square's spot, brought forward toward the viewer.
    const s = Math.max(1, Math.min(2.1, width * .46 / (rel.x1 - rel.x0), height * .62 / (rel.y1 - rel.y0)));
    const hero0 = { x: -s * (rel.x0 + rel.x1) / 2, y: frame.y1 - 40 - s * rel.y1 };
    stage.set(hero.id, { ...hero0, s, back: false });
    // Everything else circles it on an arc from its left, over the top, to its right, each block keeping
    // roughly the side of the hero it stood on in the ring.
    const centre = { x: hero0.x + s * (rel.x0 + rel.x1) / 2, y: hero0.y + s * (rel.y0 + rel.y1) / 2 };
    const rx = s * (rel.x1 - rel.x0) / 2 + 250, ry = s * (rel.y1 - rel.y0) / 2 + 130;
    const rest = [...[...islands.values()].filter((i) => i.id !== hero.id).map((i) => ({ id: i.id, at: i.at, s: .42 })), { id: MARKET, at: { x: 0, y: 0 }, s: .5 }]
      .map((item) => {
        let a = (Math.atan2(item.at.y - hero.at.y, item.at.x - hero.at.x) * 180 / Math.PI + 360) % 360;
        if (a < 160) a += 360;
        if (a > 380) a = a - 380 < 520 - a ? 380 : 160;
        return { ...item, a };
      }).sort((p, q) => p.a - q.a);
    rest.forEach((item, i) => {
      const angle = (160 + (i + .5) * 220 / rest.length) * Math.PI / 180;
      const r = relOf(item.id), hw = item.s * (r.x1 - r.x0) / 2, hh = item.s * (r.y1 - r.y0) / 2;
      const x = Math.max(frame.x0 + hw + 10, Math.min(frame.x1 - hw - 10, centre.x + Math.cos(angle) * rx));
      const y = Math.max(frame.y0 + hh + 40, Math.min(frame.y1 - hh - 10, centre.y + Math.sin(angle) * ry));
      stage.set(item.id, { x: x - item.s * (r.x0 + r.x1) / 2, y: y - item.s * (r.y0 + r.y1) / 2, s: item.s, back: true });
    });
    return stage;
  };
  const places = stageFor(focusIsland?.id ?? null);
  // Draw order follows the stage only once blocks have arrived (stackFocus lags behind focus): moving an
  // element in the DOM mid-way would cut its transition short.
  const settledStage = stageFor(stackFocus && islands.has(stackFocus) ? stackFocus : null);
  const order = [...settledStage].sort(([idA, a], [idB, b]) => (idA === stackFocus ? 1 : 0) - (idB === stackFocus ? 1 : 0) || a.y - b.y || a.x - b.x).map(([id]) => id);

  // Where the selected tower stands on the protagonist, and the free space beside it for the stocks to fly out to.
  const place = focusIsland ? places.get(focusIsland.id)! : null;
  const onStage = (p: Point) => place ? { x: place.x + place.s * p.x, y: place.y + place.s * p.y } : p;
  const hostIndex = visibleDistrict ? visibleDistrict.groups.findIndex((b) => b.id === selectedId) : -1;
  const anchor = focusIsland && visibleDistrict && hostIndex >= 0
    ? onStage({ x: slotAt(focusIsland.shape, hostIndex).x, y: slotAt(focusIsland.shape, hostIndex).y - 5 - towerHeight(visibleDistrict.groups[hostIndex]) }) : null;
  const spots = anchor && focusIsland ? (() => {
    const rel = shift(outlines.get(focusIsland.id)!.box, { x: -focusIsland.at.x, y: -focusIsland.at.y });
    const [a, b] = [onStage({ x: rel.x0, y: rel.y0 }), onStage({ x: rel.x1, y: rel.y1 })];
    // Stocks open out on the side of the island their tower stands on; a tower on the middle line uses the island's bearing.
    const tower = slotAt(focusIsland.shape, hostIndex);
    const side = Math.abs(tower.x) > 1 ? Math.sign(tower.x) : Math.sign(Math.cos(focusIsland.address.angle * Math.PI / 180)) || 1;
    return flyoutSpots({ x0: a.x, y0: a.y, x1: b.x, y1: b.y },
      islandSilhouettes(focusIsland.shape, { x: 0, y: 0 }, outlines.get(focusIsland.id)!.room).map((poly) => poly.map(onStage)),
      // Keep clear of the breadcrumb floating over the top-left of the scene.
      { ...frame, y0: frame.y0 + 50 },
      { x: side, y: -.25 },
      Math.min(4, flyout.length || 4));
  })() : [];

  useEffect(() => {
    if (focus === stackFocus) return;
    const timer = setTimeout(() => setStackFocus(focus), motion ? MOVE : 0);
    return () => clearTimeout(timer);
  }, [focus, stackFocus, motion]);

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
    if (motion) setClosing(true);
    else { setSelectedId(null); setStockId(null); }
  }
  function reset() { setClosing(false); setFocus(null); setSelectedId(null); setStockId(null); setPage(0); setQuery(""); setView({ x: 0, y: 0, scale: 1 }); }
  function focusDistrict(id: string) {
    if (id !== focus) setMovedAt(performance.now());
    setClosing(false); setFocus(id); setSelectedId(null); setStockId(null); setPage(0); setQuery(""); setView({ x: 0, y: 0, scale: 1 });
  }
  function pick(id: string) {
    setClosing(false); setStockId(null);
    // A group always opens on its island at centre stage, on the page that holds it.
    const home = buildCityDistricts(groups, level, null, id).find((d) => d.groups.some((b) => b.id === id));
    if (!home) return;
    if (home.id !== focus) setMovedAt(performance.now());
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
  const statusAt = spots.length ? { x: spots.reduce((s, p) => s + p.x, 0) / spots.length, y: spots.reduce((s, p) => s + p.y, 0) / spots.length } : null;

  return <section className={`brick-city ${motion ? "" : "city-still"}`} aria-label="市場積木城市" onKeyDown={(e) => { if (e.key === "Escape") { if (selectedId) closeGroup(); else reset(); } }}>
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
        {overview.replay.length <= 1 ? <div className="city-timeline-tools"><button type="button" aria-pressed={animated} onClick={() => setAnimated(!animated)}>動畫{animated ? "開" : "關"}</button></div> : null}
        {overview.replay.length ? <label className="city-date">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v14H4z M4 10h16 M8 3v5 M16 3v5 M8 14h2 M12 14h2 M16 14h2 M8 17h2 M12 17h2" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>
          <select aria-label="資料日期" value={step} onChange={(e) => jump(Number(e.target.value))}>{overview.replay.map((d, i) => <option key={d.date} value={i}>{i === last ? "收盤" : "回放"} {d.date}</option>)}</select>
        </label> : null}
      </div>
    </header>

    <div className="city-stage">
      <div className="city-scene-wrap">
        <div className="city-mobile-nav"><div><small>TAIEX · 大盤 {date ? shortDate(date) : ""}</small><strong>{indexText(day?.index?.value)}</strong><b className={signClass(day?.index?.change ?? null)}>{pct(day?.index?.change ?? null)}</b></div><label>選擇產業底板<select aria-label="選擇產業底板" value={focus ?? ""} onChange={(e) => e.target.value ? focusDistrict(e.target.value) : reset()}><option value="">全市場總覽</option>{districts.map((d) => <option value={d.id} key={d.id}>{d.name} · {d.totalGroups} 群</option>)}</select></label></div>
        <nav className="city-breadcrumb" aria-label="城市導覽"><button onClick={reset} aria-current={!focus && !selectedId ? "page" : undefined}>全市場</button>{focused ? <><span>/</span><button onClick={() => focusDistrict(focused.id)} aria-current={!selectedId ? "page" : undefined}>{focused.name}</button></> : null}{selected ? <><span>/</span><span>{selected.name}</span></> : null}<small className="city-hint">點積木塔拆開成分股 · 點名牌展開產業</small></nav>
        <div className="city-scene">
          {overview.groups.length ? <svg ref={svg} role="group" viewBox={cityViewBox} className={`city-svg ${focused ? "city-svg-focused" : ""}`} aria-label={focused ? `${focused.name}的${levelName}積木` : "全市場產業積木城市"}
            onPointerDown={(e) => { if (e.button !== 0 || (e.target as Element).closest("[data-city-action]")) return; const p = point(e); drag.current = { id: e.pointerId, ...p }; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { const prev = drag.current; if (!prev || prev.id !== e.pointerId) return; const p = point(e); setView((v) => ({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y })); drag.current = { id: e.pointerId, ...p }; }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <defs>
              <linearGradient id="city-top-light" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fffdf8" stopOpacity=".34"/><stop offset="1" stopColor="#fffdf8" stopOpacity="0"/></linearGradient>
              {[...GROUNDS, INK].map((g) => <StudPattern key={g} id={studsId(g)} fill={g === INK ? "#2B4C70" : g}/>)}
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {/* Footpaths run from the centre block (the square, or the opened island) to every other block. */}
              <g className="city-trails">{[...places].map(([id, p]) => <Trail key={`trail:${id}`} from={places.get(focusIsland?.id ?? MARKET)!} to={p} bend={hash(id) % 2 ? .08 : -.08}/>)}</g>
              {order.map((id) => {
                const p = places.get(id);
                if (!p) return null;
                const lead = id === focused?.id;
                const district = lead ? visibleDistrict : overviewDistricts.find((d) => d.id === id);
                const island = islands.get(id);
                return <g key={id} className={`city-place ${p.back ? "is-back" : ""} ${lead ? "city-protagonist" : ""}`} style={{ transform: `translate(${p.x}px, ${p.y}px) scale(${p.s})` }}>
                  {id === MARKET ? <Plaza value={day?.index?.value} change={day?.index?.change ?? null} onClick={reset}/>
                    : district && island ? <IslandView district={district} shape={island.shape} address={island.address} selectedId={selectedId} onFocus={() => focusDistrict(id)} onPick={pick}
                      note={lead && focused.groups.length > PAGE ? `${page * PAGE + 1}–${page * PAGE + district.groups.length} / ${focused.totalGroups} 群`
                        : district.totalGroups > Math.min(OVERVIEW_TOWERS, district.groups.length) && !lead ? `${Math.min(OVERVIEW_TOWERS, district.groups.length)}/${district.totalGroups} 群 ›` : `${district.totalGroups} 群${lead ? "" : " ›"}`}/> : null}
                </g>;
              })}
              {selectedId && anchor ? (flyout.length && !failed
                ? <Constellation key={selectedId} seed={hash(selectedId)} anchor={anchor} members={flyout} spots={spots} kind={kind} stockId={stockId} motion={motion} closing={closing} startAt={movedAt + MOVE} pending={!detail} onPick={setStockId}/>
                : statusAt ? <text x={statusAt.x} y={statusAt.y} textAnchor="middle" className="city-flyout-status">{failed ? "資料讀取失敗，請於右側重試" : !detail ? "正在拆開成分股…" : "目前沒有成分股資料"}</text> : null) : null}
            </g>
          </svg> : <div className="city-empty">尚未取得市場行情，資料同步後將自動建立積木城市。</div>}
        </div>
        <div className="city-zoom"><button onClick={() => zoom(.8)} aria-label="縮小城市">−</button><button onClick={() => setView({ x: 0, y: 0, scale: 1 })} aria-label="重設城市視角">{Math.round(view.scale * 100)}%</button><button onClick={() => zoom(1.25)} aria-label="放大城市">＋</button></div>
        {focused && focused.groups.length > PAGE ? <div className="city-pagination" role="group" aria-label={`${focused.name}的${levelName}分頁`}><button disabled={page === 0} onClick={() => turnPage(-1)}>‹ 上一組</button><span>{page * PAGE + 1}–{Math.min((page + 1) * PAGE, focused.groups.length)} / {focused.groups.length}</span><button disabled={(page + 1) * PAGE >= focused.groups.length} onClick={() => turnPage(1)}>下一組 ›</button></div> : null}
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
      <p><b>島</b>＝產業　<b>積木塔</b>＝{levelName}　<b>占地</b>＝成交額　<b>層數</b>＝法人{kindLabel(kind)}幅度（相對 1–6 級，整段回放同一比例）</p>
    </div>
  </section>;
}
