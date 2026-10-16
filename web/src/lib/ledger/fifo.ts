import { D, DB_SCALE, type Dec, round, ZERO } from "@/lib/money/decimal";
import { lotCost } from "@/lib/ledger/rules";

/**
 * FIFO 持倉引擎（純函式，不碰資料庫）。
 *
 * 同一個帳戶＋資產的所有買賣，依時間順序重播一次，得到每個批次的剩餘數量／成本，
 * 以及每筆賣出消耗了哪些批次。持倉批次與賣出分配都是「由交易推導出來」的資料，
 * 所以補登較早日期的交易時，整段重播就能得到一致的結果。
 */

export interface TradeEvent {
  transactionId: string;
  type: "buy" | "sell";
  tradeDate: string; // YYYY-MM-DD
  /** 固定寬度的 UTC 時間字串（YYYY-MM-DDTHH:MM:SS.ffffff），可直接用字串比大小 */
  tradeAt: string | null;
  createdAt: string;
  quantity: Dec;
  gross: Dec;
  fee: Dec;
  tax: Dec;
  otherCost: Dec;
  currency: string;
}

export interface Lot {
  sourceTransactionId: string;
  acquiredDate: string;
  originalQuantity: Dec;
  remainingQuantity: Dec;
  totalCost: Dec;
  remainingCost: Dec;
  costCurrency: string;
}

export interface Disposal {
  sellTransactionId: string;
  lotSourceTransactionId: string;
  quantity: Dec;
  allocatedCost: Dec;
  allocatedProceeds: Dec;
  allocatedFee: Dec;
  allocatedTax: Dec;
  allocatedOtherCost: Dec;
  realizedPnl: Dec;
}

export class InsufficientPositionError extends Error {
  constructor(
    readonly transactionId: string,
    readonly tradeDate: string,
    readonly requested: Dec,
    readonly available: Dec,
  ) {
    super(`${tradeDate} 賣出 ${requested.toFixed()}，但當時可賣數量只有 ${available.toFixed()}`);
    this.name = "InsufficientPositionError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(readonly transactionId: string, readonly expected: string, readonly actual: string) {
    super(`同一資產的買賣幣別不一致：批次是 ${expected}，這筆是 ${actual}`);
    this.name = "CurrencyMismatchError";
  }
}

/**
 * 重播順序：交易日 → 同一天先買後賣 → 成交時間（沒有的排後面）→ 建立時間 → ID。
 * 「同一天先買後賣」只影響可賣數量；FIFO 一律先消耗最早的批次，所以不會改變已實現損益。
 */
export function compareTradeEvents(a: TradeEvent, b: TradeEvent): number {
  if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
  if (a.type !== b.type) return a.type === "buy" ? -1 : 1;
  if (a.tradeAt !== b.tradeAt) {
    if (a.tradeAt === null) return 1;
    if (b.tradeAt === null) return -1;
    return a.tradeAt < b.tradeAt ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.transactionId === b.transactionId) return 0;
  return a.transactionId < b.transactionId ? -1 : 1;
}

/**
 * 把 total 依權重分給各份；前面各份無條件捨去到資料庫小數位，最後一份拿餘數。
 * 加總剛好等於 total，而且每一份都不會是負數（四捨五入的話，餘數可能變成 −0.0000000001）。
 */
export function allocateByWeight(total: Dec, weights: Dec[], weightSum: Dec): Dec[] {
  const out: Dec[] = [];
  let used = ZERO;
  weights.forEach((w, i) => {
    if (i === weights.length - 1) {
      out.push(total.minus(used));
    } else {
      const part = total.times(w).dividedBy(weightSum).toDecimalPlaces(DB_SCALE, D.ROUND_DOWN);
      out.push(part);
      used = used.plus(part);
    }
  });
  return out;
}

export function replayFifo(events: TradeEvent[]): { lots: Lot[]; disposals: Disposal[] } {
  const ordered = [...events].sort(compareTradeEvents);
  const lots: Lot[] = [];
  const disposals: Disposal[] = [];

  for (const ev of ordered) {
    if (ev.type === "buy") {
      const cost = round(lotCost(ev));
      lots.push({
        sourceTransactionId: ev.transactionId,
        acquiredDate: ev.tradeDate,
        originalQuantity: ev.quantity,
        remainingQuantity: ev.quantity,
        totalCost: cost,
        remainingCost: cost,
        costCurrency: ev.currency,
      });
      continue;
    }

    // 賣出：從最早仍有剩餘數量的批次開始消耗
    const open = lots.filter((l) => l.remainingQuantity.greaterThan(0));
    const available = open.reduce((s, l) => s.plus(l.remainingQuantity), ZERO);
    if (available.lessThan(ev.quantity)) {
      throw new InsufficientPositionError(ev.transactionId, ev.tradeDate, ev.quantity, available);
    }

    let toSell = ev.quantity;
    const chunks: { lot: Lot; quantity: Dec; cost: Dec }[] = [];
    for (const lot of open) {
      if (toSell.isZero()) break;
      if (lot.costCurrency !== ev.currency) {
        throw new CurrencyMismatchError(ev.transactionId, lot.costCurrency, ev.currency);
      }
      const take = lot.remainingQuantity.lessThan(toSell) ? lot.remainingQuantity : toSell;
      // 吃光整批就拿走全部剩餘成本；只吃一部分就按比例，避免分批賣出累積誤差
      const cost = take.equals(lot.remainingQuantity)
        ? lot.remainingCost
        : round(lot.remainingCost.times(take).dividedBy(lot.remainingQuantity));
      lot.remainingQuantity = lot.remainingQuantity.minus(take);
      lot.remainingCost = lot.remainingCost.minus(cost);
      chunks.push({ lot, quantity: take, cost });
      toSell = toSell.minus(take);
    }

    // 成交收入與賣出費用依數量比例分配到被消耗的批次
    const weights = chunks.map((c) => c.quantity);
    const proceeds = allocateByWeight(ev.gross, weights, ev.quantity);
    const fees = allocateByWeight(ev.fee, weights, ev.quantity);
    const taxes = allocateByWeight(ev.tax, weights, ev.quantity);
    const others = allocateByWeight(ev.otherCost, weights, ev.quantity);

    chunks.forEach((c, i) => {
      disposals.push({
        sellTransactionId: ev.transactionId,
        lotSourceTransactionId: c.lot.sourceTransactionId,
        quantity: c.quantity,
        allocatedCost: c.cost,
        allocatedProceeds: proceeds[i],
        allocatedFee: fees[i],
        allocatedTax: taxes[i],
        allocatedOtherCost: others[i],
        // 賣出損益 = 賣出總額 − 賣出手續費 − 交易稅 − 其他費用 − 被賣出批次成本
        realizedPnl: proceeds[i].minus(fees[i]).minus(taxes[i]).minus(others[i]).minus(c.cost),
      });
    });
  }

  return { lots, disposals };
}
