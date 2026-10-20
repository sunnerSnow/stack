# STACK web

STACK 是把市場分析、個人資產與 AI 研究放在一起的投資平台。產品規格在上一層的 `spec.md`，設計稿在 `../design/`。

目前完成的是規格第 16 節的 **Phase 1：基礎帳本**：投資組合、帳戶、資產、手動交易、現金帳本、FIFO 持倉批次與賣出分配，以及對應的 API、基本畫面與測試。另外補上了交易的**沖銷與更正**（含稽核紀錄）。

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
   - Vercel 另外要設 `CRON_SECRET`（至少 16 個隨機字元），每天同步資產主檔的排程會帶著它呼叫 `/api/cron/sync-assets`
4. Authentication → URL Configuration（`https://supabase.com/dashboard/project/<ref>/auth/url-configuration`）把 Site URL 設成網站網址，並把 `https://<網址>/auth/callback` 加進 Redirect URLs（註冊確認信會回到這裡）。
5. Supabase 內建寄信每小時只能寄很少封、而且只寄給組織成員；開放給別人註冊前要設定自訂 SMTP。

三個變數**只設一半會直接報錯**，正式環境（`NODE_ENV=production`）沒設也會報錯，不會默默改用本機資料庫。

`vercel.json` 把函式固定在新加坡（`sin1`），跟 Supabase 專案（`ap-southeast-1`）同一區；換資料庫地區時要一起改，否則每次查詢都要跨區。同一個檔案也設定了每天 UTC 22 點（台北 6 點，Hobby 方案會在那一小時內的任意時間執行）同步資產主檔。要立刻同步，可以自己帶密鑰呼叫：

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
| GET | `/api/assets?q=&market=TW\|US&limit=` | 搜尋資產主檔（`q` 必填：代號開頭或名稱包含） |
| GET | `/api/cron/sync-assets` | 同步共用資產主檔；只接受 `Authorization: Bearer <CRON_SECRET>` |

新增交易時 `fee`、`tax` 省略代表「依帳戶設定估算」，送 `"0"` 代表實際就是 0；台股賣出可帶 `dayTrade: true`（現股當沖）。

未登入回 401；別人的資源一律回 404（不透露是否存在）。沖銷與更正也用 `clientRequestId` 防重複送出；已經沖銷過的交易回 409 `already_reversed`，沖銷交易本身回 409 `not_reversible`，更正內容跟原交易一樣回 400 `no_change`。

## Phase 1 沒有做的事

- 行情、匯率、市值、未實現損益、總淨值、XIRR、TWR、基準比較（Phase 3、4）。畫面上明確標示「尚無行情」，不顯示估計值。
- 快速淨值（庫存快照）模式、CSV 匯入（Phase 2）。
- 帳戶間轉帳、換匯、股票分割、帳戶與組合的封存／刪除、使用者資料匯出與刪除。
- 補登較早日期的買賣造成的重算還沒有寫稽核紀錄（只在畫面提示重算了幾筆）；沖銷與更正的重算有。
- 沖銷交易與更正後的新交易在同一個資料庫交易內寫入，`created_at` 相同，列表中兩者的先後順序不固定（不影響計算：沖銷交易不參與 FIFO）。
- 損益顏色固定為台灣慣例（紅賺綠虧，並附 ＋／− 與文字）；切換國際慣例待設定頁。
- 現金餘額允許為負（常見原因是還沒記入金），畫面會標示「現金為負」。
