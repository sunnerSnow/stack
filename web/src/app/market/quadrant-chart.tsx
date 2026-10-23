"use client";

import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { HomeBrick, homeBrickExtent } from "@/components/bricks";

/**
 * 輪動象限圖：STACK 的積木版（SVG，海軍藍底）。
 * - 四個象限是四塊底板（淡淡的凸點紋），每個族群是一塊首頁那一款等角 2×2 積木（深色底上用奶油白描邊，跟首頁的海軍藍區塊一樣），成員股票是小一號的積木。
 * - RS 模式：x＝強度、y＝動能，中心 (100, 100)；IS 模式：x＝前一日強度、y＝今天漲跌，黃線是全市場平均。
 * - 積木大小＝成交金額（5 日平均，面積比例）；上漲是實心紅積木、下跌是首頁「下一塊」那種虛線積木（綠色，色盲也看得出實心／虛線）、平盤灰；
 *   黃色描邊＝含我的持股。
 * - 滑過時積木會跳一下；積木整塊留在框內（極端值貼邊）。
 * - 動畫：進場時積木一塊塊掉下來；換模式、回放時積木滑到新位置（系統設定「減少動態」時關掉）。
 * 先量到寬度才畫，避免伺服器與瀏覽器的版面不同。
 */

export interface ChartNode {
  id: string;
  label: string;
  x: number;
  y: number;
  size: number;
  ret: number | null;
  held: boolean;
  /** 軌跡（舊到新），date 給回放用 */
  trail?: { date: string; x: number; y: number; ret: number | null }[];
  kind: "group" | "member";
}

interface Props {
  nodes: ChartNode[];
  mode: "rs" | "is";
  baseline?: number | null;
  selectedId: string | null;
  focusIds?: Set<string> | null;
  onSelect: (id: string | null) => void;
  /** 回放中：顯示這一天的位置（沒有那天資料的點先藏起來） */
  frameDate?: string | null;
  height?: number;
  describe: (node: ChartNode) => string[];
}

export const UP = "#ff9a9a";
export const DOWN = "#289163";
export const FLAT = "#8fa3b8";
const DOWN_LINE = "#5cc99a";
/** 下跌的虛線積木：頂面、左面、右面（綠色半透明） */
const DOWN_FILLS: [string, string, string] = ["rgba(92,201,154,0.34)", "rgba(92,201,154,0.16)", "rgba(92,201,154,0.24)"];
const SUN = "#F5D548";
const CREAM = "#F5F0E5";
const NAVY = "#173451";

const PAD = { top: 26, right: 26, bottom: 34, left: 52 };

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

export function QuadrantChart({ nodes, mode, baseline, selectedId, focusIds, onSelect, frameDate = null, height = 580, describe }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [hover, setHover] = useState<{ id: string; px: number; py: number } | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 這一格要畫在哪裡：回放時用那天的軌跡點 */
  const placed = useMemo(
    () =>
      nodes.flatMap((n) => {
        if (!frameDate) return [{ node: n, x: n.x, y: n.y, ret: n.ret }];
        const p = n.trail?.find((t) => t.date === frameDate);
        return p ? [{ node: n, x: p.x, y: p.y, ret: p.ret }] : [];
      }),
    [nodes, frameDate],
  );

  const layout = useMemo(() => {
    if (!width) return null;
    // 範圍用全部軌跡算，回放時座標軸不會跳
    const xs = nodes.flatMap((n) => [n.x, ...(n.trail ?? []).map((t) => t.x)]);
    const ys = nodes.flatMap((n) => [n.y, ...(n.trail ?? []).map((t) => t.y)]);
    const xr = range(xs, 100, 2, 12);
    const yr = mode === "rs" ? range(ys, 100, 1.5, 8) : range(ys, 0, 0.02, 0.1);
    const pw = width - PAD.left - PAD.right;
    const ph = height - PAD.top - PAD.bottom;
    const clampX = (v: number) => Math.min(xr[1], Math.max(xr[0], v));
    const clampY = (v: number) => Math.min(yr[1], Math.max(yr[0], v));
    const x = (v: number) => PAD.left + ((clampX(v) - xr[0]) / (xr[1] - xr[0])) * pw;
    const y = (v: number) => PAD.top + (1 - (clampY(v) - yr[0]) / (yr[1] - yr[0])) * ph;
    const maxSize = Math.max(1, ...nodes.map((n) => n.size));
    // 積木大小：首頁積木原始寬 120
    const scale = (n: ChartNode) => {
      const t = Math.sqrt(n.size / maxSize);
      return n.kind === "member" ? 0.2 + t * 0.26 : 0.2 + t * Math.min(0.42, width / 2300);
    };
    const extent = (n: ChartNode) => homeBrickExtent(scale(n));
    const halfW = (n: ChartNode) => extent(n).halfW;
    const halfH = (n: ChartNode) => extent(n).top;
    // 積木整塊留在底板裡：中心點依積木大小往內收
    const L = PAD.left;
    const T = PAD.top;
    const R = PAD.left + pw;
    const B = PAD.top + ph;
    const at = (n: ChartNode, vx: number, vy: number) => {
      const e = extent(n);
      return { px: Math.min(R - e.halfW, Math.max(L + e.halfW, x(vx))), py: Math.min(B - e.bottom, Math.max(T + e.top, y(vy))) };
    };
    const step = { x: niceStep(xr[1] - xr[0]), y: niceStep(yr[1] - yr[0]) };
    const ticks = (lo: number, hi: number, s: number) => {
      const out: number[] = [];
      for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) out.push(Math.round(v / s) * s);
      return out;
    };
    /** 名稱的 y：積木上方；太靠近上緣就放到積木下方 */
    const labelY = (n: ChartNode, py: number) => {
      const above = py - extent(n).top - 4;
      return above < T + 14 ? py + extent(n).bottom + 12 : above;
    };
    return { xr, yr, pw, ph, x, y, scale, halfW, halfH, at, extent, labelY, xTicks: ticks(xr[0], xr[1], step.x), yTicks: ticks(yr[0], yr[1], step.y) };
  }, [width, nodes, mode, height]);

  // 標籤：選取、持股與成交金額前幾大的才放，避開彼此重疊
  const labels = useMemo(() => {
    if (!layout || !width) return new Set<string>();
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const out = new Set<string>();
    const budget = Math.max(8, Math.floor(width / 45));
    const order = [...placed].sort(
      (a, b) => Number(b.node.id === selectedId) - Number(a.node.id === selectedId) || Number(b.node.held) - Number(a.node.held) || b.node.size - a.node.size,
    );
    for (const { node: n, x: vx, y: vy } of order) {
      if (out.size >= budget && n.id !== selectedId) continue;
      if (focusIds && !focusIds.has(n.id)) continue;
      const w = n.label.length * 12 + 4;
      const { px: cx, py } = layout.at(n, vx, vy);
      const cy = layout.labelY(n, py);
      const box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - 12, y1: cy + 2 };
      if (box.x0 < PAD.left || box.x1 > width - PAD.right) continue;
      if (boxes.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
      boxes.push(box);
      out.add(n.id);
    }
    return out;
  }, [layout, width, placed, selectedId, focusIds]);

  const fmtY = (v: number) => (mode === "rs" ? v.toFixed(1) : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`);
  const selected = placed.find((p) => p.node.id === selectedId)?.node ?? null;
  const hovered = hover ? placed.find((p) => p.node.id === hover.id) ?? null : null;

  const nearest = (e: MouseEvent<SVGRectElement>) => {
    if (!layout) return null;
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: { id: string; d: number } | null = null;
    for (const { node: n, x: vx, y: vy } of placed) {
      if (focusIds && !focusIds.has(n.id)) continue;
      const p = layout.at(n, vx, vy);
      const dx = Math.max(0, Math.abs(p.px - px) - layout.halfW(n));
      const dy = Math.max(0, Math.abs(p.py - py) - layout.halfH(n));
      const d = Math.hypot(dx, dy);
      if (d < 12 && (!best || d < best.d)) best = { id: n.id, d };
    }
    return best ? { id: best.id, px, py } : null;
  };

  // 畫的順序固定（大的在後、小的在前，小積木不會被蓋住）：順序一變，瀏覽器會把元素拿掉再放回去，
  // 掉落動畫重跑、移動動畫也沒了，所以不能依位置排序
  const drawOrder = [...placed].sort((a, b) => b.node.size - a.node.size || a.node.id.localeCompare(b.node.id));
  const move = reduced ? undefined : "transform 650ms cubic-bezier(0.2, 0.9, 0.3, 1.15)";

  return (
    <div ref={wrap} className="relative w-full" style={{ height }}>
      {layout ? (
        <svg width={width!} height={height} role="img" aria-label={`輪動象限圖，${placed.length} 塊積木；完整數字見下方表格`} className="block select-none">
          <defs>
            <clipPath id="plot-clip">
              <rect x={PAD.left} y={PAD.top} width={layout.pw} height={layout.ph} />
            </clipPath>
            {/* 底板的凸點紋 */}
            <pattern id="baseplate-studs" width={18} height={18} patternUnits="userSpaceOnUse">
              <circle cx={9} cy={9} r={3.4} fill="rgba(245,240,229,0.07)" />
              <circle cx={9} cy={8.2} r={3.4} fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth={0.8} />
            </pattern>
          </defs>
          {(() => {
            const cx = layout.x(100);
            const cy = mode === "rs" ? layout.y(100) : layout.y(baseline ?? 0);
            const L = PAD.left;
            const T = PAD.top;
            const R = PAD.left + layout.pw;
            const B = PAD.top + layout.ph;
            const plates = [
              { x: cx, y: T, w: R - cx, h: cy - T, fill: "rgba(24,127,124,0.30)", label: mode === "rs" ? "領先" : "強勢且今天上漲", lx: R - 10, ly: T + 18, anchor: "end" },
              { x: cx, y: cy, w: R - cx, h: B - cy, fill: "rgba(245,213,72,0.10)", label: mode === "rs" ? "轉弱" : "強勢但今天下跌", lx: R - 10, ly: B - 10, anchor: "end" },
              { x: L, y: cy, w: cx - L, h: B - cy, fill: "rgba(0,0,0,0.14)", label: mode === "rs" ? "落後" : "弱勢且今天下跌", lx: L + 10, ly: B - 10, anchor: "start" },
              { x: L, y: T, w: cx - L, h: cy - T, fill: "rgba(142,214,207,0.09)", label: mode === "rs" ? "改善" : "弱勢但今天上漲", lx: L + 10, ly: T + 18, anchor: "start" },
            ];
            return plates.map((p) => (
              <g key={p.label}>
                <rect x={p.x} y={p.y} width={Math.max(0, p.w)} height={Math.max(0, p.h)} fill={p.fill} />
                <rect x={p.x} y={p.y} width={Math.max(0, p.w)} height={Math.max(0, p.h)} fill="url(#baseplate-studs)" />
                <text x={p.lx} y={p.ly} textAnchor={p.anchor as "start" | "end"} fill="var(--color-on-navy)" fontFamily="var(--font-display)" fontSize={12} fontWeight={700} letterSpacing="0.12em">
                  {p.label}
                </text>
              </g>
            ));
          })()}
          {/* 底板的接縫（粗線）＝中心線 */}
          <rect x={PAD.left} y={PAD.top} width={layout.pw} height={layout.ph} fill="none" stroke="rgba(245,240,229,0.35)" strokeWidth={2} />
          <line x1={layout.x(100)} x2={layout.x(100)} y1={PAD.top} y2={PAD.top + layout.ph} stroke="rgba(245,240,229,0.55)" strokeWidth={2} />
          <line
            x1={PAD.left}
            x2={PAD.left + layout.pw}
            y1={mode === "rs" ? layout.y(100) : layout.y(baseline ?? 0)}
            y2={mode === "rs" ? layout.y(100) : layout.y(baseline ?? 0)}
            stroke={mode === "rs" ? "rgba(245,240,229,0.55)" : SUN}
            strokeWidth={2}
          />
          {layout.xTicks.map((t) => (
            <text key={`x${t}`} x={layout.x(t)} y={height - 14} textAnchor="middle" fontSize={11} fill="var(--color-on-navy-2)" fontFamily="var(--font-mono)">
              {t.toFixed(1)}
            </text>
          ))}
          {layout.yTicks.map((t) => (
            <text key={`y${t}`} x={PAD.left - 8} y={layout.y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-on-navy-2)" fontFamily="var(--font-mono)">
              {fmtY(t)}
            </text>
          ))}
          <text x={PAD.left + layout.pw} y={height - 2} textAnchor="end" fontSize={11} fill="var(--color-on-navy)">
            {mode === "rs" ? "強度 →" : "前一日強度 →"}
          </text>
          <text x={8} y={16} fontSize={11} fill="var(--color-on-navy)">
            {mode === "rs" ? "↑ 動能" : "↑ 今天漲跌"}
          </text>

          {/* 選取的族群：10 日軌跡（一顆顆凸點，越新越亮） */}
          {selected?.trail && selected.trail.length > 1 && !frameDate ? (
            <g pointerEvents="none">
              <polyline points={selected.trail.map((t) => { const p = layout.at(selected, t.x, t.y); return `${p.px},${p.py}`; }).join(" ")} fill="none" stroke={SUN} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
              {selected.trail.slice(0, -1).map((t, i) => {
                const p = layout.at(selected, t.x, t.y);
                return <rect key={t.date} x={p.px - 3.5} y={p.py - 3.5} width={7} height={7} rx={1.5} fill={SUN} opacity={0.3 + (i / selected.trail!.length) * 0.6} />;
              })}
            </g>
          ) : null}

          <g clipPath="url(#plot-clip)">
            {drawOrder.map(({ node: n, x: vx, y: vy, ret }, k) => {
              const dim = focusIds ? !focusIds.has(n.id) : false;
              const flat = ret === null || Math.abs(ret) < 0.0005;
              const up = !flat && ret! > 0;
              const s = layout.scale(n);
              const { px, py } = layout.at(n, vx, vy);
              const hop = hover?.id === n.id && !reduced;
              const selected = n.id === selectedId;
              return (
                <g key={n.id} style={{ transform: `translate(${px}px, ${py}px)`, transition: move }} opacity={dim ? 0.16 : 1}>
                  <g style={{ transform: hop ? "translateY(-5px)" : "none", transition: reduced ? undefined : "transform 160ms ease-out" }}>
                    <g className={reduced ? undefined : "brick"} style={reduced ? undefined : { animationDelay: `${Math.min(k * 14, 900)}ms` }}>
                      <HomeBrick
                        scale={s}
                        color={flat ? FLAT : UP}
                        ghost={!flat && !up}
                        ghostFills={DOWN_FILLS}
                        line={n.held ? SUN : !flat && !up ? DOWN_LINE : CREAM}
                        lineWidth={selected ? 3.2 : n.held ? 2.4 : 1.6}
                      />
                    </g>
                  </g>
                </g>
              );
            })}
          </g>
          {/* 名稱放最上層（不被後面畫的積木蓋住），跟著積木一起移動 */}
          {drawOrder.map(({ node: n, x: vx, y: vy }, k) => {
            if (!labels.has(n.id)) return null;
            const { px, py } = layout.at(n, vx, vy);
            return (
              <g key={`l-${n.id}`} style={{ transform: `translate(${px}px, ${layout.labelY(n, py)}px)`, transition: move }} pointerEvents="none">
                <g className={reduced ? undefined : "brick"} style={reduced ? undefined : { animationDelay: `${Math.min(k * 14, 900)}ms` }}>
                  <text
                    y={0}
                    textAnchor="middle"
                    fontSize={n.kind === "member" ? 11 : 12}
                    fontWeight={n.id === selectedId ? 900 : 700}
                    fill={CREAM}
                    stroke={NAVY}
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {n.label}
                  </text>
                </g>
              </g>
            );
          })}

          {mode === "is" && baseline !== null && baseline !== undefined ? (
            <text
              x={PAD.left + layout.pw - 8}
              y={layout.y(baseline) + 16}
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
          {/* 感應區：找最近的積木（不用剛好點在積木上） */}
          <rect
            x={0}
            y={0}
            width={width!}
            height={height}
            fill="transparent"
            style={{ cursor: hover ? "pointer" : "default", touchAction: "pan-y" }}
            onMouseMove={(e) => setHover(nearest(e))}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => {
              const hit = nearest(e);
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
          <p className="text-[13px] font-black">{hovered.node.label}</p>
          {describe(hovered.node).map((line) => (
            <p key={line} className="num mt-0.5 text-on-navy">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
