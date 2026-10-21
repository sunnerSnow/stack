-- STACK Phase 3：歷史收盤價回補
--
-- 逐筆記帳的帳戶要算 TWR，需要從第一筆交易起每一天的淨值，所以要補歷史收盤價。
-- 台股的歷史日線取自 FinMind（TaiwanStockPrice，資料源為證交所／櫃買中心），來源記為 finmind_tw；
-- 每天的最新收盤價仍以證交所／櫃買中心官方 OpenAPI 為主。
--
-- 本檔可重複執行。

alter table stack.price_history drop constraint if exists price_history_source_check;
alter table stack.price_history add constraint price_history_source_check check (source in ('twse', 'tpex', 'finmind_us', 'finmind_tw'));
