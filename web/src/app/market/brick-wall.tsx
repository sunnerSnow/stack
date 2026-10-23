"use client";

import { useEffect, useMemo, useState } from "react";
import { RowBrick, rowBrickGeometry } from "@/components/bricks";
import { flowValue } from "@/lib/market/flows";
import { QUADRANT_LABEL, type Quadrant } from "@/lib/market/rotation";
import type { RotationDto, RotationNode } from "@/lib/services/market";

/**
 * 積木牆：依板塊分列，每塊積木是一個族群（或產業、板塊）。
 * - 積木跟首頁同一種畫法（粗描邊、頂面基本色、側面較深、凸點有描邊；深色底上用奶油白描邊）。
 * - 長度＝成交金額（5 日平均）：凸點從 2×4 到 2×9；顏色＝選的數字（漲跌、強度、法人、象限）。
 * - 漲（或高於基準）是實心紅積木、越深越多；跌是首頁「下一塊」那種虛線積木（綠色，色盲也分得出）；接近 0 是灰色。
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

const CREAM = "#F5F0E5";
const NAVY = "#173451";
const SUN = "#F5D548";
const UP = ["#ffd2d2", "#ffa3a3", "#ff7a7a"];
const DOWN_LINE = "#5cc99a";
const DOWN_FILLS: [string, string, string][] = [
  ["rgba(92,201,154,0.16)", "rgba(92,201,154,0.10)", "rgba(92,201,154,0.06)"],
  ["rgba(92,201,154,0.32)", "rgba(92,201,154,0.22)", "rgba(92,201,154,0.14)"],
  ["rgba(92,201,154,0.55)", "rgba(92,201,154,0.40)", "rgba(92,201,154,0.28)"],
];
const FLAT = "#8fa3b8";
const QUAD: Record<Quadrant, { color: string; fg: string }> = {
  leading: { color: "#187F7C", fg: CREAM },
  improving: { color: "#8ED6CF", fg: NAVY },
  weakening: { color: "#F5D548", fg: NAVY },
  lagging: { color: "#4A5F75", fg: CREAM },
};

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
const pct = (n: number) => `${sign(n)}${Math.abs(n * 100).toFixed(1)}%`;
const yi = (n: number | null) => n === null ? "資料不足" : `${sign(n)}${Math.abs(n / 1e8).toFixed(1)} 億`;
const flowTotal = (n: RotationNode, p: 1 | 5) => flowValue(n.flows[p], "total");

/** 數值 → 方向與深淺（dir 0 是接近 0） */
function bin(v: number | null, t: [number, number, number]): { dir: 1 | -1 | 0; level: 0 | 1 | 2 } | null {
  if (v === null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a < t[0]) return { dir: 0, level: 0 };
  return { dir: v > 0 ? 1 : -1, level: a >= t[2] ? 2 : a >= t[1] ? 1 : 0 };
}

interface Look {
  color: string;
  fg: string;
  ghost: [string, string, string] | null;
  value: string;
}

function look(n: RotationNode, metric: WallMetric, frameRet: number | null | undefined): Look {
  if (metric === "quadrant") {
    const q = n.quadrant ? QUAD[n.quadrant] : { color: "#2a4560", fg: "#B9C7D6" };
    return { color: q.color, fg: q.fg, ghost: null, value: n.quadrant ? QUADRANT_LABEL[n.quadrant].slice(0, 2) : "暖機中" };
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
    case "flow1": {
      const total = flowTotal(n, 1);
      v = total !== null && n.turnover > 0 ? total / n.turnover : null;
      t = [0.005, 0.02, 0.05];
      value = yi(flowTotal(n, 1));
      break;
    }
    case "flow5": {
      const total = flowTotal(n, 5);
      v = total !== null && n.turnover5Avg > 0 ? total / (n.turnover5Avg * 5) : null;
      t = [0.005, 0.02, 0.05];
      value = yi(flowTotal(n, 5));
      break;
    }
  }
  const b = bin(v, t);
  if (!b || b.dir === 0) return { color: FLAT, fg: NAVY, ghost: null, value };
  if (b.dir > 0) return { color: UP[b.level], fg: NAVY, ghost: null, value };
  return { color: DOWN_LINE, fg: CREAM, ghost: DOWN_FILLS[b.level], value };
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

  let index = 0;
  return (
    <div className="grid gap-5">
      {rows.map((row, r) => (
        <div key={row.id} className="grid gap-2 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-4">
          <div className="pt-4">
            <p className="font-display text-xs font-bold tracking-[0.1em] text-cream">{row.name}</p>
            <p className="mt-0.5 text-[11px] text-on-navy-2">{row.nodes.length} 個</p>
          </div>
          <div className="flex flex-wrap items-end gap-x-1 gap-y-1.5">
            {row.nodes.map((n) => {
              const frameRet = frameDate ? n.trail.find((t) => t.date === frameDate)?.ret ?? null : undefined;
              const lk = look(n, metric, frameRet);
              const studs = Math.max(4, Math.min(9, Math.round(4 + (Math.sqrt(n.turnover5Avg) / maxW) * 5)));
              const g = rowBrickGeometry(studs);
              const delay = reduced ? undefined : `${Math.min(r * 90 + index++ * 10, 1200)}ms`;
              const selected = n.id === selectedId;
              return (
                <div key={n.id} className={reduced ? "" : "brick"} style={{ animationDelay: delay }}>
                  <button
                    type="button"
                    onClick={() => onSelect(n.id)}
                    aria-pressed={selected}
                    title={`${n.name}：${lk.value}${n.held ? "（含我的持股）" : ""}`}
                    className="wall-brick relative block"
                    style={{ width: g.width, height: g.height, transform: selected && !reduced ? "translateY(-4px)" : undefined }}
                  >
                    <RowBrick
                      studs={studs}
                      color={lk.color}
                      ghost={lk.ghost !== null}
                      ghostFills={lk.ghost ?? undefined}
                      line={n.held ? SUN : lk.ghost ? DOWN_LINE : CREAM}
                      lineWidth={selected ? 3.2 : n.held ? 2.6 : 2}
                    />
                    {/* 名稱與數字寫在正面 */}
                    <span className="pointer-events-none absolute grid content-center overflow-hidden px-2 text-left" style={{ left: g.faceX, top: g.faceY, width: g.W, height: g.H, color: lk.fg }}>
                      <span className="block truncate text-[12px] font-black leading-tight">
                        {n.held ? "★ " : ""}
                        {n.name}
                      </span>
                      <span className="num block truncate text-[11px] leading-tight opacity-90">{lk.value}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
