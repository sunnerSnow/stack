-- STACK：券商成交明細匯入
--
-- * 匯入批次多一種格式 broker_trades_pdf：券商的「客戶交易明細表」PDF（目前是國泰證券的版面）。
--   跟集保 e 存摺一樣，PDF 只在瀏覽器裡打開，伺服器只收解析好的成交列；不存客戶代號、帳號與姓名。
-- * 每一列存在 import_rows（原始內容、對到的資產、檢查結果；只能新增，不回填）。確認後記成逐筆交易：
--   交易的 source 標 import、import_row_id 指回那一列，可以追溯到原始檔案的哪一列。
-- * 明細期間之前就持有、期間內才賣掉的股票，以「轉入持股」（transfer_in，schema 原本就有）補上期初持股。
--
-- 本檔可重複執行。

alter table stack.import_batches drop constraint if exists import_batches_broker_format_check;
alter table stack.import_batches add constraint import_batches_broker_format_check check (broker_format in ('tdcc_passbook_pdf', 'broker_trades_pdf'));

alter table stack.transactions drop constraint if exists transactions_source_check;
alter table stack.transactions add constraint transactions_source_check check (source in ('manual', 'csv', 'snapshot_adjustment', 'import'));
