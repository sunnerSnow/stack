import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { withUser } from "@/lib/db/with-user";
import { AppError } from "@/lib/errors";
import type { TdccMovement } from "@/lib/imports/tdcc";
import { createTdccImport, getImport } from "@/lib/services/imports";
import { getLedgerSummary } from "@/lib/services/positions";
import { createAccount, setAccountTrackingMode } from "@/lib/services/portfolios";
import { createSnapshot, getLatestSnapshots, getRecentSnapshots } from "@/lib/services/snapshots";
import { postTransaction } from "@/lib/services/transactions";
import { createLedger, createTestDb, createUser, req, TODAY } from "./helpers/db";

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;
let snapAccountId: string;

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const error = await p.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect((error as AppError).status).toBe(status);
  return error as AppError;
}

const tw = (symbol: string) => ({ market: "TW", symbol });
const snap = (input: Record<string, unknown>, accountId = snapAccountId) =>
  createSnapshot(db, L.userId, { clientRequestId: req(), accountId, asOfDate: "2026-10-15", positions: [], ...input }, { today: TODAY });

beforeEach(async () => {
  db = await createTestDb();
  L = await createLedger(db);
  snapAccountId = (await createAccount(db, L.userId, L.portfolioId, { name: "國泰（集保）", accountType: "brokerage", currency: "TWD", trackingMode: "snapshot" })).id;
});

describe("庫存快照", () => {
  it("建立快照：成本與價格可不填；只填價格就以股數 × 價格當市值", async () => {
    const { snapshot } = await snap({
      cashBalance: "50000",
      positions: [
        { asset: tw("2330"), quantity: "1000", unitCost: "550.5", marketPrice: "600" },
        { asset: tw("0050"), quantity: "2182" },
      ],
    });
    expect(snapshot).toMatchObject({ asOfDate: "2026-10-15", cashBalance: "50000", source: "manual" });
    expect(snapshot.positions.map((p) => [p.asset.symbol, p.quantity, p.unitCost, p.costBasis, p.marketValue])).toEqual([
      ["0050", "2182", null, null, null],
      ["2330", "1000", "550.5", "550500", "600000"],
    ]);
  });

  it("每次更新都是新的一份，舊的保留；最新的依基準日判斷", async () => {
    await snap({ asOfDate: "2026-10-01", positions: [{ asset: tw("2330"), quantity: "1000" }] });
    await snap({ asOfDate: "2026-10-15", positions: [{ asset: tw("2330"), quantity: "2000" }] });
    // 補建一份更早的快照，不會變成「最新」
    await snap({ asOfDate: "2026-09-01", positions: [{ asset: tw("2330"), quantity: "500" }] });
    const { latest, previous } = await getRecentSnapshots(db, L.userId, snapAccountId);
    expect([latest?.asOfDate, latest?.positions[0].quantity]).toEqual(["2026-10-15", "2000"]);
    expect([previous?.asOfDate, previous?.positions[0].quantity]).toEqual(["2026-10-01", "1000"]);
  });

  it("快照只能新增：資料庫拒絕修改或刪除", async () => {
    await snap({ positions: [{ asset: tw("2330"), quantity: "1000" }] });
    const err = await withUser(db, L.userId, (tx) => tx.execute(sql`update stack.position_snapshots set quantity = 1`)).then(
      () => null,
      (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
    );
    expect(err).toMatch(/permission denied/i);
    const owner = await db.execute(sql`delete from stack.account_snapshots`).then(
      () => null,
      (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
    );
    expect(owner).toMatch(/原始帳本紀錄/);
  });

  it("同一個送出識別碼重送：回傳原本那份", async () => {
    const input = { clientRequestId: req(), accountId: snapAccountId, asOfDate: "2026-10-15", positions: [{ asset: tw("2330"), quantity: "1" }] };
    const first = await createSnapshot(db, L.userId, input, { today: TODAY });
    const again = await createSnapshot(db, L.userId, input, { today: TODAY });
    expect(again.duplicate).toBe(true);
    expect(again.snapshot.id).toBe(first.snapshot.id);
  });

  it("檢查：基準日不能晚於今天、股數要大於 0、同一檔不能重複、幣別要跟帳戶相同", async () => {
    const fields = async (input: Record<string, unknown>) => (await expectAppError(snap(input), "validation_failed", 400)).issues.map((i) => i.field);
    expect(await fields({ asOfDate: "2026-10-17" })).toEqual(["asOfDate"]);
    expect(await fields({ positions: [{ asset: tw("2330"), quantity: "0" }] })).toEqual(["positions.0.quantity"]);
    expect(await fields({ positions: [{ asset: tw("2330"), quantity: "1" }, { asset: tw("2330"), quantity: "2" }] })).toEqual(["positions.1.asset.symbol"]);
    expect(await fields({ positions: [{ asset: { market: "US", symbol: "AAPL" }, quantity: "1" }] })).toEqual(["positions.0.asset.symbol"]);
    // 主檔沒有的代號要填名稱，錯誤指到那一列
    expect(await fields({ positions: [{ asset: tw("9999"), quantity: "1" }] })).toEqual(["positions.0.asset.name", "positions.0.asset.assetType"]);
  });

  it("逐筆交易帳戶不能建快照；快照帳戶不能記交易", async () => {
    await expectAppError(snap({}, L.accountId), "transaction_account", 409);
    await expectAppError(
      postTransaction(db, L.userId, { clientRequestId: req(), accountId: snapAccountId, type: "deposit", tradeDate: "2026-03-01", amount: "1" }, { today: TODAY }),
      "snapshot_account",
      409,
    );
  });

  it("投資組合彙總：快照帳戶的現金與已知成本加進總數，缺的標示不完整", async () => {
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, type: "deposit", tradeDate: "2026-03-01", amount: "1000" }, { today: TODAY });
    await snap({ cashBalance: "500", positions: [{ asset: tw("2330"), quantity: "10", unitCost: "100" }] });
    let summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary).toMatchObject({ cash: [{ currency: "TWD", amount: "1500" }], costBasis: [{ currency: "TWD", amount: "1000" }], snapshotAccounts: 1, cashIncomplete: false, costIncomplete: false });
    await snap({ asOfDate: "2026-10-16", positions: [{ asset: tw("2330"), quantity: "10" }] });
    summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary).toMatchObject({ cash: [{ currency: "TWD", amount: "1000" }], costBasis: [], cashIncomplete: true, costIncomplete: true });
    expect((await getLatestSnapshots(db, L.userId, L.portfolioId)).map((s) => s.accountName)).toEqual(["國泰（集保）"]);
  });

  it("看不到也不能寫別人的快照", async () => {
    await snap({ positions: [{ asset: tw("2330"), quantity: "1" }] });
    const bob = await createUser(db);
    await expectAppError(getRecentSnapshots(db, bob, snapAccountId), "not_found", 404);
    await expectAppError(createSnapshot(db, bob, { clientRequestId: req(), accountId: snapAccountId, asOfDate: "2026-10-15", positions: [] }, { today: TODAY }), "not_found", 404);
    const rows = await withUser(db, bob, (tx) => tx.execute(sql`select (select count(*)::int from stack.account_snapshots) a, (select count(*)::int from stack.position_snapshots) p`));
    expect((rows as unknown as { rows: unknown[] }).rows[0]).toEqual({ a: 0, p: 0 });
  });
});

describe("切換追蹤方式", () => {
  it("空的帳戶可以切換；已有交易或快照就不行", async () => {
    const empty = await createAccount(db, L.userId, L.portfolioId, { name: "新帳戶", accountType: "brokerage", currency: "TWD" });
    expect((await setAccountTrackingMode(db, L.userId, empty.id, "snapshot")).trackingMode).toBe("snapshot");
    await snap({ positions: [] }, empty.id);
    await expectAppError(setAccountTrackingMode(db, L.userId, empty.id, "transaction"), "account_not_empty", 409);
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, type: "deposit", tradeDate: "2026-03-01", amount: "1" }, { today: TODAY });
    await expectAppError(setAccountTrackingMode(db, L.userId, L.accountId, "snapshot"), "account_not_empty", 409);
  });
});

const movement = (line: number, date: string, symbol: string, memo: string, w: string | null, d: string | null, b: string | null): TdccMovement => ({
  line,
  page: 1,
  date,
  symbol,
  name: `測試${symbol}`,
  memo,
  withdrawal: w,
  deposit: d,
  balance: b,
});
const MOVEMENTS = [
  movement(0, "2026-04-29", "2330", "賣出", "1000", null, "1000"),
  movement(1, "2026-04-27", "2330", "買進", null, "1000", "2000"),
  movement(2, "2026-04-10", "0050", "買進", null, "62", "2182"),
  movement(3, "2026-03-01", "9988", "買進", null, "5", "5"),
];
const HASH = "a".repeat(64);
const HEADER = { brokerName: "測試證券", brokerCode: "9999", periodFrom: "2024-10-20", periodTo: "2026-10-20", generatedAt: "2026-10-20T17:06" };

describe("集保 e 存摺匯入", () => {
  const upload = (extra: Record<string, unknown> = {}) =>
    createTdccImport(db, L.userId, { accountId: snapAccountId, fileName: "e存摺.pdf", fileHash: HASH, header: HEADER, movements: MOVEMENTS, ...extra });

  it("建立待確認的批次：伺服器自己推算持股（不信任瀏覽器），每一列都留著", async () => {
    const batch = await upload();
    expect(batch).toMatchObject({ status: "pending", rowCount: 4, header: HEADER });
    expect(batch.derived.holdings.map((h) => [h.symbol, h.quantity])).toEqual([
      ["0050", "2182"],
      ["2330", "1000"],
      ["9988", "5"],
    ]);
    // 主檔查得到的帶名稱，查不到的是 null（確認時要補名稱）
    expect(batch.derived.known).toMatchObject({ "0050": { name: "元大台灣50" }, "2330": { name: "台積電" }, "9988": null });
    const rows = await withUser(db, L.userId, (tx) => tx.execute(sql`select count(*)::int n, min(status) s from stack.import_rows where batch_id = ${batch.id}`));
    expect((rows as unknown as { rows: unknown[] }).rows[0]).toEqual({ n: 4, s: "skipped" });
  });

  it("只能匯入台幣的快照模式帳戶", async () => {
    const e = await expectAppError(upload({ accountId: L.accountId }), "validation_failed", 400);
    expect(e.issues[0].field).toBe("accountId");
  });

  it("確認：用批次建立快照後批次標成已確認；同一份不能再確認，同一個檔案也不能再匯", async () => {
    const batch = await upload();
    const positions = [
      { asset: tw("0050"), quantity: "2182" },
      { asset: tw("2330"), quantity: "1000" },
      { asset: { market: "TW", symbol: "9988", name: "測試零股", assetType: "stock" }, quantity: "5" },
    ];
    const { snapshot } = await snap({ asOfDate: "2026-10-16", importBatchId: batch.id, positions });
    expect(snapshot).toMatchObject({ source: "tdcc_pdf", importBatchId: batch.id });
    expect((await getImport(db, L.userId, batch.id)).status).toBe("confirmed");
    await expectAppError(snap({ importBatchId: batch.id, positions }), "import_not_pending", 409);
    await expectAppError(upload(), "already_imported", 409);
  });

  it("同一個檔案上傳兩次（都還沒確認）：先確認的那份成功，另一份確認時被擋", async () => {
    const a = await upload();
    const b = await upload();
    await snap({ importBatchId: a.id, positions: [] });
    await expectAppError(snap({ importBatchId: b.id, positions: [] }), "already_imported", 409);
  });

  it("別人的匯入紀錄：404", async () => {
    const batch = await upload();
    const bob = await createUser(db);
    await expectAppError(getImport(db, bob, batch.id), "not_found", 404);
  });

  it("格式檢查：至少一列、代號與日期格式正確", async () => {
    await expectAppError(upload({ movements: [] }), "validation_failed", 400);
    await expectAppError(upload({ movements: [{ ...MOVEMENTS[0], symbol: "<script>" }] }), "validation_failed", 400);
    await expectAppError(upload({ fileHash: "not-a-hash" }), "validation_failed", 400);
  });
});
