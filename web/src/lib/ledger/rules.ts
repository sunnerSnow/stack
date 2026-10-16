import { type Dec, ZERO } from "@/lib/money/decimal";

/**
 * 交易類型的持倉與現金效果規則（唯一來源）。
 * 使用者輸入的金額一律是正數，正負號只由這裡決定，前端不能自己決定。
 *
 * Phase 1 只開放下列八種；schema 已預留轉帳、分割、調整等類型，之後的 Phase 再開。
 */
export const PHASE1_TYPES = ["buy", "sell", "deposit", "withdrawal", "dividend", "interest", "fee", "tax"] as const;
export type Phase1Type = (typeof PHASE1_TYPES)[number];

export type CashEventType = Phase1Type;
export type TaxKind = "transaction_tax" | "withholding_tax";

export interface TransactionRule {
  label: string;
  /** 是否需要（或禁止）指定資產 */
  asset: "required" | "forbidden";
  /** 買賣：以數量 × 單價計算成交金額；其他類型直接輸入金額 */
  trade: boolean;
  /** 可以另外填手續費／稅／其他費用 */
  allowsCosts: boolean;
  /** tax 欄位的子類型 */
  taxKind: TaxKind | null;
  /** 只有使用者與投資組合邊界之外的入金／出金才算外部現金流 */
  externalFlow: "contribution" | "withdrawal" | null;
  /** 對持倉的效果 */
  position: "open_lot" | "close_fifo" | null;
}

export const TRANSACTION_RULES: Record<Phase1Type, TransactionRule> = {
  buy: { label: "買進", asset: "required", trade: true, allowsCosts: true, taxKind: "transaction_tax", externalFlow: null, position: "open_lot" },
  sell: { label: "賣出", asset: "required", trade: true, allowsCosts: true, taxKind: "transaction_tax", externalFlow: null, position: "close_fifo" },
  deposit: { label: "入金", asset: "forbidden", trade: false, allowsCosts: false, taxKind: null, externalFlow: "contribution", position: null },
  withdrawal: { label: "出金", asset: "forbidden", trade: false, allowsCosts: false, taxKind: null, externalFlow: "withdrawal", position: null },
  dividend: { label: "現金股息", asset: "required", trade: false, allowsCosts: true, taxKind: "withholding_tax", externalFlow: null, position: null },
  interest: { label: "利息", asset: "forbidden", trade: false, allowsCosts: true, taxKind: "withholding_tax", externalFlow: null, position: null },
  fee: { label: "費用", asset: "forbidden", trade: false, allowsCosts: false, taxKind: null, externalFlow: null, position: null },
  tax: { label: "稅費", asset: "forbidden", trade: false, allowsCosts: false, taxKind: null, externalFlow: null, position: null },
};

export interface Amounts {
  gross: Dec;
  fee: Dec;
  tax: Dec;
  otherCost: Dec;
}

export function totalCosts(a: Amounts): Dec {
  return a.fee.plus(a.tax).plus(a.otherCost);
}

/**
 * 交易對帳戶現金的影響（正數入帳、負數支出）。
 * - 買進：現金減少「成交金額 ＋ 手續費 ＋ 稅 ＋ 其他費用」
 * - 賣出：現金增加「成交金額 − 手續費 − 交易稅 − 其他費用」
 * - 股息／利息：現金增加實際淨額
 */
export function cashEffect(type: Phase1Type, a: Amounts): Dec {
  switch (type) {
    case "buy":
      return a.gross.plus(totalCosts(a)).negated();
    case "sell":
    case "dividend":
    case "interest":
      return a.gross.minus(totalCosts(a));
    case "deposit":
      return a.gross;
    case "withdrawal":
    case "fee":
    case "tax":
      return a.gross.negated();
  }
}

/** 買進批次的成本：成交金額加上可資本化的買進費用 */
export function lotCost(a: Amounts): Dec {
  return a.gross.plus(totalCosts(a));
}

export function isPhase1Type(value: string): value is Phase1Type {
  return (PHASE1_TYPES as readonly string[]).includes(value);
}

export const NO_COSTS: Pick<Amounts, "fee" | "tax" | "otherCost"> = { fee: ZERO, tax: ZERO, otherCost: ZERO };
