import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { ROTATION } from "@/lib/market/rotation";
import { type GroupLevel, getRotation, getStockScreens } from "@/lib/services/market";
import { RotationView } from "./rotation-view";

export const metadata: Metadata = { title: "族群輪動" };

const LEVELS = new Set<GroupLevel>(["theme", "industry", "sector"]);

export default async function MarketPage({ searchParams }: PageProps<"/market">) {
  const user = await requireUser();
  const { level: raw } = await searchParams;
  const level: GroupLevel = typeof raw === "string" && LEVELS.has(raw as GroupLevel) ? (raw as GroupLevel) : "theme";
  const db = await getDb();
  const [data, screens] = await Promise.all([getRotation(db, user.id, { level }), getStockScreens(db, user.id)]);

  return (
    <div className="grid grid-cols-1 gap-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="kicker">Explore — 探索市場</p>
          <h1 className="page-title">族群輪動</h1>
          <p className="mt-3 max-w-[44em] text-[15px] leading-relaxed text-ink-2">
            上市櫃的族群、產業與板塊，每天收盤後更新。積木牆一眼看出今天錢往哪裡去、哪裡漲哪裡跌；輪動象限看每個族群走到「領先、轉弱、落後、改善」哪個階段。資金流向是線索，不是買賣訊號。
          </p>
        </div>
        <p className="font-mono text-xs leading-relaxed text-ink-2">
          資料日 <b className="text-ink">{data.date ?? "—"}</b>
          <br />
          證交所、櫃買中心收盤後資料 · 計算版本 {ROTATION.version}
        </p>
      </div>

      {data.date === null ? (
        <p className="notice">還沒有算好的資料：每天收盤後（台北 18:00）的排程會抓上市櫃行情與法人，累積 65 個交易日後才算得出強度與動能。</p>
      ) : (
        <RotationView data={data} level={level} screens={screens} />
      )}

      <details className="panel">
        <summary className="cursor-pointer list-none px-5 py-4 font-bold">怎麼算的</summary>
        <div className="grid gap-2 border-t-[3px] border-ink px-5 py-4 text-sm leading-relaxed text-ink-2">
          <p>
            <b className="text-ink">還原報酬：</b>每天收盤價 ÷ 參考價 − 1。參考價平常是前一天收盤，除權息那天用交易所公布的除權息參考價，所以配息不會被當成下跌。單日漲跌超過 50%（多半是減資或分割）視為資料中斷，之後重新累積。
          </p>
          <p>
            <b className="text-ink">強度：</b>還原指數 ÷ 台灣加權報酬指數（兩邊都含息）得到相對強弱 RS；強度 = 100 × RS 的 10 日平均 ÷ RS 的 60 日平均。大於 100 表示最近兩週比近三個月平均更強。
          </p>
          <p>
            <b className="text-ink">動能：</b>100 × 今天的強度 ÷ 5 個交易日前的強度。大於 100 表示強度正在上升。強度與動能都大於 100 是「領先」；強度大、動能小是「轉弱」；都小是「落後」；強度小、動能大是「改善」。
          </p>
          <p>
            <b className="text-ink">族群：</b>成員每天還原報酬的平均（等權重），再用同樣方法算強度與動能。族群清單是整理過的草稿；產業取自證交所的產業別。法人金額＝每天買賣超股數 × 收盤價。至少要 65 個交易日的資料才有座標，不足的標「暖機中」，不補造。
          </p>
        </div>
      </details>
    </div>
  );
}
