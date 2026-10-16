# STACK web

STACK 是把市場分析、個人資產與 AI 研究放在一起的投資平台。產品規格在上一層的 `spec.md`，設計稿在 `../design/`。

目前完成的是規格第 16 節的 **Phase 1：基礎帳本**：投資組合、帳戶、資產、手動交易、現金帳本、FIFO 持倉批次與賣出分配，以及對應的 API、基本畫面與測試。

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
2. 到 **SQL Editor** 貼上並執行 `supabase/migrations/20261016000000_phase1_ledger.sql`（可重複執行）。
   - **不要**執行 `supabase/local/auth_stub.sql`，那是給本機 PGlite 模擬 Supabase 用的。
   - 跑完用下面這段確認權限：應該只有 `authenticated`，而且 `transactions`、`cash_ledger` 只有 SELECT 與 INSERT。
     ```sql
     select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type)
     from information_schema.role_table_grants where table_schema = 'stack'
     group by 1, 2 order by 2, 1;
     ```
3. 在 `.env.local`（以及 Vercel 的環境變數）設定三個值，格式見 `.env.example`：
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（舊專案可用 `NEXT_PUBLIC_SUPABASE_ANON_KEY`）
   - `DATABASE_URL`：Supabase「Connect」裡的 **Transaction pooler**（port 6543）連線字串
4. Authentication → URL Configuration 把網站網址加進 Redirect URLs（註冊確認信會回到 `/auth/callback`）。
5. Supabase 內建寄信每小時只能寄很少封、而且只寄給組織成員；開放給別人註冊前要設定自訂 SMTP。

三個變數**只設一半會直接報錯**，正式環境（`NODE_ENV=production`）沒設也會報錯，不會默默改用本機資料庫。

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
- **原始紀錄只能新增。** `transactions`、`cash_ledger` 沒有 update／delete 權限，另有 trigger 擋下任何角色的改寫（包括在 SQL Editor 裡）；之後的更正會用沖銷交易（`reversal_of_id`）。刪除只在同一個交易內 `set local stack.allow_purge = 'on'` 時允許，留給之後的「刪除我的資料」流程。
- **資產主檔分成共用與私人。** `created_by` 為空的是共用主檔（migration 內附常見台股與美股，之後由行情資料來源維護）；使用者自己新增的代號只有本人看得到，名稱與類別不會影響別人，也不會洩漏誰持有冷門代號。
- **持倉批次是衍生資料。** 每次新增買賣，會把同一帳戶＋資產的所有買賣依時間重播一次，重建 `position_lots` 與 `lot_disposals`。補登較早日期的交易也會得到一致的 FIFO 結果，畫面會告訴你重新計算了幾筆既有賣出；如果補登會讓任何時點的持倉變負，整筆拒絕。
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
| GET | `/api/transactions/:id` | 交易明細與 FIFO 分配 |
| GET | `/api/assets?q=` | 搜尋資產主檔 |

未登入回 401；別人的資源一律回 404（不透露是否存在）。

## Phase 1 沒有做的事

- 行情、匯率、市值、未實現損益、總淨值、XIRR、TWR、基準比較（Phase 3、4）。畫面上明確標示「尚無行情」，不顯示估計值。
- 快速淨值（庫存快照）模式、CSV 匯入（Phase 2）。
- 交易更正／沖銷、帳戶間轉帳、換匯、股票分割、帳戶與組合的封存／刪除、使用者資料匯出與刪除。
- 重新計算的稽核紀錄（目前只在畫面提示重算了幾筆）。
- 損益顏色固定為台灣慣例（紅賺綠虧，並附 ＋／− 與文字）；切換國際慣例待設定頁。
- 現金餘額允許為負（常見原因是還沒記入金），畫面會標示「現金為負」。
