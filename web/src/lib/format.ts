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

export const ACCOUNT_TYPE_LABEL: Record<string, string> = { brokerage: "券商", cash: "現金", other: "其他" };
export const MARKET_LABEL: Record<string, string> = { TW: "台股", US: "美股" };
