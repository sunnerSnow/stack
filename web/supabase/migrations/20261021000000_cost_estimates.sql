-- STACK：手續費與證交稅估算
--
-- * 每個帳戶自己的手續費設定（各家券商、各帳戶的折扣與最低手續費不同）。
--   fee_rate 為 null 表示不自動估算（之前建立的帳戶維持原本行為：沒填就是 0）。
-- * 交易記下哪些費用是系統估算的（cost_estimate），以及是否為現股當沖（day_trade，證交稅率不同）。
--   實際的券商成交費用一律優先；估算只在使用者沒填時使用，畫面上標示「估算」。
--
-- 本檔可重複執行。

alter table stack.accounts
  -- 手續費率（台股法定上限 0.1425% → 0.001425）
  add column if not exists fee_rate        numeric(12, 8) check (fee_rate is null or (fee_rate >= 0 and fee_rate < 0.1)),
  -- 折扣倍數：2.8 折 → 0.28；不打折 → 1
  add column if not exists fee_discount    numeric(6, 4) not null default 1 check (fee_discount > 0 and fee_discount <= 1),
  -- 每筆最低手續費（帳戶幣別）
  add column if not exists fee_min         numeric(28, 10) not null default 0 check (fee_min >= 0),
  -- 台股零股的最低手續費；null 表示跟整股相同
  add column if not exists fee_min_odd_lot numeric(28, 10) check (fee_min_odd_lot is null or fee_min_odd_lot >= 0),
  -- 每筆手續費上限（少數複委託有）；null 表示沒有
  add column if not exists fee_max         numeric(28, 10) check (fee_max is null or fee_max >= 0),
  -- 捨入到帳戶幣別的最小單位（TWD 元、USD 分）：floor 無條件捨去、round 四捨五入
  add column if not exists fee_rounding    text not null default 'floor' check (fee_rounding in ('floor', 'round'));

alter table stack.transactions
  add column if not exists day_trade     boolean not null default false,
  -- 系統估算的費用與依據，例如 {"fee": {...}, "tax": {...}}；null 表示都是使用者填的實際金額
  add column if not exists cost_estimate jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_day_trade_sell_only') then
    alter table stack.transactions add constraint transactions_day_trade_sell_only check (not day_trade or transaction_type = 'sell');
  end if;
end
$$;
