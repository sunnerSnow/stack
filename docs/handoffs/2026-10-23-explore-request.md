# Explore 需求轉交

使用者在其他對話誤傳以下 STACK 需求，現已明確要求轉回 STACK 對話並由該對話實作。

## 使用者原文

「可以了 explore 應該是公開資料放在外層，請參考 https://tide-tw.app/ & https://assetmetra.com/ 我個人比較喜歡後者，要怎樣做成積木版？另外，雖然今天沒有開盤，可是 explore 應該要有資料，可是剛剛沒有，請確認」

接著使用者說：「我傳錯地方了，請把這段對話傳到更新給 stack 那一則，讓他去實作」。

## 需求與尚未批准的提案

- 使用者要求：Explore 的公開市場資料放在登入外層；參考兩站，偏好 AssetMetra；採 STACK 積木視覺；查證並處理休市仍應可看既有行情的問題。
- 本對話提案（使用者尚未逐項確認）：頂部市場摘要、主要族群積木牆、點擊展開成分股／法人／輪動圖，登入後再加私人持股標記。不要誤當成使用者指定所有細節。
- 休市或最新行情未公布時，預期顯示最近有效交易日與明確資料日期；輪動暖機不足應獨立呈現，不能因此把可用行情全部藏掉。不以假資料冒充行情。

## 唯讀檢查已知結果

- 專案 /Users/yuki/Project/stack/web。
- src/app/(app)/market/page.tsx 使用 requireUser，proxy.ts 的公開路徑也未包含 /market。
- getRotation 的 computedDates（src/lib/services/market.ts）以目前計算版本的 market_group_daily 最新 market 記錄，搭配 taiex benchmark 日期取得資料日，並非強制查今天。
- page.tsx 在 data.date === null 時隱藏 RotationView，顯示等待 65 交易日的提示。
- rotation-compute.ts 的完整歷史窗口與 market-sync.ts 的分批回補可能影響可用結果；未查到實際資料庫內容，不可把它們直接定為此次故障根因。
- 本對話 curl localhost:3000、3001 都失敗；尚未重現使用者的空白畫面，也未確認其網址。不同對話的環境狀態可能不同，請自行重查。
- AssetMetra 首頁明示部分畫面為示意數字，參考版面不代表可直接使用其行情。

## 修改狀態

本對話沒有修改任何 STACK 產品程式碼、資料庫或現有未提交變更。此交接文件是唯一新增的 STACK 文件。檢查時已有多個未提交修改，請保留並在既有工作上銜接。

請在 STACK 對話繼續實作、驗證公開／私人資料界線，以及休市、回補中、暖機中與來源錯誤的顯示。
