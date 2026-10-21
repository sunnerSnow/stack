"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTdccImportAction } from "@/app/actions";
import { formatDecimal } from "@/lib/format";
import { PdfPasswordError, readPdfText, sha256Hex } from "@/lib/imports/pdf-reader";
import { type DerivedHoldings, deriveHoldings, parseTdccPassbook, type TdccFormatError, type TdccParseResult } from "@/lib/imports/tdcc";

interface Props {
  portfolioId: string;
  accounts: { id: string; name: string }[];
  defaultAccountId?: string;
}

type Parsed = TdccParseResult & { derived: DerivedHoldings };

const MAX_BYTES = 20 * 1024 * 1024;

export function TdccImporter({ portfolioId, accounts, defaultAccountId }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer; hash: string } | null>(null);
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [accountId, setAccountId] = useState(defaultAccountId && accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : (accounts[0]?.id ?? "new"));
  const [newName, setNewName] = useState("");
  const [submitting, startSubmit] = useTransition();

  async function read(bytes: ArrayBuffer, pw?: string) {
    setReading(true);
    setError(null);
    try {
      const result = parseTdccPassbook(await readPdfText(bytes, pw));
      setParsed({ ...result, derived: deriveHoldings(result.movements) });
      setNeedPassword(false);
      setNewName((name) => name || `${result.header.brokerName ?? "券商"}（集保）`);
    } catch (e) {
      setParsed(null);
      if (e instanceof PdfPasswordError) {
        setNeedPassword(true);
        if (e.reason === "incorrect") setError("密碼不對，請再試一次（e 存摺的密碼通常是身分證字號，英文字母大寫）");
      } else if ((e as TdccFormatError)?.name === "TdccFormatError") {
        setError((e as Error).message);
      } else {
        setError("讀不到這個 PDF 的內容；請確認是 e 存摺匯出的檔案");
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
      const result = await createTdccImportAction(portfolioId, {
        ...(accountId === "new" ? { newAccountName: newName.trim() } : { accountId }),
        fileName: file.name.slice(0, 200),
        fileHash: file.hash,
        header: parsed.header,
        movements: parsed.movements,
      });
      if (result.importId && result.accountId) {
        router.push(`/portfolios/${portfolioId}/accounts/${result.accountId}/snapshot?import=${result.importId}`);
      } else {
        setError(result.error ?? "匯入失敗，請稍後再試");
      }
    });
  }

  const d = parsed?.derived;
  return (
    <div className="grid gap-5 p-5 sm:p-6">
      <label className="field">
        <span>e 存摺 PDF</span>
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

      {parsed && d ? (
        <>
          <dl className="grid gap-x-6 gap-y-1 border-2 border-dashed border-line p-4 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">券商</dt>
              <dd>
                {parsed.header.brokerName ?? "—"}
                {parsed.header.brokerCode ? <span className="num text-ink-3">（{parsed.header.brokerCode}）</span> : null}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">產製時間</dt>
              <dd className="num">{parsed.header.generatedAt?.replace("T", " ") ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">查詢期間</dt>
              <dd className="num">
                {parsed.header.periodFrom ?? "?"} ～ {parsed.header.periodTo ?? "?"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">異動</dt>
              <dd>
                {parsed.movements.length} 筆
                <span className="text-ink-3">
                  （{Object.entries(d.memoCounts)
                    .map(([memo, n]) => `${memo} ${n}`)
                    .join("、")}
                  ）
                </span>
              </dd>
            </div>
          </dl>

          <section>
            <h2 className="text-sm font-bold">推算出目前的持股（{d.holdings.length} 檔）</h2>
            {d.holdings.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">期間內的異動算下來沒有剩下任何持股。</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>代號</th>
                      <th>名稱</th>
                      <th className="r">股數</th>
                      <th className="r">最後異動</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.holdings.map((h) => (
                      <tr key={h.symbol}>
                        <td className="num font-bold">{h.symbol}</td>
                        <td>{h.name}</td>
                        <td className="r num">{formatDecimal(h.quantity, { maxFraction: 0 })}</td>
                        <td className="r num">{h.lastDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="notice">
            <p>
              異動明細只列出查詢期間內<strong>有變動</strong>的股票；兩年內完全沒買賣、一直持有的股票不會出現在這裡，下一步可以手動補上。
              集保沒有成交價與費用，所以成本先留空（顯示「成本未完整」）。
            </p>
            {d.dayTradeOnly.length > 0 ? <p className="mt-1">{d.dayTradeOnly.length} 檔只有當沖（買賣相抵），股數沒有變動，沒有列入。</p> : null}
            {d.issues.map((issue) => (
              <p key={`${issue.kind}:${issue.symbol}`} className="mt-1">
                ⚠ {issue.message}
              </p>
            ))}
            {parsed.warnings.map((w) => (
              <p key={w} className="mt-1">
                ⚠ {w}
              </p>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span>匯入到哪個帳戶</span>
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                <option value="new">＋ 新建一個快照帳戶</option>
              </select>
            </label>
            {accountId === "new" ? (
              <label className="field">
                <span>新帳戶名稱</span>
                <input className="input" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
              </label>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-ink pt-5">
            <button className="btn btn-sun" type="button" onClick={submit} disabled={submitting || (accountId === "new" && !newName.trim())}>
              {submitting ? "處理中…" : "下一步：確認庫存"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
