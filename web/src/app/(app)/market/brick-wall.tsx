"use client";

import { useEffect, useMemo, useState } from "react";
import { QUADRANT_LABEL, type Quadrant } from "@/lib/market/rotation";
import type { RotationDto, RotationNode } from "@/lib/services/market";

/**
 * 積木牆：依板塊分列，每塊積木是一個族群（或產業、板塊）。
 * - 寬度＝成交金額（5 日平均，開根號，比較小的也看得到名字）；顏色＝選的數字（漲跌、強度、法人、象限）。
 * - 漲（或高於基準）是實心紅積木、越深越多；跌是半透明虛線綠積木（色盲也分得出實心／空心）；接近 0 是灰色。
 * - 動畫：積木一列一列掉進牆裡、換顏色時漸變、回放時一天一格重新上色（系統設定減少動態時關掉）。
 * 積木是按鈕，可以用鍵盤選；完整數字在下方表格。
 */

export type WallMetric = "ret" | "ret5" | "ret20" | "strength" | "flow1" | "flow5" | "quadrant";
export const WALL_METRICS: { id: WallMetric; label: string }[] = [
  { id: "ret", label: "今天漲跌" },
  { id: "ret5", label: "5 日漲跌" },
  { id: "ret20", label: "20 日漲跌" },
  { id: "strength", label: "強度" },
  { id: "flow1", label: "法人（當日）" },
  { id: "flow5", label: "法人（5 日）" },
  { id: "quadrant", label: "象限" },
];

const UP = ["#ffd9d9", "#ffaaaa", "#ff7d7d"];
const DOWN_ALPHA = [0.14, 0.28, 0.45];
const DOWN = "#5cc99a";
const FLAT = "#8fa3b8";
const QUAD: Record<Quadrant, { bg: string; fg: string }> = {
  leading: { bg: "#187F7C", fg: "#F5F0E5" },
  improving: { bg: "#8ED6CF", fg: "#173451" },
  weakening: { bg: "#F5D548", fg: "#173451" },
  lagging: { bg: "#4A5F75", fg: "#F5F0E5" },
};

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
const pct = (n: number) => `${sign(n)}${Math.abs(n * 100).toFixed(1)}%`;
const yi = (n: number) => `${sign(n)}${Math.abs(n / 1e8).toFixed(1)} 億`;
const flowTotal = (n: RotationNode, p: 1 | 5) => n.flows[p].foreign + n.flows[p].trust + n.flows[p].dealer;

/** 數值 → 方向與深淺（0 是接近 0） */
function bin(v: number | null, t: [number, number, number]): { dir: 1 | -1 | 0; level: 0 | 1 | 2 } | null {
  if (v === null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a < t[0]) return { dir: 0, level: 0 };
  return { dir: v > 0 ? 1 : -1, level: a >= t[2] ? 2 : a >= t[1] ? 1 : 0 };
}

interface Look {
  style: React.CSSProperties;
  fg: string;
  glass: boolean;
  value: string;
  mood: "smile" | "sad" | "flat" | null;
}

function look(n: RotationNode, metric: WallMetric, frameRet: number | null | undefined): Look {
  if (metric === "quadrant") {
    const q = n.quadrant ? QUAD[n.quadrant] : { bg: "#2a4560", fg: "#B9C7D6" };
    return { style: { background: q.bg }, fg: q.fg, glass: false, value: n.quadrant ? QUADRANT_LABEL[n.quadrant].slice(0, 2) : "暖機中", mood: n.quadrant === "leading" ? "smile" : n.quadrant === "lagging" ? "sad" : "flat" };
  }
  let v: number | null;
  let t: [number, number, number];
  let value: string;
  switch (metric) {
    case "ret":
      v = frameRet !== undefined ? frameRet : n.ret;
      t = [0.002, 0.01, 0.025];
      value = v === null ? "—" : pct(v);
      break;
    case "ret5":
      v = n.ret5;
      t = [0.005, 0.02, 0.05];
      value = v === null ? "—" : pct(v);
      break;
    case "ret20":
      v = n.ret20;
      t = [0.01, 0.04, 0.1];
      value = v === null ? "—" : pct(v);
      break;
    case "strength":
      v = n.strength === null ? null : n.strength - 100;
      t = [0.5, 2, 5];
      value = n.strength === null ? "暖機中" : n.strength.toFixed(1);
      break;
    case "flow1":
      v = n.turnover > 0 ? flowTotal(n, 1) / n.turnover : null;
      t = [0.005, 0.02, 0.05];
      value = yi(flowTotal(n, 1));
      break;
    case "flow5":
      v = n.turnover5Avg > 0 ? flowTotal(n, 5) / (n.turnover5Avg * 5) : null;
      t = [0.005, 0.02, 0.05];
      value = yi(flowTotal(n, 5));
      break;
  }
  const b = bin(v, t);
  if (!b || b.dir === 0) return { style: { background: FLAT }, fg: "#173451", glass: false, value, mood: b ? "flat" : null };
  if (b.dir > 0) return { style: { background: UP[b.level] }, fg: "#173451", glass: false, value, mood: "smile" };
  return {
    style: { background: `rgba(92, 201, 154, ${DOWN_ALPHA[b.level]})`, borderColor: DOWN, borderStyle: "dashed" },
    fg: "#F5F0E5",
    glass: true,
    value,
    mood: "sad",
  };
}

function Face({ mood, color }: { mood: "smile" | "sad" | "flat"; color: string }) {
  return (
    <svg viewBox="-14 -8 28 16" className="h-4 w-7 shrink-0" aria-hidden="true">
      <circle cx={-6} cy={-2.5} r={2} fill={color} />
      <circle cx={6} cy={-2.5} r={2} fill={color} />
      {mood === "smile" ? (
        <>
          <path d="M -4 1.5 Q 0 5.5 4 1.5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
          <ellipse cx={-10.5} cy={1.5} rx={2.4} ry={1.4} fill="rgba(255,255,255,0.55)" />
          <ellipse cx={10.5} cy={1.5} rx={2.4} ry={1.4} fill="rgba(255,255,255,0.55)" />
        </>
      ) : mood === "sad" ? (
        <path d="M -4 5 Q 0 1.5 4 5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      ) : (
        <path d="M -3.5 3.5 L 3.5 3.5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      )}
    </svg>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function BrickWall({
  data,
  metric,
  selectedId,
  onSelect,
  frameDate,
  onlyHeld,
}: {
  data: RotationDto;
  metric: WallMetric;
  selectedId: string | null;
  onSelect: (id: string) => void;
  frameDate: string | null;
  onlyHeld: boolean;
}) {
  const reduced = useReducedMotion();
  const parents = useMemo(() => new Map(data.parents.map((p) => [p.id, p])), [data.parents]);

  // 依板塊分列（族群的上層可能是產業或直接是板塊；板塊層級時全部放一列）
  const rows = useMemo(() => {
    const sectorOf = (n: RotationNode): string => {
      if (n.level === "sector") return "all";
      let id = n.parentId;
      while (id && parents.get(id)?.level === "industry") id = parents.get(id)!.parentId;
      return id ?? "sector-other";
    };
    const groups = new Map<string, RotationNode[]>();
    for (const n of data.nodes) {
      if (onlyHeld && !n.held) continue;
      const s = sectorOf(n);
      groups.set(s, [...(groups.get(s) ?? []), n]);
    }
    return [...groups.entries()]
      .map(([id, nodes]) => ({
        id,
        name: id === "all" ? "全部板塊" : parents.get(id)?.name ?? "其他",
        order: parents.get(id)?.sortOrder ?? 999,
        nodes: nodes.sort((a, b) => b.turnover5Avg - a.turnover5Avg),
        turnover: nodes.reduce((s, n) => s + n.turnover5Avg, 0),
      }))
      .sort((a, b) => b.turnover - a.turnover || a.order - b.order);
  }, [data.nodes, parents, onlyHeld]);

  const maxW = Math.max(1, ...data.nodes.map((n) => Math.sqrt(n.turnover5Avg)));
  // 成交金額前 12 大的積木有小臉
  const faceIds = useMemo(() => new Set([...data.nodes].sort((a, b) => b.turnover5Avg - a.turnover5Avg).slice(0, 12).map((n) => n.id)), [data.nodes]);

  let index = 0;
  return (
    <div className="grid gap-5">
      {rows.map((row, r) => (
        <div key={row.id} className="grid gap-2 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-4">
          <div className="pt-3">
            <p className="font-display text-xs font-bold tracking-[0.1em] text-cream">{row.name}</p>
            <p className="mt-0.5 text-[11px] text-on-navy-2">{row.nodes.length} 個</p>
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-3">
            {row.nodes.map((n) => {
              const frameRet = frameDate ? n.trail.find((t) => t.date === frameDate)?.ret ?? null : undefined;
              const lk = look(n, metric, frameRet);
              const weight = Math.sqrt(n.turnover5Avg) / maxW;
              const delay = reduced ? undefined : `${Math.min(r * 90 + index++ * 10, 1200)}ms`;
              const selected = n.id === selectedId;
              return (
                <div key={n.id} className={reduced ? "" : "brick"} style={{ flex: `${0.4 + weight * 3} 1 ${Math.round(56 + weight * 150)}px`, animationDelay: delay }}>
                  <button
                    type="button"
                    onClick={() => onSelect(n.id)}
                    aria-pressed={selected}
                    title={`${n.name}：${lk.value}${n.held ? "（含我的持股）" : ""}`}
                    className="wall-brick group relative block h-[60px] w-full min-w-0 rounded-[7px] border-[2.5px] border-[#0d2236] px-2.5 text-left"
                    style={{
                      ...lk.style,
                      color: lk.fg,
                      outline: selected ? "3px solid #F5F0E5" : n.held ? "3px solid #F5D548" : undefined,
                      outlineOffset: 2,
                      transition: reduced ? undefined : "background-color 450ms ease, transform 160ms ease-out",
                    }}
                  >
                    {/* 凸點：沿上緣重複的半橢圓，跟積木同色 */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -top-[9px] left-2 right-2 h-[8px]"
                      style={{
                        backgroundImage: lk.glass
                          ? `radial-gradient(ellipse 9px 8px at 50% 100%, rgba(92,201,154,0.35) 85%, transparent 90%)`
                          : `radial-gradient(ellipse 9px 8px at 50% 100%, ${String(lk.style.background)} 85%, transparent 90%)`,
                        backgroundSize: "24px 8px",
                        backgroundRepeat: "repeat-x",
                        transition: reduced ? undefined : "background-image 450ms ease",
                      }}
                    />
                    <span className="flex h-full items-center justify-between gap-1.5 overflow-hidden">
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-black leading-tight">
                          {n.held ? "★ " : ""}
                          {n.name}
                        </span>
                        <span className="num mt-0.5 block truncate text-[12px] opacity-90">{lk.value}</span>
                      </span>
                      {faceIds.has(n.id) && lk.mood ? <Face mood={lk.mood} color={lk.fg} /> : null}
                    </span>
                  </button>
                </div>
              );
            })}
            {/* 看不見的空格：吃掉最後一行剩下的寬度，最後幾塊才不會被拉長（寬度要代表成交金額） */}
            <div aria-hidden="true" style={{ flex: "1000 1 0px" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
