import { D } from "@/lib/money/decimal";

/**
 * 以字串格式化十進位數字（不經過浮點數）：千分位、指定最多小數位、負號用 −。
 */
export function formatDecimal(value: string | null | undefined, opts: { maxFraction?: number; minFraction?: number; signed?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const { maxFraction = 2, minFraction = 0, signed = false } = opts;
  const d = new D(value).toDecimalPlaces(maxFraction);
  const [int, frac = ""] = d.abs().toFixed().split(".");
  const intPart = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracPart = frac.padEnd(minFraction, "0");
  const sign = d.isZero() ? "" : d.isNegative() ? "−" : signed ? "+" : "";
  return `${sign}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

/** 損益方向（台灣慣例：賺錢紅、賠錢綠；同時一定附上 +／− 與文字） */
export function pnlTone(value: string | null | undefined): "gain" | "loss" | "flat" {
  if (!value) return "flat";
  const d = new D(value);
  return d.isZero() ? "flat" : d.isNegative() ? "loss" : "gain";
}

const DATE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** 資料庫的 timestamptz 字串（例如 "2026-10-19 04:33:22.1+00"）→ 台北時間「2026-10-19 12:33」 */
export function formatDateTime(value: string): string {
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? value : DATE_TIME.format(date);
}

export const ACCOUNT_TYPE_LABEL: Record<string, string> = { brokerage: "券商", cash: "現金", other: "其他" };
export const MARKET_LABEL: Record<string, string> = { TW: "台股", US: "美股" };
