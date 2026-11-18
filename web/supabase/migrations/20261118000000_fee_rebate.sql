-- STACK：手續費退佣（月退）
--
-- * 新交易類型 fee_rebate：券商退回的手續費（例如每月退佣）。現金增加，但不是外部入金；不指定資產。
--   各筆買賣照樣記原價手續費（月退的帳戶折扣設成不打折），退佣入帳時再記一筆，整體損益就會包含退回的錢。
-- * 交易類型與現金帳本事件類型的清單都加上 fee_rebate；資料庫另外擋「退佣指定了資產」。
--
-- 本檔可重複執行。

alter table stack.transactions drop constraint if exists transactions_transaction_type_check;
alter table stack.transactions add constraint transactions_transaction_type_check check (transaction_type in (
  'buy', 'sell', 'deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'tax', 'fee_rebate',
  'transfer_in', 'transfer_out', 'split', 'cash_in_lieu', 'adjustment'));

alter table stack.cash_ledger drop constraint if exists cash_ledger_event_type_check;
alter table stack.cash_ledger add constraint cash_ledger_event_type_check check (event_type in (
  'deposit', 'withdrawal', 'buy', 'sell', 'dividend', 'interest', 'fee', 'tax', 'fee_rebate',
  'transfer_in', 'transfer_out', 'adjustment'));

alter table stack.transactions drop constraint if exists transactions_fee_rebate_no_asset;
alter table stack.transactions add constraint transactions_fee_rebate_no_asset check (transaction_type <> 'fee_rebate' or asset_id is null);
