import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { BRICK, BrickWall, MiniBrick } from "@/components/bricks";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: { absolute: "STACK — Build Your Financial World" } };

/** 首頁（由 design/landing-stack.html 移植）：積木牆、黃色概念區、海軍藍模組區。畫面上的數字都是示意資料。 */

const DEMO_BRICKS = [
  { label: "現金 TWD", color: BRICK.cash },
  { label: "現金 USD", color: BRICK.cash },
  { label: "0056", color: BRICK.tw },
  { label: "00891", color: BRICK.tw },
  { label: "VOO", color: BRICK.us },
  { label: "AAPL", color: BRICK.us },
  { label: "2603", color: BRICK.tw },
  { label: "2454", color: BRICK.tw },
  { label: "2330", color: BRICK.tw },
];

const TICKER = ["Explore 探索市場", "Build 組合資產", "Discover 發掘觀點", "Snapshot 不用補登歷史", "XIRR / TWR 可解釋", "示意資料 Mock Data"];

const MODULES = [
  {
    n: "01 — Market",
    en: "Explore",
    zh: "探索市場",
    text: "族群輪動、法人買賣超、個股強度、成交量能。每個指標都有資料日期、來源與算法。資金流向是線索，不是訊號。",
    color: BRICK.tw,
    card: "",
    status: "已上線",
  },
  {
    n: "02 — Portfolio",
    en: "Build",
    zh: "組合資產",
    text: "多組合、多帳戶、台股美股、現金與股息。淨值、損益、XIRR、TWR 與基準比較，全部可解釋、可追溯。",
    color: BRICK.cash,
    card: "y",
    status: "已上線",
  },
  {
    n: "03 — Intelligence",
    en: "Discover",
    zh: "發掘觀點",
    text: "把持倉和產業、新聞、技術指標接起來。每個結論都標示資料時間、來源與不確定性，不把資金流入寫成買進訊號。",
    color: BRICK.cream,
    card: "c",
    status: "即將推出",
  },
];

export default async function Home() {
  const user = await getSessionUser();
  const start = user ? { href: "/portfolios", label: "進入我的組合" } : { href: "/login", label: "開始使用" };

  return (
    <div className="flex min-h-full flex-col">
      <nav className="sticky top-0 z-20 flex items-center justify-between border-b-[3px] border-ink bg-cream px-4 py-3.5 sm:px-8">
        <Link href="/" aria-label="STACK 首頁">
          <Brand />
        </Link>
        <div className="hidden gap-7 md:flex">
          <a href="#concept" className="nav-mod">
            Concept
          </a>
          <Link href="/market" className="nav-mod">Explore 探索市場</Link>
          <a href="#modules" className="nav-mod">
            Modules
          </a>
        </div>
        <Link href={start.href} className="btn btn-sun">
          {start.label}
        </Link>
      </nav>

      <header className="grid items-center gap-10 overflow-hidden px-4 py-10 sm:px-8 lg:min-h-[calc(100vh-74px)] lg:grid-cols-[1.15fr_1fr]">
        <div>
          <p className="kicker">STACK — 模組化投資平台</p>
          <h1 className="hero-en mt-4 text-[clamp(40px,6vw,96px)]">
            Build your
            <br />
            financial
            <br />
            <span className="hl-sun">world</span>.
          </h1>
          <p className="mt-6 text-[clamp(22px,2.3vw,30px)] font-black leading-snug tracking-[0.04em]">
            把投資，<em className="bg-ink px-2 not-italic text-sun">一塊一塊</em>拼起來。
          </p>
          <p className="mt-3.5 max-w-[34em] text-[15px] leading-[1.85] text-ink-2">
            <b className="text-ink">投資不必一次看懂全部。</b>從一塊開始，逐步建立自己的全貌：不想補登十年的交易紀錄，只要更新目前庫存和現金，就看得到總淨值；想要精準的 XIRR、TWR，也可以逐筆記錄。
          </p>
          <div className="mt-7 flex flex-wrap gap-3.5">
            <Link href={start.href} className="btn btn-ink">
              {user ? start.label : "放上第一塊"}
            </Link>
            <a href="#modules" className="btn">
              看三個模組
            </a>
          </div>
        </div>
        <div className="relative">
          <BrickWall bricks={DEMO_BRICKS} ghostLabel="＋下一塊" className="h-auto w-full max-h-[560px]" />
          <div className="absolute left-0 top-4 border-2 border-ink bg-paper px-2 py-1 font-mono text-[11.5px] tracking-[0.08em] text-ink-2 shadow-[3px_3px_0_var(--color-ink)]">
            <b className="font-medium text-ink">NT$ 4,862,310</b> 總淨值
          </div>
          <div className="absolute right-0 top-1/4 border-2 border-ink bg-paper px-2 py-1 font-mono text-[11.5px] tracking-[0.08em] text-ink-2 shadow-[3px_3px_0_var(--color-ink)]">
            +11.4% <b className="font-medium text-ink">XIRR</b>
          </div>
          <div className="absolute bottom-2 right-0 border-2 border-dashed border-warn bg-warn-bg px-2 py-1 font-mono text-[11.5px] tracking-[0.08em] text-warn">示意資料</div>
        </div>
      </header>

      <div className="ticker" aria-hidden="true">
        <div className="track">
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      </div>

      <section id="concept" className="border-b-[3px] border-ink bg-sun px-4 py-16 sm:px-8 sm:py-24">
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em]">■ Concept — STACK 的中文</p>
            <p className="font-serif-tc mt-2.5 text-[clamp(140px,24vw,360px)] font-black leading-[0.9] tracking-[-0.04em]">疊</p>
          </div>
          <div>
            <div className="mt-0 border-t-[3px] border-ink pt-4 lg:mt-12">
              <h2 className="flex flex-wrap items-baseline gap-3.5 text-[28px] font-black">
                疊 <small className="font-mono text-xs font-normal tracking-[0.1em]">ㄉㄧㄝˊ · stack</small>
                <span className="border-2 border-ink px-1.5 font-mono text-[10.5px] font-normal">動 / VERB</span>
              </h2>
              <p className="mt-3.5 text-[17px] font-bold">一塊一塊放上去，不用一次蓋完。</p>
              <p className="mt-5 text-[15px] leading-[1.95] text-sun-ink">
                STACK 不要求你補齊每一筆歷史交易。<b className="text-ink">快照模式</b>讓你從今天開始，更新庫存和現金就有總淨值；<b className="text-ink">逐筆模式</b>
                讓想追蹤批次成本和已實現損益的人把每一塊都記清楚，算得出 XIRR、TWR 與基準比較。
              </p>
            </div>
            <div className="mt-14 grid grid-cols-2 border-[3px] border-ink lg:grid-cols-4">
              {[
                ["2", "種追蹤模式：逐筆、快照"],
                ["7", "種績效指標，每一個都附期間與完整度"],
                ["2", "個市場，TWD／USD 雙幣別", "TW+US"],
                ["0", "筆假造的歷史淨值。資料缺就標示缺"],
              ].map(([v, k, tag], i) => (
                <div key={k} className={`px-5 pb-5 pt-6 ${i % 2 === 1 ? "border-l-[3px] border-ink" : ""} ${i >= 2 ? "border-t-[3px] border-ink lg:border-t-0" : ""} ${i === 2 ? "lg:border-l-[3px]" : ""}`}>
                  <div className="font-display text-[clamp(34px,4.6vw,64px)] font-black leading-none tracking-[-0.03em]">
                    {tag ? <small className="mr-1.5 inline-block bg-ink px-1.5 py-0.5 align-top font-mono text-[11px] font-normal tracking-[0.1em] text-sun">{tag}</small> : null}
                    {v}
                  </div>
                  <div className="mt-4 border-t-2 border-ink pt-2 text-[12.5px]">{k}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="modules" className="bg-ink px-4 py-16 text-cream sm:px-8 sm:py-24">
        <h2 className="hero-en text-[clamp(44px,8vw,124px)]">
          Explore<span className="text-sun">.</span>
          <br />
          Build<span className="text-sun">.</span>
          <br />
          Discover<span className="text-sun">.</span>
        </h2>
        <p className="mt-6 max-w-[40em] text-[15px] text-on-navy">三個動詞、三塊積木，拼成同一個全貌：探索市場 × 組合資產 × 發掘觀點。</p>
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {MODULES.map((m) => (
            <article key={m.en} className={`mod-card flex min-h-[300px] flex-col bg-ink ${m.card}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="sh-n">{m.n}</span>
                <span className={`tag ${m.status === "已上線" ? "bg-sun text-ink" : ""}`}>{m.status}</span>
              </div>
              <h3 className="hero-en mt-4 text-[30px]">{m.en}</h3>
              <p className="mt-1 text-lg font-black tracking-[0.06em]">{m.zh}</p>
              <p className="mt-4 flex-1 text-sm leading-[1.9] text-on-navy">{m.text}</p>
              <MiniBrick color={m.color} line={BRICK.cream} className="mt-4 h-11 w-16" />
            </article>
          ))}
        </div>
        <div className="mt-16 grid border-[3px] border-cream lg:grid-cols-2">
          <div className="bg-sun px-6 py-7 text-ink lg:border-r-[3px] lg:border-cream">
            <h3 className="hero-en mb-3 text-[22px]">We do</h3>
            <ul className="grid gap-2 text-sm">
              {["先看整體淨值，再看單一持倉", "匯率缺漏標示不完整，列出缺哪幾天", "每個 AI 結論都能追溯到資料與來源", "示意資料永遠標成示意資料"].map((t) => (
                <li key={t}>■ {t}</li>
              ))}
            </ul>
          </div>
          <div className="border-t-[3px] border-cream px-6 py-7 lg:border-t-0">
            <h3 className="hero-en mb-3 text-[22px]">We don&apos;t</h3>
            <ul className="grid gap-2 text-sm text-on-navy">
              <li>
                ■ 把 <b className="text-cream">0</b> 當成「無法計算」的 XIRR
              </li>
              <li>
                ■ 把空成本當成 <b className="text-cream">0</b>
              </li>
              <li>
                ■ 在沒有行情的日子<b className="text-cream">假造</b>歷史淨值
              </li>
              <li>
                ■ 把資金流入直接寫成<b className="text-cream">買進訊號</b>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t-[3px] border-ink px-4 py-20 text-center sm:px-8 sm:py-28">
        <h2 className="hero-en text-[clamp(36px,7vw,100px)]">
          Start <span className="bg-sun px-2.5">building</span>.
        </h2>
        <p className="mb-9 mt-5 text-xl font-bold">從一塊開始，逐步建立自己的全貌。</p>
        <Link href={start.href} className="btn btn-ink">
          {user ? start.label : "放上第一塊"}
        </Link>
      </section>
      <footer className="flex flex-wrap justify-between gap-2 border-t-[3px] border-ink px-4 py-6 font-mono text-[11.5px] tracking-[0.08em] sm:px-8">
        <span>STACK · Build Your Financial World.</span>
        <span>首頁積木牆與數字為示意資料 · 不構成投資建議</span>
      </footer>
    </div>
  );
}
