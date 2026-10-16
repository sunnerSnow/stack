import { describe, expect, it } from "vitest";
import { allocateByWeight, InsufficientPositionError, CurrencyMismatchError, replayFifo, type TradeEvent } from "@/lib/ledger/fifo";
import { D, dec } from "@/lib/money/decimal";

let seq = 0;
function ev(type: "buy" | "sell", tradeDate: string, quantity: string, price: string, costs: { fee?: string; tax?: string; other?: string; currency?: string } = {}): TradeEvent {
  seq += 1;
  return {
    transactionId: `t${String(seq).padStart(3, "0")}`,
    type,
    tradeDate,
    tradeAt: null,
    createdAt: `2026-10-16T00:00:${String(seq).padStart(2, "0")}.000000`,
    quantity: dec(quantity),
    gross: dec(quantity).times(price),
    fee: dec(costs.fee),
    tax: dec(costs.tax),
    otherCost: dec(costs.other),
    currency: costs.currency ?? "TWD",
  };
}

const s = (d: { toFixed(): string }) => d.toFixed();

describe("FIFO 持倉引擎", () => {
  it("買入 100 股 × 100 元、手續費 20：批次成本 10,020、單位成本 100.20", () => {
    const { lots } = replayFifo([ev("buy", "2026-01-05", "100", "100", { fee: "20" })]);
    expect(lots).toHaveLength(1);
    expect(s(lots[0].totalCost)).toBe("10020");
    expect(s(lots[0].remainingCost.dividedBy(lots[0].remainingQuantity))).toBe("100.2");
  });

  it("再買 100 股 × 120 元：兩個批次分別保留 10,020 與 12,020", () => {
    const { lots } = replayFifo([ev("buy", "2026-01-05", "100", "100", { fee: "20" }), ev("buy", "2026-02-05", "100", "120", { fee: "20" })]);
    expect(lots.map((l) => s(l.totalCost))).toEqual(["10020", "12020"]);
  });

  it("賣出 50 股 × 130：只消耗第一批 50 股，已實現損益 = 6,500 − 20 − 19 − 5,010 = 1,451", () => {
    const sell = ev("sell", "2026-03-05", "50", "130", { fee: "20", tax: "19" });
    const { lots, disposals } = replayFifo([ev("buy", "2026-01-05", "100", "100", { fee: "20" }), ev("buy", "2026-02-05", "100", "120", { fee: "20" }), sell]);
    expect(disposals).toHaveLength(1);
    const d = disposals[0];
    expect(d.sellTransactionId).toBe(sell.transactionId);
    expect(d.lotSourceTransactionId).toBe(lots[0].sourceTransactionId);
    expect(s(d.quantity)).toBe("50");
    expect(s(d.allocatedCost)).toBe("5010");
    expect(s(d.allocatedProceeds)).toBe("6500");
    expect(s(d.realizedPnl)).toBe("1451");
    expect(s(lots[0].remainingQuantity)).toBe("50");
    expect(s(lots[0].remainingCost)).toBe("5010");
    expect(s(lots[1].remainingQuantity)).toBe("100");
  });

  it("跨兩個批次的賣出：費用依數量比例分配，加總剛好等於原始費用", () => {
    const { disposals } = replayFifo([
      ev("buy", "2026-01-05", "100", "100", { fee: "20" }),
      ev("buy", "2026-02-05", "100", "120", { fee: "20" }),
      ev("sell", "2026-03-05", "150", "130", { fee: "27.79", tax: "58.5" }),
    ]);
    expect(disposals.map((d) => s(d.quantity))).toEqual(["100", "50"]);
    expect(s(disposals[0].allocatedCost)).toBe("10020");
    expect(s(disposals[1].allocatedCost)).toBe("6010");
    const fee = disposals.reduce((a, d) => a.plus(d.allocatedFee), new D(0));
    const tax = disposals.reduce((a, d) => a.plus(d.allocatedTax), new D(0));
    expect(s(fee)).toBe("27.79");
    expect(s(tax)).toBe("58.5");
    const realized = disposals.reduce((a, d) => a.plus(d.realizedPnl), new D(0));
    // 19,500 − 27.79 − 58.5 − (10,020 + 6,010)
    expect(s(realized)).toBe("3383.71");
  });

  it("全部賣出：所有批次剩餘數量與剩餘成本都歸零", () => {
    const { lots } = replayFifo([
      ev("buy", "2026-01-05", "100", "100", { fee: "20" }),
      ev("buy", "2026-02-05", "100", "120", { fee: "20" }),
      ev("sell", "2026-03-05", "200", "130", { fee: "37", tax: "78" }),
    ]);
    for (const l of lots) {
      expect(l.remainingQuantity.isZero()).toBe(true);
      expect(l.remainingCost.isZero()).toBe(true);
    }
  });

  it("賣出超過持倉：拒絕並回報可賣數量，不會形成負持倉", () => {
    const sell = ev("sell", "2026-03-05", "201", "130");
    expect(() => replayFifo([ev("buy", "2026-01-05", "100", "100"), ev("buy", "2026-02-05", "100", "120"), sell])).toThrow(InsufficientPositionError);
    try {
      replayFifo([ev("buy", "2026-01-05", "100", "100"), sell]);
    } catch (e) {
      expect((e as InsufficientPositionError).available.toFixed()).toBe("100");
      expect((e as InsufficientPositionError).transactionId).toBe(sell.transactionId);
    }
  });

  it("分三次賣出 1/3：成本分配不累積捨入誤差，最後剛好歸零", () => {
    const { lots, disposals } = replayFifo([
      ev("buy", "2026-01-05", "3", "10", { fee: "1" }),
      ev("sell", "2026-02-01", "1", "12"),
      ev("sell", "2026-02-02", "1", "12"),
      ev("sell", "2026-02-03", "1", "12"),
    ]);
    expect(disposals.map((d) => s(d.allocatedCost))).toEqual(["10.3333333333", "10.3333333334", "10.3333333333"]);
    const total = disposals.reduce((a, d) => a.plus(d.allocatedCost), new D(0));
    expect(s(total)).toBe("31");
    expect(lots[0].remainingCost.isZero()).toBe(true);
  });

  it("交易日早於買進的賣出：當時沒有持倉，拒絕", () => {
    expect(() => replayFifo([ev("buy", "2026-01-15", "100", "100"), ev("sell", "2026-01-10", "10", "100")])).toThrow(InsufficientPositionError);
  });

  it("同一天先輸入賣出、後輸入買進：同日先買後賣，不會誤判持倉不足", () => {
    const sell = ev("sell", "2026-01-15", "100", "105");
    const buy = ev("buy", "2026-01-15", "100", "100");
    const { disposals } = replayFifo([sell, buy]);
    expect(disposals).toHaveLength(1);
    expect(s(disposals[0].realizedPnl)).toBe("500");
  });

  it("輸入順序不影響結果（一律依交易日重播）", () => {
    const a = ev("buy", "2026-01-05", "100", "100", { fee: "20" });
    const b = ev("buy", "2026-02-05", "100", "120", { fee: "20" });
    const c = ev("sell", "2026-03-05", "50", "130", { fee: "20", tax: "19" });
    const x = replayFifo([a, b, c]);
    const y = replayFifo([c, b, a]);
    expect(y.disposals.map((d) => s(d.realizedPnl))).toEqual(x.disposals.map((d) => s(d.realizedPnl)));
  });

  it("同一資產買賣幣別不一致：拒絕", () => {
    expect(() => replayFifo([ev("buy", "2026-01-05", "10", "100", { currency: "USD" }), ev("sell", "2026-02-05", "5", "100", { currency: "TWD" })])).toThrow(
      CurrencyMismatchError,
    );
  });

  it("allocateByWeight：極小金額分給多個批次也不會出現負數", () => {
    const parts = allocateByWeight(dec("0.0000000002"), [dec("1"), dec("1"), dec("1"), dec("1")], dec("4"));
    expect(parts.every((p) => !p.isNegative())).toBe(true);
    expect(s(parts.reduce((a, p) => a.plus(p), new D(0)))).toBe("0.0000000002");
  });

  it("allocateByWeight：最後一份拿餘數，加總等於原值", () => {
    const parts = allocateByWeight(dec("100"), [dec("1"), dec("1"), dec("1")], dec("3"));
    expect(parts.map(s)).toEqual(["33.3333333333", "33.3333333333", "33.3333333334"]);
  });
});
