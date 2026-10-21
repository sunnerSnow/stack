import { describe, expect, it } from "vitest";
import { deriveHoldings, type PdfPage, type PdfTextItem, parseTdccPassbook, TdccFormatError } from "@/lib/imports/tdcc";

/**
 * 假資料：版面（欄位位置、數字靠右、浮水印穿插）照集保 e 存摺登摺資料 PDF 用 pdf.js 讀出來的樣子，
 * 內容（代號、名稱、股數、戶名、帳號）都是編的。
 */
const header = (page: number): PdfTextItem[] => [
  { str: "證券存摺登摺資料", x: 349, y: 545, width: 96 },
  { str: "臺灣集中保管結算所12345678901", x: 60, y: 540, width: 150 },
  { str: "檔案產製時間：115年10月20日 17:06", x: 48, y: 519, width: 170 },
  { str: "證券商名稱：測試證券", x: 366, y: 519, width: 110 },
  { str: "交易明細查詢期間：113年10月20日至115年10月20日", x: 48, y: 506, width: 250 },
  { str: "帳號：12345678901", x: 366, y: 506, width: 90 },
  { str: "證商代號：9999", x: 48, y: 487, width: 80 },
  { str: "戶名：王小明", x: 48, y: 466, width: 60 },
  { str: `頁次：${page}`, x: 720, y: 432, width: 40 },
  { str: "證券代號", x: 135, y: 413, width: 48 },
  { str: "交易日期", x: 60, y: 407, width: 48 },
  { str: "證券名稱", x: 225, y: 407, width: 48 },
  { str: "摘要", x: 323, y: 407, width: 24 },
  { str: "提出數額", x: 386, y: 407, width: 48 },
  { str: "存入數額", x: 461, y: 407, width: 48 },
  { str: "餘額", x: 604, y: 407, width: 24 },
  { str: "提供人帳號", x: 717, y: 407, width: 60 },
];

/** 一列異動；數字靠右對齊（每個字元寬 6） */
function row(y: number, date: string, code: string, name: string, memo: string, out: string, inn: string, bal: string): PdfTextItem[] {
  const num = (s: string, right: number): PdfTextItem[] => (s ? [{ str: s, x: right - s.length * 6, y, width: s.length * 6 }] : []);
  return [
    { str: date, x: 56.6, y, width: 54 },
    { str: code, x: 147, y, width: code.length * 6 },
    { str: name, x: 237, y, width: name.length * 12 },
    { str: memo, x: memo.length === 4 ? 311 : 323, y, width: memo.length * 12 },
    ...num(out, 446.3),
    ...num(inn, 521.5),
    ...num(bal, 652.8),
  ];
}

const page1: PdfPage = {
  items: [
    ...header(1),
    ...row(374, "115 04 29", "9901", "測試甲", "賣出", "1,000", "", "0"),
    ...row(359, "115 04 27", "9901", "測試甲", "買進", "", "1,000", "1,000"),
    // 浮水印穿插在資料列裡
    { str: "結算所12345678901", x: -32, y: 345, width: 90 },
    ...row(345, "115 04 20", "9902", "測試乙*", "買賣相抵", "1,000", "1,000", ""),
    ...row(330, "115 04 10", "9903", "測試丙", "買進", "", "62", "2,182"),
    { str: ":06產製", x: -19, y: 224, width: 40 },
    ...row(315, "115 03 01", "9904", "測試丁", "借貸轉帳", "1,000", "", "0"),
    ...row(301, "115 02 01", "9904", "測試丁", "買進", "", "1,000", "1,000"),
  ],
};
const page2: PdfPage = {
  items: [...header(2), ...row(374, "115 01 05", "9903", "測試丙", "買進", "", "20", "2,120"), ...row(359, "114 12 30", "9905", "測試戊", "賣出", "27", "", "0")],
};

describe("解析集保 e 存摺登摺資料", () => {
  it("讀出檔頭（券商、查詢期間、產製時間），不讀戶名與帳號", () => {
    const { header: h } = parseTdccPassbook([page1, page2]);
    expect(h).toEqual({ brokerName: "測試證券", brokerCode: "9999", periodFrom: "2024-10-20", periodTo: "2026-10-20", generatedAt: "2026-10-20T17:06" });
    expect(JSON.stringify(parseTdccPassbook([page1, page2]))).not.toMatch(/王小明|12345678901/);
  });

  it("每一列：民國年轉西元、數字依欄位分到提出／存入／餘額、名稱去掉 *、略過浮水印", () => {
    const { movements, warnings } = parseTdccPassbook([page1, page2]);
    expect(warnings).toEqual([]);
    expect(movements).toHaveLength(8);
    expect(movements[0]).toEqual({ line: 0, page: 1, date: "2026-04-29", symbol: "9901", name: "測試甲", memo: "賣出", withdrawal: "1000", deposit: null, balance: "0" });
    expect(movements[2]).toMatchObject({ symbol: "9902", name: "測試乙", memo: "買賣相抵", withdrawal: "1000", deposit: "1000", balance: null });
    expect(movements[7]).toMatchObject({ page: 2, date: "2025-12-30", withdrawal: "27", balance: "0" });
  });

  it("字型把文字拆成好幾段、用康熙部首（⽉⽇⾄）與全形字：正規化後一樣讀得到", () => {
    const split: PdfPage = {
      items: [
        ...header(1).filter((i) => !/檔案產製時間|查詢期間/.test(i.str)),
        { str: "檔案產製時間：115年10", x: 48, y: 519, width: 109 },
        { str: "⽉", x: 157, y: 519, width: 10 },
        { str: "20", x: 167, y: 519, width: 12 },
        { str: "⽇", x: 179, y: 519, width: 10 },
        { str: "17:06", x: 191, y: 519, width: 30 },
        { str: "交易明細查詢期間：113年10", x: 48, y: 506, width: 129 },
        { str: "⽉", x: 177, y: 506, width: 10 },
        { str: "20", x: 187, y: 506, width: 12 },
        { str: "⽇", x: 199, y: 506, width: 10 },
        { str: "⾄", x: 209, y: 506, width: 10 },
        { str: "115年10⽉20⽇", x: 219, y: 506, width: 70 },
        ...row(374, "115 04 29", "006208", "富邦台５０", "買進", "", "62", "62").map((i) => (i.str === "富邦台５０" ? { ...i, str: "富邦台５" } : i)),
        { str: "０", x: 290, y: 374, width: 6 },
        ...row(359, "115 04 28", "0050", "元⼤台灣50", "買賣", "1,000", "1,000", ""),
        { str: "相抵", x: 347, y: 359, width: 24 },
      ],
    };
    const { header: h, movements } = parseTdccPassbook([split]);
    expect(h).toMatchObject({ periodFrom: "2024-10-20", periodTo: "2026-10-20", generatedAt: "2026-10-20T17:06" });
    expect(movements.map((m) => [m.symbol, m.name, m.memo])).toEqual([
      ["006208", "富邦台50", "買進"],
      ["0050", "元大台灣50", "買賣相抵"],
    ]);
  });

  it("不是登摺資料的 PDF：明確拒絕", () => {
    expect(() => parseTdccPassbook([{ items: [{ str: "對帳單", x: 0, y: 0, width: 10 }] }])).toThrow(TdccFormatError);
  });

  it("推算持股：期初由第一筆有餘額的列反推；當沖只提示；出借中的另外標示", () => {
    const derived = deriveHoldings(parseTdccPassbook([page1, page2]).movements);
    expect(derived.holdings).toEqual([{ symbol: "9903", name: "測試丙", quantity: "2182", lastDate: "2026-04-10" }]);
    expect(derived.dayTradeOnly).toEqual([{ symbol: "9902", name: "測試乙" }]);
    expect(derived.issues).toEqual([expect.objectContaining({ symbol: "9904", kind: "lent_out" })]);
    expect(derived.memoCounts).toEqual({ 賣出: 2, 買進: 4, 買賣相抵: 1, 借貸轉帳: 1 });
  });

  it("餘額接不上（例如讀錯欄）會列出來", () => {
    const broken: PdfPage = { items: [...header(1), ...row(374, "115 04 27", "9901", "測試甲", "買進", "", "1,000", "1,500"), ...row(359, "115 04 20", "9901", "測試甲", "買進", "", "1,000", "1,000")] };
    const { issues, holdings } = deriveHoldings(parseTdccPassbook([broken]).movements);
    expect(issues).toEqual([expect.objectContaining({ kind: "balance_mismatch", symbol: "9901" })]);
    expect(issues[0].message).toContain("1500");
    expect(holdings[0].quantity).toBe("1500"); // 以集保記載的餘額為準
  });
});
