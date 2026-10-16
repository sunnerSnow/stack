"use client";

import { useActionState, useEffect, useRef } from "react";
import { createAccountAction, type FormState } from "@/app/actions";

export function CreateAccountForm({ portfolioId }: { portfolioId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createAccountAction.bind(null, portfolioId), {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.done) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="grid gap-3.5 border-t border-line px-5 pb-5 pt-4">
      {state.error ? <p className="alert">{state.error}</p> : null}
      <label className="field">
        <span>帳戶名稱</span>
        <input className="input" name="name" required maxLength={80} placeholder="例如：元大證券" aria-invalid={Boolean(state.fieldErrors?.name)} />
      </label>
      <label className="field">
        <span>
          券商<small>選填</small>
        </span>
        <input className="input" name="brokerName" maxLength={80} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="field">
          <span>類型</span>
          <select className="input" name="accountType" defaultValue="brokerage">
            <option value="brokerage">券商</option>
            <option value="cash">現金</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label className="field">
          <span>主要幣別</span>
          <select className="input" name="currency" defaultValue="TWD">
            <option value="TWD">TWD</option>
            <option value="USD">USD</option>
          </select>
        </label>
      </div>
      <button className="btn btn-ink" type="submit" disabled={pending}>
        {pending ? "建立中…" : "建立帳戶"}
      </button>
    </form>
  );
}
