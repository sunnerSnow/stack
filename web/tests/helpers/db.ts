import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { type Db, ensureLocalAuthUser, openLocalDb } from "@/lib/db/local";
import { createAccount, createPortfolio, ensureUserProfile } from "@/lib/services/portfolios";

/** 記憶體內的 PGlite：跑 auth 模擬＋全部 migration，跟正式 schema 相同（含 RLS） */
export async function createTestDb(): Promise<Db> {
  return openLocalDb(new PGlite());
}

export async function createUser(db: Db, email = `${randomUUID().slice(0, 8)}@example.test`): Promise<string> {
  const id = randomUUID();
  await ensureLocalAuthUser(db, id, email);
  await ensureUserProfile(db, id, email);
  return id;
}

/** 建立一個使用者＋投資組合＋券商帳戶，回傳各 ID */
export async function createLedger(db: Db, opts: { currency?: "TWD" | "USD" } = {}) {
  const userId = await createUser(db);
  const portfolio = await createPortfolio(db, userId, { name: "台股長期", baseCurrency: "TWD" });
  const account = await createAccount(db, userId, portfolio.id, {
    name: "元大證券",
    brokerName: "元大",
    accountType: "brokerage",
    currency: opts.currency ?? "TWD",
  });
  return { userId, portfolioId: portfolio.id, accountId: account.id };
}

export const TODAY = "2026-10-16";
export const TSMC = { market: "TW", symbol: "2330", name: "台積電", assetType: "stock" } as const;
export const AAPL = { market: "US", symbol: "AAPL", name: "Apple", assetType: "stock" } as const;

export const req = () => randomUUID();
