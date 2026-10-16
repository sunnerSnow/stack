"use client";

import { useActionState } from "react";
import { type FormState, loginSupabaseAction } from "@/app/actions";

export function SupabaseLoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(loginSupabaseAction, {});

  if (state.done) {
    return <p className="success mt-6">註冊成功！請到信箱點確認連結，完成後就能登入。</p>;
  }

  return (
    <form action={action} className="mt-6 grid gap-4">
      {state.error ? <p className="alert">{state.error}</p> : null}
      <label className="field">
        <span>Email</span>
        <input className="input" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(state.fieldErrors?.email)} />
      </label>
      <label className="field">
        <span>
          密碼<small>至少 8 個字元</small>
        </span>
        <input className="input" name="password" type="password" autoComplete="current-password" minLength={8} required aria-invalid={Boolean(state.fieldErrors?.password)} />
      </label>
      <div className="mt-2 flex gap-3">
        <button className="btn btn-ink flex-1" type="submit" name="intent" value="signin" disabled={pending}>
          登入
        </button>
        <button className="btn flex-1" type="submit" name="intent" value="signup" disabled={pending}>
          註冊
        </button>
      </div>
    </form>
  );
}
