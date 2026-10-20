import { D, type Dec } from "@/lib/money/decimal";

/**
 * 手續費與證交稅估算（純函式；伺服器入帳與表單即時顯示共用同一份）。
 *
 * - 只在使用者沒填費用、而且帳戶開了自動估算（fee_rate 不是 null）時使用；實際的券商成交費用一律優先。
 * - 手續費依帳戶設定：成交金額 × 費率 × 折扣，捨入到幣別最小單位，再套最低（台股零股可另設）與上限。
 * - 證交稅只有台股賣出：依法定稅率與生效期間（TW_TAX_RULES），元以下捨去。
 * - 估算結果連同依據存進 transactions.cost_estimate，畫面標示「估算」。這不是稅務建議。
 */

export interface FeeSettings {
  /** 手續費率（0.001425 = 0.1425%）；null 表示不自動估算 */
  feeRate: string | null;
  /** 折扣倍數（0.28 = 2.8 折） */
  feeDiscount: string;
  feeMin: string;
  /** 台股零股的最低手續費；null 表示跟整股相同 */
  feeMinOddLot: string | null;
  feeMax: string | null;
  feeRounding: "floor" | "round";
}

/** 判斷證交稅率需要的資產資訊（共用主檔的 metadata.kind／bondEtf；私人代號只有 assetType） */
export interface TaxAsset {
  market: string;
  symbol: string;
  assetType: string;
  kind?: string | null;
  bondEtf?: boolean | null;
}

export interface FeeEstimate {
  amount: string;
  rate: string;
  discount: string;
  /** 費率算出來（已捨入）的金額 */
  computed: string;
  minimum: string;
  /** 最後採用：費率、最低手續費或上限 */
  basis: "rate" | "minimum" | "maximum";
  oddLot: boolean;
  rounding: "floor" | "round";
}

export interface TaxEstimate {
  amount: string;
  rate: string;
  ruleId: string;
  label: string;
  source: string;
}

export interface CostEstimate {
  fee?: FeeEstimate;
  tax?: TaxEstimate;
}

/** 幣別最小單位：台幣到元、美元到分 */
const CURRENCY_DECIMALS: Record<string, number> = { TWD: 0, USD: 2 };
export const TW_BOARD_LOT = 1000;

/** 台股不是 1,000 股的整數倍就是零股（最低手續費通常不同） */
export const isOddLot = (market: string, quantity: Dec) => market === "TW" && !quantity.mod(TW_BOARD_LOT).isZero();

export function estimateFee(settings: FeeSettings, trade: { market: string; currency: string; gross: Dec; quantity: Dec }): FeeEstimate | null {
  if (settings.feeRate === null) return null;
  const decimals = CURRENCY_DECIMALS[trade.currency] ?? 2;
  const computed = trade.gross
    .times(settings.feeRate)
    .times(settings.feeDiscount)
    .toDecimalPlaces(decimals, settings.feeRounding === "floor" ? D.ROUND_DOWN : D.ROUND_HALF_UP);
  const oddLot = isOddLot(trade.market, trade.quantity);
  const minimum = new D(oddLot && settings.feeMinOddLot !== null ? settings.feeMinOddLot : settings.feeMin);
  let amount = computed;
  let basis: FeeEstimate["basis"] = "rate";
  if (amount.lessThan(minimum)) {
    amount = minimum;
    basis = "minimum";
  }
  if (settings.feeMax !== null && amount.greaterThan(settings.feeMax)) {
    amount = new D(settings.feeMax);
    basis = "maximum";
  }
  return {
    amount: amount.toFixed(),
    rate: new D(settings.feeRate).toFixed(),
    discount: new D(settings.feeDiscount).toFixed(),
    computed: computed.toFixed(),
    minimum: minimum.toFixed(),
    basis,
    oddLot,
    rounding: settings.feeRounding,
  };
}

export type TaxCategory = "stock" | "etf" | "bond_etf" | "tdr";

/** 台股證交稅的分類；美股沒有證交稅（回 null） */
export function taxCategory(asset: TaxAsset): TaxCategory | null {
  if (asset.market !== "TW") return null;
  const kind = asset.kind ?? (asset.assetType === "etf" ? "etf" : "stock");
  if (kind === "etf") return (asset.bondEtf ?? asset.symbol.endsWith("B")) ? "bond_etf" : "etf";
  if (kind === "tdr") return "tdr";
  return "stock"; // 普通股與特別股
}

interface TaxRule {
  id: string;
  label: string;
  rate: string;
  /** 生效期間（含頭尾，交易日 YYYY-MM-DD）；null 表示沒有限制 */
  from: string | null;
  to: string | null;
  source: string;
  applies: (category: TaxCategory, dayTrade: boolean) => boolean;
}

const LAW = "https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=G0340078&flno=";

/**
 * 台股證交稅規則，由上往下第一條符合的生效。期限到了沒有延長，就會落到下面的一般稅率；
 * 修法延長時更新 to 的日期與來源即可（例如債券 ETF 延長到 2036 年底的草案通過後）。
 */
export const TW_TAX_RULES: readonly TaxRule[] = [
  // 證交稅條例 §2-1：以債券為主要投資標的之 ETF 暫停徵收；槓桿型、反向型不適用（代號以 L／R 結尾，不會被判成債券 ETF）
  { id: "tw-bond-etf-exempt", label: "債券 ETF 暫停徵收", rate: "0", from: "2017-01-01", to: "2026-12-31", source: `${LAW}2-1`, applies: (c) => c === "bond_etf" },
  // §2-2：同一帳戶同日現買現賣上市櫃股票
  { id: "tw-day-trade", label: "現股當沖", rate: "0.0015", from: "2017-04-28", to: "2027-12-31", source: `${LAW}2-2`, applies: (c, dayTrade) => c === "stock" && dayTrade },
  // §2 第 1 款：公司發行之股票
  { id: "tw-stock", label: "股票", rate: "0.003", from: null, to: null, source: `${LAW}2`, applies: (c) => c === "stock" },
  // §2 第 2 款：其他經政府核准之有價證券（ETF 受益憑證）
  { id: "tw-etf", label: "ETF", rate: "0.001", from: null, to: null, source: `${LAW}2`, applies: (c) => c === "etf" || c === "bond_etf" },
  // 財政部稅務入口網：轉讓臺灣存託憑證稅率千分之 1（81 年函釋）
  {
    id: "tw-tdr",
    label: "臺灣存託憑證",
    rate: "0.001",
    from: null,
    to: null,
    source: "https://www.etax.nat.gov.tw/etwmain/tax-info/understanding/tax-q-and-a/national/securities-transaction-tax/filing/LeJ1WWV",
    applies: (c) => c === "tdr",
  },
];

export function estimateTax(asset: TaxAsset, trade: { tradeDate: string; gross: Dec; dayTrade: boolean }): TaxEstimate | null {
  const category = taxCategory(asset);
  if (!category) return null;
  const rule = TW_TAX_RULES.find(
    (r) => r.applies(category, trade.dayTrade) && (r.from === null || trade.tradeDate >= r.from) && (r.to === null || trade.tradeDate <= r.to),
  );
  if (!rule) return null;
  return {
    amount: trade.gross.times(rule.rate).toDecimalPlaces(0, D.ROUND_DOWN).toFixed(),
    rate: rule.rate,
    ruleId: rule.id,
    label: rule.label,
    source: rule.source,
  };
}

/** 買賣的費用估算：手續費（買賣都有）＋證交稅（只有賣出）。帳戶沒開自動估算就回空物件 */
export function estimateCosts(
  settings: FeeSettings,
  asset: TaxAsset,
  trade: { type: "buy" | "sell"; tradeDate: string; currency: string; gross: Dec; quantity: Dec; dayTrade: boolean },
): CostEstimate {
  if (settings.feeRate === null) return {};
  const fee = estimateFee(settings, { market: asset.market, currency: trade.currency, gross: trade.gross, quantity: trade.quantity });
  const tax = trade.type === "sell" ? estimateTax(asset, trade) : null;
  return { ...(fee ? { fee } : {}), ...(tax ? { tax } : {}) };
}

/** 給畫面的一句說明，例如「0.1425% × 2.8 折 = 4，未達最低 20」 */
export function describeFee(fee: FeeEstimate): string {
  const percent = new D(fee.rate).times(100).toFixed();
  const discount = new D(fee.discount);
  const parts = [`${percent}%${discount.equals(1) ? "" : ` × ${discount.times(10).toFixed()} 折`} = ${fee.computed}`];
  if (fee.basis === "minimum") parts.push(`未達${fee.oddLot ? "零股" : ""}最低 ${fee.minimum}`);
  if (fee.basis === "maximum") parts.push(`超過上限，以 ${fee.amount} 計`);
  return parts.join("，");
}

/** 帳戶設定的摘要，例如「0.1425% × 2.8 折，最低 20（零股 1）」；沒開估算回 null */
export function describeFeeSettings(fees: FeeSettings): string | null {
  if (fees.feeRate === null) return null;
  const discount = new D(fees.feeDiscount);
  const parts = [`${new D(fees.feeRate).times(100).toFixed()}%${discount.equals(1) ? "" : ` × ${discount.times(10).toFixed()} 折`}`];
  parts.push(`最低 ${fees.feeMin}${fees.feeMinOddLot !== null ? `（零股 ${fees.feeMinOddLot}）` : ""}`);
  if (fees.feeMax !== null) parts.push(`上限 ${fees.feeMax}`);
  return parts.join("，");
}

export function describeTax(tax: TaxEstimate): string {
  return `${tax.label} ${new D(tax.rate).times(100).toFixed()}%，元以下捨去`;
}
