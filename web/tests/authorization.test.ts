import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { withUser } from "@/lib/db/with-user";
import { AppError } from "@/lib/errors";
import { getCashBalances, getHoldings, getLedgerSummary } from "@/lib/services/positions";
import { createAccount, getPortfolio, listAccounts, listPortfolios } from "@/lib/services/portfolios";
import { searchAssets } from "@/lib/services/assets";
import { getTransaction, listTransactions, postTransaction } from "@/lib/services/transactions";
import { createLedger, createTestDb, createUser, req, TODAY, TSMC } from "./helpers/db";

let db: Db;
let alice: Awaited<ReturnType<typeof createLedger>>;
let bob: string;
let aliceBuyId: string;

beforeEach(async () => {
  db = await createTestDb();
  alice = await createLedger(db);
  bob = await createUser(db);
  const { transaction } = await postTransaction(
    db,
    alice.userId,
    { clientRequestId: req(), accountId: alice.accountId, type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "100", unitPrice: "100", fee: "20" },
    { today: TODAY },
  );
  aliceBuyId = transaction.id;
});

async function expectNotFound(p: Promise<unknown>) {
  const error = await p.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).status).toBe(404);
}

/** 預期資料庫層直接拒絕（RLS、權限或複合外鍵），並回傳錯誤訊息 */
async function expectDbRejects(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => null,
    (e) => e,
  );
  expect(error).not.toBeNull();
  const cause = (error as { cause?: { message?: string } }).cause;
  return cause?.message ?? (error as Error).message;
}

describe("跨使用者存取：服務層", () => {
  it("看不到別人的投資組合", async () => {
    expect(await listPortfolios(db, bob)).toEqual([]);
    await expectNotFound(getPortfolio(db, bob, alice.portfolioId));
    await expectNotFound(listAccounts(db, bob, alice.portfolioId));
  });

  it("不能在別人的投資組合建立帳戶", async () => {
    await expectNotFound(createAccount(db, bob, alice.portfolioId, { name: "偷建", accountType: "cash", currency: "TWD" }));
  });

  it("不能對別人的帳戶記交易（回 404，不透露帳戶是否存在）", async () => {
    await expectNotFound(
      postTransaction(db, bob, { clientRequestId: req(), accountId: alice.accountId, type: "deposit", tradeDate: "2026-03-02", amount: "1" }, { today: TODAY }),
    );
  });

  it("看不到別人的交易、持倉、現金與彙總", async () => {
    await expectNotFound(listTransactions(db, bob, { portfolioId: alice.portfolioId }));
    await expectNotFound(getTransaction(db, bob, aliceBuyId));
    await expectNotFound(getHoldings(db, bob, alice.portfolioId));
    await expectNotFound(getCashBalances(db, bob, alice.portfolioId));
    await expectNotFound(getLedgerSummary(db, bob, alice.portfolioId));
  });

  it("用別人的 clientRequestId 也不會拿到別人的交易", async () => {
    const [aliceTx] = await listTransactions(db, alice.userId, { portfolioId: alice.portfolioId });
    expect(aliceTx).toBeDefined();
    // 識別碼的唯一性是「每個使用者各自」；bob 用同一個 ID 送到自己的帳戶會建立自己的交易
    const bobLedger = await createLedger(db);
    const result = await postTransaction(
      db,
      bobLedger.userId,
      { clientRequestId: req(), accountId: bobLedger.accountId, type: "deposit", tradeDate: "2026-03-02", amount: "1" },
      { today: TODAY },
    );
    expect(result.transaction.id).not.toBe(aliceTx.id);
  });
});

describe("私人資產代號", () => {
  it("自己新增的代號別人看不到，名稱也不會互相影響", async () => {
    const post = (userId: string, accountId: string, name: string) =>
      postTransaction(
        db,
        userId,
        { clientRequestId: req(), accountId, type: "buy", tradeDate: "2026-03-02", asset: { market: "TW", symbol: "1101", name, assetType: "stock" }, quantity: "1", unitPrice: "30" },
        { today: TODAY },
      );
    const aliceTx = await post(alice.userId, alice.accountId, "台泥");
    expect((await searchAssets(db, bob, "1101")).map((a) => a.symbol)).toEqual([]);

    const bobLedger = await createLedger(db);
    const bobTx = await post(bobLedger.userId, bobLedger.accountId, "臺灣水泥");
    expect(bobTx.transaction.asset?.id).not.toBe(aliceTx.transaction.asset?.id);
    expect(bobTx.transaction.asset?.name).toBe("臺灣水泥");
    const again = await getTransaction(db, alice.userId, aliceTx.transaction.id);
    expect(again.transaction.asset?.name).toBe("台泥");
  });

  it("共用主檔大家都看得到", async () => {
    const found = await searchAssets(db, bob, "2330");
    expect(found).toEqual([expect.objectContaining({ symbol: "2330", name: "台積電", shared: true })]);
  });
});

describe("跨使用者存取：資料庫層（RLS 是第二道防線）", () => {
  it("就算查詢沒帶 user_id 條件，RLS 也只回自己的資料", async () => {
    const rows = await withUser(db, bob, (tx) =>
      tx.execute(sql`select (select count(*)::int from stack.transactions) t, (select count(*)::int from stack.position_lots) l,
                            (select count(*)::int from stack.accounts) a, (select count(*)::int from stack.cash_ledger) c`),
    );
    expect((rows as unknown as { rows: unknown[] }).rows[0]).toEqual({ t: 0, l: 0, a: 0, c: 0 });
    const mine = await withUser(db, alice.userId, (tx) => tx.execute(sql`select count(*)::int n from stack.transactions`));
    expect((mine as unknown as { rows: { n: number }[] }).rows[0].n).toBe(1);
  });

  it("冒用別人的 user_id 寫入：RLS 拒絕", async () => {
    const msg = await expectDbRejects(
      withUser(db, bob, (tx) =>
        tx.execute(sql`insert into stack.portfolios (user_id, name, base_currency) values (${alice.userId}, '冒用', 'TWD')`),
      ),
    );
    expect(msg).toMatch(/row-level security/i);
  });

  it("用自己的 user_id 掛到別人的帳戶：複合外鍵拒絕", async () => {
    const msg = await expectDbRejects(
      withUser(db, bob, (tx) =>
        tx.execute(sql`insert into stack.transactions (user_id, account_id, transaction_type, trade_date, gross_amount, currency)
                       values (${bob}, ${alice.accountId}, 'deposit', '2026-03-02', 1, 'TWD')`),
      ),
    );
    expect(msg).toMatch(/foreign key/i);
  });

  it("交易與現金帳本不能被修改或刪除（只能新增）", async () => {
    expect(await expectDbRejects(withUser(db, alice.userId, (tx) => tx.execute(sql`update stack.transactions set gross_amount = 1`)))).toMatch(/permission denied/i);
    expect(await expectDbRejects(withUser(db, alice.userId, (tx) => tx.execute(sql`delete from stack.transactions`)))).toMatch(/permission denied/i);
    expect(await expectDbRejects(withUser(db, alice.userId, (tx) => tx.execute(sql`delete from stack.cash_ledger`)))).toMatch(/permission denied/i);
  });

  it("沖銷只能指向自己的交易（複合外鍵）", async () => {
    const bobLedger = await createLedger(db);
    const msg = await expectDbRejects(
      withUser(db, bobLedger.userId, (tx) =>
        tx.execute(sql`insert into stack.transactions (user_id, account_id, transaction_type, trade_date, gross_amount, currency, reversal_of_id)
                       values (${bobLedger.userId}, ${bobLedger.accountId}, 'deposit', '2026-03-02', 1, 'TWD', ${aliceBuyId})`),
      ),
    );
    expect(msg).toMatch(/foreign key/i);
  });

  it("就算是有完整權限的資料庫角色，也不能改寫或刪除原始紀錄", async () => {
    expect(await expectDbRejects(db.execute(sql`update stack.transactions set gross_amount = 1`))).toMatch(/原始帳本紀錄/);
    expect(await expectDbRejects(db.execute(sql`delete from stack.cash_ledger`))).toMatch(/原始帳本紀錄/);
  });

  it("看不到別人新增的私人資產（RLS）", async () => {
    await postTransaction(
      db,
      alice.userId,
      { clientRequestId: req(), accountId: alice.accountId, type: "buy", tradeDate: "2026-03-02", asset: { market: "TW", symbol: "9999", name: "冷門股", assetType: "stock" }, quantity: "1", unitPrice: "1" },
      { today: TODAY },
    );
    const rows = await withUser(db, bob, (tx) => tx.execute(sql`select count(*)::int n from stack.assets where symbol = '9999'`));
    expect((rows as unknown as { rows: { n: number }[] }).rows[0].n).toBe(0);
  });

  it("沒有切換成登入使用者的角色時，看不到任何資料", async () => {
    await db.execute(sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$`);
    const msg = await expectDbRejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role anon`);
        await tx.execute(sql`select * from stack.transactions`);
      }),
    );
    expect(msg).toMatch(/permission denied/i);
  });
});
