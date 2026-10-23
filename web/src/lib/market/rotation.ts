/**
 * 族群輪動的強度與動能（純函式，規格 5.18）。我們自己的定義，畫面上會寫出來：
 *
 * 1. 還原日報酬 r = 收盤價 ÷ 參考價 − 1；參考價平常是前一天收盤，除權息那天用交易所公布的除權息參考價
 *    （所以配息不會被當成下跌）。當天沒成交 → 不知道（指數持平）。
 *    單日漲跌超過 50%（台股漲跌幅限制 10%，多半是減資、分割恢復交易）→ 視為中斷，之後重新暖機。
 * 2. 相對強弱 RS = 還原指數 ÷ 基準（台灣加權報酬指數），兩邊都含息。
 * 3. 強度 = 100 × RS 的 10 日平均 ÷ RS 的 60 日平均：大於 100 表示最近兩週比近三個月的平均更強。
 * 4. 動能 = 100 × 今天的強度 ÷ 5 個交易日前的強度：大於 100 表示強度正在上升。
 * 5. 族群指數 = 成員當天還原報酬的平均（等權重），再用同樣的方法算強度與動能。
 *
 * 需要 60 + 5 個交易日的資料才有座標（暖機），不足時回 null，不補造。
 */

export const ROTATION = { version: "rot-v2", short: 10, long: 60, lag: 5, maxDailyMove: 0.5 } as const;

export type Quadrant = "leading" | "weakening" | "lagging" | "improving";
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  leading: "領先（強且轉強）",
  weakening: "轉弱（強但轉弱）",
  lagging: "落後（弱且轉弱）",
  improving: "改善（弱但轉強）",
};

export function quadrant(strength: number, momentum: number): Quadrant {
  if (strength >= 100) return momentum >= 100 ? "leading" : "weakening";
  return momentum >= 100 ? "improving" : "lagging";
}

export interface ReturnSeries {
  /** 每個交易日的還原報酬；不知道為 null */
  ret: (number | null)[];
  /** 這一天起重新開始（資料中斷） */
  breaks: boolean[];
}

/**
 * closes[i]：第 i 個交易日的收盤價（沒成交為 null）；refs[i]：那天的除權息參考價（沒有除權息為 null）。
 */
export function dailyReturns(closes: (number | null)[], refs: (number | null)[]): ReturnSeries {
  const ret: (number | null)[] = [];
  const breaks: boolean[] = [];
  let prev: number | null = null;
  closes.forEach((close, i) => {
    const ref = refs[i] ?? prev;
    let r: number | null = null;
    let broken = false;
    if (close !== null && ref !== null && ref > 0) {
      r = close / ref - 1;
      if (Math.abs(r) > ROTATION.maxDailyMove) {
        r = null;
        broken = true;
      }
    }
    ret.push(r);
    breaks.push(broken);
    if (close !== null) prev = close;
  });
  return { ret, breaks };
}

/** 還原指數（起點 1）：不知道的日子持平；中斷的那天重新從 1 開始。segment 是第幾段 */
export function chainIndex(series: ReturnSeries): { level: number[]; segment: number[] } {
  const level: number[] = [];
  const segment: number[] = [];
  let cur = 1;
  let seg = 0;
  series.ret.forEach((r, i) => {
    if (series.breaks[i]) {
      cur = 1;
      seg++;
    } else if (r !== null) cur *= 1 + r;
    level.push(cur);
    segment.push(seg);
  });
  return { level, segment };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * 強度與動能。index：還原指數；segment：段落（不同段不能混算）；bench：基準值（缺為 null）；
 * hasData：那天在段落裡有沒有實際資料（第一筆成交之前的日子不算）。
 */
export function rotationSeries(index: number[], segment: number[], bench: (number | null)[], hasData: boolean[]): { strength: (number | null)[]; momentum: (number | null)[] } {
  const { short, long, lag } = ROTATION;
  const rs = index.map((v, i) => (hasData[i] && bench[i] !== null && bench[i]! > 0 ? v / bench[i]! : null));
  const strength: (number | null)[] = rs.map((_, i) => {
    if (i < long - 1) return null;
    const window = rs.slice(i - long + 1, i + 1);
    if (window.some((x) => x === null) || segment[i - long + 1] !== segment[i]) return null;
    const vals = window as number[];
    return (100 * mean(vals.slice(-short))) / mean(vals);
  });
  const momentum = strength.map((s, i) => {
    const before = i >= lag ? strength[i - lag] : null;
    return s !== null && before !== null && segment[i - lag] === segment[i] ? (100 * s) / before : null;
  });
  return { strength, momentum };
}

/** 族群的等權重報酬：當天有報酬的成員取平均；都沒有為 null */
export function groupReturns(memberReturns: (number | null)[][], days: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let d = 0; d < days; d++) {
    const vals = memberReturns.map((m) => m[d]).filter((x): x is number => x !== null);
    out.push(vals.length > 0 ? mean(vals) : null);
  }
  return out;
}

/** 每一天是否已有資料（第一個非 null 報酬之後都算有；中斷那天起重新等第一個報酬） */
export function dataFlags(series: ReturnSeries): boolean[] {
  let seen = false;
  return series.ret.map((r, i) => {
    if (series.breaks[i]) seen = false;
    if (r !== null) seen = true;
    return seen;
  });
}
