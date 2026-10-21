/**
 * 上市櫃每日全市場資料的來源（純函式：只解析，不連網）。
 *
 * - 證交所每日收盤行情 MI_INDEX（type=ALLBUT0999：不含權證、牛熊證）
 * - 證交所三大法人買賣超日報 T86
 * - 證交所除權除息計算結果表 TWT49U（可查一段期間）
 * - 櫃買中心上櫃股票行情 dailyQuotes、三大法人買賣明細 insti/dailyTrade、除權除息計算結果 exDailyQ
 *
 * 除權息那天證交所的「漲跌價差」是 0（標 X），所以還原報酬要用除權息參考價，不能用漲跌價差。
 * 沒有成交（收盤價 --）的列略過；當天沒有資料（假日、還沒公布）回傳空陣列。
 */

const TWSE = "https://www.twse.com.tw/rwd/zh";
const TPEX = "https://www.tpex.org.tw/www/zh-tw";

const compact = (iso: string) => iso.replaceAll("-", "");
const slash = (iso: string) => iso.replaceAll("-", "/");

export const twseQuotesUrl = (date: string) => `${TWSE}/afterTrading/MI_INDEX?date=${compact(date)}&type=ALLBUT0999&response=json`;
export const twseInstUrl = (date: string) => `${TWSE}/fund/T86?date=${compact(date)}&selectType=ALLBUT0999&response=json`;
export const twseExRightsUrl = (start: string, end: string) => `${TWSE}/exRight/TWT49U?startDate=${compact(start)}&endDate=${compact(end)}&response=json`;
export const tpexQuotesUrl = (date: string) => `${TPEX}/afterTrading/dailyQuotes?date=${slash(date)}&type=EW&response=json`;
export const tpexInstUrl = (date: string) => `${TPEX}/insti/dailyTrade?type=Daily&sect=AL&date=${slash(date)}&response=json`;
export const tpexExRightsUrl = (start: string, end: string) => `${TPEX}/bulletin/exDailyQ?startDate=${slash(start)}&endDate=${slash(end)}&response=json`;

export interface DailyQuote {
  symbol: string;
  close: string;
  /** 成交股數 */
  volume: string;
  /** 成交金額（元） */
  turnover: string;
}

export interface InstFlow {
  symbol: string;
  /** 外資（含外資自營商）買賣超股數 */
  foreign: string;
  /** 投信 */
  trust: string;
  /** 自營商（自行買賣＋避險） */
  dealer: string;
}

export interface ExRight {
  date: string;
  symbol: string;
  prevClose: string;
  refPrice: string;
}

type Row = unknown[];
interface Table {
  title?: string;
  fields: string[];
  data: Row[];
}

const norm = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, "").trim();
/** "1,234.50" → "1234.5"；不是數字（--、空白）回 null */
function num(value: unknown): string | null {
  const s = norm(value).replaceAll(",", "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = s.replace(/^\+/, "");
  // 去掉多餘的 0：「102.50」→「102.5」、「-0.00」→「0」
  const [i, f = ""] = n.split(".");
  const frac = f.replace(/0+$/, "");
  const int = i.replace(/^(-?)0+(?=\d)/, "$1");
  const out = frac ? `${int}.${frac}` : int;
  return out === "-0" ? "0" : out;
}
const positive = (v: unknown) => {
  const n = num(v);
  return n !== null && Number(n) > 0 ? n : null;
};
const symbolOf = (v: unknown) => norm(v).toUpperCase();

/** 民國日期「115年07月21日」「115/07/16」→ 2026-07-21 */
export function rocToIso(value: unknown): string | null {
  const m = norm(value).match(/^(\d{2,3})[年/](\d{1,2})[月/](\d{1,2})日?$/);
  return m ? `${Number(m[1]) + 1911}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

function tablesOf(json: unknown): Table[] {
  const body = json as { tables?: unknown; fields?: unknown; data?: unknown; title?: string };
  const list: unknown[] = Array.isArray(body?.tables) ? body.tables : body?.fields ? [body] : [];
  return list.flatMap((t) => {
    const tb = t as { title?: string; fields?: unknown; data?: unknown };
    return Array.isArray(tb.fields) && Array.isArray(tb.data) ? [{ title: tb.title, fields: tb.fields.map(norm), data: tb.data.filter(Array.isArray) as Row[] }] : [];
  });
}

/** 證交所回應：stat 不是 OK（假日、還沒公布）就是沒有資料 */
function twseTables(json: unknown): Table[] {
  return (json as { stat?: string })?.stat === "OK" ? tablesOf(json) : [];
}

function column(t: Table, name: string): number {
  const i = t.fields.indexOf(norm(name));
  if (i < 0) throw new Error(`找不到欄位「${name}」（${t.title ?? "表格"}的格式可能改了）`);
  return i;
}

export function parseTwseQuotes(json: unknown): DailyQuote[] {
  const t = twseTables(json).find((tb) => tb.fields.includes("證券代號") && tb.fields.includes("收盤價"));
  if (!t) return [];
  const [c, close, vol, value] = [column(t, "證券代號"), column(t, "收盤價"), column(t, "成交股數"), column(t, "成交金額")];
  return t.data.flatMap((r) => {
    const p = positive(r[close]);
    const v = num(r[vol]);
    const m = num(r[value]);
    return p && v !== null && m !== null ? [{ symbol: symbolOf(r[c]), close: p, volume: v, turnover: m }] : [];
  });
}

export function parseTwseInst(json: unknown): InstFlow[] {
  const t = twseTables(json).find((tb) => tb.fields.includes("證券代號") && tb.fields.includes("三大法人買賣超股數"));
  if (!t) return [];
  const c = column(t, "證券代號");
  const foreign = column(t, "外陸資買賣超股數(不含外資自營商)");
  const foreignDealer = column(t, "外資自營商買賣超股數");
  const trust = column(t, "投信買賣超股數");
  const dealer = column(t, "自營商買賣超股數");
  return t.data.flatMap((r) => {
    const [f, fd, tr, d] = [num(r[foreign]), num(r[foreignDealer]), num(r[trust]), num(r[dealer])];
    if (f === null || fd === null || tr === null || d === null) return [];
    return [{ symbol: symbolOf(r[c]), foreign: String(Number(f) + Number(fd)), trust: tr, dealer: d }];
  });
}

export function parseTwseExRights(json: unknown): ExRight[] {
  const t = twseTables(json).find((tb) => tb.fields.includes("除權息參考價"));
  if (!t) return [];
  const [d, c, prev, ref] = [column(t, "資料日期"), column(t, "股票代號"), column(t, "除權息前收盤價"), column(t, "除權息參考價")];
  return t.data.flatMap((r) => {
    const date = rocToIso(r[d]);
    const [p, rf] = [positive(r[prev]), positive(r[ref])];
    return date && p && rf ? [{ date, symbol: symbolOf(r[c]), prevClose: p, refPrice: rf }] : [];
  });
}

export function parseTpexQuotes(json: unknown): DailyQuote[] {
  const t = tablesOf(json).find((tb) => tb.fields.includes("代號") && tb.fields.includes("收盤") && tb.data.length > 0);
  if (!t) return [];
  const [c, close, vol, value] = [column(t, "代號"), column(t, "收盤"), column(t, "成交股數"), column(t, "成交金額(元)")];
  return t.data.flatMap((r) => {
    const p = positive(r[close]);
    const v = num(r[vol]);
    const m = num(r[value]);
    return p && v !== null && m !== null ? [{ symbol: symbolOf(r[c]), close: p, volume: v, turnover: m }] : [];
  });
}

/**
 * 櫃買三大法人：欄名重複（每一組都是買進／賣出／買賣超），只能靠位置：
 * 4 外資及陸資(不含外資自營商)、7 外資自營商、10 外資合計、13 投信、16 自營商(自行買賣)、19 自營商(避險)、22 自營商合計、23 三大法人合計。
 * 用「外資合計＋投信＋自營商合計＝三大法人合計」檢查，對不上的列不收（格式改了寧可不收也不收錯）。
 */
export function parseTpexInst(json: unknown): InstFlow[] {
  const t = tablesOf(json).find((tb) => tb.fields.length >= 24 && tb.fields[0] === "代號");
  if (!t) return [];
  return t.data.flatMap((r) => {
    const [f, tr, d, total] = [num(r[10]), num(r[13]), num(r[22]), num(r[23])];
    if (f === null || tr === null || d === null || total === null) return [];
    if (Number(f) + Number(tr) + Number(d) !== Number(total)) return [];
    return [{ symbol: symbolOf(r[0]), foreign: f, trust: tr, dealer: d }];
  });
}

export function parseTpexExRights(json: unknown): ExRight[] {
  const t = tablesOf(json).find((tb) => tb.fields.includes("除權息參考價"));
  if (!t) return [];
  const [d, c, prev, ref] = [column(t, "除權息日期"), column(t, "代號"), column(t, "除權息前收盤價"), column(t, "除權息參考價")];
  return t.data.flatMap((r) => {
    const date = rocToIso(r[d]);
    const [p, rf] = [positive(r[prev]), positive(r[ref])];
    return date && p && rf ? [{ date, symbol: symbolOf(r[c]), prevClose: p, refPrice: rf }] : [];
  });
}
