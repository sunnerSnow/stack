"use client";

import { useActionState } from "react";
import { type FormState, generateResearchAction } from "@/app/actions";

export function GenerateResearchButton({ portfolioId, assetId, disabledReason, hasReport }: { portfolioId: string; assetId: string; disabledReason: string | null; hasReport: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(generateResearchAction.bind(null, portfolioId, assetId), {});
  return (
    <form action={action} className="grid gap-2">
      {state.error ? (
        <p className="alert" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-ink" type="submit" disabled={pending || disabledReason !== null}>
          {pending ? "產生中…" : hasReport ? "重新產生研究摘要" : "產生研究摘要"}
        </button>
        <span className="text-xs text-ink-2" aria-live="polite">
          {pending ? "正在整理資料並請 AI 撰寫，約需 30～90 秒，請不要關閉這個頁面。" : disabledReason}
        </span>
      </div>
    </form>
  );
}
