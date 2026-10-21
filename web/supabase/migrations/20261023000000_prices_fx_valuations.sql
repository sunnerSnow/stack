-- STACK：行情、匯率與每日淨值快照（規格 5.11、5.12、5.14、第 8 節）
--
-- * price_history：收盤價（共用資料，大家都讀得到；只有排程以資料庫擁有者身分寫入）。
--   只存「有人持有」的共用資產，資料量才不會每年長幾十 MB。
-- * fx_rates：匯率方向固定為「1 base = rate quote」，例如 USD/TWD = 32.6 表示 1 美元 = 32.6 台幣。
--   缺匯率時估值標示不完整，絕不用 1 代替。
-- * portfolio_valuations：每天每個投資組合一筆淨值快照（只能新增）；同一天同一個計算版本只記一次，
--   之後價格更新也不會無聲覆寫，修正計算邏輯時用新的 calculation_version。
--
-- 本檔可重複執行。

create table if not exists stack.price_history (
  asset_id    uuid not null references stack.assets (id) on delete cascade,
  price_date  date not null,
  close_price numeric(28, 10) not null check (close_price >= 0),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  source      text not null check (source in ('twse', 'tpex', 'finmind_us')),
  is_adjusted boolean not null default false,
  fetched_at  timestamptz not null default now(),
  primary key (asset_id, price_date, source, is_adjusted)
);
create index if not exists price_history_latest_idx on stack.price_history (asset_id, price_date desc);

create table if not exists stack.fx_rates (
  base_currency  char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) not null check (quote_currency ~ '^[A-Z]{3}$'),
  rate_date      date not null,
  rate           numeric(28, 12) not null check (rate > 0),
  -- bot_spot_mid：臺灣銀行牌告即期買入與賣出的中價（經 FinMind 取得）
  source         text not null check (source in ('bot_spot_mid')),
  fetched_at     timestamptz not null default now(),
  primary key (base_currency, quote_currency, rate_date, source),
  check (base_currency <> quote_currency)
);

create table if not exists stack.portfolio_valuations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  portfolio_id        uuid not null,
  valuation_date      date not null,
  base_currency       char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  -- 以下皆為基準幣別；缺價格或匯率的部分不計入（data_quality 標示 partial），null 表示完全算不出來
  securities_value    numeric(28, 10),
  cash_value          numeric(28, 10),
  total_value         numeric(28, 10),
  cost_basis          numeric(28, 10),
  realized_pnl        numeric(28, 10),
  unrealized_pnl      numeric(28, 10),
  dividend_income_net numeric(28, 10),
  fees_and_taxes      numeric(28, 10),
  fx_effect_estimate  numeric(28, 10),
  data_quality        text not null check (data_quality in ('complete', 'partial', 'stale')),
  -- 各持股的價格與價格日期、使用的匯率、缺漏清單
  details             jsonb not null default '{}'::jsonb,
  calculation_version text not null,
  created_at          timestamptz not null default now(),
  unique (portfolio_id, valuation_date, calculation_version),
  foreign key (portfolio_id, user_id) references stack.portfolios (id, user_id) on delete cascade
);
create index if not exists portfolio_valuations_portfolio_idx on stack.portfolio_valuations (portfolio_id, valuation_date desc);

drop trigger if exists forbid_mutation on stack.portfolio_valuations;
create trigger forbid_mutation before update or delete on stack.portfolio_valuations for each row execute function stack.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------
-- 權限與 RLS：行情與匯率大家都讀得到；淨值快照只看得到自己的。寫入都只由排程（擁有者）進行。
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
  t text;
begin
  foreach t in array array['price_history', 'fx_rates', 'portfolio_valuations'] loop
    execute format('revoke all on stack.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on stack.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end
$$;
grant select on stack.price_history, stack.fx_rates, stack.portfolio_valuations to authenticated;

alter table stack.price_history        enable row level security;
alter table stack.fx_rates             enable row level security;
alter table stack.portfolio_valuations enable row level security;

drop policy if exists price_history_read on stack.price_history;
create policy price_history_read on stack.price_history for select to authenticated using (true);
drop policy if exists fx_rates_read on stack.fx_rates;
create policy fx_rates_read on stack.fx_rates for select to authenticated using (true);
drop policy if exists portfolio_valuations_select on stack.portfolio_valuations;
create policy portfolio_valuations_select on stack.portfolio_valuations for select to authenticated using (user_id = (select auth.uid()));
