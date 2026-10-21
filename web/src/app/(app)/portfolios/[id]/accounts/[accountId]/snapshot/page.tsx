import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { todayInTaipei } from "@/lib/ledger/input";
import { getImport, type ImportDto } from "@/lib/services/imports";
import { getPortfolio, listAccounts } from "@/lib/services/portfolios";
import { getRecentSnapshots } from "@/lib/services/snapshots";
import { type SnapshotRow, SnapshotForm } from "./snapshot-form";

export const metadata: Metadata = { title: "更新庫存" };

export default async function SnapshotPage({ params, searchParams }: PageProps<"/portfolios/[id]/accounts/[accountId]/snapshot">) {
  const user = await requireUser();
  const { id, accountId } = await params;
  const { import: importId } = await searchParams;
  const db = await getDb();
  let portfolio, accounts;
  try {
    [portfolio, accounts] = await Promise.all([getPortfolio(db, user.id, id), listAccounts(db, user.id, id)]);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const account = accounts.find((a) => a.id === accountId);
  if (!account) notFound();
  if (account.trackingMode !== "snapshot") redirect(`/portfolios/${id}`);

  const { latest } = await getRecentSnapshots(db, user.id, accountId);
  let batch: ImportDto | null = null;
  let importNote: string | null = null;
  if (typeof importId === "string") {
    batch = await getImport(db, user.id, importId).catch(() => null);
    if (!batch || batch.accountId !== accountId) batch = null;
    else if (batch.status !== "pending") {
      importNote = "這次匯入已經確認過了，下面是目前的庫存。";
      batch = null;
    }
  }

  const market = account.currency === "USD" ? "US" : "TW";
  const previous = new Map((latest?.positions ?? []).map((p) => [p.asset.symbol, p]));
  let rows: SnapshotRow[];
  let sold: { symbol: string; name: string; quantity: string }[] = [];
  if (batch) {
    const seen = new Set(batch.derived.seen);
    const fromImport: SnapshotRow[] = batch.derived.holdings.map((h) => {
      const prev = previous.get(h.symbol);
      const known = batch!.derived.known[h.symbol];
      return {
        symbol: h.symbol,
        name: known?.name ?? h.name,
        needsName: !known,
        quantity: h.quantity,
        unitCost: prev?.unitCost ?? "",
        marketPrice: prev?.marketPrice ?? "",
        previousQuantity: prev?.quantity ?? null,
        origin: "import",
      };
    });
    // 上一份快照有、但集保這段期間完全沒有異動的：沿用上次的股數
    const carried: SnapshotRow[] = (latest?.positions ?? [])
      .filter((p) => !seen.has(p.asset.symbol))
      .map((p) => ({
        symbol: p.asset.symbol,
        name: p.asset.name,
        needsName: false,
        quantity: p.quantity,
        unitCost: p.unitCost ?? "",
        marketPrice: p.marketPrice ?? "",
        previousQuantity: p.quantity,
        origin: "carried",
      }));
    rows = [...fromImport, ...carried];
    // 上一份快照有、集保顯示已經賣光的
    sold = (latest?.positions ?? [])
      .filter((p) => seen.has(p.asset.symbol) && !batch!.derived.holdings.some((h) => h.symbol === p.asset.symbol))
      .map((p) => ({ symbol: p.asset.symbol, name: p.asset.name, quantity: p.quantity }));
  } else {
    rows = (latest?.positions ?? []).map((p) => ({
      symbol: p.asset.symbol,
      name: p.asset.name,
      needsName: false,
      quantity: p.quantity,
      unitCost: p.unitCost ?? "",
      marketPrice: p.marketPrice ?? "",
      previousQuantity: p.quantity,
      origin: "previous",
    }));
  }

  return (
    <div className="mx-auto grid max-w-[980px] grid-cols-1 gap-6">
      <div>
        <p className="kicker">
          <Link href={`/portfolios/${id}`} className="hover:underline">
            {portfolio.name} · {account.name}
          </Link>
        </p>
        <h1 className="mt-2 text-[28px] font-black">{batch ? "確認庫存" : "更新庫存"}</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          列出這一天持有的每一檔（沒列出的就是不再持有）與現金。送出後建立一份新的快照，之前的快照都會保留。
          {latest ? `上一份快照：${latest.asOfDate}。` : "這是這個帳戶的第一份快照。"}
        </p>
      </div>
      {importNote ? <p className="notice">{importNote}</p> : null}
      {batch ? (
        <p className="success">
          已讀取 {batch.header.brokerName ?? "集保"} 的 e 存摺（{batch.rowCount} 筆異動，查詢期間 {batch.header.periodFrom ?? "?"} ～ {batch.header.periodTo ?? "?"}）。
          請確認下面的股數，補上集保這段期間沒有異動、但你仍持有的股票。
        </p>
      ) : null}
      <section className="panel">
        <SnapshotForm
          portfolioId={id}
          accountId={accountId}
          market={market}
          currency={account.currency}
          today={todayInTaipei()}
          asOfDate={batch?.header.generatedAt?.slice(0, 10) ?? todayInTaipei()}
          cashBalance={latest?.cashBalance ?? ""}
          previousCash={latest?.cashBalance ?? null}
          importBatchId={batch?.id ?? null}
          rows={rows}
          sold={sold}
        />
      </section>
    </div>
  );
}
