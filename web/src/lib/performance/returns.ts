/**
 * 報酬率（純函式，規格第 7 節）。
 *
 * 報酬率用浮點數求解（金額先用十進位加總好再轉成 number），結果取到小數第 6 位（0.0001%）。
 * 算不出來時一律回傳狀態與原因，不會默默回傳 0。
 */

const DAY = 24 * 60 * 60 * 1000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const fixed = (n: number) => (Math.round(n * 1e6) / 1e6).toString();

// ---------------------------------------------------------------------------
// XIRR（資金加權）：Σ CF_i / (1 + r)^((d_i − d_0) / 365) = 0
// 站在使用者的角度：投入是負數、提領是正數、期末淨值是正數
// ---------------------------------------------------------------------------

export interface CashFlow {
  date: string;
  amount: number;
}

export interface XirrResult {
  status: "ok" | "no_flows" | "no_sign_change" | "multiple_roots" | "no_solution" | "too_short";
  /** 年化報酬率（0.0812 = 8.12%） */
  rate: string | null;
  reason: string | null;
}

const LOW = -0.9999;
const HIGH = 100; // +10,000%

export function xirr(flows: CashFlow[]): XirrResult {
  const nonZero = flows.filter((f) => f.amount !== 0);
  if (nonZero.length === 0) return { status: "no_flows", rate: null, reason: "沒有入金、提領或期末淨值" };
  if (!nonZero.some((f) => f.amount < 0) || !nonZero.some((f) => f.amount > 0)) {
    return { status: "no_sign_change", rate: null, reason: "現金流沒有同時包含投入與回收（例如沒有記入金，或期末淨值為零）" };
  }
  const d0 = nonZero.reduce((min, f) => (f.date < min ? f.date : min), nonZero[0].date);
  const terms = nonZero.map((f) => ({ t: daysBetween(d0, f.date) / 365, a: f.amount }));
  if (terms.every((x) => x.t === 0)) return { status: "too_short", rate: null, reason: "所有現金流都在同一天，無法計算年化報酬" };
  const npv = (r: number) => terms.reduce((s, x) => s + x.a / Math.pow(1 + r, x.t), 0);

  // 在 −99.99%～+10,000% 之間掃一遍，數有幾個變號區間
  const grid: number[] = [LOW];
  for (let r = -0.99; r < 1; r += 0.01) grid.push(r);
  for (let r = 1; r <= HIGH; r *= 1.1) grid.push(r);
  grid.push(HIGH);
  const brackets: [number, number][] = [];
  let prev = npv(grid[0]);
  for (let i = 1; i < grid.length; i++) {
    const cur = npv(grid[i]);
    // 剛好落在根上：記一次，prev 不更新，下一格才不會又算成一次變號
    if (cur === 0) {
      brackets.push([grid[i], grid[i]]);
      continue;
    }
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev !== 0 && Math.sign(prev) !== Math.sign(cur)) brackets.push([grid[i - 1], grid[i]]);
    prev = cur;
  }
  if (brackets.length === 0) return { status: "no_solution", rate: null, reason: "在 −99.99%～+10,000% 之間找不到解" };
  if (brackets.length > 1) return { status: "multiple_roots", rate: null, reason: "現金流方向改變多次，XIRR 有不只一個解，不採用任何一個" };

  let [lo, hi] = brackets[0];
  let flo = npv(lo);
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return { status: "ok", rate: fixed((lo + hi) / 2), reason: null };
}

// ---------------------------------------------------------------------------
// TWR（時間加權）：每天收盤後估值，外部現金流視為「當天開盤前」發生（先入金才下單）
// r_i = V_i / (V_(i−1) + F_i) − 1，TWR = Π(1 + r_i) − 1
// 第一天就是「收盤淨值 ÷ 入金」，買進價和收盤價的差也算進報酬（若視為收盤時入金，第一天的報酬會整個不見）。
// ---------------------------------------------------------------------------

export interface DailyPoint {
  date: string;
  /** 當天收盤後的淨值（含當天的現金流）；算不出來為 null */
  value: number | null;
  /** 當天的外部現金流淨額（流入為正），視為開盤前發生 */
  flow: number;
}

export interface TwrResult {
  status: "ok" | "gap" | "non_positive" | "no_capital" | "too_short";
  /** 期間累積報酬（0.25 = 25%） */
  cumulative: string | null;
  /** 期間滿一年才年化，否則 null */
  annualized: string | null;
  from: string | null;
  to: string | null;
  days: number;
  reason: string | null;
}

export interface TwrPath {
  status: "ok" | "gap" | "non_positive" | "no_capital";
  reason: string | null;
  /** 每一天收盤時的累積報酬（0.25 = 25%）；還沒有資金或算不下去之後為 null */
  path: (number | null)[];
  /** 整段的成長倍數（status 為 ok 才有意義） */
  growth: number;
}

/**
 * 從某一天收盤（淨值 openingValue）起逐日連乘；遇到缺值或淨值為負就停下並回傳原因。
 * openingValue 為 0 表示起點之前沒有資金（例如第一筆交易的前一天）。
 */
export function twrPath(points: DailyPoint[], openingValue = 0): TwrPath {
  const path: (number | null)[] = [];
  let growth = 1;
  let computed = 0;
  let prevValue = openingValue;
  const stop = (status: "gap" | "non_positive", reason: string): TwrPath => {
    while (path.length < points.length) path.push(null);
    return { status, reason, path, growth };
  };
  for (const cur of points) {
    if (cur.value === null) return stop("gap", `${cur.date} 的淨值算不出來（缺價格或匯率）`);
    const start = prevValue + cur.flow;
    if (start < 0 || cur.value < 0) return stop("non_positive", `${cur.date} 的淨值是負的（常見原因是少記了入金），時間加權報酬沒有意義`);
    // 開盤時沒有資金、收盤卻有淨值：錢不是從入金來的（常見是只記了買進），之後的報酬會建立在錯的基礎上
    if (start === 0 && cur.value !== 0) return stop("non_positive", `${cur.date} 沒有投入資金卻有淨值（常見原因是少記了入金），時間加權報酬沒有意義`);
    // 開盤時沒有資金（還沒開始或全部提領）：這一天沒有可計算的報酬
    if (start > 0) {
      growth *= cur.value / start;
      computed++;
    }
    path.push(computed > 0 ? growth - 1 : null);
    prevValue = cur.value;
  }
  if (computed === 0) return { status: "no_capital", reason: "期間內沒有投入的資金（淨值一直是 0），常見原因是沒有記入金", path, growth };
  return { status: "ok", reason: null, path, growth };
}

export function chainTwr(points: DailyPoint[]): TwrResult {
  const from = points[0]?.date ?? null;
  const to = points.at(-1)?.date ?? null;
  const days = from && to ? daysBetween(from, to) : 0;
  const fail = (status: TwrResult["status"], reason: string): TwrResult => ({ status, cumulative: null, annualized: null, from, to, days, reason });
  if (points.length < 2 || days === 0) return fail("too_short", "期間不到一天");

  const r = twrPath(points);
  if (r.status !== "ok") return fail(r.status, r.reason!);
  return {
    status: "ok",
    cumulative: fixed(r.growth - 1),
    annualized: days >= 365 ? fixed(Math.pow(r.growth, 365 / days) - 1) : null,
    from,
    to,
    days,
    reason: null,
  };
}

/** 簡單報酬率 = 整體損益 ÷ 淨投入；淨投入不是正數就不適用（null） */
export function simpleReturn(totalPnl: number, netContributions: number): string | null {
  return netContributions > 0 ? fixed(totalPnl / netContributions) : null;
}
