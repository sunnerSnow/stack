"use client";

import { useActionState, useState } from "react";
import { type FormState, updateAccountFeesAction } from "@/app/actions";
import type { FeeSettings } from "@/lib/ledger/costs";
import { D } from "@/lib/money/decimal";

export function AccountFeesForm({ portfolioId, accountId, currency, fees }: { portfolioId: string; accountId: string; currency: string; fees: FeeSettings }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateAccountFeesAction.bind(null, portfolioId, accountId), {});
  const [enabled, setEnabled] = useState(fees.feeRate !== null);
  const err = (field: string) => state.fieldErrors?.[field];
  const tw = currency === "TWD";
  // 沒開過估算的帳戶，打開時先帶入常見值（台股法定上限 0.1425%）
  const rate = fees.feeRate !== null ? new D(fees.feeRate).times(100).toFixed() : tw ? "0.1425" : "";
  const discount = new D(fees.feeDiscount).equals(1) ? "" : new D(fees.feeDiscount).times(10).toFixed();

  return (
    <form action={action} className="mt-2 grid gap-3 border-t border-dashed border-line pt-3" noValidate>
      {state.error ? <p className="alert">{state.error}</p> : null}
      {state.done && !state.error ? <p className="success">已更新，之後的交易會用新的設定估算</p> : null}
      <label className="flex items-center gap-2 text-sm font-bold">
        <input type="checkbox" name="enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        沒填費用時自動估算{tw ? "手續費與證交稅" : "手續費"}
      </label>
      {enabled ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="field">
              <span>手續費率（%）</span>
              <input className="input num" name="ratePercent" inputMode="decimal" defaultValue={rate} placeholder={tw ? "0.1425" : "0.25"} aria-invalid={Boolean(err("ratePercent"))} />
              {err("ratePercent") ? <span className="field-error">{err("ratePercent")}</span> : null}
            </label>
            <label className="field">
              <span>
                折扣（折）<small>不打折留空</small>
              </span>
              <input className="input num" name="discount" inputMode="decimal" defaultValue={discount} placeholder="例如 2.8" aria-invalid={Boolean(err("discount"))} />
              {err("discount") ? <span className="field-error">{err("discount")}</span> : null}
            </label>
            <label className="field">
              <span>{tw ? "整股最低" : "每筆最低"}（{currency}）</span>
              <input className="input num" name="min" inputMode="decimal" defaultValue={fees.feeMin === "0" && fees.feeRate === null && tw ? "20" : fees.feeMin} aria-invalid={Boolean(err("min"))} />
              {err("min") ? <span className="field-error">{err("min")}</span> : null}
            </label>
            {tw ? (
              <label className="field">
                <span>
                  零股最低<small>空白＝同整股</small>
                </span>
                <input className="input num" name="minOddLot" inputMode="decimal" defaultValue={fees.feeMinOddLot ?? (fees.feeRate === null ? "1" : "")} aria-invalid={Boolean(err("minOddLot"))} />
                {err("minOddLot") ? <span className="field-error">{err("minOddLot")}</span> : null}
              </label>
            ) : (
              <label className="field">
                <span>
                  每筆上限<small>選填</small>
                </span>
                <input className="input num" name="max" inputMode="decimal" defaultValue={fees.feeMax ?? ""} aria-invalid={Boolean(err("max"))} />
                {err("max") ? <span className="field-error">{err("max")}</span> : null}
              </label>
            )}
          </div>
          <label className="field">
            <span>{tw ? "元以下" : "分以下"}</span>
            <select className="input" name="rounding" defaultValue={fees.feeRounding}>
              <option value="floor">無條件捨去</option>
              <option value="round">四捨五入</option>
            </select>
          </label>
          <p className="text-xs leading-relaxed text-ink-3">
            {tw
              ? "折扣若是月退（成交時收全額、之後退回），這裡請留空不打折。證交稅依法定稅率估算：股票 0.3%、ETF 與 TDR 0.1%、債券 ETF 免徵、現股當沖 0.15%。"
              : "美股沒有證交稅；券商另收的 SEC／交易所規費請記在「其他費用」。"}
            只影響之後新增的交易，已入帳的不會重算。
          </p>
        </>
      ) : null}
      <div className="flex justify-end">
        <button className="btn btn-ink" type="submit" disabled={pending}>
          {pending ? "儲存中…" : "儲存設定"}
        </button>
      </div>
    </form>
  );
}
