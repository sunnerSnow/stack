import Decimal from "decimal.js";

/**
 * 財務計算一律用十進位，不用 JavaScript number。
 * 資料庫欄位是 numeric(28, 10)：整數最多 18 位、小數 10 位。
 */
export const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const DB_SCALE = 10;
export const ZERO = new D(0);

export function dec(value: string | number | Dec | null | undefined): Dec {
  if (value === null || value === undefined || value === "") return ZERO;
  return new D(value);
}

/** 捨入到資料庫的小數位數 */
export function round(value: Dec): Dec {
  return value.toDecimalPlaces(DB_SCALE);
}

/** 寫進資料庫用的字串（固定小數位、不會出現科學記號） */
export function toDb(value: Dec): string {
  return round(value).toFixed(DB_SCALE);
}

/** 給 API／畫面的十進位字串：去掉多餘的 0，例如 "10020.0000000000" → "10020" */
export function toPlain(value: Dec | string): string {
  return (typeof value === "string" ? new D(value) : value).toFixed();
}

export function toPlainOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : toPlain(value);
}
