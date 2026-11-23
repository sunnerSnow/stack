import { D } from "@/lib/money/decimal";
import { groupRows, normalizePages, type PdfPage, type PdfTextItem } from "@/lib/imports/tdcc";

/**
 * 券商「客戶交易明細表」PDF 的解析（目前是國泰證券的版面；純函式：輸入 PDF 的文字座標，輸出成交列）。
 *
 * - 瀏覽器用 pdf.js 打開 PDF 後把每頁的文字項目交給這裡，伺服器只收到解析好的成交列。
 *   客戶代號、帳號、姓名那一列一律不讀：只從「交易日期:」右邊讀出查詢期間。
 * - 欄位：交易日期（民國年）、CD、股票名稱（只有名稱，沒有代號）、股數、單價、手續費、交易稅、證所稅、
 *   融券手續費、利息、預收/留置款、價金、淨收付金額（後面標「收」或「付」，是券商的角度）、委託書號。
 * - 數字欄靠右對齊：用數字的右緣找最近的欄名右緣；文字欄（CD、名稱、委託書號）用左緣。
 * - 每列自我核對（rowProblems）：價金＝股數 × 單價；買進淨收付＝價金＋手續費（收）；賣出淨收付＝價金−手續費−交易稅（付）。
 *   頁尾的合計與交易筆數也要對得上（totalsProblems），少讀或多讀一列都會被發現。
 */

export interface BrokerTradeHeader {
  brokerName: string | null;
  /** 查詢期間 YYYY-MM-DD */
  periodFrom: string | null;
  periodTo: string | null;
  /** 印表日期 YYYY-MM-DD */
  printedOn: string | null;
}

/** 一般現股買賣用不到、有值就不支援的欄位（融資融券、借券等） */
export const EXTRA_COLUMNS = ["證所稅", "融券手續費", "利息", "預收/留置款"] as const;
export type ExtraColumn = (typeof EXTRA_COLUMNS)[number];

export interface BrokerTradeRow {
  /** 在檔案中的順序（0 起算，依頁次由上往下；明細依交易日由舊到新） */
  line: number;
  page: number;
  date: string;
  /** CD 欄原文，例如「集買」「OT賣」「沖買」 */
  code: string;
  name: string;
  /** 以下數字都是不含千分位的十進位字串 */
  quantity: string;
  price: string;
  fee: string;
  tax: string;
  gross: string;
  net: string;
  netDirection: "收" | "付";
  orderNo: string | null;
  extras: Partial<Record<ExtraColumn, string>>;
}

export interface BrokerTradeTotals {
  /** 頁尾「交易筆數」 */
  count: number | null;
  fee: string | null;
  tax: string | null;
  gross: string | null;
  net: string | null;
  netDirection: "收" | "付" | null;
}

export interface BrokerTradeParseResult {
  header: BrokerTradeHeader;
  rows: BrokerTradeRow[];
  totals: BrokerTradeTotals;
}

export class BrokerTradeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerTradeFormatError";
  }
}

export interface TradeCodeInfo {
  side: "buy" | "sell";
  /** 集中市場（上市）／櫃檯買賣（上櫃）；當沖的代碼沒有標市場 */
  market: "TWSE" | "TPEx" | null;
  dayTrade: boolean;
}

/** 支援的 CD：現股買賣與現股當沖。融資融券、零股等其他代碼一律不支援（不猜） */
export const TRADE_CODES: Record<string, TradeCodeInfo> = {
  集買: { side: "buy", market: "TWSE", dayTrade: false },
  集賣: { side: "sell", market: "TWSE", dayTrade: false },
  OT買: { side: "buy", market: "TPEx", dayTrade: false },
  OT賣: { side: "sell", market: "TPEx", dayTrade: false },
  沖買: { side: "buy", market: null, dayTrade: true },
  沖賣: { side: "sell", market: null, dayTrade: true },
};

const ROC_DATE = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/;
const NUMERIC = /^[\d,]+(\.\d+)?(\((收|付)\))?$/;

const rocToIso = (s: string): string | null => {
  const m = s.trim().match(ROC_DATE);
  return m ? `${Number(m[1]) + 1911}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const compact = (s: string) => s.replace(/\s+/g, "");
const right = (i: PdfTextItem) => i.x + i.width;

type NumericColumn = "股數" | "單價" | "手續費" | "交易稅" | ExtraColumn | "價金" | "淨收付金額";
const NUMERIC_COLUMNS: NumericColumn[] = ["股數", "單價", "手續費", "交易稅", ...EXTRA_COLUMNS, "價金", "淨收付金額"];

interface Columns {
  date: number;
  cd: number;
  name: number;
  order: number;
  /** 數字欄的欄名右緣 */
  numeric: Record<NumericColumn, number>;
}

/** 欄名：「價金」常被拆成「價」「金」兩段 */
function findColumns(row: PdfTextItem[]): Columns | null {
  const find = (label: string) => row.find((i) => compact(i.str) === label);
  const [date, cd, name, order] = [find("交易日期"), find("CD"), find("股票名稱"), find("委託書號")];
  if (!date || !cd || !name || !order) return null;
  const numeric = {} as Record<NumericColumn, number>;
  for (const label of NUMERIC_COLUMNS) {
    let item = find(label);
    if (!item && label === "價金") {
      const [p, g] = [find("價"), find("金")];
      if (p && g) item = { ...g, x: p.x, width: right(g) - p.x };
    }
    if (!item) return null;
    numeric[label] = right(item);
  }
  return { date: date.x, cd: cd.x, name: name.x, order: order.x, numeric };
}

/** 數字的右緣離欄名右緣夠近才算那一欄 */
const NUMERIC_TOLERANCE = 15;

function nearestNumericColumn(cols: Columns, item: PdfTextItem): NumericColumn | null {
  let best: NumericColumn | null = null;
  let bestDistance = Infinity;
  for (const label of NUMERIC_COLUMNS) {
    const d = Math.abs(cols.numeric[label] - right(item));
    if (d < bestDistance) [best, bestDistance] = [label, d];
  }
  return bestDistance <= NUMERIC_TOLERANCE ? best : null;
}

const plainNumber = (s: string) => {
  const m = s.match(/^([\d,]+(?:\.\d+)?)(?:\((收|付)\))?$/);
  if (!m) return null;
  return { value: new D(m[1].replaceAll(",", "")).toFixed(), direction: (m[2] as "收" | "付" | undefined) ?? null };
};

function parseHeader(rows: PdfTextItem[][]): BrokerTradeHeader {
  const text = (r: PdfTextItem[]) => r.map((i) => i.str).join("");
  const broker = rows.find((r) => /證券.*公司/.test(text(r)));
  // 「交易日期:」在客戶資料那一列：只讀它右邊、「頁次」之前的文字，左邊的客戶代號與姓名完全不碰
  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  for (const r of rows) {
    const i = r.findIndex((it) => compact(it.str) === "交易日期:");
    if (i < 0) continue;
    const after: string[] = [];
    for (const it of r.slice(i + 1)) {
      if (compact(it.str).startsWith("頁次")) break;
      after.push(it.str);
    }
    const m = compact(after.join("")).match(/^(\d{2,3}\/\d{1,2}\/\d{1,2})-(\d{2,3}\/\d{1,2}\/\d{1,2})$/);
    if (m) [periodFrom, periodTo] = [rocToIso(m[1]), rocToIso(m[2])];
    break;
  }
  return { brokerName: broker ? text(broker).trim().slice(0, 40) : null, periodFrom, periodTo, printedOn: null };
}

export function parseBrokerTradeStatement(rawPages: PdfPage[]): BrokerTradeParseResult {
  const pages = normalizePages(rawPages);
  const pageRows = pages.map((p) => groupRows(p.items));
  const allText = pageRows.flat().map((r) => r.map((i) => compact(i.str)).join("")).join("\n");
  if (!allText.includes("客戶交易明細表")) throw new BrokerTradeFormatError("這不是券商的「客戶交易明細表」PDF（目前支援國泰證券的格式）");

  const header = parseHeader(pageRows[0] ?? []);
  const rows: BrokerTradeRow[] = [];
  const totals: BrokerTradeTotals = { count: null, fee: null, tax: null, gross: null, net: null, netDirection: null };
  let line = 0;
  let lastCols: Columns | null = null;

  pageRows.forEach((rowsOnPage, index) => {
    const headerRow = rowsOnPage.find((r) => r.some((i) => compact(i.str) === "交易日期") && r.some((i) => compact(i.str) === "股票名稱"));
    // 沒有欄名列的頁面（例如頁尾單獨一頁）沿用前一頁的欄位位置
    const cols = headerRow ? findColumns(headerRow) : lastCols;
    if (headerRow && !cols) throw new BrokerTradeFormatError(`第 ${index + 1} 頁的欄名跟預期不同（需要交易日期、CD、股票名稱、股數、單價、手續費、交易稅、價金、淨收付金額、委託書號等欄）`);
    if (!cols) {
      if (rowsOnPage.some((r) => ROC_DATE.test(r[0]?.str.trim() ?? "") && r.length > 3)) throw new BrokerTradeFormatError(`第 ${index + 1} 頁找不到欄名列，格式可能改了`);
      return;
    }
    lastCols = cols;

    for (const r of rowsOnPage) {
      const first = r[0];
      const firstText = compact(first?.str ?? "");
      const joined = r.map((i) => compact(i.str)).join("");

      if (joined.startsWith("合計")) {
        for (const item of r) {
          const n = plainNumber(compact(item.str));
          const col = n ? nearestNumericColumn(cols, item) : null;
          if (!n || !col) continue;
          if (col === "手續費") totals.fee = n.value;
          else if (col === "交易稅") totals.tax = n.value;
          else if (col === "價金") totals.gross = n.value;
          else if (col === "淨收付金額") [totals.net, totals.netDirection] = [n.value, n.direction];
        }
        continue;
      }
      if (joined.includes("交易筆數:")) {
        const count = joined.match(/交易筆數:(\d+)/);
        const printed = joined.match(/印表日期:(\d{2,3}\/\d{1,2}\/\d{1,2})/);
        if (count) totals.count = Number(count[1]);
        if (printed) header.printedOn = rocToIso(printed[1]);
        continue;
      }
      if (!ROC_DATE.test(firstText) || Math.abs(first.x - cols.date) > 10) continue;

      const date = rocToIso(firstText)!;
      const text = { code: [] as string[], name: [] as string[], order: [] as string[] };
      const numbers: Partial<Record<NumericColumn, { value: string; direction: "收" | "付" | null }>> = {};
      for (const item of r.slice(1)) {
        const s = compact(item.str);
        if (!s) continue;
        const col = NUMERIC.test(s) ? nearestNumericColumn(cols, item) : null;
        if (col) {
          if (numbers[col]) throw new BrokerTradeFormatError(`第 ${index + 1} 頁 ${firstText} 那一列的「${col}」出現兩個數字，格式可能改了`);
          numbers[col] = plainNumber(s)!;
        } else if (item.x >= cols.order - 6) text.order.push(s);
        else if (item.x >= cols.name - 4) text.name.push(s);
        else if (item.x >= cols.cd - 4) text.code.push(s);
      }
      const need = (col: NumericColumn) => numbers[col]?.value ?? null;
      const [quantity, price, gross, net] = [need("股數"), need("單價"), need("價金"), need("淨收付金額")];
      const netDirection = numbers["淨收付金額"]?.direction ?? null;
      if (!quantity || !price || !gross || !net || !netDirection || text.code.length === 0 || text.name.length === 0) {
        throw new BrokerTradeFormatError(`第 ${index + 1} 頁 ${firstText} 那一列缺少股數、單價、價金或淨收付金額，格式可能改了`);
      }
      const extras: Partial<Record<ExtraColumn, string>> = {};
      for (const c of EXTRA_COLUMNS) if (numbers[c]) extras[c] = numbers[c]!.value;
      rows.push({
        line: line++,
        page: index + 1,
        date,
        code: text.code.join(""),
        name: text.name.join(""),
        quantity,
        price,
        fee: need("手續費") ?? "0",
        tax: need("交易稅") ?? "0",
        gross,
        net,
        netDirection,
        orderNo: text.order.join("") || null,
        extras,
      });
    }
  });

  if (rows.length === 0) throw new BrokerTradeFormatError("檔案裡沒有任何成交明細");
  return { header, rows, totals };
}

/** 一列自己的問題（伺服器與瀏覽器共用）：不支援的類別、算式對不上 */
export function rowProblems(row: Pick<BrokerTradeRow, "code" | "quantity" | "price" | "fee" | "tax" | "gross" | "net" | "netDirection" | "extras">): string[] {
  const problems: string[] = [];
  const info = TRADE_CODES[row.code];
  if (!info) problems.push(`不支援的交易類別「${row.code}」（目前只支援現股買賣與現股當沖）`);
  const extras = Object.entries(row.extras).filter(([, v]) => v && !new D(v).isZero());
  if (extras.length > 0) problems.push(`有${extras.map(([k]) => k).join("、")}，目前不支援融資融券等交易`);
  const [q, p, fee, tax, gross, net] = [row.quantity, row.price, row.fee, row.tax, row.gross, row.net].map((v) => new D(v));
  if (q.lessThanOrEqualTo(0) || !q.isInteger()) problems.push("股數必須是正整數");
  if (p.lessThanOrEqualTo(0)) problems.push("單價必須大於 0");
  if (!q.times(p).equals(gross)) problems.push(`價金 ${gross.toFixed()} 不等於股數 × 單價 ${q.times(p).toFixed()}`);
  if (info) {
    const expectedDirection = info.side === "buy" ? "收" : "付";
    const expected = info.side === "buy" ? gross.plus(fee).plus(tax) : gross.minus(fee).minus(tax);
    if (row.netDirection !== expectedDirection) problems.push(`${info.side === "buy" ? "買進" : "賣出"}的淨收付應該是「${expectedDirection}」`);
    else if (!expected.equals(net)) problems.push(`淨收付 ${net.toFixed()} 不等於價金${info.side === "buy" ? "＋" : "−"}手續費與稅 ${expected.toFixed()}`);
  }
  return problems;
}

/** 整份檔案跟頁尾的合計、交易筆數核對 */
export function totalsProblems(rows: Pick<BrokerTradeRow, "fee" | "tax" | "gross" | "net" | "netDirection">[], totals: BrokerTradeTotals): string[] {
  const problems: string[] = [];
  if (totals.count === null) problems.push("找不到頁尾的「交易筆數」，無法確認有沒有漏讀");
  else if (totals.count !== rows.length) problems.push(`頁尾寫 ${totals.count} 筆，但讀到 ${rows.length} 筆`);
  const sum = (pick: (r: (typeof rows)[number]) => string) => rows.reduce((s, r) => s.plus(pick(r)), new D(0));
  const check = (label: string, total: string | null, actual: InstanceType<typeof D>) => {
    if (total === null) problems.push(`找不到頁尾的${label}合計`);
    else if (!actual.equals(total)) problems.push(`${label}合計 ${new D(total).toFixed()} 跟各列加總 ${actual.toFixed()} 不同`);
  };
  check("手續費", totals.fee, sum((r) => r.fee));
  check("交易稅", totals.tax, sum((r) => r.tax));
  check("價金", totals.gross, sum((r) => r.gross));
  // 淨收付：「付」（券商付給客戶）為正、「收」為負
  const signed = (value: string, dir: "收" | "付" | null) => (dir === "收" ? new D(value).negated() : new D(value));
  const net = rows.reduce((s, r) => s.plus(signed(r.net, r.netDirection)), new D(0));
  if (totals.net === null) problems.push("找不到頁尾的淨收付合計");
  else if (!signed(totals.net, totals.netDirection).equals(net)) problems.push(`淨收付合計跟各列加總不同（${net.toFixed()}）`);
  return problems;
}
