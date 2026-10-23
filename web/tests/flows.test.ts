import { describe, expect, it } from "vitest";
import { flowValue } from "@/lib/market/flows";

describe("法人金額顯示", () => {
  it("合計必須有三種法人資料，真實零值仍保留", () => {
    expect(flowValue({ foreign: null, trust: 0, dealer: 0 }, "total")).toBeNull();
    expect(flowValue({ foreign: 0, trust: 0, dealer: 0 }, "total")).toBe(0);
    expect(flowValue({ foreign: 100, trust: -20, dealer: 0 }, "total")).toBe(80);
  });
  it("可個別檢視完整的法人，不受其他法人的缺值影響", () => {
    expect(flowValue({ foreign: null, trust: 0, dealer: 0 }, "trust")).toBe(0);
    expect(flowValue({ foreign: null, trust: 0, dealer: 0 }, "foreign")).toBeNull();
  });
});
