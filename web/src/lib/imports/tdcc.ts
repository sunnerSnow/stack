import { D } from "@/lib/money/decimal";

/**
 * 集保 e 存摺「證券存摺登摺資料」PDF 的解析（純函式：輸入 PDF 的文字座標，輸出異動明細）。
 *
 * - 瀏覽器用 pdf.js 打開 PDF（密碼也只在瀏覽器裡用）後把每頁的文字項目交給這裡，
 *   伺服器只收到解析好的異動列；戶名、帳號、身分證字號都不會被讀出來。
 * - 每一列：交易日期（民國年，成交日）、證券代號、名稱、摘要、提出數額、存入數額、餘額。
 *   集保只管股數，沒有成交價、手續費與稅。
 * - 數字欄是靠右對齊，用「欄名右緣之間的中點」切分提出／存入／餘額。
 */

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

export interface PdfPage {
  items: PdfTextItem[];
}

export interface TdccHeader {
  brokerName: string | null;
  brokerCode: string | null;
  /** 查詢期間 YYYY-MM-DD */
  periodFrom: string | null;
  periodTo: string | null;
  /** 檔案產製時間（台北時間）YYYY-MM-DDTHH:MM */
  generatedAt: string | null;
}

export interface TdccMovement {
  /** 在檔案中的順序（0 起算；檔案是新到舊） */
  line: number;
  page: number;
  date: string;
  symbol: string;
  name: string;
  memo: string;
  withdrawal: string | null;
  deposit: string | null;
  balance: string | null;
}

export interface TdccParseResult {
  header: TdccHeader;
  movements: TdccMovement[];
  warnings: string[];
}

export class TdccFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdccFormatError";
  }
}

const ROC_DATE = /^(\d{2,3}) (\d{2}) (\d{2})$/;
const NUMBER = /^[\d,]+$/;
const SYMBOL = /^[0-9A-Z]{4,6}$/;
const NOISE = /集中保管結算所|產製/;

const rocToIso = (y: string | number, m: string | number, d: string | number) =>
  `${Number(y) + 1911}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** 文字已經過 NFKC（全形冒號變成半形）；欄位之間以「 | 」分開 */
function parseHeader(text: string): TdccHeader {
  const broker = text.match(/證券商名稱:\s*([^\s|]+)/);
  const code = text.match(/證商代號:\s*([0-9A-Za-z]+)/);
  const period = text.match(/交易明細查詢期間:\s*(\d+)年(\d+)月(\d+)日至(\d+)年(\d+)月(\d+)日/);
  const generated = text.match(/檔案產製時間:\s*(\d+)年(\d+)月(\d+)日\s*(\d{1,2}):(\d{2})/);
  return {
    brokerName: broker?.[1] ?? null,
    brokerCode: code?.[1] ?? null,
    periodFrom: period ? rocToIso(period[1], period[2], period[3]) : null,
    periodTo: period ? rocToIso(period[4], period[5], period[6]) : null,
    generatedAt: generated ? `${rocToIso(generated[1], generated[2], generated[3])}T${generated[4].padStart(2, "0")}:${generated[5]}` : null,
  };
}

interface Columns {
  /** 數字右緣 < withdrawalMax → 提出；< depositMax → 存入；< balanceMax → 餘額 */
  withdrawalMax: number;
  depositMax: number;
  balanceMax: number;
}

/** 從欄名的右緣算出數字欄的分界 */
function findColumns(items: PdfTextItem[]): Columns | null {
  const right = (label: string) => {
    const item = items.find((i) => i.str.trim() === label);
    return item ? item.x + item.width : null;
  };
  const [w, d, b, p] = [right("提出數額"), right("存入數額"), right("餘額"), right("提供人帳號")];
  if (w === null || d === null || b === null) return null;
  return { withdrawalMax: (w + d) / 2, depositMax: (d + b) / 2, balanceMax: p === null ? b + 80 : (b + p) / 2 };
}

/** 同一列：y 相差 2.5 以內 */
function groupRows(items: PdfTextItem[]): PdfTextItem[][] {
  const rows: { y: number; items: PdfTextItem[] }[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - item.y) <= 2.5);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x));
}

const plain = (s: string) => s.replaceAll(",", "");

/**
 * 把一頁的文字依列重組：同一列裡相鄰的片段直接接起來（字型會把一句話拆成好幾段），
 * 中間有明顯空白的才當成不同欄位，用「 | 」分開。
 */
function pageText(items: PdfTextItem[]): string {
  return groupRows(items)
    .map((row) =>
      row.reduce((text, item, i) => {
        if (i === 0) return item.str;
        const prev = row[i - 1];
        return text + (item.x - (prev.x + prev.width) > 8 ? " | " : "") + item.str;
      }, ""),
    )
    .join("\n");
}

/**
 * PDF 的字型常把「月」「日」「至」對應成康熙部首（⽉ U+2F49、⽇ U+2F47…），全形數字與冒號也很常見；
 * 先做 NFKC 正規化，名稱與檔頭才比對得到。
 */
const normalizePages = (pages: PdfPage[]): PdfPage[] =>
  pages.map((p) => ({ items: p.items.map((i) => ({ ...i, str: i.str.normalize("NFKC") })) }));

export function parseTdccPassbook(rawPages: PdfPage[]): TdccParseResult {
  const pages = normalizePages(rawPages);
  const firstText = pages[0] ? pageText(pages[0].items) : "";
  if (!firstText.includes("證券存摺登摺資料") || !/提出數額/.test(firstText) || !/存入數額/.test(firstText)) {
    throw new TdccFormatError("這份 PDF 不是集保 e 存摺的「證券存摺登摺資料」（異動明細）");
  }
  const header = parseHeader(firstText);
  const movements: TdccMovement[] = [];
  const warnings: string[] = [];
  let columns: Columns | null = null;

  pages.forEach((page, pageIndex) => {
    columns = findColumns(page.items) ?? columns;
    if (!columns) throw new TdccFormatError(`第 ${pageIndex + 1} 頁找不到「提出數額／存入數額／餘額」欄`);
    const cols: Columns = columns;
    // 浮水印（「臺灣集中保管結算所…」「…產製」）會穿插在資料列裡，先濾掉
    const items = page.items.filter((i) => !NOISE.test(i.str) && i.x >= 30);
    for (const row of groupRows(items)) {
      const dateItem = row.find((i) => i.x < 130 && ROC_DATE.test(i.str.trim()));
      if (!dateItem) continue;
      const [, y, m, d] = dateItem.str.trim().match(ROC_DATE)!;
      const symbolItem = row.find((i) => i.x >= 120 && i.x < 200 && SYMBOL.test(i.str.trim()));
      // 名稱（約 x 190～300）與摘要（約 x 300～380）可能被字型拆成好幾段，各自接起來
      const memoText = row
        .filter((i) => i.x >= 300 && i.x < 380 && !NUMBER.test(i.str.trim()))
        .map((i) => i.str.trim())
        .join("");
      const nameText = row
        .filter((i) => i.x >= 190 && i.x < 300 && i !== symbolItem)
        .map((i) => i.str.trim())
        .join("");
      if (!symbolItem || !memoText) {
        warnings.push(`第 ${pageIndex + 1} 頁 ${rocToIso(y, m, d)} 有一列讀不出代號或摘要，已略過`);
        continue;
      }
      const numbers = { withdrawal: null as string | null, deposit: null as string | null, balance: null as string | null };
      for (const item of row) {
        const s = item.str.trim();
        if (item.x < 360 || !NUMBER.test(s)) continue;
        const right = item.x + item.width;
        if (right < cols.withdrawalMax) numbers.withdrawal = plain(s);
        else if (right < cols.depositMax) numbers.deposit = plain(s);
        else if (right < cols.balanceMax) numbers.balance = plain(s);
      }
      movements.push({
        line: movements.length,
        page: pageIndex + 1,
        date: rocToIso(y, m, d),
        symbol: symbolItem.str.trim(),
        // 名稱後面的 * 是集保的註記，不是名稱的一部分
        name: nameText.replace(/\*+$/, "").trim(),
        memo: memoText,
        ...numbers,
      });
    }
  });

  if (movements.length === 0) warnings.push("PDF 裡沒有任何異動明細");
  return { header, movements, warnings };
}

export interface DerivedHolding {
  symbol: string;
  name: string;
  quantity: string;
  /** 最後一次異動日 */
  lastDate: string;
}

export interface HoldingIssue {
  symbol: string;
  name: string;
  kind: "balance_mismatch" | "no_balance" | "lent_out";
  message: string;
}

export interface DerivedHoldings {
  holdings: DerivedHolding[];
  issues: HoldingIssue[];
  /** 期間內只有當沖（買賣相抵）的代號：股數沒有變動，也看不出期初有沒有持股 */
  dayTradeOnly: { symbol: string; name: string }[];
  /** 期間內有異動的所有代號（不在 holdings 裡的就是已經賣光）；沒出現的代號可能是兩年內沒動過的持股 */
  seen: string[];
  /** 各種摘要的筆數，例如 { 買進: 120, 賣出: 98, 買賣相抵: 20 } */
  memoCounts: Record<string, number>;
}

/**
 * 依異動明細推算每檔最後的股數，並逐列檢查餘額是否接得上（前一列餘額 − 提出 ＋ 存入 ＝ 這一列餘額）。
 * 期初（查詢期間之前）的股數由第一筆有餘額的列反推；買賣相抵（當沖）的列沒有餘額，股數不變。
 */
export function deriveHoldings(movements: TdccMovement[]): DerivedHoldings {
  const memoCounts: Record<string, number> = {};
  const bySymbol = new Map<string, TdccMovement[]>();
  for (const m of movements) {
    memoCounts[m.memo] = (memoCounts[m.memo] ?? 0) + 1;
    bySymbol.set(m.symbol, [...(bySymbol.get(m.symbol) ?? []), m]);
  }

  const holdings: DerivedHolding[] = [];
  const issues: HoldingIssue[] = [];
  const dayTradeOnly: { symbol: string; name: string }[] = [];
  for (const [symbol, rows] of bySymbol) {
    // 檔案是新到舊；反過來就是時間順序（同一天也照檔案的相反順序）
    const chronological = [...rows].sort((a, b) => b.line - a.line);
    const latest = rows.reduce((a, b) => (a.line < b.line ? a : b));
    const name = latest.name;
    const change = (m: TdccMovement) => new D(m.deposit ?? 0).minus(m.withdrawal ?? 0);

    const anchor = chronological.findIndex((m) => m.balance !== null);
    if (anchor === -1) {
      // 沒有任何一列有餘額：只有當沖（提出＝存入）就只是提示，否則是資料有缺
      if (rows.every((m) => change(m).isZero())) dayTradeOnly.push({ symbol, name });
      else issues.push({ symbol, name, kind: "no_balance", message: `${symbol} ${name} 的異動都沒有餘額，無法判斷股數` });
      continue;
    }
    let balance = chronological.slice(0, anchor + 1).reduce((b, m) => b.minus(change(m)), new D(chronological[anchor].balance!));
    for (const m of chronological) {
      balance = balance.plus(change(m));
      if (m.balance !== null && !balance.equals(m.balance)) {
        issues.push({
          symbol,
          name,
          kind: "balance_mismatch",
          message: `${symbol} ${name} 在 ${m.date} 的餘額是 ${m.balance}，但依前面的異動算出來是 ${balance.toFixed()}`,
        });
        balance = new D(m.balance);
      }
    }
    const lastLending = [...chronological].reverse().find((m) => m.memo.includes("借貸"));
    if (lastLending?.withdrawal && !lastLending.deposit) {
      issues.push({
        symbol,
        name,
        kind: "lent_out",
        message: `${symbol} ${name} 最後一筆是借貸轉帳提出（${lastLending.date}），可能正在出借中，集保餘額不含出借的股數`,
      });
    }
    if (balance.greaterThan(0)) holdings.push({ symbol, name, quantity: balance.toFixed(), lastDate: latest.date });
  }
  holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
  dayTradeOnly.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { holdings, issues, dayTradeOnly, seen: [...bySymbol.keys()].sort(), memoCounts };
}
