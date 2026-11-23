"use client";

import { useState, useTransition } from "react";
import { confirmTradeImportAction, type FormState } from "@/app/actions";
import { formatDecimal } from "@/lib/format";
import type { TradeImportOpeningDto } from "@/lib/services/trade-imports";

interface Props {
  portfolioId: string;
  importId: string;
  openings: TradeImportOpeningDto[];
  openingDate: string;
  toImport: number;
  duplicates: number;
}

const COST_RE = /^\d{1,15}(\.\d{1,6})?$/;

export function ConfirmTradeImport({ portfolioId, importId, openings, openingDate, toImport, duplicates }: Props) {
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [state, setState] = useState<FormState>({});
  const [pending, startTransition] = useTransition();
  const filled = openings.every((o) => COST_RE.test(costs[o.assetId] ?? "") && Number(costs[o.assetId]) > 0);

  function confirm() {
    startTransition(async () => {
      // 成功時伺服器會轉回投資組合頁；回到這裡就是有錯
      const result = await confirmTradeImportAction(portfolioId, importId, { openings: openings.map((o) => ({ assetId: o.assetId, unitCost: costs[o.assetId] ?? "" })) });
      setState(result);
    });
  }

  return (
    <div className="grid gap-5 p-5 sm:p-6">
      {state.error ? (
        <p className="alert" role="alert">
          {state.error}
        </p>
      ) : null}

      {openings.length > 0 ? (
        <div>
          <h2 className="text-sm font-bold">補上期初持股（{openings.length} 檔）</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            這幾檔在明細期間內賣出，但帳戶裡沒有足夠的買進紀錄，表示 <span className="num">{openingDate}</span> 之前就持有。請填當時的每股平均成本（券商 App 的庫存或舊對帳單上查得到），
            會記成一筆「轉入持股」：之後的賣出用這個成本算已實現損益，績效則以那天的市值當作投入。
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>股票</th>
                  <th className="r">期初股數</th>
                  <th className="r">平均成本（每股）</th>
                </tr>
              </thead>
              <tbody>
                {openings.map((o) => {
                  const fieldError = state.fieldErrors?.[`openings.${o.assetId}`];
                  return (
                    <tr key={o.assetId}>
                      <td className="whitespace-nowrap">
                        <span className="num font-bold">{o.symbol}</span> {o.name}
                      </td>
                      <td className="r num">{formatDecimal(o.quantity)}</td>
                      <td className="r">
                        <input
                          className="input num w-32 text-right"
                          inputMode="decimal"
                          aria-label={`${o.symbol} 平均成本`}
                          value={costs[o.assetId] ?? ""}
                          placeholder="例如 52.3"
                          onChange={(e) => setCosts((c) => ({ ...c, [o.assetId]: e.target.value.trim() }))}
                          aria-invalid={Boolean(fieldError)}
                        />
                        {fieldError ? <span className="field-error block">{fieldError}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-2">
        確認後會記下 {toImport} 筆成交{openings.length > 0 ? `與 ${openings.length} 筆期初持股` : ""}
        {duplicates > 0 ? `；${duplicates} 筆之前已經入帳過，會略過` : ""}。手續費與交易稅用明細上的實際金額，當沖賣出會先配同一天的當沖買進。
        明細沒有入金與出金：這個帳戶的現金會隨買賣增減，要算報酬率的話，請另外記下投入的資金。
      </p>
      <div className="flex justify-end">
        <button className="btn btn-sun" type="button" onClick={confirm} disabled={pending || toImport === 0 || !filled}>
          {pending ? "匯入中…" : "確認匯入"}
        </button>
      </div>
    </div>
  );
}
