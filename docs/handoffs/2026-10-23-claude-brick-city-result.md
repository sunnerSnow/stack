# Explore 積木城市 A：Codex 接續交付

使用者要求 Codex 接續 Claude 未完成部分。接手時工作樹尚無城市 UI 或 Claude 結果文件；沿用已批准的交接規範與既有 city-layout 工具完成實作。

## 完成內容

- `web/src/app/market/brick-city.tsx`：以真實資料建立產業底板、族群積木塔、中央大盤與個股拆解；原站四色、相對占地／法人幅度、缺值虛線。
- `web/src/app/market/brick-city.css`：獨立城市樣式、組裝及合攏動畫、減少動態媒體規則、390px 手機摘要與原生產業選單。
- `web/src/app/market/page.tsx`：城市作主畫面，更新閱讀說明及 metadata；保留下方完整輪動工具。
- `web/src/lib/market/city-layout.ts`、`web/tests/city-layout.test.ts`：比例改以全分類資料計算，避免展開隱藏族群後原塔高度改變；新增回歸測試，已見失敗再修正通過。

## 驗證

- `npx vitest run tests/city-layout.test.ts tests/flows.test.ts tests/viewport.test.ts tests/public-market.test.ts tests/market-api.test.ts`：5 檔、49 項通過。
- `npm run lint` 通過；`npm run typecheck` 通過；最終 `npm run build` 通過，包含 TypeScript 檢查。既有多 lockfile 警告仍存在，未更動使用者 lockfile。
- Chrome 桌面、390×844 手機：公開未登入總覽、產業／族群切換、電子科技 47 群分頁、AI 伺服器搜尋及選取、晶圓代工拆解、台積電個股、合攏、鍵盤 Enter、動畫關閉均已操作。
- 手機 document scrollWidth 與 viewport 同為 390，無橫向溢出；以大盤摘要、產業選單及文字清單提供等效導覽，總覽保留全城市縮圖。
- 合攏時觀察到 `city-disassemble` 動畫，關閉動畫時觀察到 animationName 為 none。減少動態由 CSS 與合攏處理器遵循媒體設定，未改使用者 OS 偏好。
- 全新 Chrome 分頁載入 `/market`，console error/warn 清單為空。修正開發中 SVG title 多子節點造成的 hydration 問題。
- 真實資料抽查：2026-10-22，大盤 46,041.43；晶圓代工當日法人合計 -264.9 億、成交額 915.1 億，成分股台積電／聯電／力積電／世界；台積電收盤 2385、-1.45%。個股 20 日法人不足保留 —，期間文字獨立標示。
- 獨立唯讀審核未發現日期、法人期間、缺值合計、搜尋漏群或請求競態阻斷問題；指出的合攏動畫與互動 SVG 語義已修正。

## 保留邊界

組裝動畫不冒充歷史資金回放；法人部分資料不足不補零；重疊群組不加總為全市場。未修改資料庫或環境檔，未提交／推送／部署。開發伺服器保留於 http://localhost:3000/market。概覽每區最多六個族群，聚焦每頁九個，完整清單與搜尋可達全部。

## 使用者要求的視覺第二輪

買超積木改紅色（#D9534F），同步圖例與閱讀說明；黃色保留選取。概覽每區改前四個、2×2 排列，塔身與名稱放大、底板距離縮短，增加底板凸點網格與頂面高光。聚焦保留每頁九個，擴大頂端視野以容納高塔。第一輪的每區六個與四色限制已由本次使用者要求更新。

## 街區與根節點相容修正

使用者提供的 hydration diff 只有 body 額外屬性 cz-shortcut-listen=true；原始碼搜尋無此屬性，屬於外部 DOM 注入差異。layout 的 body 加 suppressHydrationWarning，依 React 官方單層 escape hatch 容忍根元素屬性，未停用應用子樹 hydration 檢查。檢查用瀏覽器沒有該擴充屬性，故沒有聲稱重現同一擴充套件情境；重新載入 console error 清單為空。

街區改為圍繞中央廣場的相接等角平台，淡黃／藍／綠／砂色底板只編碼分類；紅／海綠塔身仍表示法人正負。以抬高的步道連接相鄰街區，取代資金放射線；區名牌貼合底板側面並保持點選入口。單族群地區使用較小底板，減少空板。補上大盤廣場小凸點鋪面、暖色地面、陰影及右側摘要的緊密排列。

桌面與 390px 手機已檢查，手機 scrollWidth=390；新街區可選族群並讀取成分股。相關 city-layout、flows、public-market 共 17 項測試通過，typecheck、lint 與正式 build 通過。
