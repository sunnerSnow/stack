import { boolean, char, date, integer, jsonb, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * 與 supabase/migrations/ 對應的 Drizzle schema。
 * 約束、RLS 與權限以 SQL migration 為準；這裡只描述欄位，讓查詢有型別。
 * numeric 欄位一律以字串讀寫（不經過 JavaScript number）。
 */
export const stack = pgSchema("stack");

const amount = (name: string) => numeric(name, { precision: 28, scale: 10 });
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

export const users = stack.table("users", {
  id: uuid("id").primaryKey(),
  email: text("email"),
  baseCurrency: char("base_currency", { length: 3 }).notNull().default("TWD"),
  timezone: text("timezone").notNull().default("Asia/Taipei"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const portfolios = stack.table("portfolios", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  name: text("name").notNull(),
  baseCurrency: char("base_currency", { length: 3 }).notNull(),
  trackingMode: text("tracking_mode", { enum: ["transaction", "snapshot", "hybrid"] }).notNull().default("transaction"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
});

export const accounts = stack.table("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  portfolioId: uuid("portfolio_id").notNull(),
  name: text("name").notNull(),
  brokerName: text("broker_name"),
  accountType: text("account_type", { enum: ["brokerage", "cash", "other"] }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  trackingMode: text("tracking_mode", { enum: ["transaction", "snapshot"] }).notNull().default("transaction"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
});

export const assets = stack.table("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  assetType: text("asset_type", { enum: ["stock", "etf", "cash"] }).notNull(),
  market: text("market").notNull(),
  exchange: text("exchange"),
  currency: char("currency", { length: 3 }).notNull(),
  industryId: uuid("industry_id"),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").notNull().default({}),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const transactions = stack.table("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id").notNull(),
  assetId: uuid("asset_id"),
  transactionType: text("transaction_type").notNull(),
  tradeDate: date("trade_date", { mode: "string" }).notNull(),
  tradeAt: timestamp("trade_at", { withTimezone: true, mode: "string" }),
  settlementDate: date("settlement_date", { mode: "string" }),
  quantity: amount("quantity"),
  unitPrice: amount("unit_price"),
  grossAmount: amount("gross_amount").notNull(),
  fee: amount("fee").notNull().default("0"),
  tax: amount("tax").notNull().default("0"),
  taxKind: text("tax_kind", { enum: ["transaction_tax", "withholding_tax", "other"] }),
  otherCost: amount("other_cost").notNull().default("0"),
  currency: char("currency", { length: 3 }).notNull(),
  fxRateToBase: numeric("fx_rate_to_base", { precision: 28, scale: 12 }),
  externalFlowType: text("external_flow_type", { enum: ["contribution", "withdrawal"] }),
  notes: text("notes"),
  source: text("source", { enum: ["manual", "csv", "snapshot_adjustment"] }).notNull().default("manual"),
  importRowId: uuid("import_row_id"),
  reversalOfId: uuid("reversal_of_id"),
  clientRequestId: uuid("client_request_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cashLedger = stack.table("cash_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id").notNull(),
  transactionId: uuid("transaction_id"),
  eventDate: date("event_date", { mode: "string" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  amount: amount("amount").notNull(),
  eventType: text("event_type").notNull(),
  transferGroupId: uuid("transfer_group_id"),
  createdAt: createdAt(),
});

export const positionLots = stack.table("position_lots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  sourceTransactionId: uuid("source_transaction_id").notNull(),
  acquiredDate: date("acquired_date", { mode: "string" }).notNull(),
  originalQuantity: amount("original_quantity").notNull(),
  remainingQuantity: amount("remaining_quantity").notNull(),
  totalCost: amount("total_cost").notNull(),
  remainingCost: amount("remaining_cost").notNull(),
  costCurrency: char("cost_currency", { length: 3 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const lotDisposals = stack.table("lot_disposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  sellTransactionId: uuid("sell_transaction_id").notNull(),
  lotId: uuid("lot_id").notNull(),
  quantity: amount("quantity").notNull(),
  allocatedCost: amount("allocated_cost").notNull(),
  allocatedProceeds: amount("allocated_proceeds").notNull(),
  allocatedFee: amount("allocated_fee").notNull().default("0"),
  allocatedTax: amount("allocated_tax").notNull().default("0"),
  allocatedOtherCost: amount("allocated_other_cost").notNull().default("0"),
  realizedPnl: amount("realized_pnl").notNull(),
  createdAt: createdAt(),
});

/** 稽核紀錄（20261019000000_reversals.sql）：沖銷與更正，只能新增 */
export const auditLog = stack.table("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  action: text("action", { enum: ["reverse", "correct"] }).notNull(),
  transactionId: uuid("transaction_id"),
  reversalId: uuid("reversal_id"),
  replacementId: uuid("replacement_id"),
  reason: text("reason"),
  recalculatedSells: integer("recalculated_sells").notNull().default(0),
  createdAt: createdAt(),
});

export const schema = { users, portfolios, accounts, assets, transactions, cashLedger, positionLots, lotDisposals, auditLog };
