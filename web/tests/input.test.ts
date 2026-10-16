import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { normalizeTransactionInput, todayInTaipei } from "@/lib/ledger/input";
import { cashEffect, lotCost } from "@/lib/ledger/rules";
import { dec } from "@/lib/money/decimal";

const base = () => ({ clientRequestId: randomUUID(), accountId: randomUUID(), tradeDate: "2026-10-01" });
const tsmc = { market: "TW", symbol: "2330", name: "台積電", assetType: "stock" };
const TODAY = { today: "2026-10-16" };

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).issues.map((i) => i.field);
  }
  throw new Error("預期要丟出驗證錯誤");
}

describe("交易輸入驗證", () => {
  it("買進：成交金額由數量 × 單價計算", () => {
    const n = normalizeTransactionInput({ ...base(), type: "buy", asset: tsmc, quantity: "100", unitPrice: "100", fee: "20" }, TODAY);
    expect(n.gross.toFixed()).toBe("10000");
    expect(n.fee.toFixed()).toBe("20");
    expect(n.asset?.symbol).toBe("2330");
  });

  it("代號自動轉大寫、去空白", () => {
    const n = normalizeTransactionInput({ ...base(), type: "buy", asset: { ...tsmc, market: "US", symbol: " aapl " }, quantity: "1", unitPrice: "200" }, TODAY);
    expect(n.asset?.symbol).toBe("AAPL");
  });

  it("買進缺代號、數量、單價都會列出", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "buy" }, TODAY))).toEqual(
      expect.arrayContaining(["asset.symbol", "quantity", "unitPrice"]),
    );
  });

  it("買賣不接受另外輸入金額", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "buy", asset: tsmc, quantity: "1", unitPrice: "1", amount: "5" }, TODAY))).toContain("amount");
  });

  it("金額必須是字串：JSON number 會被拒絕（避免浮點精度）", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount: 0.1 + 0.2 }, TODAY))).toContain("amount");
  });

  it("負數、科學記號、超過 10 位小數都不接受", () => {
    for (const amount of ["-1", "1e5", "0.12345678901"]) {
      expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount }, TODAY))).toContain("amount");
    }
  });

  it("入金不能另外填手續費（要另記一筆費用）", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount: "1000", fee: "15" }, TODAY))).toContain("fee");
  });

  it("入金不需要資產", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount: "1000", asset: tsmc }, TODAY))).toContain("asset.symbol");
  });

  it("股息的扣繳稅與費用不能超過收入", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "dividend", asset: tsmc, amount: "100", tax: "80", fee: "30" }, TODAY))).toContain("tax");
  });

  it("交易日不能晚於今天；交割日不能早於交易日", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount: "1", tradeDate: "2026-10-17" }, TODAY))).toContain("tradeDate");
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount: "1", settlementDate: "2026-09-30" }, TODAY))).toContain("settlementDate");
  });

  it("不存在的日期會被拒絕", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "deposit", amount: "1", tradeDate: "2026-02-30" }, TODAY))).toContain("tradeDate");
  });

  it("Phase 1 不開放的類型會被拒絕", () => {
    expect(issuesOf(() => normalizeTransactionInput({ ...base(), type: "split", amount: "1" }, TODAY))).toContain("type");
  });

  it("todayInTaipei 以台北時區計算", () => {
    expect(todayInTaipei(new Date("2026-10-15T16:30:00Z"))).toBe("2026-10-16");
  });
});

describe("交易類型的現金效果（正負號只由規則決定）", () => {
  const a = (gross: string, fee = "0", tax = "0", otherCost = "0") => ({ gross: dec(gross), fee: dec(fee), tax: dec(tax), otherCost: dec(otherCost) });

  it("買進：現金減少 成交金額＋費用", () => {
    expect(cashEffect("buy", a("10000", "20")).toFixed()).toBe("-10020");
    expect(lotCost(a("10000", "20")).toFixed()).toBe("10020");
  });
  it("賣出：現金增加 成交金額−手續費−交易稅", () => {
    expect(cashEffect("sell", a("6500", "20", "19")).toFixed()).toBe("6461");
  });
  it("入金增加、出金減少", () => {
    expect(cashEffect("deposit", a("500")).toFixed()).toBe("500");
    expect(cashEffect("withdrawal", a("500")).toFixed()).toBe("-500");
  });
  it("股息：現金增加稅後淨額", () => {
    expect(cashEffect("dividend", a("1000", "10", "100")).toFixed()).toBe("890");
  });
  it("費用與稅費：現金減少", () => {
    expect(cashEffect("fee", a("15")).toFixed()).toBe("-15");
    expect(cashEffect("tax", a("15")).toFixed()).toBe("-15");
  });
});
