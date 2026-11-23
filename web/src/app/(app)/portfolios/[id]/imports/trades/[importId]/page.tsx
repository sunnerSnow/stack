import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { formatDecimal } from "@/lib/format";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { getTradeImport, type TradeImportRowStatus } from "@/lib/services/trade-imports";
import { ConfirmTradeImport } from "./confirm-form";

export const metadata: Metadata = { title: "確認匯入成交明細" };

const STATUS: Record<TradeImportRowStatus, { label: string; tag: string }> = {
  valid: { label: "待匯入", tag: "tag" },
  duplicate: { label: "已入帳過", tag: "tag" },
  error: { label: "有問題", tag: "tag tag-warn" },
  imported: { label: "已匯入", tag: "tag tag-sea" },
};

export default async function TradeImportPreviewPage({ params }: PageProps<"/portfolios/[id]/imports/trades/[importId]">) {
  const user = await requireUser();
  const { id, importId } = await params;
  const db = await getDb();
  let portfolio, batch;
  try {
    [portfolio, batch] = await Promise.all([getPortfolio(db, user.id, id), getTradeImport(db, user.id, importId)]);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  if (!(await listAccounts(db, user.id, id)).some((a) => a.id === batch.accountId)) notFound();
  const pending = batch.status === "pending";

  return (
    <div className="mx-auto grid max-w-[1000px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name}
          </Link>
        </p>
        <h1 className="page-title">{pending ? "確認匯入成交明細" : "成交明細匯入紀錄"}</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          {batch.header.brokerName ?? "券商"} · <span className="num">{batch.header.periodFrom ?? "—"}</span> ～ <span className="num">{batch.header.periodTo ?? "—"}</span> · 匯入到「
          {batch.accountName}」
          {batch.confirmedAt ? (
            <>
              {" "}
              · <span className="num">{batch.confirmedAt.slice(0, 10)}</span> 已匯入
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {(["valid", "imported", "duplicate", "error"] as const)
          .filter((s) => batch.counts[s] > 0)
          .map((s) => (
            <span key={s} className={STATUS[s].tag}>
              {STATUS[s].label} {batch.counts[s]} 筆
            </span>
          ))}
      </div>

      {batch.counts.error > 0 ? (
        <p className="alert" role="alert">
          有 {batch.counts.error} 列有問題（見下表的說明），這份明細不能匯入。常見原因是資產主檔找不到股票名稱，或是融資融券等目前不支援的交易。
        </p>
      ) : null}

      {pending && batch.counts.error === 0 ? (
        <section className="panel">
          <ConfirmTradeImport portfolioId={id} importId={batch.id} openings={batch.openings} openingDate={batch.openingDate} toImport={batch.counts.valid} duplicates={batch.counts.duplicate} />
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>成交明細</h2>
          <span className="tag">{batch.rows.length} 筆</span>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>交易日</th>
                <th>類別</th>
                <th>股票</th>
                <th className="r">股數</th>
                <th className="r">單價</th>
                <th className="r">手續費</th>
                <th className="r">交易稅</th>
                <th className="r">淨收付</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {batch.rows.map((r) => (
                <tr key={r.rowNumber}>
                  <td className="num whitespace-nowrap">{r.date}</td>
                  <td className="whitespace-nowrap">{r.code}</td>
                  <td className="whitespace-nowrap">
                    {r.symbol ? <span className="num font-bold">{r.symbol}</span> : null} {r.name}
                  </td>
                  <td className="r num">{formatDecimal(r.quantity)}</td>
                  <td className="r num">{formatDecimal(r.price)}</td>
                  <td className="r num">{formatDecimal(r.fee)}</td>
                  <td className="r num">{formatDecimal(r.tax)}</td>
                  <td className="r num whitespace-nowrap">
                    {formatDecimal(r.net)}
                    <span className="text-xs text-ink-3">（{r.netDirection}）</span>
                  </td>
                  <td>
                    <span className={STATUS[r.status].tag}>{STATUS[r.status].label}</span>
                    {r.problems.length > 0 ? <span className="mt-1 block text-xs text-ink-2">{r.problems.join("；")}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
