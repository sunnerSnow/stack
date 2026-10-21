# STACK web

STACK 是把市場分析、個人資產與 AI 研究放在一起的投資平台。產品規格在上一層的 `spec.md`，設計稿在 `../design/`。

目前完成的是規格第 16 節的 **Phase 1：基礎帳本**：投資組合、帳戶、資產、手動交易、現金帳本、FIFO 持倉批次與賣出分配，以及對應的 API、基本畫面與測試。另外補上了交易的**沖銷與更正**（含稽核紀錄）、手續費與證交稅估算、每日同步的台美股資產主檔，以及 **Phase 2 的庫存快照（快速淨值）與集保 e 存摺匯入**。

技術：Next.js 16.4（App Router）＋ TypeScript ＋ Tailwind 4 ＋ Drizzle ORM ＋ PostgreSQL（正式環境用 Supabase，本機與測試用 PGlite）＋ Vitest。

## 快速開始（本機示範模式，不需要 Supabase）

```bash
npm install
npm run dev          # http://localhost:3000
```

`.env.local` 沒有設定任何資料庫時就是**本機示範模式**：

- 資料存在 `web/.data/pglite`（已在 .gitignore），啟動時自動跑 migration。
- 登入頁可以選「示範使用者 A／B」，兩位的資料互相看不到，可以用來確認權限隔離。
- 想清空就停掉 dev server，刪掉 `web/.data/`。
- 頁面最上方會有黃色提示列，避免跟正式資料搞混。

## 接上 Supabase（正式環境）

1. 建立 Supabase 專案。
2. 到 **SQL Editor** 依檔名順序貼上並執行 `supabase/migrations/` 裡的每一份（都可重複執行）：
   1. `20261016000000_phase1_ledger.sql`
   2. `20261019000000_reversals.sql`（沖銷、更正與稽核紀錄）
   3. `20261021000000_cost_estimates.sql`（帳戶手續費設定、交易的估算紀錄與當沖標記）
   4. `20261022000000_snapshots_imports.sql`（庫存快照、匯入批次與每一列）
   5. `20261023000000_prices_fx_valuations.sql`（收盤價、匯率、每日淨值快照）
   6. `20261024000000_price_backfill.sql`（歷史收盤價回補的來源）
   7. `20261025000000_benchmarks.sql`（比較基準的定義、每日值、每個投資組合選的基準）
   8. `20261026000000_market_rotation.sql`（族群輪動：上市櫃每日行情與法人、除權息參考價、族群與成員、強度與動能）

   - 重跑前面某一份之後，要把後面的也依序重跑：第一份會先收回 `stack` 裡所有表的權限，再只補回它自己建的表。
   - **不要**執行 `supabase/local/auth_stub.sql`，那是給本機 PGlite 模擬 Supabase 用的。
   - 跑完用下面這段確認權限：應該只有 `authenticated`，而且 `transactions`、`cash_ledger`、`audit_log` 只有 SELECT 與 INSERT。
     ```sql
     select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type)
     from information_schema.role_table_grants where table_schema = 'stack'
     group by 1, 2 order by 2, 1;
     ```
3. 在 `.env.local`（以及 Vercel 的環境變數）設定三個值，格式見 `.env.example`：
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（舊專案可用 `NEXT_PUBLIC_SUPABASE_ANON_KEY`）
   - `DATABASE_URL`：Supabase「Connect」裡的 **Transaction pooler**（port 6543）連線字串
   - Vercel 另外要設 `CRON_SECRET`（至少 16 個隨機字元），每天同步資產主檔與行情的排程會帶著它呼叫 `/api/cron/sync-assets`、`/api/cron/sync-prices`
   - 選填 `FINMIND_TOKEN`：FinMind 的免費金鑰（美股與匯率）；不設也能用，只是每小時的次數比較少
4. Authentication → URL Configuration（`https://supabase.com/dashboard/project/<ref>/auth/url-configuration`）把 Site URL 設成網站網址，並把 `https://<網址>/auth/callback` 加進 Redirect URLs（註冊確認信會回到這裡）。
5. Supabase 內建寄信每小時只能寄很少封、而且只寄給組織成員；開放給別人註冊前要設定自訂 SMTP。

三個變數**只設一半會直接報錯**，正式環境（`NODE_ENV=production`）沒設也會報錯，不會默默改用本機資料庫。

`vercel.json` 把函式固定在新加坡（`sin1`），跟 Supabase 專案（`ap-southeast-1`）同一區；換資料庫地區時要一起改，否則每次查詢都要跨區。同一個檔案也設定了兩個每日排程（Hobby 方案會在指定的那一小時內任意時間執行）：UTC 22 點（台北 6 點）同步資產主檔、UTC 8:30（台北 16:30～17:30，台股收盤資料已公布）同步行情、回補歷史價格並記每日淨值快照。要立刻同步，可以自己帶密鑰呼叫（行情換成 `/api/cron/sync-prices`）：

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<網址>/api/cron/sync-assets
```

本機示範模式也能用同一個端點把清單同步進 PGlite（啟動前設 `CRON_SECRET`）。

## 指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 開發伺服器 |
| `npm test` | Vitest：單元測試＋在記憶體內 PGlite 上跑的整合測試（含 RLS）。PGlite 一次只跑一個交易，真正的並行競爭要在 Supabase 上驗證 |
| `npm run typecheck` | 產生路由型別並執行 `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | 正式建置 |

## 架構

```
supabase/migrations/   SQL migration（schema、約束、RLS、權限的唯一來源）
supabase/local/        本機 PGlite 用的 auth 模擬（auth.users、auth.uid()、authenticated 角色）
src/lib/money/         十進位運算（decimal.js）；不經過 JavaScript number
src/lib/ledger/        交易類型規則、FIFO 引擎（純函式）、輸入驗證
src/lib/assets/        資產主檔的資料來源解析（純函式）與每日同步
src/lib/imports/       集保 e 存摺 PDF 解析（純函式）與瀏覽器端的 pdf.js 讀取
src/lib/services/      投資組合／帳戶／資產／交易／持倉服務（所有財務邏輯都在這裡，不在 React 元件裡）
src/lib/db/            Drizzle schema、連線、withUser（以使用者身分執行資料庫交易）
src/lib/auth/          Supabase session、本機示範使用者
src/app/api/           Route Handlers（回應格式 { data, meta, errors }）
src/app/(app)/         登入後的頁面
src/proxy.ts           更新 Supabase session、未登入導向 /login（只是樂觀檢查）
tests/                 Vitest
```

### 重要設計

- **資料表放在 `stack` schema，不在 `public`。** Supabase 的 Data API 只公開 `public`，所以前端拿 anon key 也碰不到帳本；所有寫入都經過伺服器的交易服務。
- **兩道權限防線。** 服務層每個查詢都帶 `user_id` 條件；另外 `withUser` 在資料庫交易內 `set local role authenticated` 並帶入使用者 ID，RLS（`user_id = auth.uid()`）會再擋一次。每張子表都用 `(父表 id, user_id)` 複合外鍵，資料庫保證資料不會掛到別人的帳戶下。
- **原始紀錄只能新增。** `transactions`、`cash_ledger`、`audit_log` 沒有 update／delete 權限，另有 trigger 擋下任何角色的改寫（包括在 SQL Editor 裡）。刪除只在同一個交易內 `set local stack.allow_purge = 'on'` 時允許，留給之後的「刪除我的資料」流程。
- **記錯了用沖銷與更正。**
  - **沖銷**：新增一筆內容相同的沖銷交易（`reversal_of_id` 指向原交易），現金帳本以原交易的入帳日記一筆反向金額，持倉重播時原交易與沖銷交易成對排除。
  - **更正**：在同一個資料庫交易內「沖銷原交易＋依新內容新增一筆」，最後才重建 FIFO。所以把買進數量改少時，只要之後的賣出仍然夠賣，就不會被「先沖銷」的中間狀態擋下。新交易可以換類型、資產或帳戶（同一個投資組合內）。
  - 每次沖銷或更正都在 `audit_log` 留一筆稽核紀錄：原交易、沖銷交易、更正後的新交易、原因、因此重算了幾筆其他賣出。
  - 資料庫保證：一筆交易只能被沖銷一次（唯一索引）、沖銷交易不能再被沖銷、沖銷交易的內容必須與原交易相同（trigger）。
  - 沖銷買進後，如果之後的賣出會變成持倉不足，整筆拒絕，並指出是哪一筆賣出。
  - 原交易與沖銷交易都留在交易列表（淡化顯示、標「已沖銷」或「已更正」），組合的交易筆數只算有效的交易。
- **資產主檔分成共用與私人。** `created_by` 為空的是共用主檔；使用者自己新增的代號只有本人看得到，名稱與類別不會影響別人，也不會洩漏誰持有冷門代號。
  - **共用主檔每天同步**（`src/lib/assets/`）：台股取自證交所「證券編碼查詢」（上市＋上櫃的股票、特別股、TDR、ETF，約 2,350 檔；不含權證與債券），美股取自 Nasdaq Trader 代號表（Nasdaq、NYSE、NYSE American、NYSE Arca、Cboe、IEX，約 1.2 萬檔；排除測試代號、權證、單位、認股權與含 `$` 的特別股代號）。只有代號、名稱、交易所與類別，沒有股價。
  - 細分類記在 `metadata.kind`（stock／preferred／tdr／etf），台股代號以 B 結尾的 ETF 標 `metadata.bondEtf`，之後算證交稅會用到。
  - 來源裡消失的代號標成 `is_active = false`（下市），不刪除，舊交易仍指向它；某個來源抓取失敗，或筆數比目前有效筆數少 20% 以上時，那個來源不做下市標記。
  - 同一個代號如果使用者早就存成私人資產，之後一律沿用私人的那筆（搜尋也只顯示它），持倉才不會被拆成兩個資產。
  - 交易表單輸入代號或名稱時即時查詢（`/api/assets`），不再一次載入整份清單。
- **持倉批次是衍生資料。** 每次新增買賣，會把同一帳戶＋資產的所有買賣依時間重播一次，重建 `position_lots` 與 `lot_disposals`。補登較早日期的交易也會得到一致的 FIFO 結果，畫面會告訴你重新計算了幾筆既有賣出；如果補登會讓任何時點的持倉變負，整筆拒絕。
- **手續費與證交稅估算**（`src/lib/ledger/costs.ts`，伺服器入帳與表單即時顯示共用同一份）：
  - 只在使用者**沒填**、而且帳戶開了自動估算時使用；有填（包括填 0）一律用實際金額。估算的金額與依據存在 `transactions.cost_estimate`，畫面標「估算」，明細頁附法源連結。
  - 手續費依帳戶設定：成交金額 × 費率 × 折扣，捨入到幣別最小單位（台幣元、美元分；可選無條件捨去或四捨五入），再套最低手續費（台股不是 1,000 股整數倍的算零股，可另設最低）與上限。月退的折扣請設成不打折。
  - 證交稅只有台股賣出，元以下捨去，規則表 `TW_TAX_RULES` 依交易日選用：股票與特別股 0.3%、ETF 與 TDR 0.1%（證交稅條例 §2、財政部函釋）、債券 ETF 至 2026-12-31 免徵（§2-1；代號 B 結尾，槓桿 L／反向 R 不適用）、股票現股當沖 0.15% 至 2027-12-31（§2-2，表單勾選「現股當沖」）。期限到了沒延長就自動回到一般稅率；修法延長時改規則表的日期。
  - 新建的台幣券商帳戶預設開啟估算（0.1425%、不打折、整股最低 20、零股最低 1）；美元與現金帳戶預設不估算。改設定只影響之後的交易。
  - 美股的 SEC／交易所規費沒有估算，請記在「其他費用」。
- **行情、匯率與估值**（`src/lib/market/`、`src/lib/valuation/`、`src/lib/services/valuations.ts`）：
  - 收盤價：台股上市取證交所 OpenAPI（STOCK_DAY_ALL）、上櫃取櫃買中心 OpenAPI；美股取 FinMind（代號的 `.` 換成 `-`）。只抓**現在有人持有**的共用資產，資料庫才不會每年長幾十 MB；已經有的那天價格不覆寫。
  - 匯率：FinMind 的臺灣銀行牌告，取即期買入與賣出的中價；方向固定為 `1 base = rate quote`（USD/TWD = 32.6）。臺銀官網有機器人驗證，不能直接抓。
  - 估值用估值日當天或之前最近的收盤價並標示價格日期（台股休市、美股有交易時日期各自標示），超過 7 天標「過期」。缺價格的持股不計入市值、缺匯率的幣別不換算（絕不用 1），總淨值標「不完整」並列出缺什麼；沒有成本的持股不算未實現損益。
  - 快照帳戶一樣估值：有價格就有市值，即使成本未完整。
  - 每天收盤後替每個投資組合記一筆 `portfolio_valuations`（只能新增；同一天同一個 `calculation_version` 只記一次，不無聲覆寫）。已實現、股息與費用以估值日匯率換算成基準幣別。
- **績效**（`src/lib/performance/returns.ts`、`src/lib/services/performance.ts`，規格第 7 節）：
  - 只算**逐筆記帳的帳戶**：快照帳戶沒有入金／出金紀錄，持股數變了分不出是賺的還是新投入的，所以不計入（畫面會說明）。
  - 從第一筆交易起逐日重建淨值：持股與現金都以**成交日**計（用交割日的話，成交到交割之間股票與現金會重複計算）；每天用當天或之前最近的收盤價與匯率。歷史價格由每日排程從 FinMind 回補（逐筆帳戶交易過的共用資產，含已賣掉的；一次最多 40 檔，補過的起點記在 `assets.metadata.priceBackfillFrom`）。
  - 外部現金流只有入金與出金（股息、買賣不是），以發生日匯率換算（交易上有記匯率就用那個）。
  - **TWR**：入金／出金視為當天開盤前發生，`r = V_今天 ÷ (V_昨天 + 當天現金流) − 1` 逐日連乘；期間滿一年才另外年化。視為開盤前，第一天的報酬（收盤淨值 ÷ 入金）才算得到。
  - **XIRR**：入金為負、出金為正、期末淨值為正；掃 −99.99%～+10,000% 找變號區間，只有一個才用二分法求解。
  - **簡單報酬率** = 整體損益 ÷ 淨投入（淨投入不是正數就「不適用」）。**整體投資損益** = 期末淨值 − 淨投入。
  - 損益拆解：已實現、未實現、股息利息、單獨記的費用稅費以發生日匯率換算，未實現用今天的價格與匯率；**匯率影響（估算）** = 整體損益減去前述各項的差額（全部是基準幣別時恆為 0，不顯示）。
  - 算不出來（沒有入金、淨值為負、沒投入資金卻有淨值、缺價格或匯率、XIRR 無解或多重解）一律顯示「無法計算」與原因，不回 0；現金為負的日子另外提醒（入金被低估，報酬率可能失真）。
- **基準比較與走勢圖**（`src/lib/performance/periods.ts`、`src/lib/market/benchmarks.ts`、`src/lib/services/benchmarks.ts`，規格 7.5）：
  - 可選的基準：台灣加權報酬指數（含息，台幣組合預設）、台灣加權指數（不含息）、VOO 含息（調整後收盤價，美元組合預設）、VOO 不含息。**價格報酬與總報酬一律標示**，不混用。0050 有 2025 年 1 拆 4，未調整的收盤價會失真，所以不列入（等公司行動做好再加）。
  - 每天的排程從 FinMind 抓基準值：往後從已有的最後一天抓到今天，往前補到最早一筆交易的前 10 天（補過的起點記在 `backfilled_from`）。VOO 的調整後收盤價每次配息都會整串往回改，所以只用同一次抓到的資料算日報酬、接在已存的值上；銜接日不在資料裡就回報錯誤，不硬接。
  - 比較時兩邊用同一段日期與同一個幣別：起點是期間第一天的前一天收盤；投資組合從那天的淨值起逐日連乘 TWR，基準用同一天（休市用之前最近的交易日，最多 14 天）的值。外幣基準以臺銀即期中價逐日換算成組合的基準幣別（含匯率變動，選了之後排程會補匯率）。基準缺資料就標示缺漏，不補造。
  - 期間：1M、3M、6M、今年以來、1Y、全部、自訂，期間與基準在同一列，作用在下面所有數字與兩張圖（累積報酬比較、淨值與累積淨投入）。圖可以用游標或方向鍵逐日看，也可以切成表格。
- **族群輪動**（EXPLORE，`src/lib/market/`：`exchange-sources.ts`、`market-sync.ts`、`rotation.ts`、`rotation-compute.ts`、`groups.ts`；頁面 `/market`）：
  - 資料：證交所每日收盤行情（MI_INDEX）與三大法人（T86）、櫃買中心上櫃行情（dailyQuotes）與三大法人（insti/dailyTrade），只存資產主檔裡的共用台股，保留約 260 天（約 100 MB）。除權息那天證交所的漲跌價差是 0（標 X），所以另抓除權除息計算結果（證交所 TWT49U、櫃買 exDailyQ）的參考價來算還原報酬。
  - 排程兩個（各有 60 秒）：`/api/cron/sync-market`（平日台北 18:00）同步族群清單 → 抓資料（有時間預算，回補分好幾次；舊的日子先補；證交所擋請求時回 HTML 就先停）；`/api/cron/compute-market`（19:00）算強度與動能。回補可以在本機用 `?budget=秒數` 一次抓完並算完。
  - 算法（版本 `rot-v1`，畫面上的「怎麼算的」有寫）：還原指數 ÷ 台灣加權報酬指數＝RS；強度＝100 × RS 的 10 日平均 ÷ 60 日平均；動能＝100 × 今天強度 ÷ 5 日前強度。族群＝成員還原報酬的等權重平均。要 65 個交易日暖機，不足標「暖機中」。
  - 層級：板塊（`SECTORS`）> 產業（證交所產業別，存在資產的 `metadata.industry`）> 族群（`THEMES`，整理過的清單，成員寫「代號 名稱」，同步時名稱對不上的不加入並列出）> 個股。
- **正負號只由規則決定。** 使用者輸入的金額都是正數，現金增減由 `src/lib/ledger/rules.ts` 決定；買賣的成交金額一律由「數量 × 單價」計算。
- **防重複送出。** 每次打開表單產生一個 `clientRequestId`（每位使用者唯一）。同一個 ID 再送一次會回傳原本那筆（API 回 200、`meta.duplicate: true`）；同一個 ID 拿來送不同內容會回 409。
- **金額以字串傳輸。** API 的金額、數量都是十進位字串；送 JSON number 會被拒絕（避免 `0.1 + 0.2` 這類精度問題）。
- **API 防跨站請求。** 會改資料的 API 只收 `Content-Type: application/json`，並拒絕來自其他網站的 `Origin`；Server Actions 由 Next.js 本身檢查來源。
- **捨入。** 資料庫是 `numeric(28, 10)`。分批賣出時成本依剩餘成本比例分配、吃光整批時拿走全部剩餘成本；賣出收入與費用依數量比例分配（前面各份無條件捨去、最後一份拿餘數），加總永遠等於原值，也不會出現負數。

### 交易類型（Phase 1）

| 類型 | 現金效果 | 持倉 |
|---|---|---|
| 買進 `buy` | −（成交金額＋手續費＋稅＋其他費用） | 新增批次，成本含費用 |
| 賣出 `sell` | ＋（成交金額−手續費−交易稅−其他費用） | FIFO 消耗批次、記已實現損益 |
| 入金 `deposit`／出金 `withdrawal` | ＋／−金額（外部現金流） | — |
| 現金股息 `dividend`／利息 `interest` | ＋稅後淨額 | — |
| 費用 `fee`／稅費 `tax` | −金額 | — |

**每個帳戶只用一種幣別**（Phase 1 還沒有換匯交易）：台股記在 TWD 帳戶、美股記在 USD 帳戶。在 TWD 帳戶買美股會被拒絕，否則會留下一筆永遠補不回來的 USD 負現金。帳戶幣別與投資組合基準幣別不同時，可以另外記下當時匯率（`fxRateToBase`）。有交割日時，現金以交割日入帳。

## API

| Method | Endpoint | 用途 |
|---|---|---|
| GET／POST | `/api/portfolios` | 列出／建立投資組合 |
| GET | `/api/portfolios/:id` | 投資組合 |
| GET／POST | `/api/portfolios/:id/accounts` | 列出／建立帳戶 |
| GET | `/api/portfolios/:id/holdings` | 持倉（數量、成本、已實現；尚無市值） |
| GET | `/api/portfolios/:id/summary` | 帳本彙總（各幣別分開）與各帳戶現金 |
| GET | `/api/transactions?portfolioId=&accountId=&limit=` | 交易列表 |
| POST | `/api/transactions` | 新增交易 |
| GET | `/api/transactions/:id` | 交易明細、FIFO 分配與稽核紀錄 |
| PATCH | `/api/accounts/:id/fees` | 帳戶手續費設定 `{ enabled, ratePercent, discount（折）, min, minOddLot, max, rounding }` |
| PATCH | `/api/transactions/:id` | 更正交易：沖銷原交易並依 body 新增一筆（格式同新增交易，另可帶 `reason`）；`data` 是新交易 |
| POST | `/api/transactions/:id/reversal` | 沖銷交易，body `{ clientRequestId, reason? }`；`data` 是沖銷交易 |
| POST | `/api/imports` | 建立匯入批次（集保 e 存摺：瀏覽器解析好的異動明細） |
| GET | `/api/imports/:id` | 匯入批次與伺服器推算的持股 |
| POST | `/api/positions/snapshots` | 建立庫存快照（快照模式帳戶；可帶 `importBatchId` 確認匯入） |
| GET | `/api/accounts/:id/snapshots` | 帳戶最新與上一份快照 |
| GET | `/api/assets?q=&market=TW\|US&limit=` | 搜尋資產主檔（`q` 必填：代號開頭或名稱包含） |
| GET | `/api/portfolios/:id/valuation?asOf=` | 估值（基準幣別、各持股價格日期、使用的匯率、缺漏清單） |
| GET | `/api/portfolios/:id/history` | 每日淨值快照 |
| GET | `/api/portfolios/:id/performance?asOf=` | 績效：整體損益、簡單報酬率、XIRR、TWR、損益拆解、基準比較、每日淨值與基準值 |
| PUT | `/api/portfolios/:id/benchmark` | 設定比較基準，body `{ benchmarkId }` |
| GET | `/api/benchmarks` | 可選的比較基準（`returnBasis`：`price` 價格報酬／`total_return` 總報酬） |
| GET | `/api/cron/sync-prices` | 同步收盤價、匯率、比較基準並記每日淨值快照；只接受 `Authorization: Bearer <CRON_SECRET>` |
| GET | `/api/cron/sync-assets` | 同步共用資產主檔；只接受 `Authorization: Bearer <CRON_SECRET>` |
| GET | `/api/cron/sync-market?budget=` | 族群輪動：同步族群清單、抓上市櫃行情與法人；只接受 `Authorization: Bearer <CRON_SECRET>` |
| GET | `/api/cron/compute-market` | 族群輪動：算強度與動能；只接受 `Authorization: Bearer <CRON_SECRET>` |
| GET | `/api/market/rotation?level=theme\|industry\|sector&date=` | 族群（產業、板塊）的強度、動能、漲跌、成交金額、法人金額與 10 日軌跡 |
| GET | `/api/market/groups/:id?date=` | 族群成員與 60 日法人金額 |
| GET | `/api/market/stocks?date=` | 個股篩選：續強、轉強 |

新增交易時 `fee`、`tax` 省略代表「依帳戶設定估算」，送 `"0"` 代表實際就是 0；台股賣出可帶 `dayTrade: true`（現股當沖）。

未登入回 401；別人的資源一律回 404（不透露是否存在）。沖銷與更正也用 `clientRequestId` 防重複送出；已經沖銷過的交易回 409 `already_reversed`，沖銷交易本身回 409 `not_reversible`，更正內容跟原交易一樣回 400 `no_change`。

### 庫存快照（快速淨值，Phase 2）

- 帳戶建立時選「快速淨值」：不記逐筆交易（新增交易會被拒絕），只記「某天持有多少、平均成本（可不填）、價格（可不填）、現金（可不填）」。
- 每次更新都是一份新的 `account_snapshots`＋`position_snapshots`（資料庫只開 insert，另有 trigger 擋改寫）；快照列出的就是當天持有的全部，沒列出的就是 0。「最新」依基準日、再依建立時間。
- 沒填的成本、價格、現金一律是 null，畫面標「成本未完整」「未提供」，彙總只加總已知的部分並註明不完整，不當成 0。
- 已有交易或快照的帳戶不能直接切換追蹤方式（之後要做轉換基準日）。

### 集保 e 存摺匯入

- e 存摺匯出的「證券存摺登摺資料」是有密碼的 PDF。**在瀏覽器裡用 pdf.js 打開**（`isEvalSupported: false`），密碼與 PDF 不會送到伺服器；解析器只挑出檔頭（券商、查詢期間、產製時間）與異動列，不讀戶名、帳號、身分證字號。
- 文字先做 NFKC：PDF 字型常把「月」「日」「至」對應成康熙部首、數字與冒號用全形。數字欄靠右對齊，用欄名右緣之間的中點切分提出／存入／餘額；浮水印（「臺灣集中保管結算所…」）會被濾掉。
- e 存摺**只有股數**，沒有成交價、手續費與稅，所以用來建立庫存快照而不是交易。伺服器會重新推算持股（不信任瀏覽器的結果）：期初由第一筆有餘額的列反推，並逐列檢查「前一列餘額 − 提出 ＋ 存入 ＝ 這一列餘額」。只有當沖（買賣相抵）的代號只提示；最後一筆是借貸轉帳提出的標示「可能出借中」。
- 異動明細只含查詢期間內有變動的股票：兩年內沒動過的持股不會出現。確認庫存時會沿用上一份快照裡集保沒提到的股票，賣光的另外列出；也可以手動補。
- 每次匯入存一筆 `import_batches`（原始檔 SHA-256、檔頭、推算結果）與每一列 `import_rows`（之後對帳用）。同一個檔案確認過一次就不能再匯（唯一索引）；批次在建立快照時才標成已確認。
- e 存摺上的日期是成交日（使用者確認過）。

## Phase 1 沒有做的事

- 基準比較（Phase 3 剩下的部分）；快照帳戶的績效（要先能記快照帳戶的入金／出金）；淨值走勢圖與配置圖（Phase 4 的圖表）；股票分割等公司行動（價格目前用原始收盤價，數量也沒有調整）；歷史價格回補（只從開始同步的那天起有價格）。
- 快照帳戶轉成逐筆記帳（轉換基準日、期初批次）、券商成交明細 CSV 匯入、用集保餘額核對逐筆帳本的持股。
- 帳戶間轉帳、換匯、股票分割、帳戶與組合的封存／刪除、使用者資料匯出與刪除。
- 補登較早日期的買賣造成的重算還沒有寫稽核紀錄（只在畫面提示重算了幾筆）；沖銷與更正的重算有。
- 沖銷交易與更正後的新交易在同一個資料庫交易內寫入，`created_at` 相同，列表中兩者的先後順序不固定（不影響計算：沖銷交易不參與 FIFO）。
- 損益顏色固定為台灣慣例（紅賺綠虧，並附 ＋／− 與文字）；切換國際慣例待設定頁。
- 現金餘額允許為負（常見原因是還沒記入金），畫面會標示「現金為負」。
