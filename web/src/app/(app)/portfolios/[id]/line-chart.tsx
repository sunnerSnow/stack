"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";

/**
 * 折線圖（SVG，不靠圖表套件）：
 * - 2px 線、細格線、終點 8px 圓點（外圈 2px 背景色），文字一律用文字色，不用線的顏色
 * - 游標或鍵盤（← → Home End）移動十字線，提示框列出同一天所有線的值
 * - 「表格」切換成逐日表格，提示框裡的每個值都看得到
 * 只有一個 y 軸；先量到寬度才畫，避免伺服器與瀏覽器的版面不同。
 */

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS 顏色（用 var(--color-…)） */
  color: string;
  /** step：階梯線（例如累積入金） */
  kind?: "line" | "step";
  values: (number | null)[];
}

interface Props {
  /** 給螢幕閱讀器的圖表說明 */
  label: string;
  dates: string[];
  series: ChartSeries[];
  /** 提示框、終點標籤、表格用的格式 */
  format: (n: number) => string;
  /** y 軸刻度的格式（step 是刻度間距） */
  axisFormat: (n: number, step: number) => string;
  includeZero?: boolean;
  height?: number;
}

const TOP = 12;
const BOTTOM = 26;
const CHAR = 6.9; // 11px IBM Plex Mono 每個字約 6.6px，留一點餘裕

export function niceTicks(lo: number, hi: number, count = 4): { ticks: number[]; step: number } {
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let i = Math.floor(lo / step); i <= Math.ceil(hi / step); i++) ticks.push(i * step === 0 ? 0 : i * step);
  return { ticks, step };
}

/** x 軸刻度：期間長用每月 1 號，短用每週一；太擠就間隔著取 */
function xTicks(dates: string[], max: number): number[] {
  const n = dates.length;
  const candidates =
    n > 75
      ? dates.flatMap((d, i) => (d.endsWith("-01") ? [i] : []))
      : dates.flatMap((d, i) => (new Date(`${d}T00:00:00Z`).getUTCDay() === 1 ? [i] : []));
  const every = Math.max(1, Math.ceil(candidates.length / Math.max(1, max)));
  return candidates.filter((_, k) => k % every === 0);
}

function tickLabel(date: string, monthly: boolean, multiYear: boolean): string {
  const [y, m, d] = date.split("-");
  if (!monthly) return `${Number(m)}/${Number(d)}`;
  return multiYear ? `${y}/${m}` : `${Number(m)}月`;
}

export function LineChart({ label, dates, series, format, axisFormat, includeZero = false, height = 240 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
    // 切回圖表時是新的容器，要重新量
  }, [table]);

  const n = dates.length;
  const layout = useMemo(() => {
    if (!width || n < 2) return null;
    const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (values.length === 0) return null;
    let lo = values.reduce((a, b) => Math.min(a, b));
    let hi = values.reduce((a, b) => Math.max(a, b));
    if (includeZero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const { ticks, step } = niceTicks(lo, hi);
    const yMin = ticks[0];
    const yMax = ticks.at(-1)!;
    const left = Math.ceil(Math.max(...ticks.map((t) => axisFormat(t, step).length)) * CHAR) + 10;

    // 終點標籤：寬度夠才放；兩條線的終點太近就不放（圖例裡有數值）
    const ends = series.map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && s.values[i] === null) i--;
      return i < 0 ? null : { i, v: s.values[i]! };
    });
    const labelWidth = Math.max(0, ...ends.map((e) => (e ? format(e.v).length * CHAR : 0)));
    let endLabels = width >= 520 && ends.some(Boolean);
    const right = endLabels ? Math.ceil(labelWidth) + 16 : 12;
    const pw = Math.max(10, width - left - right);
    const ph = height - TOP - BOTTOM;
    const x = (i: number) => left + (i / (n - 1)) * pw;
    const y = (v: number) => TOP + (1 - (v - yMin) / (yMax - yMin)) * ph;
    const endYs = ends.filter(Boolean).map((e) => y(e!.v));
    if (endYs.some((a, k) => endYs.some((b, j) => j !== k && Math.abs(a - b) < 14))) endLabels = false;

    const paths = series.map((s) => {
      let d = "";
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null) {
          pen = false;
          return;
        }
        const X = x(i).toFixed(1);
        const Y = y(v).toFixed(1);
        d += !pen ? `M${X},${Y}` : s.kind === "step" ? `H${X}V${Y}` : `L${X},${Y}`;
        pen = true;
      });
      return d;
    });
    const monthly = n > 75;
    const multiYear = dates[0].slice(0, 4) !== dates[n - 1].slice(0, 4);
    const xt = xTicks(dates, Math.floor(pw / (monthly && multiYear ? 72 : 56)));
    return { ticks, step, left, pw, ph, x, y, ends, endLabels, paths, xt, monthly, multiYear };
  }, [width, n, series, includeZero, axisFormat, format, height, dates]);

  const move = (e: PointerEvent<SVGRectElement>) => {
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left) / rect.width) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = hover ?? n - 1;
    const next = e.key === "ArrowLeft" ? cur - (e.shiftKey ? 7 : 1) : e.key === "ArrowRight" ? cur + (e.shiftKey ? 7 : 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (e.key === "Escape") setHover(null);
    if (next === null) return;
    e.preventDefault();
    setHover(Math.min(n - 1, Math.max(0, next)));
  };

  const tipWidth = 196;
  const tipLeft = layout && hover !== null ? (layout.x(hover) + 14 + tipWidth > (width ?? 0) ? layout.x(hover) - 14 - tipWidth : layout.x(hover) + 14) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {/* 圖例：線段＋名稱＋期末值（文字用文字色） */}
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-2">
          {series.map((s, k) => {
            const end = layout?.ends[k] ?? null;
            return (
              <li key={s.key} className="flex items-center gap-1.5">
                <LineKey color={s.color} />
                {s.label}
                <span className="num font-medium text-ink">{end ? format(end.v) : "—"}</span>
              </li>
            );
          })}
        </ul>
        <button type="button" className="text-xs font-bold hover:underline" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? "看圖表" : "看表格"}
        </button>
      </div>

      {table ? (
        <div className="mt-2 max-h-72 overflow-auto border-2 border-ink">
          <table className="table">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr>
                <th>日期</th>
                {series.map((s) => (
                  <th key={s.key} className="r">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates
                .map((d, i) => ({ d, i }))
                .reverse()
                .map(({ d, i }) => (
                  <tr key={d}>
                    <td className="num whitespace-nowrap">{d}</td>
                    {series.map((s) => (
                      <td key={s.key} className="r num whitespace-nowrap">
                        {s.values[i] === null ? <span className="text-ink-3">—</span> : format(s.values[i]!)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={wrap}
          className="relative mt-2 outline-none focus-visible:ring-3 focus-visible:ring-sea"
          style={{ height }}
          tabIndex={0}
          role="group"
          aria-label={`${label}（可用左右方向鍵逐日查看）`}
          onKeyDown={key}
          onFocus={() => setHover((h) => h ?? n - 1)}
          onBlur={() => setHover(null)}
        >
          {layout ? (
            <svg width={width!} height={height} role="img" aria-label={label} className="block">
              {/* 格線與 y 軸刻度：1px 實線、比背景深一階 */}
              {layout.ticks.map((t) => (
                <g key={t}>
                  <line x1={layout.left} x2={layout.left + layout.pw} y1={layout.y(t)} y2={layout.y(t)} stroke={t === 0 && includeZero ? "var(--color-line)" : "var(--color-grid)"} strokeWidth={1} />
                  <text x={layout.left - 8} y={layout.y(t) + 3.5} textAnchor="end" className="num" fontSize={11} fill="var(--color-ink-3)">
                    {axisFormat(t, layout.step)}
                  </text>
                </g>
              ))}
              {layout.xt.map((i) => (
                <text key={i} x={layout.x(i)} y={height - 8} textAnchor="middle" className="num" fontSize={11} fill="var(--color-ink-3)">
                  {tickLabel(dates[i], layout.monthly, layout.multiYear)}
                </text>
              ))}
              {series.map((s, k) => (
                <path key={s.key} d={layout.paths[k]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {/* 終點：圓點＋外圈背景色；有空間才放數值 */}
              {series.map((s, k) => {
                const end = layout.ends[k];
                if (!end) return null;
                return (
                  <g key={s.key}>
                    <circle cx={layout.x(end.i)} cy={layout.y(end.v)} r={4} fill={s.color} stroke="var(--color-paper)" strokeWidth={2} />
                    {layout.endLabels ? (
                      <text x={layout.x(end.i) + 9} y={layout.y(end.v) + 4} className="num" fontSize={11} fill="var(--color-ink-2)">
                        {format(end.v)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {hover !== null ? (
                <g pointerEvents="none">
                  <line x1={layout.x(hover)} x2={layout.x(hover)} y1={TOP} y2={TOP + layout.ph} stroke="var(--color-ink-3)" strokeWidth={1} />
                  {series.map((s) =>
                    s.values[hover] === null ? null : (
                      <circle key={s.key} cx={layout.x(hover)} cy={layout.y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--color-paper)" strokeWidth={2} />
                    ),
                  )}
                </g>
              ) : null}
              {/* 感應區比線大：整個繪圖區都能找到最近的日期 */}
              <rect
                x={layout.left}
                y={0}
                width={layout.pw}
                height={height}
                fill="transparent"
                style={{ touchAction: "pan-y" }}
                onPointerMove={move}
                onPointerDown={move}
                onPointerLeave={() => setHover(null)}
              />
            </svg>
          ) : width ? (
            <p className="grid h-full place-items-center text-sm text-ink-3">這段期間沒有可以畫的資料</p>
          ) : null}
          {layout && hover !== null ? (
            <div className="pointer-events-none absolute top-1 z-10 border-2 border-ink bg-paper px-3 py-2 shadow-[3px_3px_0_var(--color-ink)]" style={{ left: tipLeft, width: tipWidth }}>
              <p className="num text-[11px] text-ink-3">{dates[hover]}</p>
              <ul className="mt-1 grid gap-1">
                {series.map((s) => (
                  <li key={s.key} className="flex items-center gap-1.5 text-xs text-ink-2">
                    <LineKey color={s.color} />
                    <span className="num text-[13px] font-bold text-ink">{s.values[hover] === null ? "—" : format(s.values[hover]!)}</span>
                    <span className="truncate">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function LineKey({ color }: { color: string }) {
  return (
    <svg width={14} height={8} aria-hidden="true" className="shrink-0">
      <line x1={1} x2={13} y1={4} y2={4} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}
