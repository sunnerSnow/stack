"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTradeImportAction } from "@/app/actions";
import { formatDecimal } from "@/lib/format";
import { type BrokerTradeFormatError, type BrokerTradeParseResult, parseBrokerTradeStatement, rowProblems, TRADE_CODES, totalsProblems } from "@/lib/imports/broker-trades";
import { PdfPasswordError, readPdfText, sha256Hex } from "@/lib/imports/pdf-reader";

interface Props {
  portfolioId: string;
  accounts: { id: string; name: string }[];
  defaultAccountId?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;

/** 「國泰綜合證券股份有限公司(敦南)」→「國泰證券（敦南）」，新帳戶的預設名稱 */
function shortBrokerName(name: string | null): string {
  const m = name?.match(/^(.+?)(?:綜合)?證券.*?(?:\(([^)]+)\))?$/);
  return m ? `${m[1]}證券${m[2] ? `（${m[2]}）` : ""}` : "券商帳戶";
}

export function TradeImporter({ portfolioId, accounts, defaultAccountId }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer; hash: string } | null>(null);
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<BrokerTradeParseResult | null>(null);
  const [accountId, setAccountId] = useState(defaultAccountId && accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : (accounts[0]?.id ?? "new"));
  const [newName, setNewName] = useState("");
  const [submitting, startSubmit] = useTransition();

  // 跟伺服器用同一份檢查：每一列的算式、頁尾的筆數與合計
  const rowIssues = parsed ? parsed.rows.flatMap((r) => rowProblems(r).map((p) => `${r.date} ${r.code} ${r.name}：${p}`)) : [];
  const fileIssues = parsed ? totalsProblems(parsed.rows, parsed.totals) : [];
  const count = (pred: (code: string) => boolean) => parsed?.rows.filter((r) => pred(r.code)).length ?? 0;

  async function read(bytes: ArrayBuffer, pw?: string) {
    setReading(true);
    setError(null);
    try {
      const result = parseBrokerTradeStatement(await readPdfText(bytes, pw));
      setParsed(result);
      setNeedPassword(false);
      setNewName((name) => name || shortBrokerName(result.header.brokerName));
    } catch (e) {
      setParsed(null);
      if (e instanceof PdfPasswordError) {
        setNeedPassword(true);
        if (e.reason === "incorrect") setError("密碼不對，請再試一次");
      } else if ((e as BrokerTradeFormatError)?.name === "BrokerTradeFormatError") {
        setError((e as Error).message);
      } else {
        setError("讀不到這個 PDF 的內容；請確認是券商的「客戶交易明細表」");
      }
    } finally {
      setReading(false);
    }
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const f = event.target.files?.[0];
    setParsed(null);
    setNeedPassword(false);
    setPassword("");
    setError(null);
    if (!f) return setFile(null);
    if (f.size > MAX_BYTES) return setError("檔案太大（上限 20 MB）");
    const bytes = await f.arrayBuffer();
    setFile({ name: f.name, bytes, hash: await sha256Hex(bytes) });
    await read(bytes);
  }

  function submit() {
    if (!file || !parsed) return;
    startSubmit(async () => {
      const result = await createTradeImportAction(portfolioId, {
        ...(accountId === "new" ? { newAccountName: newName.trim() } : { accountId }),
        fileName: file.name.slice(0, 200),
        fileHash: file.hash,
        header: parsed.header,
        totals: parsed.totals,
        rows: parsed.rows,
      });
      if (result.importId) router.push(`/portfolios/${portfolioId}/imports/trades/${result.importId}`);
      else setError(result.error ?? "匯入失敗，請稍後再試");
    });
  }

  return (
    <div className="grid gap-5 p-5 sm:p-6">
      <label className="field">
        <span>客戶交易明細表 PDF</span>
        <input className="input" type="file" accept="application/pdf,.pdf" onChange={onFile} />
      </label>

      {needPassword && file ? (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void read(file.bytes, password);
          }}
        >
          <label className="field">
            <span>
              PDF 密碼<small>只用來在你的瀏覽器裡打開檔案，不會送出或保存</small>
            </span>
            <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          <button className="btn btn-ink" type="submit" disabled={reading || !password}>
            {reading ? "讀取中…" : "打開"}
          </button>
        </form>
      ) : null}

      {reading && !needPassword ? <p className="text-sm text-ink-2">讀取中…</p> : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {parsed ? (
        <>
          <dl className="grid gap-x-6 gap-y-1 border-2 border-dashed border-line p-4 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">券商</dt>
              <dd className="text-right">{parsed.header.brokerName ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">查詢期間</dt>
              <dd className="num">
                {parsed.header.periodFrom ?? "—"} ～ {parsed.header.periodTo ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">成交</dt>
              <dd>
                <span className="num">{parsed.rows.length}</span> 筆
                <span className="text-ink-3">
                  （買 {count((c) => TRADE_CODES[c]?.side === "buy")}、賣 {count((c) => TRADE_CODES[c]?.side === "sell")}，其中當沖 {count((c) => TRADE_CODES[c]?.dayTrade === true)}）
                </span>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">手續費／交易稅合計</dt>
              <dd className="num">
                {formatDecimal(parsed.totals.fee ?? "0")}／{formatDecimal(parsed.totals.tax ?? "0")}
              </dd>
            </div>
          </dl>

          {fileIssues.length === 0 && rowIssues.length === 0 ? (
            <p className="success">每一列的價金與淨收付都對得上，頁尾的筆數與合計也一致。</p>
          ) : (
            <div className="alert" role="alert">
              {fileIssues.map((m) => (
                <p key={m}>{m}</p>
              ))}
              {rowIssues.slice(0, 10).map((m) => (
                <p key={m}>{m}</p>
              ))}
              {rowIssues.length > 10 ? <p>另外還有 {rowIssues.length - 10} 個問題，送出後在預覽表裡看得到。</p> : null}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span>匯入到哪個帳戶</span>
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                <option value="new">＋ 新建一個逐筆記帳帳戶</option>
              </select>
            </label>
            {accountId === "new" ? (
              <label className="field">
                <span>新帳戶名稱</span>
                <input className="input" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
              </label>
            ) : null}
          </div>
          <p className="text-xs leading-relaxed text-ink-2">
            下一步會先預覽：每一列對到的股票代號、跟之前匯入重複的成交，以及明細期間之前就持有、期間內才賣掉的股票（要補期初持股的平均成本）。確認之前不會入帳。
          </p>
          <div className="flex justify-end">
            <button className="btn btn-sun" type="button" onClick={submit} disabled={submitting || fileIssues.length > 0 || (accountId === "new" && !newName.trim())}>
              {submitting ? "檢查中…" : "下一步：預覽"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
