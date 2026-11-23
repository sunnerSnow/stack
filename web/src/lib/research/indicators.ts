/**
 * 技術指標（ta-v1）：用證交所／櫃買中心的每日收盤行情（market_daily），除權息日以參考價還原之前的價格。
 * 只描述過去的價格與成交量，不產生買賣訊號；資料不夠算的指標回 null。
 */
export const TA_VERSION = "ta-v1";

export interface DailyBar {
  date: string;
  close: number | null;
  volume: number | null;
}

export interface ExRightPoint {
  exDate: string;
  /** 除權息前一天的收盤價 */
  prevClose: number;
  /** 除權息參考價 */
  refPrice: number;
}

export interface TechnicalIndicators {
  version: typeof TA_VERSION;
  /** 最後一個有收盤價的交易日 */
  asOf: string;
  /** 當天實際收盤價（未還原） */
  close: number;
  /** 用到的交易日數 */
  bars: number;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  /** 收盤價相對均線（%） */
  closeVsMa20Pct: number | null;
  closeVsMa60Pct: number | null;
  /** 還原後的期間報酬（%） */
  ret5Pct: number | null;
  ret20Pct: number | null;
  ret60Pct: number | null;
  /** Wilder RSI（14 日） */
  rsi14: number | null;
  /** 區間（最多 RANGE_DAYS 個交易日）的最高／最低還原收盤價，以及收盤價距離它們多少（%） */
  rangeDays: number;
  rangeHigh: number | null;
  rangeLow: number | null;
  fromHighPct: number | null;
  fromLowPct: number | null;
  /** 5 日均量 ÷ 20 日均量 */
  volumeRatio: number | null;
}

/** 約一年的交易日 */
export const RANGE_DAYS = 250;
/** 區間高低點至少要有這麼多天才算 */
const MIN_RANGE_DAYS = 20;

interface AdjustedBar extends DailyBar {
  close: number;
  adj: number;
}

/**
 * 把除權息日之前的收盤價乘上「參考價 ÷ 前一日收盤」，讓價格可以跨除權息比較。
 * 最後一天之後才除權息的不算（不然全部價格會被等比例縮小，均線就跟實際收盤價對不上）。
 */
export function adjustCloses(bars: DailyBar[], exRights: ExRightPoint[]): AdjustedBar[] {
  const valid = bars
    .filter((b): b is DailyBar & { close: number } => b.close !== null && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (valid.length === 0) return [];
  const last = valid[valid.length - 1].date;
  const ex = exRights
    .filter((e) => e.prevClose > 0 && e.refPrice > 0 && e.exDate <= last)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
  const out: AdjustedBar[] = new Array(valid.length);
  let factor = 1;
  let k = 0;
  for (let i = valid.length - 1; i >= 0; i--) {
    while (k < ex.length && ex[k].exDate > valid[i].date) {
      factor *= ex[k].refPrice / ex[k].prevClose;
      k++;
    }
    out[i] = { ...valid[i], adj: valid[i].close * factor };
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

function movingAverage(adj: number[], n: number): number | null {
  return adj.length >= n ? mean(adj.slice(-n)) : null;
}

function periodReturn(adj: number[], n: number): number | null {
  return adj.length > n ? (adj[adj.length - 1] / adj[adj.length - 1 - n] - 1) * 100 : null;
}

/** Wilder RSI：前 n 個漲跌取平均，之後以 (前值 × (n−1) ＋ 當日) ÷ n 平滑 */
export function wilderRsi(adj: number[], n = 14): number | null {
  if (adj.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = adj[i] - adj[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < adj.length; i++) {
    const d = adj[i] - adj[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function volumeRatio(bars: AdjustedBar[]): number | null {
  const recent = bars.slice(-20);
  if (recent.length < 20 || recent.some((b) => b.volume === null)) return null;
  const v20 = mean(recent.map((b) => b.volume!));
  const v5 = mean(recent.slice(-5).map((b) => b.volume!));
  return v20 > 0 ? v5 / v20 : null;
}

export function computeIndicators(bars: DailyBar[], exRights: ExRightPoint[] = []): TechnicalIndicators | null {
  const adjusted = adjustCloses(bars, exRights);
  if (adjusted.length === 0) return null;
  const adj = adjusted.map((b) => b.adj);
  const last = adjusted[adjusted.length - 1];
  const close = last.adj;
  const ma20 = movingAverage(adj, 20);
  const ma60 = movingAverage(adj, 60);
  const range = adj.slice(-RANGE_DAYS);
  const hasRange = range.length >= MIN_RANGE_DAYS;
  const rangeHigh = hasRange ? Math.max(...range) : null;
  const rangeLow = hasRange ? Math.min(...range) : null;
  return {
    version: TA_VERSION,
    asOf: last.date,
    close: last.close,
    bars: adjusted.length,
    ma5: movingAverage(adj, 5),
    ma20,
    ma60,
    closeVsMa20Pct: ma20 === null ? null : (close / ma20 - 1) * 100,
    closeVsMa60Pct: ma60 === null ? null : (close / ma60 - 1) * 100,
    ret5Pct: periodReturn(adj, 5),
    ret20Pct: periodReturn(adj, 20),
    ret60Pct: periodReturn(adj, 60),
    rsi14: wilderRsi(adj, 14),
    rangeDays: range.length,
    rangeHigh,
    rangeLow,
    fromHighPct: rangeHigh === null ? null : (close / rangeHigh - 1) * 100,
    fromLowPct: rangeLow === null ? null : (close / rangeLow - 1) * 100,
    volumeRatio: volumeRatio(adjusted),
  };
}
