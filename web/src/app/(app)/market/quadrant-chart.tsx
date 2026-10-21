"use client";

import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";

/**
 * 輪動象限圖（SVG，深色海軍藍底）。
 * - RS 模式：x＝強度、y＝動能，中心 (100, 100)；IS 模式：x＝前一日強度、y＝今天漲跌，橫線是全市場平均。
 * - 點的大小＝成交金額（5 日平均，面積比例）；漲跌用顏色＋形狀：上漲實心紅、下跌空心綠、平盤灰（台灣慣例紅漲綠跌，色盲也分得出實心／空心）。
 * - 選取的族群畫 10 日軌跡；展開成員時其他族群變淡。
 * 先量到寬度才畫，避免伺服器與瀏覽器的版面不同。
 */

export interface ChartNode {
  id: string;
  label: string;
  x: number;
  y: number;
  /** 決定大小 */
  size: number;
  ret: number | null;
  held: boolean;
  /** 軌跡（舊到新） */
  trail?: { x: number; y: number }[];
  kind: "group" | "member";
}

interface Props {
  nodes: ChartNode[];
  mode: "rs" | "is";
  /** IS 模式的橫線（全市場平均漲跌） */
  baseline?: number | null;
  selectedId: string | null;
  focusIds?: Set<string> | null;
  onSelect: (id: string | null) => void;
  height?: number;
  describe: (node: ChartNode) => string[];
}

export const UP = "#ff9a9a";
export const DOWN = "#289163";
export const FLAT = "#8fa3b8";
const SUN = "#F5D548";
const CREAM = "#F5F0E5";
const NAVY = "#173451";

const PAD = { top: 22, right: 22, bottom: 34, left: 52 };

function niceStep(span: number) {
  const raw = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/** 以中心為準的對稱範圍：中心兩側取最遠的點，至少 minHalf，最多 maxHalf（極端值貼邊） */
function range(values: number[], center: number, minHalf: number, maxHalf: number): [number, number] {
  const far = values.reduce((m, v) => Math.max(m, Math.abs(v - center)), 0);
  const half = Math.min(maxHalf, Math.max(minHalf, far * 1.12));
  return [center - half, center + half];
}

export function QuadrantChart({ nodes, mode, baseline, selectedId, focusIds, onSelect, height = 560, describe }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [hover, setHover] = useState<{ id: string; px: number; py: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!width) return null;
    const xs = nodes.flatMap((n) => [n.x, ...(n.trail ?? []).map((t) => t.x)]);
    const ys = nodes.flatMap((n) => [n.y, ...(n.trail ?? []).map((t) => t.y)]);
    const xr = range(xs, 100, 2, 12);
    const yCenter = mode === "rs" ? 100 : 0;
    const yr = mode === "rs" ? range(ys, 100, 1.5, 8) : range(ys, 0, 0.02, 0.1);
    const pw = width - PAD.left - PAD.right;
    const ph = height - PAD.top - PAD.bottom;
    const clampX = (v: number) => Math.min(xr[1], Math.max(xr[0], v));
    const clampY = (v: number) => Math.min(yr[1], Math.max(yr[0], v));
    const x = (v: number) => PAD.left + ((clampX(v) - xr[0]) / (xr[1] - xr[0])) * pw;
    const y = (v: number) => PAD.top + (1 - (clampY(v) - yr[0]) / (yr[1] - yr[0])) * ph;
    const maxSize = Math.max(1, ...nodes.map((n) => n.size));
    const r = (n: ChartNode) => (n.kind === "member" ? 3.5 : 4) + Math.sqrt(n.size / maxSize) * (n.kind === "member" ? 12 : Math.min(26, width / 40));
    const xStep = niceStep(xr[1] - xr[0]);
    const yStep = niceStep(yr[1] - yr[0]);
    const ticks = (lo: number, hi: number, step: number) => {
      const out: number[] = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
      return out;
    };
    // 標籤：選取、滑過、持股與成交金額前幾大的才放，避開彼此重疊
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const order = [...nodes].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || Number(b.held) - Number(a.held) || b.size - a.size);
    const labels = new Map<string, { lx: number; ly: number }>();
    const budget = Math.max(8, Math.floor(width / 45));
    for (const n of order) {
      if (labels.size >= budget && n.id !== selectedId) continue;
      if (focusIds && !focusIds.has(n.id)) continue;
      const w = n.label.length * 12 + 4;
      const cx = x(n.x);
      const cy = y(n.y) - r(n) - 5;
      const box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - 12, y1: cy + 2 };
      if (box.x0 < PAD.left || box.x1 > width - PAD.right) continue;
      if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
      placed.push(box);
      labels.set(n.id, { lx: cx, ly: cy });
    }
    return { xr, yr, yCenter, pw, ph, x, y, r, xTicks: ticks(xr[0], xr[1], xStep), yTicks: ticks(yr[0], yr[1], yStep), labels };
  }, [width, nodes, mode, height, selectedId, focusIds]);

  const fmtY = (v: number) => (mode === "rs" ? v.toFixed(1) : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const hovered = hover ? nodes.find((n) => n.id === hover.id) ?? null : null;

  const nearest = (e: PointerEvent<SVGRectElement>) => {
    if (!layout) return null;
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: { id: string; d: number } | null = null;
    for (const n of nodes) {
      if (focusIds && !focusIds.has(n.id)) continue;
      const d = Math.hypot(layout.x(n.x) - px, layout.y(n.y) - py) - layout.r(n);
      if (d < 14 && (!best || d < best.d)) best = { id: n.id, d };
    }
    return best ? { id: best.id, px, py } : null;
  };

  return (
    <div ref={wrap} className="relative w-full" style={{ height }}>
      {layout ? (
        <svg width={width!} height={height} role="img" aria-label={`輪動象限圖，${nodes.length} 個點；完整數字見下方表格`} className="block select-none">
          {/* 象限底色與名稱 */}
          {(() => {
            const cx = layout.x(100);
            const cy = mode === "rs" ? layout.y(100) : layout.y(baseline ?? 0);
            const L = PAD.left;
            const T = PAD.top;
            const R = PAD.left + layout.pw;
            const B = PAD.top + layout.ph;
            const q = [
              { x: cx, y: T, w: R - cx, h: cy - T, fill: "rgba(24,127,124,0.22)", label: mode === "rs" ? "領先" : "強勢且今天上漲", lx: R - 8, ly: T + 16, anchor: "end" },
              { x: cx, y: cy, w: R - cx, h: B - cy, fill: "rgba(245,213,72,0.08)", label: mode === "rs" ? "轉弱" : "強勢但今天下跌", lx: R - 8, ly: B - 8, anchor: "end" },
              { x: L, y: cy, w: cx - L, h: B - cy, fill: "rgba(0,0,0,0.10)", label: mode === "rs" ? "落後" : "弱勢且今天下跌", lx: L + 8, ly: B - 8, anchor: "start" },
              { x: L, y: T, w: cx - L, h: cy - T, fill: "rgba(142,214,207,0.07)", label: mode === "rs" ? "改善" : "弱勢但今天上漲", lx: L + 8, ly: T + 16, anchor: "start" },
            ];
            return q.map((r) => (
              <g key={r.label}>
                <rect x={r.x} y={r.y} width={Math.max(0, r.w)} height={Math.max(0, r.h)} fill={r.fill} />
                <text x={r.lx} y={r.ly} textAnchor={r.anchor as "start" | "end"} fill="var(--color-on-navy)" fontSize={12} fontWeight={700} letterSpacing="0.1em">
                  {r.label}
                </text>
              </g>
            ));
          })()}
          {layout.xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={layout.x(t)} x2={layout.x(t)} y1={PAD.top} y2={PAD.top + layout.ph} stroke="rgba(185,199,214,0.10)" />
              <text x={layout.x(t)} y={height - 14} textAnchor="middle" fontSize={11} fill="var(--color-on-navy-2)" fontFamily="var(--font-mono)">
                {t.toFixed(1)}
              </text>
            </g>
          ))}
          {layout.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.left} x2={PAD.left + layout.pw} y1={layout.y(t)} y2={layout.y(t)} stroke="rgba(185,199,214,0.10)" />
              <text x={PAD.left - 8} y={layout.y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-on-navy-2)" fontFamily="var(--font-mono)">
                {fmtY(t)}
              </text>
            </g>
          ))}
          {/* 中心線：強度 100；RS 模式動能 100，IS 模式全市場平均 */}
          <line x1={layout.x(100)} x2={layout.x(100)} y1={PAD.top} y2={PAD.top + layout.ph} stroke="rgba(245,240,229,0.45)" />
          <line
            x1={PAD.left}
            x2={PAD.left + layout.pw}
            y1={mode === "rs" ? layout.y(100) : layout.y(baseline ?? 0)}
            y2={mode === "rs" ? layout.y(100) : layout.y(baseline ?? 0)}
            stroke={mode === "rs" ? "rgba(245,240,229,0.45)" : SUN}
          />

          <text x={PAD.left + layout.pw} y={height - 2} textAnchor="end" fontSize={11} fill="var(--color-on-navy)">
            {mode === "rs" ? "強度 →" : "前一日強度 →"}
          </text>
          <text x={8} y={14} fontSize={11} fill="var(--color-on-navy)">
            {mode === "rs" ? "↑ 動能" : "↑ 今天漲跌"}
          </text>

          {/* 選取的族群：10 日軌跡 */}
          {selected?.trail && selected.trail.length > 1 ? (
            <g pointerEvents="none">
              <polyline
                points={selected.trail.map((t) => `${layout.x(t.x)},${layout.y(t.y)}`).join(" ")}
                fill="none"
                stroke={SUN}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
              />
              {selected.trail.slice(0, -1).map((t, i) => (
                <circle key={i} cx={layout.x(t.x)} cy={layout.y(t.y)} r={2.5 + (i / selected.trail!.length) * 2} fill={SUN} opacity={0.35 + (i / selected.trail!.length) * 0.5} />
              ))}
            </g>
          ) : null}

          {[...nodes]
            .sort((a, b) => b.size - a.size)
            .map((n) => {
              const dim = focusIds ? !focusIds.has(n.id) : false;
              const color = n.ret === null || Math.abs(n.ret) < 0.0005 ? FLAT : n.ret > 0 ? UP : DOWN;
              const filled = n.ret === null || n.ret >= 0.0005;
              const rr = layout.r(n);
              return (
                <g key={n.id} opacity={dim ? 0.18 : 1}>
                  {n.held ? <circle cx={layout.x(n.x)} cy={layout.y(n.y)} r={rr + 4} fill="none" stroke={SUN} strokeWidth={2} /> : null}
                  <circle
                    cx={layout.x(n.x)}
                    cy={layout.y(n.y)}
                    r={rr}
                    fill={filled ? color : NAVY}
                    fillOpacity={filled ? 0.9 : 1}
                    stroke={filled ? NAVY : color}
                    strokeWidth={filled ? 2 : 2.5}
                  />
                  {n.id === selectedId ? <circle cx={layout.x(n.x)} cy={layout.y(n.y)} r={rr + 7} fill="none" stroke={CREAM} strokeWidth={2} /> : null}
                </g>
              );
            })}
          {[...layout.labels].map(([id, p]) => {
            const n = nodes.find((x) => x.id === id)!;
            return (
              <text
                key={`l${id}`}
                x={p.lx}
                y={p.ly}
                textAnchor="middle"
                fontSize={n.kind === "member" ? 11 : 12}
                fontWeight={id === selectedId ? 900 : 700}
                fill={CREAM}
                stroke={NAVY}
                strokeWidth={3}
                paintOrder="stroke"
                pointerEvents="none"
              >
                {n.label}
              </text>
            );
          })}
          {mode === "is" && baseline !== null && baseline !== undefined ? (
            <text
              x={PAD.left + layout.pw - 6}
              y={layout.y(baseline) + 15}
              textAnchor="end"
              fontSize={11}
              fontWeight={700}
              fill={SUN}
              stroke={NAVY}
              strokeWidth={3}
              paintOrder="stroke"
              fontFamily="var(--font-mono)"
              pointerEvents="none"
            >
              全市場平均 {fmtY(baseline)}
            </text>
          ) : null}
          {/* 感應區：找最近的點（不用剛好點在點上） */}
          <rect
            x={0}
            y={0}
            width={width!}
            height={height}
            fill="transparent"
            style={{ cursor: hover ? "pointer" : "default", touchAction: "pan-y" }}
            onPointerMove={(e) => setHover(nearest(e))}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => {
              const hit = nearest(e as unknown as PointerEvent<SVGRectElement>);
              onSelect(hit ? hit.id : null);
            }}
          />
        </svg>
      ) : null}
      {layout && hovered && hover ? (
        <div
          className="pointer-events-none absolute z-10 min-w-44 border-2 border-cream bg-ink px-3 py-2 text-xs text-cream shadow-[4px_4px_0_var(--color-sea)]"
          style={{ left: Math.min(hover.px + 14, (width ?? 0) - 200), top: Math.max(4, hover.py - 10) }}
        >
          <p className="text-[13px] font-black">{hovered.label}</p>
          {describe(hovered).map((line) => (
            <p key={line} className="num mt-0.5 text-on-navy">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
