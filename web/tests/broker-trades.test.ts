import { describe, expect, it } from "vitest";
import { BrokerTradeFormatError, parseBrokerTradeStatement, rowProblems, totalsProblems, type BrokerTradeRow } from "@/lib/imports/broker-trades";
import type { PdfPage, PdfTextItem } from "@/lib/imports/tdcc";

// ---------------------------------------------------------------------------
// 假的「客戶交易明細表」：欄位位置仿照國泰證券的版面，資料是編的
// ---------------------------------------------------------------------------
const W = 5; // 每個字元的寬度
const text = (str: string, x: number, y: number): PdfTextItem => ({ str, x, y, width: str.length * W });
/** 靠右對齊：右緣對到欄名右緣 */
const num = (str: string, rightEdge: number, y: number): PdfTextItem => ({ str, x: rightEdge - str.length * W, y, width: str.length * W });

const HEADER: [string, number][] = [
  ["交易日期", 15],
  ["CD", 66],
  ["股票名稱", 97],
  ["股數", 203],
  ["單價", 254],
  ["手續費", 296],
  ["交易稅", 347],
  ["證所稅", 389],
  ["融券手續費", 425],
  ["利息", 506],
  ["預收/留置款", 535],
  ["價", 635],
  ["金", 662],
  ["淨收付金額", 714],
  ["委託書號", 766],
];
const rightOf = (label: string) => {
  const [s, x] = HEADER.find(([l]) => l === label)!;
  return x + s.length * W;
};

type Row = { date: string; cd: string; name: string; qty: string; price: string; fee?: string; tax?: string; gross: string; net: string; order: string; extra?: [string, string] };

function page(rows: Row[], opts: { footer?: [string, string, string, string]; count?: number; mergedGross?: boolean } = {}): PdfPage {
  const items: PdfTextItem[] = [
    text("國泰綜合證券股份有限公司(敦南)", 156, 549),
    text("客戶交易明細表", 191, 536),
    // 客戶資料列：解析器不能讀出左邊這幾段
    text("客戶:9999-", 14, 523),
    text("123456-7", 58, 523),
    text("王小明", 98, 523),
    text("交易日期:", 298, 523),
    text("114/11/16", 345, 523),
    text("- 115/11/16", 389, 523),
    text("頁次:", 510, 523),
    text("1", 540, 523),
  ];
  for (const [label, x] of HEADER) {
    if (opts.mergedGross && label === "價") items.push(text("價金", 635, 482));
    else if (!(opts.mergedGross && label === "金")) items.push(text(label, x, 482));
  }
  const grossRight = opts.mergedGross ? 635 + 2 * W : rightOf("金");
  rows.forEach((r, i) => {
    const y = 456 - i * 13;
    items.push(text(r.date, 15, y), text(r.cd, 66, y), text(r.name, 97, y), num(r.qty, rightOf("股數"), y), num(r.price, rightOf("單價"), y));
    if (r.fee) items.push(num(r.fee, rightOf("手續費"), y));
    if (r.tax) items.push(num(r.tax, rightOf("交易稅"), y));
    if (r.extra) items.push(num(r.extra[1], rightOf(r.extra[0]), y));
    items.push(num(r.gross, grossRight, y), num(r.net, rightOf("淨收付金額"), y), text(r.order, 766, y));
  });
  if (opts.footer) {
    const [fee, tax, gross, net] = opts.footer;
    items.push(text("合", 15, 248), text("計:", 42, 248), num(fee, rightOf("手續費"), 248), num(tax, rightOf("交易稅"), 248), num(gross, grossRight, 248), num(net, rightOf("淨收付金額"), 248));
    items.push(text("交易筆數:", 14, 229), text(String(opts.count), 62, 229), text("印表日期:", 85, 229), text("115/11/17", 133, 229), text("171046", 177, 229));
  }
  return { items };
}

const ROWS: Row[] = [
  { date: "114/11/17", cd: "OT賣", name: "方土昶", qty: "2,000", price: "19.85", fee: "15", tax: "119", gross: "39,700", net: "39,566(付)", order: "b-0504-00" },
  { date: "114/11/20", cd: "集買", name: "南亞科", qty: "1,000", price: "155.00", fee: "61", gross: "155,000", net: "155,061(收)", order: "b-Y088-00" },
  { date: "114/11/25", cd: "沖賣", name: "沛亨", qty: "1,000", price: "186.00", fee: "74", tax: "279", gross: "186,000", net: "185,647(付)", order: "a-K593-00" },
  { date: "114/11/27", cd: "集買", name: "鴻勁", qty: "39", price: "2,895.00", fee: "45", gross: "112,905", net: "112,950(收)", order: "r-04zw-00" },
];

describe("券商客戶交易明細表", () => {
  it("讀出期間、每一列與頁尾；客戶代號、帳號、姓名不會出現在結果裡", () => {
    const r = parseBrokerTradeStatement([page(ROWS.slice(0, 2)), page(ROWS.slice(2), { footer: ["195", "398", "493,605", "42,798(收)"], count: 4 })]);
    expect(r.header).toEqual({ brokerName: "國泰綜合證券股份有限公司(敦南)", periodFrom: "2025-11-16", periodTo: "2026-11-16", printedOn: "2026-11-17" });
    expect(r.rows.map((x) => [x.line, x.page, x.date, x.code, x.name, x.quantity, x.price, x.fee, x.tax, x.gross, x.net, x.netDirection, x.orderNo])).toEqual([
      [0, 1, "2025-11-17", "OT賣", "方土昶", "2000", "19.85", "15", "119", "39700", "39566", "付", "b-0504-00"],
      [1, 1, "2025-11-20", "集買", "南亞科", "1000", "155", "61", "0", "155000", "155061", "收", "b-Y088-00"],
      [2, 2, "2025-11-25", "沖賣", "沛亨", "1000", "186", "74", "279", "186000", "185647", "付", "a-K593-00"],
      [3, 2, "2025-11-27", "集買", "鴻勁", "39", "2895", "45", "0", "112905", "112950", "收", "r-04zw-00"],
    ]);
    expect(r.totals).toEqual({ count: 4, fee: "195", tax: "398", gross: "493605", net: "42798", netDirection: "收" });
    expect(r.rows.flatMap(rowProblems)).toEqual([]);
    expect(totalsProblems(r.rows, r.totals)).toEqual([]);
    const json = JSON.stringify(r);
    for (const secret of ["9999", "123456", "王小明"]) expect(json).not.toContain(secret);
  });

  it("頁尾單獨在最後一頁（沒有欄名列）：沿用前一頁的欄位位置", () => {
    const footerOnly = page([], { footer: ["195", "398", "493,605", "42,798(收)"], count: 4 });
    // 拿掉欄名列與表頭，只剩頁尾
    footerOnly.items = footerOnly.items.filter((i) => i.y < 300);
    const r = parseBrokerTradeStatement([page(ROWS), footerOnly]);
    expect(r.totals).toMatchObject({ count: 4, fee: "195", net: "42798", netDirection: "收" });
    expect(totalsProblems(r.rows, r.totals)).toEqual([]);
  });

  it("「價金」欄名沒有被拆開也讀得到", () => {
    const r = parseBrokerTradeStatement([page(ROWS.slice(1, 2), { mergedGross: true, footer: ["61", "0", "155,000", "155,061(收)"], count: 1 })]);
    expect(r.rows[0]).toMatchObject({ gross: "155000", net: "155061" });
    expect(totalsProblems(r.rows, r.totals)).toEqual([]);
  });

  it("算式對不上、不支援的類別、融資融券欄有值：逐列列出問題", () => {
    const base = parseBrokerTradeStatement([page(ROWS.slice(0, 1))]).rows[0];
    const bad = (patch: Partial<BrokerTradeRow>) => rowProblems({ ...base, ...patch });
    expect(bad({ gross: "39701" })[0]).toContain("價金 39701 不等於股數 × 單價 39700");
    expect(bad({ net: "39567" })[0]).toContain("淨收付 39567 不等於價金−手續費與稅 39566");
    expect(bad({ netDirection: "收" })[0]).toContain("賣出的淨收付應該是「付」");
    expect(bad({ code: "資買" })[0]).toContain("不支援的交易類別「資買」");
    expect(bad({ extras: { 利息: "12" } })[0]).toContain("有利息");
    expect(bad({ quantity: "0.5", gross: "9.925" })).toContain("股數必須是正整數");
  });

  it("頁尾的筆數或合計對不上：整份不收", () => {
    const r = parseBrokerTradeStatement([page(ROWS, { footer: ["195", "398", "493,605", "42,798(收)"], count: 5 })]);
    expect(totalsProblems(r.rows, r.totals)).toEqual(["頁尾寫 5 筆，但讀到 4 筆"]);
    const noFooter = parseBrokerTradeStatement([page(ROWS)]);
    expect(totalsProblems(noFooter.rows, noFooter.totals)[0]).toContain("找不到頁尾的「交易筆數」");
    const wrongFee = parseBrokerTradeStatement([page(ROWS, { footer: ["196", "398", "493,605", "42,798(收)"], count: 4 })]);
    expect(totalsProblems(wrongFee.rows, wrongFee.totals)).toEqual(["手續費合計 196 跟各列加總 195 不同"]);
  });

  it("不是客戶交易明細表：直接說明", () => {
    expect(() => parseBrokerTradeStatement([{ items: [text("證券存摺登摺資料", 10, 10)] }])).toThrow(BrokerTradeFormatError);
  });
});
