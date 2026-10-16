import { formatDecimal, pnlTone } from "@/lib/format";

/** 金額：幣別＋千分位（滑過可看到完整精度） */
export function Amount({ value, currency, maxFraction = 2, signed = false }: { value: string | null; currency?: string; maxFraction?: number; signed?: boolean }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  return (
    <span className="num whitespace-nowrap" title={currency ? `${currency} ${value}` : value}>
      {currency ? <span className="text-ink-3 text-[0.85em] mr-1">{currency}</span> : null}
      {formatDecimal(value, { maxFraction, signed })}
    </span>
  );
}

/** 損益：顏色（台灣慣例紅賺綠虧）＋正負號＋文字，不只靠顏色 */
export function Pnl({ value, currency }: { value: string | null; currency?: string }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  const tone = pnlTone(value);
  const label = tone === "gain" ? "獲利" : tone === "loss" ? "虧損" : "持平";
  return (
    <span className={`num whitespace-nowrap ${tone === "flat" ? "" : tone}`} title={`${label} ${currency ?? ""} ${value}`.trim()}>
      {currency ? <span className="opacity-70 text-[0.85em] mr-1">{currency}</span> : null}
      {formatDecimal(value, { signed: true })}
      <span className="sr-only">（{label}）</span>
    </span>
  );
}
