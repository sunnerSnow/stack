"use client";

import { useMemo, useState, useTransition } from "react";
import { setPortfolioBenchmarkAction } from "@/app/actions";
import { formatDecimal } from "@/lib/format";
import { type ChartPoint, periodResult, RANGE_LABEL, RANGES, type RangeKey, rangeStart } from "@/lib/performance/periods";
import type { BenchmarkDto } from "@/lib/services/benchmarks";
import type { BenchmarkComparisonDto, PerformanceDto } from "@/lib/services/performance";
import { type ChartSeries, LineChart } from "./line-chart";

/**
 * 走勢與基準比較：上方一列控制（期間、比較基準）同時作用在下面所有數字與圖表。
 * 期間報酬一律用 TWR（入金出金不算報酬），基準用同一段日期、換算成同一個幣別。
 */

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
const pct = (n: number) => `${sign(n)}${Math.abs(n * 100).toFixed(2)}%`;
const pctAxis = (n: number, step: number) => `${sign(n)}${Math.abs(n * 100).toFixed(step * 100 < 1 ? 1 : 0)}%`;

/** 軸上的金額：萬、億 */
function moneyAxis(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  const short = (v: number) => String(Math.round(v * 100) / 100);
  if (a >= 1e8) return `${s}${short(a / 1e8)}億`;
  if (a >= 1e4) return `${s}${short(a / 1e4)}萬`;
  return `${s}${formatDecimal(String(Math.round(a)))}`;
}

function Unavailable({ reason }: { reason: string | null }) {
  return (
    <>
      <span className="tag tag-warn">無法計算</span>
      {reason ? <span className="mt-1 block text-xs font-normal leading-relaxed text-ink-3">{reason}</span> : null}
    </>
  );
}

function Stat({ label, children, note }: { label: React.ReactNode; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="min-w-0 p-5">
      <p className="kicker">{label}</p>
      <div className="mt-2 text-[19px] font-medium">{children}</div>
      {note ? <p className="mt-1 text-xs leading-relaxed text-ink-3">{note}</p> : null}
    </div>
  );
}

const BASIS_LABEL = { total_return: "總報酬（含股利再投入）", price: "價格報酬（不含股利）" } as const;

export function PerformanceCharts({
  portfolioId,
  baseCurrency,
  asOf,
  series,
  benchmark,
  options,
}: {
  portfolioId: string;
  baseCurrency: string;
  asOf: string;
  series: PerformanceDto["series"];
  benchmark: BenchmarkComparisonDto | null;
  options: BenchmarkDto[];
}) {
  const [range, setRange] = useState<RangeKey | "CUSTOM">("ALL");
  const firstBase = series[0]?.date ?? asOf;
  const [custom, setCustom] = useState({ from: rangeStart("1Y", asOf, firstBase), to: asOf });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const points: ChartPoint[] = useMemo(
    () => series.map((p) => ({ date: p.date, value: p.value === null ? null : Number(p.value), flow: Number(p.flow), benchmark: p.benchmark === null ? null : Number(p.benchmark) })),
    [series],
  );
  // 累積淨投入（從第一筆交易起，不分期間）
  const contributed = useMemo(() => {
    const out: number[] = [];
    for (const p of points) out.push((out.at(-1) ?? 0) + p.flow);
    return out;
  }, [points]);

  const from = range === "CUSTOM" ? (custom.from < firstBase ? firstBase : custom.from) : rangeStart(range, asOf, firstBase);
  const to = range === "CUSTOM" ? (custom.to > asOf ? asOf : custom.to) : asOf;
  const result = useMemo(() => periodResult(points, from, to), [points, from, to]);
  const offset = points.findIndex((p) => p.date === result.from);
  const dates = result.rows.map((r) => r.date);
  const money = (n: number) => formatDecimal(String(n), { maxFraction: baseCurrency === "TWD" ? 0 : 2 });

  const returnSeries: ChartSeries[] = useMemo(
    () => [
      { key: "portfolio", label: "我的組合（TWR）", color: "var(--color-series-1)", values: result.rows.map((r) => r.portfolio) },
      ...(benchmark ? [{ key: "benchmark", label: benchmark.name, color: "var(--color-series-2)", values: result.rows.map((r) => r.benchmark) }] : []),
    ],
    [result, benchmark],
  );
  // 第一筆交易的前一天（淨值 0）只是報酬的起點，淨值圖不畫，否則開頭會有一條從 0 拉上來的線
  const valueSeries: ChartSeries[] = useMemo(
    () => [
      { key: "value", label: "淨值", color: "var(--color-series-1)", values: result.rows.map((r) => (r.date === firstBase ? null : r.value)) },
      {
        key: "contributed",
        label: "累積淨投入",
        color: "var(--color-series-ref)",
        kind: "step",
        values: result.rows.map((r, i) => (offset < 0 || r.date === firstBase ? null : contributed[offset + i])),
      },
    ],
    [result, contributed, offset, firstBase],
  );

  const chooseBenchmark = (id: string) => {
    setError(null);
    startTransition(async () => {
      const r = await setPortfolioBenchmarkAction(portfolioId, id);
      if (r.error) setError(r.error);
    });
  };

  return (
    <section className="panel min-w-0">
      <div className="panel-head">
        <div>
          <p className="sh-n">03 — Trend</p>
          <h2>走勢與基準比較</h2>
        </div>
        <span className="text-xs text-ink-2">逐筆記帳的帳戶 · {baseCurrency}</span>
      </div>

      {/* 控制列：期間在前，作用在下面全部的數字與圖表 */}
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b-[3px] border-ink px-5 py-4">
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-bold">期間</span>
          <div className="seg" role="group" aria-label="期間">
            {RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={range === r} title={RANGE_LABEL[r]} onClick={() => setRange(r)}>
                {r === "ALL" ? "全部" : r}
              </button>
            ))}
            <button type="button" aria-pressed={range === "CUSTOM"} onClick={() => setRange("CUSTOM")}>
              自訂
            </button>
          </div>
        </div>
        {range === "CUSTOM" ? (
          <div className="flex items-end gap-2">
            <label className="field">
              <span>從</span>
              <input className="input num" type="date" min={firstBase} max={asOf} value={custom.from} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} />
            </label>
            <label className="field">
              <span>到</span>
              <input className="input num" type="date" min={firstBase} max={asOf} value={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} />
            </label>
          </div>
        ) : null}
        {options.length > 0 ? (
          <label className="field min-w-52">
            <span>比較基準</span>
            <select className="input" value={benchmark?.id ?? ""} disabled={pending} onChange={(e) => chooseBenchmark(e.target.value)}>
              {benchmark ? null : <option value="">請選擇</option>}
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.currency !== baseCurrency ? `（${o.currency}，換算成 ${baseCurrency}）` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {error ? <p className="alert mx-5 mt-4">{error}</p> : null}

      <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={pending}>
        <div className="grid divide-y-2 divide-ink border-b-[3px] border-ink sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x-2">
          <Stat label="我的組合（TWR）" note={result.portfolio.status === "ok" ? `${result.from} 收盤 ～ ${result.to}` : undefined}>
            {result.portfolio.status === "ok" ? <span className="num">{pct(result.portfolio.value!)}</span> : <Unavailable reason={result.portfolio.reason} />}
          </Stat>
          <Stat label={benchmark ? benchmark.name : "比較基準"} note={benchmark ? BASIS_LABEL[benchmark.returnBasis] : undefined}>
            {benchmark === null ? (
              <span className="text-sm text-ink-3">沒有可用的基準</span>
            ) : result.benchmark.status === "ok" ? (
              <span className="num">{pct(result.benchmark.value!)}</span>
            ) : (
              <Unavailable reason={result.benchmark.reason} />
            )}
          </Stat>
          <Stat label="差距" note="我的組合 − 基準">
            {result.excess === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <>
                <span className="num">
                  {sign(result.excess)}
                  {Math.abs(result.excess * 100).toFixed(2)}
                </span>
                <span className="ml-1 text-sm text-ink-2">個百分點</span>
              </>
            )}
          </Stat>
          <Stat label={`淨值變化（${baseCurrency}）`} note={<>期間淨投入 {money(result.netFlows)}（入金出金也會改變淨值）</>}>
            {result.valueChange === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="num">{formatDecimal(String(result.valueChange), { maxFraction: baseCurrency === "TWD" ? 0 : 2, signed: true })}</span>
            )}
          </Stat>
        </div>

        <div className="grid gap-8 px-5 py-5">
          <figure className="grid gap-1">
            <figcaption className="text-sm font-bold">累積報酬：我的組合 vs 基準</figcaption>
            <LineChart
              label={`${result.from} 收盤到 ${result.to} 的累積報酬：我的組合（時間加權）${benchmark ? `與${benchmark.name}` : ""}`}
              dates={dates}
              series={returnSeries}
              format={pct}
              axisFormat={pctAxis}
              includeZero
              height={260}
            />
          </figure>
          <figure className="grid gap-1">
            <figcaption className="text-sm font-bold">淨值走勢（{baseCurrency}）</figcaption>
            <LineChart label={`${result.from} 到 ${result.to} 的每日淨值與累積淨投入（${baseCurrency}）`} dates={dates} series={valueSeries} format={money} axisFormat={moneyAxis} height={220} />
          </figure>
        </div>

        <p className="border-t-[3px] border-ink px-5 py-3 text-xs leading-relaxed text-ink-2">
          我的組合用時間加權報酬（TWR），入金出金不算報酬；起點是期間第一天的前一天收盤。
          {benchmark ? (
            <>
              {" "}
              基準：{benchmark.name}，{BASIS_LABEL[benchmark.returnBasis]}，{benchmark.convertedTo ? `${benchmark.currency} 換算成 ${benchmark.convertedTo}（含匯率變動，臺銀即期中價）` : `${benchmark.currency} 計價`}。
              {benchmark.description}休市的日子沿用前一個交易日的值。資料來源 FinMind（{benchmark.currency === "USD" ? "美股日線" : "證交所指數"}）
              {benchmark.dataFrom ? `，已有 ${benchmark.dataFrom} ～ ${benchmark.dataTo}` : ""}。
              {benchmark.issues.map((issue) => ` ${issue}。`)}
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}
