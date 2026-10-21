import { daysBetween, twrPath } from "@/lib/performance/returns";

/**
 * 期間報酬與基準比較（純函式，伺服器與圖表共用）。
 *
 * 比較的起點是「起點那天的收盤」：投資組合從那天收盤的淨值開始逐日連乘 TWR，
 * 基準用同一天（或之前最近一個交易日）的值，兩者日期區間與幣別一致（規格 7.5）。
 */

export const RANGES = ["1M", "3M", "6M", "YTD", "1Y", "ALL"] as const;
export type RangeKey = (typeof RANGES)[number];
export const RANGE_LABEL: Record<RangeKey, string> = { "1M": "1 個月", "3M": "3 個月", "6M": "6 個月", YTD: "今年以來", "1Y": "1 年", ALL: "全部" };

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 往前推 n 個月；月底對不上時取該月最後一天（3/31 往前一個月 → 2/28） */
export function minusMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

/**
 * 期間的起點（那天收盤是比較基準）。firstBase 是最早可用的起點（第一筆交易的前一天）；
 * 起點早於它時以它為準。
 */
export function rangeStart(range: RangeKey, end: string, firstBase: string): string {
  const raw =
    range === "ALL"
      ? firstBase
      : range === "YTD"
        ? `${Number(end.slice(0, 4)) - 1}-12-31`
        : minusMonths(end, range === "1M" ? 1 : range === "3M" ? 3 : range === "6M" ? 6 : 12);
  return raw < firstBase ? firstBase : raw;
}

/** 每一天的資料：淨值（收盤、基準幣別）、當天的外部現金流（視為開盤前）、基準值（已換算成基準幣別） */
export interface ChartPoint {
  date: string;
  value: number | null;
  flow: number;
  benchmark: number | null;
}

export interface PeriodRow {
  date: string;
  value: number | null;
  /** 起點以來的累積淨投入（不含起點當天） */
  netFlow: number;
  /** 起點以來的 TWR 累積報酬 */
  portfolio: number | null;
  /** 起點以來的基準累積報酬 */
  benchmark: number | null;
}

export interface PeriodResult {
  from: string;
  to: string;
  days: number;
  rows: PeriodRow[];
  portfolio: { status: "ok" | "gap" | "non_positive" | "no_capital" | "no_data"; value: number | null; reason: string | null };
  benchmark: { status: "ok" | "missing"; value: number | null; reason: string | null };
  /** 投資組合減基準（百分點，0.012 = 1.2 個百分點）；任一邊算不出來為 null */
  excess: number | null;
  /** 期末淨值 − 起點淨值（含入金出金的影響） */
  valueChange: number | null;
  /** 期間內的淨投入 */
  netFlows: number;
}

/** points 必須是連續的每一天、已排序；from 起點、to 終點都要在 points 的範圍內 */
export function periodResult(points: ChartPoint[], from: string, to: string): PeriodResult {
  const a = points.findIndex((p) => p.date >= from);
  let b = points.length - 1;
  while (b >= 0 && points[b].date > to) b--;
  const empty = (reason: string): PeriodResult => ({
    from,
    to,
    days: daysBetween(from, to),
    rows: [],
    portfolio: { status: "no_data", value: null, reason },
    benchmark: { status: "missing", value: null, reason },
    excess: null,
    valueChange: null,
    netFlows: 0,
  });
  if (a < 0 || b <= a) return empty("期間內沒有資料");

  const anchor = points[a];
  const after = points.slice(a + 1, b + 1);
  // 投資組合：從起點收盤的淨值開始連乘
  let portfolio: PeriodResult["portfolio"];
  let path: (number | null)[];
  if (anchor.value === null) {
    portfolio = { status: "gap", value: null, reason: `起點 ${anchor.date} 的淨值算不出來（缺價格或匯率）` };
    path = after.map(() => null);
  } else if (anchor.value < 0) {
    portfolio = { status: "non_positive", value: null, reason: `起點 ${anchor.date} 的淨值是負的（常見原因是少記了入金），時間加權報酬沒有意義` };
    path = after.map(() => null);
  } else {
    const r = twrPath(after, anchor.value);
    // 算不出來就整條不畫：中斷前的那一段常常也是錯的基礎（例如少記入金時的極小淨值）
    path = r.status === "ok" ? r.path : after.map(() => null);
    portfolio = r.status === "ok" ? { status: "ok", value: r.growth - 1, reason: null } : { status: r.status, value: null, reason: r.reason };
  }

  // 起點那天兩邊都是 0%（投資組合要在起點有資金，或隔天就開始有報酬）
  const base = anchor.benchmark;
  const startsAtZero = portfolio.status === "ok" && (anchor.value! > 0 || path[0] !== null);
  const rows: PeriodRow[] = [{ date: anchor.date, value: anchor.value, netFlow: 0, portfolio: startsAtZero ? 0 : null, benchmark: base !== null ? 0 : null }];
  let netFlow = 0;
  after.forEach((p, i) => {
    netFlow += p.flow;
    rows.push({ date: p.date, value: p.value, netFlow, portfolio: path[i], benchmark: base !== null && p.benchmark !== null ? p.benchmark / base - 1 : null });
  });
  const end = rows.at(-1)!;
  const benchmark: PeriodResult["benchmark"] =
    base === null
      ? { status: "missing", value: null, reason: `基準在起點 ${anchor.date} 沒有資料` }
      : end.benchmark === null
        ? { status: "missing", value: null, reason: `基準在 ${end.date} 沒有資料` }
        : { status: "ok", value: end.benchmark, reason: null };

  return {
    from: anchor.date,
    to: end.date,
    days: daysBetween(anchor.date, end.date),
    rows,
    portfolio,
    benchmark,
    excess: portfolio.value !== null && benchmark.value !== null ? portfolio.value - benchmark.value : null,
    valueChange: end.value !== null && anchor.value !== null ? end.value - anchor.value : null,
    netFlows: netFlow,
  };
}
