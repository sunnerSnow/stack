"use client";

import { useActionState } from "react";
import { createPortfolioAction, type FormState } from "@/app/actions";

export function CreatePortfolioForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createPortfolioAction, {});
  return (
    <form action={action} className="grid gap-4">
      {state.error ? <p className="alert">{state.error}</p> : null}
      <label className="field">
        <span>名稱</span>
        <input className="input" name="name" required maxLength={80} placeholder="例如：台股長期" aria-invalid={Boolean(state.fieldErrors?.name)} />
        {state.fieldErrors?.name ? <span className="field-error">{state.fieldErrors.name}</span> : null}
      </label>
      <label className="field">
        <span>
          報表基準幣別<small>之後的淨值與報酬率以此幣別呈現</small>
        </span>
        <select className="input" name="baseCurrency" defaultValue="TWD">
          <option value="TWD">TWD 新台幣</option>
          <option value="USD">USD 美元</option>
        </select>
      </label>
      <p className="text-xs leading-relaxed text-ink-3">建立後再加帳戶：每個帳戶可以選逐筆記交易，或只更新庫存快照（快速淨值）。</p>
      <button className="btn btn-sun" type="submit" disabled={pending}>
        {pending ? "建立中…" : "建立投資組合"}
      </button>
    </form>
  );
}
