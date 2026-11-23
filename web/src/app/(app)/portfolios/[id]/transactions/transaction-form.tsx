"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { MARKETS, marketFor, useAssetSearch } from "../use-asset-search";
import { correctTransactionAction, createTransactionAction, type FormState } from "@/app/actions";
import { formatDecimal } from "@/lib/format";
import { type CostEstimate, describeFee, describeTax, estimateCosts, type FeeSettings, type TaxAsset } from "@/lib/ledger/costs";
import { type Phase1Type, SNAPSHOT_ACCOUNT_TYPES, TRANSACTION_RULES } from "@/lib/ledger/rules";
import { D } from "@/lib/money/decimal";

/** 表單欄位的初始值（更正時帶入原交易的內容） */
export interface TransactionFormValues {
  type: Phase1Type;
  accountId: string;
  tradeDate: string;
  settlementDate: string;
  symbol: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  fee: string;
  tax: string;
  otherCost: string;
  notes: string;
  dayTrade: boolean;
}

interface Props {
  portfolioId: string;
  today: string;
  /** snapshot：快照（快速淨值）帳戶，只能記入金與出金 */
  accounts: { id: string; name: string; currency: string; fees: FeeSettings; snapshot?: boolean }[];
  initial?: Partial<TransactionFormValues>;
  /** 更正這筆交易：送出時沖銷它，再依表單內容新增一筆 */
  correctionOf?: string;
}

const TYPE_GROUPS: { label: string; types: Phase1Type[] }[] = [
  { label: "買賣與轉入", types: ["buy", "sell", "transfer_in"] },
  { label: "資金進出", types: ["deposit", "withdrawal"] },
  { label: "收入", types: ["dividend", "interest"] },
  { label: "費用與退佣", types: ["fee", "tax", "fee_rebate"] },
];

const DECIMAL_RE = /^\d{1,18}(\.\d{1,10})?$/;

export function TransactionForm({ portfolioId, today, accounts, initial = {}, correctionOf }: Props) {
  const submit = correctionOf ? correctTransactionAction.bind(null, portfolioId, correctionOf) : createTransactionAction.bind(null, portfolioId);
  const [state, action, pending] = useActionState<FormState, FormData>(submit, {});
  // 每次打開表單產生一個送出識別碼：重複點擊或網路重送都只會入帳一次
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [accountId, setAccountId] = useState(initial.accountId ?? accounts[0]?.id ?? "");
  const account = accounts.find((a) => a.id === accountId);
  const allowedFor = (a: Props["accounts"][number] | undefined, t: Phase1Type) => !a?.snapshot || SNAPSHOT_ACCOUNT_TYPES.includes(t);
  const [type, setType] = useState<Phase1Type>(() => {
    const wanted = initial.type ?? "buy";
    return allowedFor(accounts.find((a) => a.id === (initial.accountId ?? accounts[0]?.id)), wanted) ? wanted : "deposit";
  });
  // 快照帳戶只顯示入金／出金
  const typeGroups = account?.snapshot ? TYPE_GROUPS.filter((g) => g.types.every((t) => SNAPSHOT_ACCOUNT_TYPES.includes(t))) : TYPE_GROUPS;
  function chooseAccount(id: string) {
    setAccountId(id);
    if (!allowedFor(accounts.find((a) => a.id === id), type)) setType("deposit");
  }
  const market = marketFor(account?.currency);
  const [symbol, setSymbol] = useState(initial.symbol ?? "");
  const [quantity, setQuantity] = useState(initial.quantity ?? "");
  const [unitPrice, setUnitPrice] = useState(initial.unitPrice ?? "");
  const [tradeDate, setTradeDate] = useState(initial.tradeDate ?? today);
  const [dayTrade, setDayTrade] = useState(initial.dayTrade ?? false);
  const [newAssetType, setNewAssetType] = useState("stock");

  const rule = TRANSACTION_RULES[type];
  const search = useAssetSearch(rule.asset === "required" ? market : null, symbol);
  const known = search.hits.find((a) => a.symbol === symbol.trim().toUpperCase());
  const gross = DECIMAL_RE.test(quantity) && DECIMAL_RE.test(unitPrice) ? new D(quantity).times(unitPrice).toFixed() : null;
  const canDayTrade = type === "sell" && market === "TW";

  // 跟伺服器用同一份規則估算，沒填的手續費／證交稅會以這個值入帳
  const taxAsset: TaxAsset | null =
    market && symbol.trim()
      ? known
        ? { market, symbol: known.symbol, assetType: known.assetType, kind: known.kind, bondEtf: known.bondEtf }
        : { market, symbol: symbol.trim().toUpperCase(), assetType: newAssetType }
      : null;
  const estimate: CostEstimate =
    (type === "buy" || type === "sell") && account && taxAsset && gross && !search.loading && !search.error
      ? estimateCosts(account.fees, taxAsset, { type, tradeDate, currency: account.currency, gross: new D(gross), quantity: new D(quantity), dayTrade: canDayTrade && dayTrade })
      : {};
  const err = (field: string) => state.fieldErrors?.[field];
  const invalid = (field: string) => Boolean(err(field));
  const taxLabel = rule.taxKind === "withholding_tax" ? "扣繳稅" : "交易稅";

  // 不用 <form action>：React 會在送出後清空欄位；這裡送出失敗時保留使用者填的內容
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-6 p-5 sm:p-6" noValidate>
      <input type="hidden" name="clientRequestId" value={clientRequestId} />
      {state.error ? (
        <p className="alert" role="alert">
          {state.error}
        </p>
      ) : null}

      <fieldset>
        <legend className="mb-2 text-[12.5px] font-bold">交易類型</legend>
        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
          {typeGroups.map((g) => (
            <div key={g.label}>
              <p className="mb-1 text-[11px] text-ink-3">{g.label}</p>
              <div className="flex gap-2">
                {g.types.map((t) => (
                  <label key={t} className={`btn flex-1 ${type === t ? "btn-ink" : ""}`}>
                    <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="sr-only" />
                    {TRANSACTION_RULES[t].label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        {type === "transfer_in" ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-2">
            開始記帳前就持有、或從別的券商轉進來的股票：填股數與每股平均成本，建立持倉批次，不動現金。之後的賣出依 FIFO 用這個成本算已實現損益；績效以轉入當天的市值當作投入。
          </p>
        ) : null}
        {type === "fee_rebate" ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-2">
            券商退回的手續費（例如每月退佣），填實際入帳的金額。退佣不是外部入金，會算進損益。月退的帳戶，手續費折扣請設成「不打折」，每筆照原價估算，退佣入帳時再記這一筆。
          </p>
        ) : null}
        {account?.snapshot ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-2">
            「{account.name}」是快照帳戶，只記入金與出金（算報酬率要知道投入了多少）；買賣、股息由下一份快照反映。現金以最近一份填了現金的快照為準：快照日當天和之前的入金出金已經含在快照裡，不會再加一次。
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="field sm:col-span-1">
          <span>帳戶</span>
          <select className="input" name="accountId" value={accountId} onChange={(e) => chooseAccount(e.target.value)} aria-invalid={invalid("accountId")}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.currency}
                {a.snapshot ? " · 快照" : ""}）
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>交易日</span>
          <input className="input num" type="date" name="tradeDate" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} max={today} required aria-invalid={invalid("tradeDate")} />
          {err("tradeDate") ? <span className="field-error">{err("tradeDate")}</span> : null}
        </label>
        <label className="field">
          <span>
            交割日<small>選填，現金以此日入帳</small>
          </span>
          <input className="input num" type="date" name="settlementDate" defaultValue={initial.settlementDate} aria-invalid={invalid("settlementDate")} />
          {err("settlementDate") ? <span className="field-error">{err("settlementDate")}</span> : null}
        </label>
      </div>

      {rule.asset === "required" ? (
        <div className="grid gap-4 border-2 border-dashed border-line p-4 sm:grid-cols-[110px_1fr_1.4fr_110px]">
          <div className="field">
            <span>市場</span>
            <input type="hidden" name="market" value={market ?? ""} />
            <p className="input border-dashed bg-cream">{MARKETS.find((m) => m.value === market)?.label ?? "—"}</p>
          </div>
          <label className="field">
            <span>代號</span>
            <input
              className="input num"
              name="symbol"
              list="known-assets"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder={market === "TW" ? "2330 或 台積" : "AAPL 或 Apple"}
              autoComplete="off"
              aria-invalid={invalid("asset.symbol")}
            />
            <datalist id="known-assets">
              {search.hits.map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.name}
                  {a.active ? "" : "（已下市）"}
                </option>
              ))}
            </datalist>
            {err("asset.symbol") ? <span className="field-error">{err("asset.symbol")}</span> : null}
          </label>
          {known ? (
            <div className="field">
              <span>名稱</span>
              <p className="input border-dashed bg-cream">
                {known.name}
                {known.active ? null : <span className="tag tag-warn ml-2">已下市</span>}
              </p>
            </div>
          ) : search.error ? (
            <div className="field sm:col-span-2">
              <span>名稱</span>
              <p className="field-error" role="alert">{search.error} <button type="button" className="underline" onClick={search.retry}>重新查詢</button></p>
            </div>
          ) : search.loading ? (
            <div className="field sm:col-span-2">
              <span>名稱</span>
              <p className="input border-dashed bg-cream text-ink-3">查詢中…</p>
            </div>
          ) : (
            <label className="field">
              <span>
                名稱<small>新代號才需要</small>
              </span>
              <input className="input" name="assetName" maxLength={120} placeholder={market === "TW" ? "台積電" : "Apple"} aria-invalid={invalid("asset.name")} />
              {err("asset.name") ? <span className="field-error">{err("asset.name")}</span> : null}
            </label>
          )}
          {known || search.loading || search.error ? null : (
            <label className="field">
              <span>類別</span>
              <select className="input" name="assetType" value={newAssetType} onChange={(e) => setNewAssetType(e.target.value)} aria-invalid={invalid("asset.assetType")}>
                <option value="stock">股票</option>
                <option value="etf">ETF</option>
              </select>
            </label>
          )}
          <p className="text-xs text-ink-3 sm:col-span-4">
            {market
              ? `市場依帳戶幣別決定：${account?.currency} 帳戶記${MARKETS.find((m) => m.value === market)?.label}。`
              : `${account?.currency} 帳戶目前不能記股票買賣。`}
            {known || search.loading || search.error ? "" : "台股上市櫃與美股的代號都在清單裡；查不到的代號會存成你自己的資產（只有你看得到），之後不必再填名稱。"}
          </p>
        </div>
      ) : null}

      {rule.trade ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="field">
            <span>數量</span>
            <input className="input num" name="quantity" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.trim())} placeholder="100" aria-invalid={invalid("quantity")} />
            {err("quantity") ? <span className="field-error">{err("quantity")}</span> : null}
          </label>
          <label className="field">
            <span>{type === "transfer_in" ? "平均成本（每股）" : "單價"}</span>
            <input className="input num" name="unitPrice" inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value.trim())} placeholder="100" aria-invalid={invalid("unitPrice")} />
            {err("unitPrice") ? <span className="field-error">{err("unitPrice")}</span> : null}
          </label>
          <div className="field">
            <span>{type === "transfer_in" ? "持倉成本" : "成交金額"}</span>
            <p className="input num border-dashed bg-cream">{gross ? formatDecimal(gross, { maxFraction: 4 }) : "—"}</p>
          </div>
        </div>
      ) : (
        <label className="field sm:max-w-[260px]">
          <span>{type === "dividend" || type === "interest" ? "稅前金額" : "金額"}</span>
          <input className="input num" name="amount" inputMode="decimal" placeholder="0" defaultValue={initial.amount} aria-invalid={invalid("amount")} />
          {err("amount") ? <span className="field-error">{err("amount")}</span> : null}
        </label>
      )}

      {rule.allowsCosts ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="field">
            <span>
              手續費<small>{estimate.fee ? "沒填就用估算值" : "選填"}</small>
            </span>
            <input
              className="input num"
              name="fee"
              inputMode="decimal"
              placeholder={estimate.fee ? `估算 ${formatDecimal(estimate.fee.amount)}` : "0"}
              defaultValue={initial.fee}
              aria-invalid={invalid("fee")}
            />
            {err("fee") ? <span className="field-error">{err("fee")}</span> : null}
          </label>
          <label className="field">
            <span>
              {taxLabel}
              <small>{estimate.tax ? "沒填就用估算值" : "選填"}</small>
            </span>
            <input
              className="input num"
              name="tax"
              inputMode="decimal"
              placeholder={estimate.tax ? `估算 ${formatDecimal(estimate.tax.amount)}` : "0"}
              defaultValue={initial.tax}
              aria-invalid={invalid("tax")}
            />
            {err("tax") ? <span className="field-error">{err("tax")}</span> : null}
          </label>
          <label className="field">
            <span>
              其他費用<small>選填</small>
            </span>
            <input className="input num" name="otherCost" inputMode="decimal" placeholder="0" defaultValue={initial.otherCost} aria-invalid={invalid("otherCost")} />
            {err("otherCost") ? <span className="field-error">{err("otherCost")}</span> : null}
          </label>
          {canDayTrade ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" name="dayTrade" checked={dayTrade} onChange={(e) => setDayTrade(e.target.checked)} />
              現股當沖<small className="text-xs text-ink-3">同一天先買後賣（或先賣後買）同一檔股票，證交稅 0.15%</small>
            </label>
          ) : null}
          {rule.trade ? (
            <p className="text-xs leading-relaxed text-ink-3 sm:col-span-3" aria-live="polite">
              {estimate.fee || estimate.tax ? (
                <>
                  沒填會自動估算：
                  {estimate.fee ? `手續費 ${formatDecimal(estimate.fee.amount, { maxFraction: 2 })}（${describeFee(estimate.fee)}）` : ""}
                  {estimate.fee && estimate.tax ? "；" : ""}
                  {estimate.tax ? `證交稅 ${formatDecimal(estimate.tax.amount)}（${describeTax(estimate.tax)}）` : ""}
                  。有對帳單的實際金額就直接填入。
                </>
              ) : account?.fees.feeRate === null ? (
                "這個帳戶沒有開啟自動估算，沒填的費用以 0 計（可到投資組合頁的帳戶「手續費」設定開啟）。"
              ) : null}
            </p>
          ) : null}
          <p className="text-xs text-ink-3 sm:col-span-3">
            {type === "buy"
              ? "買進的手續費與其他費用會計入持倉成本。"
              : type === "sell"
                ? "賣出依 FIFO 先消耗最早的批次；持倉不足會被拒絕，不會形成負持倉。"
                : "現金以稅後淨額入帳。"}
          </p>
        </div>
      ) : null}

      <label className="field">
        <span>
          備註<small>選填，最多 500 字</small>
        </span>
        <input className="input" name="notes" maxLength={500} defaultValue={initial.notes} />
      </label>

      {correctionOf ? (
        <label className="field">
          <span>
            更正原因<small>選填，最多 200 字，會記在稽核紀錄</small>
          </span>
          <input className="input" name="reason" maxLength={200} placeholder="例如：單價打錯" aria-invalid={invalid("reason")} />
          {err("reason") ? <span className="field-error">{err("reason")}</span> : null}
        </label>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-ink pt-5">
        <Link href={correctionOf ? `/portfolios/${portfolioId}/transactions/${correctionOf}` : `/portfolios/${portfolioId}`} className="btn btn-quiet">
          取消
        </Link>
        <button className="btn btn-sun" type="submit" disabled={pending}>
          {correctionOf ? (pending ? "更正中…" : "送出更正") : pending ? "記錄中…" : `記錄${rule.label}`}
        </button>
      </div>
    </form>
  );
}
