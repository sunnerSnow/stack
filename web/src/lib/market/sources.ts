import { D } from "@/lib/money/decimal";

/**
 * 行情與匯率的資料來源（純函式：只解析，不連網、不碰資料庫）。
 *
 * - 台股上市：證交所 OpenAPI STOCK_DAY_ALL（最近一個交易日的全部收盤價）
 * - 台股上櫃：櫃買中心 OpenAPI tpex_mainboard_daily_close_quotes
 * - 美股：FinMind USStockPrice（逐檔查，代號的 . 改成 -，例如 BRK.B → BRK-B）
 * - 台股歷史日線（回補）：FinMind TaiwanStockPrice
 * - 匯率：FinMind TaiwanExchangeRate（臺灣銀行牌告），取即期買入與賣出的中價
 *
 * 沒有成交、停牌或格式不對的列直接略過，不會變成 0。
 */

export const TWSE_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
export const TPEX_CLOSE_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";
const FINMIND = "https://api.finmindtrade.com/api/v4/data";

const range = (startDate: string, endDate?: string) => `&start_date=${startDate}${endDate ? `&end_date=${endDate}` : ""}`;

export const finmindUsUrl = (symbol: string, startDate: string, endDate?: string) =>
  `${FINMIND}?dataset=USStockPrice&data_id=${encodeURIComponent(finmindUsSymbol(symbol))}${range(startDate, endDate)}`;
/** 台股歷史日線（回補用；每天的最新價仍以證交所／櫃買中心為主） */
export const finmindTwUrl = (symbol: string, startDate: string, endDate?: string) =>
  `${FINMIND}?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(symbol)}${range(startDate, endDate)}`;
export const finmindFxUrl = (currency: string, startDate: string, endDate?: string) =>
  `${FINMIND}?dataset=TaiwanExchangeRate&data_id=${encodeURIComponent(currency)}${range(startDate, endDate)}`;

/** Nasdaq 代號表用 BRK.B，FinMind 用 BRK-B */
export const finmindUsSymbol = (symbol: string) => symbol.replaceAll(".", "-");

export interface ClosePrice {
  symbol: string;
  date: string;
  close: string;
}

export interface FxRate {
  base: string;
  quote: string;
  date: string;
  rate: string;
}

const PRICE = /^\d+(\.\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 民國年 YYYMMDD（例如 1151020）→ 2026-10-20 */
function rocCompactToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2,3})(\d{2})(\d{2})$/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

/** JSON 裡的數字或字串 → 十進位字串；不是正數就回 null */
function positive(value: unknown): string | null {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replaceAll(",", "") : "";
  if (!PRICE.test(s)) return null;
  return new D(s).greaterThan(0) ? new D(s).toFixed() : null;
}

function rows(json: unknown): Record<string, unknown>[] {
  return Array.isArray(json) ? json.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null) : [];
}

export function parseTwseDayAll(json: unknown): ClosePrice[] {
  return rows(json).flatMap((r) => {
    const date = rocCompactToIso(String(r.Date ?? ""));
    const close = positive(r.ClosingPrice);
    const symbol = String(r.Code ?? "").trim();
    return date && close && symbol ? [{ symbol, date, close }] : [];
  });
}

export function parseTpexClose(json: unknown): ClosePrice[] {
  return rows(json).flatMap((r) => {
    const date = rocCompactToIso(String(r.Date ?? ""));
    const close = positive(r.Close);
    const symbol = String(r.SecuritiesCompanyCode ?? "").trim();
    return date && close && symbol ? [{ symbol, date, close }] : [];
  });
}

function finmindData(json: unknown): Record<string, unknown>[] {
  const body = json as { status?: number; msg?: string; data?: unknown };
  if (body?.status !== 200) throw new Error(`FinMind 回應 ${body?.status ?? "?"}：${body?.msg ?? "格式不對"}`);
  return rows(body.data);
}

/** FinMind 美股日線；symbol 用我們主檔的寫法（BRK.B） */
export function parseFinmindUsPrices(json: unknown, symbol: string): ClosePrice[] {
  return finmindData(json).flatMap((r) => {
    const date = typeof r.date === "string" && ISO.test(r.date) ? r.date : null;
    const close = positive(r.Close);
    return date && close ? [{ symbol, date, close }] : [];
  });
}

/** FinMind 台股日線（欄位是小寫 close；停牌日收盤為 0 的略過） */
export function parseFinmindTwPrices(json: unknown, symbol: string): ClosePrice[] {
  return finmindData(json).flatMap((r) => {
    const date = typeof r.date === "string" && ISO.test(r.date) ? r.date : null;
    const close = positive(r.close);
    return date && close ? [{ symbol, date, close }] : [];
  });
}

/** 臺銀牌告：即期買入與賣出的中價，方向是 1 外幣 = rate 台幣 */
export function parseFinmindFx(json: unknown, currency: string): FxRate[] {
  return finmindData(json).flatMap((r) => {
    const date = typeof r.date === "string" && ISO.test(r.date) ? r.date : null;
    const buy = positive(r.spot_buy);
    const sell = positive(r.spot_sell);
    if (!date || !buy || !sell) return [];
    return [{ base: currency, quote: "TWD", date, rate: new D(buy).plus(sell).dividedBy(2).toDecimalPlaces(6).toFixed() }];
  });
}
