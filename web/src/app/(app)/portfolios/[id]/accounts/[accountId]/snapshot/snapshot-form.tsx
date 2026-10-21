"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { createSnapshotAction, type FormState } from "@/app/actions";
import { formatDecimal } from "@/lib/format";
import { D, type Dec } from "@/lib/money/decimal";
import { type Market, useAssetSearch } from "../../../use-asset-search";

export interface SnapshotRow {
  symbol: string;
  name: string;
  /** 主檔沒有這個代號：要填名稱與類別（會存成私人資產） */
  needsName: boolean;
  quantity: string;
  unitCost: string;
  marketPrice: string;
  previousQuantity: string | null;
  /** import：集保推算；carried：集保期間沒異動、沿用上次；previous：上一份快照；manual：自己新增 */
  origin: "import" | "carried" | "previous" | "manual";
}

interface Props {
  portfolioId: string;
  accountId: string;
  market: Market;
  currency: string;
  today: string;
  asOfDate: string;
  cashBalance: string;
  previousCash: string | null;
  importBatchId: string | null;
  rows: SnapshotRow[];
  sold: { symbol: string; name: string; quantity: string }[];
}

type EditableRow = SnapshotRow & { key: string; assetType: "stock" | "etf" };

const DECIMAL_RE = /^\d{1,18}(\.\d{1,10})?$/;
const ORIGIN_LABEL: Record<SnapshotRow["origin"], string | null> = { import: "集保", carried: "沿用上次", previous: null, manual: "新增" };

export function SnapshotForm(props: Props) {
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<EditableRow[]>(() => props.rows.map((r, i) => ({ ...r, key: `r${i}`, assetType: "stock" })));
  const [asOfDate, setAsOfDate] = useState(props.asOfDate);
  const [cash, setCash] = useState(props.cashBalance);
  const [notes, setNotes] = useState("");
  const [state, setState] = useState<FormState>({});
  const [pending, startTransition] = useTransition();

  const update = (key: string, patch: Partial<EditableRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));
  const add = () =>
    setRows((rs) => [
      ...rs,
      { key: `n${Date.now()}`, symbol: "", name: "", needsName: false, quantity: "", unitCost: "", marketPrice: "", previousQuantity: null, origin: "manual", assetType: "stock" },
    ]);

  // 欄位錯誤是 positions.<第幾列>.<欄位>
  const rowError = (index: number) =>
    Object.entries(state.fieldErrors ?? {})
      .filter(([field]) => field.startsWith(`positions.${index}.`))
      .map(([, message]) => message)
      .join("；");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      clientRequestId,
      accountId: props.accountId,
      asOfDate,
      cashBalance: cash.trim(),
      notes: notes.trim(),
      importBatchId: props.importBatchId ?? undefined,
      // 有填名稱就一起送：主檔查得到的代號伺服器會忽略名稱，查不到的才用它建立私人資產
      positions: rows.map((r) => ({
        asset: {
          market: props.market,
          symbol: r.symbol.trim().toUpperCase(),
          ...(r.needsName || (r.origin === "manual" && r.name.trim()) ? { name: r.name.trim(), assetType: r.assetType } : {}),
        },
        quantity: r.quantity.trim(),
        unitCost: r.unitCost.trim(),
        marketPrice: r.marketPrice.trim(),
      })),
    };
    startTransition(async () => setState(await createSnapshotAction(props.portfolioId, payload)));
  }

  const totalCost = rows.reduce<Dec | null>((sum, r) => {
    if (sum === null || !DECIMAL_RE.test(r.quantity) || !DECIMAL_RE.test(r.unitCost)) return null;
    return sum.plus(new D(r.quantity).times(r.unitCost));
  }, new D(0));

  return (
    <form onSubmit={submit} className="grid gap-5 p-5 sm:p-6" noValidate>
      {state.error ? (
        <p className="alert" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="field">
          <span>基準日</span>
          <input className="input num" type="date" value={asOfDate} max={props.today} onChange={(e) => setAsOfDate(e.target.value)} aria-invalid={Boolean(state.fieldErrors?.asOfDate)} />
          {state.fieldErrors?.asOfDate ? <span className="field-error">{state.fieldErrors.asOfDate}</span> : null}
        </label>
        <label className="field">
          <span>
            現金（{props.currency}）<small>{props.previousCash !== null ? `上次 ${formatDecimal(props.previousCash)}` : "選填"}</small>
          </span>
          <input className="input num" inputMode="decimal" value={cash} placeholder="不填就標示現金未提供" onChange={(e) => setCash(e.target.value)} aria-invalid={Boolean(state.fieldErrors?.cashBalance)} />
          {state.fieldErrors?.cashBalance ? <span className="field-error">{state.fieldErrors.cashBalance}</span> : null}
        </label>
        <label className="field">
          <span>
            備註<small>選填</small>
          </span>
          <input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>代號</th>
              <th>名稱</th>
              <th className="r">股數</th>
              <th className="r">平均成本</th>
              <th className="r">價格</th>
              <th className="r">與上次相比</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-sm text-ink-2">
                  沒有任何持股。按下方「＋ 新增一檔」加入，或只填現金。
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => (
              <Row key={r.key} row={r} market={props.market} error={rowError(i)} onChange={(patch) => update(r.key, patch)} onRemove={() => remove(r.key)} />
            ))}
          </tbody>
        </table>
      </div>

      {props.sold.length > 0 ? (
        <p className="notice">
          集保顯示這段期間已經賣光，所以沒有列入：{props.sold.map((s) => `${s.symbol} ${s.name}（上次 ${formatDecimal(s.quantity, { maxFraction: 4 })}）`).join("、")}。
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="btn" type="button" onClick={add}>
          ＋ 新增一檔
        </button>
        <p className="text-xs text-ink-3">
          平均成本與價格都可以不填：沒有成本會顯示「成本未完整」，不會當成 0。
          {totalCost ? ` 已填成本合計 ${formatDecimal(totalCost.toFixed())} ${props.currency}。` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-ink pt-5">
        <Link href={`/portfolios/${props.portfolioId}`} className="btn btn-quiet">
          取消
        </Link>
        <button className="btn btn-sun" type="submit" disabled={pending}>
          {pending ? "儲存中…" : "建立快照"}
        </button>
      </div>
    </form>
  );
}

function Row({ row, market, error, onChange, onRemove }: { row: EditableRow; market: Market; error: string; onChange: (patch: Partial<EditableRow>) => void; onRemove: () => void }) {
  const editableSymbol = row.origin === "manual";
  const search = useAssetSearch(editableSymbol ? market : null, row.symbol);
  const known = editableSymbol ? search.exact : null;
  const needsName = editableSymbol ? Boolean(row.symbol.trim()) && !search.loading && !known : row.needsName;
  const diff =
    row.previousQuantity !== null && DECIMAL_RE.test(row.quantity) ? new D(row.quantity).minus(row.previousQuantity) : row.previousQuantity === null ? null : undefined;
  const label = ORIGIN_LABEL[row.origin];

  return (
    <>
      <tr>
        <td className="whitespace-nowrap">
          {editableSymbol ? (
            <>
              <input
                className="input num w-28"
                value={row.symbol}
                list={`hits-${row.key}`}
                placeholder={market === "TW" ? "2330" : "AAPL"}
                onChange={(e) => onChange({ symbol: e.target.value })}
                aria-label="代號"
              />
              <datalist id={`hits-${row.key}`}>
                {search.hits.map((h) => (
                  <option key={h.symbol} value={h.symbol}>
                    {h.name}
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <span className="num font-bold">{row.symbol}</span>
          )}
          {label ? <span className="tag ml-2">{label}</span> : null}
        </td>
        <td className="min-w-[140px]">
          {needsName ? (
            <span className="flex gap-1">
              <input className="input w-32" value={row.name} placeholder="名稱" maxLength={120} onChange={(e) => onChange({ name: e.target.value })} aria-label="名稱" />
              <select className="input w-20" value={row.assetType} onChange={(e) => onChange({ assetType: e.target.value as "stock" | "etf" })} aria-label="類別">
                <option value="stock">股票</option>
                <option value="etf">ETF</option>
              </select>
            </span>
          ) : (
            <span className="text-ink-2">{known?.name ?? row.name}</span>
          )}
        </td>
        <td className="r">
          <input className="input num w-28 text-right" inputMode="decimal" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} aria-label="股數" />
        </td>
        <td className="r">
          <input className="input num w-28 text-right" inputMode="decimal" value={row.unitCost} placeholder="未完整" onChange={(e) => onChange({ unitCost: e.target.value })} aria-label="平均成本" />
        </td>
        <td className="r">
          <input className="input num w-24 text-right" inputMode="decimal" value={row.marketPrice} placeholder="—" onChange={(e) => onChange({ marketPrice: e.target.value })} aria-label="價格" />
        </td>
        <td className="r num whitespace-nowrap">
          {diff === null ? <span className="text-ink-3">新的一檔</span> : diff === undefined ? "—" : diff.isZero() ? <span className="text-ink-3">不變</span> : `${diff.isPositive() ? "+" : "−"}${formatDecimal(diff.abs().toFixed(), { maxFraction: 4 })}`}
        </td>
        <td className="r">
          <button type="button" className="text-xs font-bold hover:underline" onClick={onRemove}>
            移除
          </button>
        </td>
      </tr>
      {error ? (
        <tr>
          <td colSpan={7} className="field-error">
            {error}
          </td>
        </tr>
      ) : null}
    </>
  );
}
