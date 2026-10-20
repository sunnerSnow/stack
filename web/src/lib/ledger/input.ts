import { z } from "zod";
import { type FieldIssue, issuesFromZod, validationFailed } from "@/lib/errors";
import { type Phase1Type, PHASE1_TYPES, TRANSACTION_RULES } from "@/lib/ledger/rules";
import { D, type Dec, dec, round, ZERO } from "@/lib/money/decimal";

/** MVP 支援的市場與幣別（資料模型預留其他 ISO 4217 幣別） */
export const MARKETS = ["TW", "US"] as const;
export const CURRENCIES = ["TWD", "USD"] as const;
export const MARKET_CURRENCY: Record<(typeof MARKETS)[number], (typeof CURRENCIES)[number]> = { TW: "TWD", US: "USD" };

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

/** 金額、數量一律用字串傳（不用 JSON number，避免精度問題）；最多 18 位整數、10 位小數 */
const decimalText = z
  .string({ error: "請輸入數字" })
  .trim()
  .regex(/^\d{1,18}(\.\d{1,10})?$/, "請輸入非負數字（最多 18 位整數、10 位小數）");

export const isoDate = z
  .string({ error: "請輸入日期" })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式應為 YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "不是有效的日期");

export const transactionInputSchema = z.object({
  // UUID 一律轉小寫：資料庫回傳的是小寫，比對重複送出時才不會因大小寫誤判
  clientRequestId: z.uuid("缺少送出識別碼，請重新整理頁面").transform((s) => s.toLowerCase()),
  accountId: z.uuid("請選擇帳戶").transform((s) => s.toLowerCase()),
  type: z.enum(PHASE1_TYPES, "不支援的交易類型"),
  tradeDate: isoDate,
  settlementDate: optional(isoDate),
  asset: optional(
    z.object({
      market: z.enum(MARKETS, "請選擇市場"),
      symbol: z.string().trim().toUpperCase().min(1, "請輸入代號").max(20, "代號太長").regex(/^[A-Z0-9][A-Z0-9.\-]*$/, "代號只能有英數字、點與連字號"),
      name: optional(z.string().trim().max(120, "名稱太長")),
      assetType: optional(z.enum(["stock", "etf"], "請選擇股票或 ETF")),
    }),
  ),
  quantity: optional(decimalText),
  unitPrice: optional(decimalText),
  amount: optional(decimalText),
  fee: optional(decimalText),
  tax: optional(decimalText),
  otherCost: optional(decimalText),
  currency: optional(z.string().trim().toUpperCase().pipe(z.enum(CURRENCIES, "目前只支援 TWD 與 USD"))),
  fxRateToBase: optional(decimalText),
  notes: optional(z.string().trim().max(500, "備註最多 500 字")),
  /** 現股當沖（證交稅率不同）；只有台股賣出可以標記 */
  dayTrade: z.boolean("當沖請用 true／false").optional(),
});
export type TransactionInput = z.input<typeof transactionInputSchema>;

export interface NormalizedTransaction {
  clientRequestId: string;
  accountId: string;
  type: Phase1Type;
  tradeDate: string;
  settlementDate: string | null;
  asset: { market: (typeof MARKETS)[number]; symbol: string; name: string | null; assetType: "stock" | "etf" | null } | null;
  quantity: Dec | null;
  unitPrice: Dec | null;
  gross: Dec;
  fee: Dec;
  tax: Dec;
  otherCost: Dec;
  /** 使用者有沒有填手續費／稅（沒填才會依帳戶設定估算；填 0 就是 0） */
  feeProvided: boolean;
  taxProvided: boolean;
  dayTrade: boolean;
  currency: string | null;
  fxRateToBase: Dec | null;
  notes: string | null;
}

const MAX_AMOUNT = new D("1e18");

/** 台北時間的今天（YYYY-MM-DD） */
export function todayInTaipei(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * 驗證並正規化交易輸入。各交易類型需要哪些欄位，依 TRANSACTION_RULES 決定。
 * 買賣的成交金額一律由「數量 × 單價」計算，不接受另外輸入。
 */
export function normalizeTransactionInput(raw: unknown, opts: { today?: string } = {}): NormalizedTransaction {
  const parsed = transactionInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const input = parsed.data;
  const rule = TRANSACTION_RULES[input.type];
  const issues: FieldIssue[] = [];
  const today = opts.today ?? todayInTaipei();

  if (rule.asset === "required" && !input.asset) issues.push({ field: "asset.symbol", message: "請輸入資產代號" });
  if (rule.asset === "forbidden" && input.asset) issues.push({ field: "asset.symbol", message: `${rule.label}不需要指定資產` });

  let quantity: Dec | null = null;
  let unitPrice: Dec | null = null;
  let gross: Dec = ZERO;
  if (rule.trade) {
    if (input.amount !== undefined) issues.push({ field: "amount", message: "買賣請填數量與單價，成交金額會自動計算" });
    if (input.quantity === undefined || dec(input.quantity).lessThanOrEqualTo(0)) issues.push({ field: "quantity", message: "數量必須大於 0" });
    if (input.unitPrice === undefined || dec(input.unitPrice).lessThanOrEqualTo(0)) issues.push({ field: "unitPrice", message: "單價必須大於 0" });
    if (input.quantity !== undefined && input.unitPrice !== undefined) {
      quantity = dec(input.quantity);
      unitPrice = dec(input.unitPrice);
      gross = round(quantity.times(unitPrice));
    }
  } else {
    if (input.quantity !== undefined) issues.push({ field: "quantity", message: `${rule.label}不需要數量` });
    if (input.unitPrice !== undefined) issues.push({ field: "unitPrice", message: `${rule.label}不需要單價` });
    if (input.amount === undefined || dec(input.amount).lessThanOrEqualTo(0)) issues.push({ field: "amount", message: "金額必須大於 0" });
    else gross = dec(input.amount);
  }
  const fee = dec(input.fee);
  const tax = dec(input.tax);
  const otherCost = dec(input.otherCost);
  // 現金效果與批次成本 = 金額 ± 各項費用，都要放得進 numeric(28, 10)
  if (gross.plus(fee).plus(tax).plus(otherCost).greaterThanOrEqualTo(MAX_AMOUNT)) {
    issues.push({ field: rule.trade ? "quantity" : "amount", message: "金額太大" });
  }
  if (!rule.allowsCosts) {
    for (const [field, value] of [["fee", fee], ["tax", tax], ["otherCost", otherCost]] as const) {
      if (value.greaterThan(0)) issues.push({ field, message: `${rule.label}不另外填費用或稅；請另記一筆「費用」或「稅費」` });
    }
  } else if (!rule.trade && fee.plus(tax).plus(otherCost).greaterThan(gross)) {
    issues.push({ field: "tax", message: "扣繳稅與費用不能超過收入金額" });
  }

  if (input.tradeDate > today) issues.push({ field: "tradeDate", message: "交易日不能晚於今天" });
  if (input.settlementDate && input.settlementDate < input.tradeDate) {
    issues.push({ field: "settlementDate", message: "交割日不能早於交易日" });
  }
  const fxRateToBase = input.fxRateToBase === undefined ? null : dec(input.fxRateToBase);
  if (fxRateToBase && fxRateToBase.lessThanOrEqualTo(0)) issues.push({ field: "fxRateToBase", message: "匯率必須大於 0" });
  if (input.dayTrade && input.type !== "sell") issues.push({ field: "dayTrade", message: "只有賣出可以標記現股當沖" });

  if (issues.length > 0) throw validationFailed(issues);

  return {
    clientRequestId: input.clientRequestId,
    accountId: input.accountId,
    type: input.type,
    tradeDate: input.tradeDate,
    settlementDate: input.settlementDate ?? null,
    asset: input.asset
      ? { market: input.asset.market, symbol: input.asset.symbol, name: input.asset.name ?? null, assetType: input.asset.assetType ?? null }
      : null,
    quantity,
    unitPrice,
    gross,
    fee,
    tax,
    otherCost,
    feeProvided: input.fee !== undefined,
    taxProvided: input.tax !== undefined,
    dayTrade: input.dayTrade ?? false,
    currency: input.currency ?? null,
    fxRateToBase,
    notes: input.notes ?? null,
  };
}

const reasonText = optional(z.string().trim().max(200, "原因最多 200 字"));

/** 沖銷：只需要送出識別碼與（選填的）原因 */
export const reversalInputSchema = z.object({
  clientRequestId: z.uuid("缺少送出識別碼，請重新整理頁面").transform((s) => s.toLowerCase()),
  reason: reasonText,
});

export function normalizeReversalInput(raw: unknown): { clientRequestId: string; reason: string | null } {
  const parsed = reversalInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  return { clientRequestId: parsed.data.clientRequestId, reason: parsed.data.reason ?? null };
}

/** 更正：新交易的完整內容（同新增交易）加上選填的原因 */
export function normalizeCorrectionInput(raw: unknown, opts: { today?: string } = {}): NormalizedTransaction & { reason: string | null } {
  const parsed = z.object({ reason: reasonText }).safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  return { ...normalizeTransactionInput(raw, opts), reason: parsed.data.reason ?? null };
}

export const portfolioInputSchema = z.object({
  name: z.string({ error: "請輸入名稱" }).trim().min(1, "請輸入名稱").max(80, "名稱最多 80 字"),
  baseCurrency: z.enum(CURRENCIES, "請選擇基準幣別"),
});

export const accountInputSchema = z.object({
  name: z.string({ error: "請輸入名稱" }).trim().min(1, "請輸入名稱").max(80, "名稱最多 80 字"),
  brokerName: optional(z.string().trim().max(80, "券商名稱最多 80 字")),
  accountType: z.enum(["brokerage", "cash", "other"], "請選擇帳戶類型"),
  currency: z.enum(CURRENCIES, "請選擇幣別"),
});

/**
 * 帳戶的手續費設定，用人習慣的寫法輸入：費率用百分比（0.1425）、折扣用「折」（2.8；空白＝不打折）。
 * enabled = false 表示不自動估算（沒填的費用就是 0）。
 */
export const feeSettingsInputSchema = z.object({
  enabled: z.boolean("請選擇是否自動估算"),
  ratePercent: optional(decimalText),
  discount: optional(decimalText),
  min: optional(decimalText),
  minOddLot: optional(decimalText),
  max: optional(decimalText),
  rounding: optional(z.enum(["floor", "round"], "請選擇捨入方式")),
});
export type FeeSettingsInput = z.input<typeof feeSettingsInputSchema>;

export interface NormalizedFeeSettings {
  feeRate: string | null;
  feeDiscount: string;
  feeMin: string;
  feeMinOddLot: string | null;
  feeMax: string | null;
  feeRounding: "floor" | "round";
}

export function normalizeFeeSettings(raw: unknown): NormalizedFeeSettings {
  const parsed = feeSettingsInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const input = parsed.data;
  const off: NormalizedFeeSettings = { feeRate: null, feeDiscount: "1", feeMin: "0", feeMinOddLot: null, feeMax: null, feeRounding: "floor" };
  if (!input.enabled) return off;

  const issues: FieldIssue[] = [];
  const rate = input.ratePercent === undefined ? null : dec(input.ratePercent).dividedBy(100);
  if (rate === null) issues.push({ field: "ratePercent", message: "請輸入手續費率（%），沒有手續費就填 0" });
  else if (rate.greaterThanOrEqualTo("0.1")) issues.push({ field: "ratePercent", message: "手續費率必須小於 10%" });
  const discount = input.discount === undefined ? new D(1) : dec(input.discount).dividedBy(10);
  if (discount.lessThanOrEqualTo(0) || discount.greaterThan(1)) issues.push({ field: "discount", message: "折扣請填 0 到 10 之間（2.8 折填 2.8，不打折留空）" });
  if (!discount.toDecimalPlaces(4).equals(discount)) issues.push({ field: "discount", message: "折扣最多到小數點後三位（例如 2.855）" });
  const min = dec(input.min);
  const max = input.max === undefined ? null : dec(input.max);
  if (max && max.lessThan(min)) issues.push({ field: "max", message: "上限不能低於最低手續費" });
  if (issues.length > 0) throw validationFailed(issues);

  return {
    feeRate: rate!.toFixed(),
    feeDiscount: discount.toFixed(),
    feeMin: min.toFixed(),
    feeMinOddLot: input.minOddLot === undefined ? null : dec(input.minOddLot).toFixed(),
    feeMax: max ? max.toFixed() : null,
    feeRounding: input.rounding ?? "floor",
  };
}

/**
 * 新帳戶的預設：台幣券商帳戶開啟估算（法定上限 0.1425%、不打折、整股最低 20、零股最低 1、元以下捨去），
 * 其他帳戶不估算。各家券商與帳戶不同，建立後請到帳戶的「手續費設定」改成自己的折扣。
 */
export function defaultFeeSettings(account: { accountType: string; currency: string }): NormalizedFeeSettings {
  if (account.accountType === "brokerage" && account.currency === "TWD") {
    return { feeRate: "0.001425", feeDiscount: "1", feeMin: "20", feeMinOddLot: "1", feeMax: null, feeRounding: "floor" };
  }
  return { feeRate: null, feeDiscount: "1", feeMin: "0", feeMinOddLot: null, feeMax: null, feeRounding: "floor" };
}
