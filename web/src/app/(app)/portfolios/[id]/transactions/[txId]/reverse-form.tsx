"use client";

import { startTransition, useActionState, useState } from "react";
import { type FormState, reverseTransactionAction } from "@/app/actions";

export function ReverseForm({ portfolioId, transactionId }: { portfolioId: string; transactionId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(reverseTransactionAction.bind(null, portfolioId, transactionId), {});
  // 重複點擊只會沖銷一次
  const [clientRequestId] = useState(() => crypto.randomUUID());

  // 不用 <form action>：送出失敗時保留填好的原因
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid gap-3" noValidate>
      <input type="hidden" name="clientRequestId" value={clientRequestId} />
      {state.error ? (
        <p className="alert" role="alert">
          {state.error}
        </p>
      ) : null}
      <label className="field">
        <span>
          原因<small>選填，最多 200 字</small>
        </span>
        <input className="input" name="reason" maxLength={200} placeholder="例如：重複記了" aria-invalid={Boolean(state.fieldErrors?.reason)} />
        {state.fieldErrors?.reason ? <span className="field-error">{state.fieldErrors.reason}</span> : null}
      </label>
      <div className="flex justify-end">
        <button className="btn btn-ink" type="submit" disabled={pending}>
          {pending ? "沖銷中…" : "確認沖銷"}
        </button>
      </div>
    </form>
  );
}
