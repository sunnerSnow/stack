-- STACK：基準比較（規格 5.18、7.5）
--
-- * benchmark_definitions：可以選的比較基準。return_basis 區分「價格報酬」與「總報酬（含息再投入）」，
--   兩者不能混為一談，畫面上一律標示。
-- * benchmark_prices：基準每天的值（共用資料，大家都讀得到；只有排程以資料庫擁有者身分寫入）。
--   指數直接存指數值；VOO 含息版存「以調整後收盤價的日報酬連乘」的值，只拿來算報酬率。
-- * portfolio_benchmark_settings：每個投資組合選的基準；沒設定時依基準幣別用預設（TWD → 加權報酬指數、USD → VOO 含息）。
--
-- 本檔可重複執行。

create table if not exists stack.benchmark_definitions (
  id            text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name          text not null,
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  return_basis  text not null check (return_basis in ('price', 'total_return')),
  -- finmind_tw_index：FinMind TaiwanStockPrice（指數收盤）；finmind_tw_return_index：TaiwanStockTotalReturnIndex；
  -- finmind_us_close／finmind_us_adj_close：USStockPrice 的 Close／Adj_Close
  source        text not null check (source in ('finmind_tw_index', 'finmind_tw_return_index', 'finmind_us_close', 'finmind_us_adj_close')),
  source_symbol text not null,
  description   text not null,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  -- 往前回補過的起點（排程用；FinMind 沒有更早的資料時，才不會每天重抓）
  backfilled_from date,
  created_at    timestamptz not null default now()
);

insert into stack.benchmark_definitions (id, name, currency, return_basis, source, source_symbol, description, sort_order) values
  ('taiex_tr', '台灣加權報酬指數', 'TWD', 'total_return', 'finmind_tw_return_index', 'TAIEX',
   '證交所編製的發行量加權股價報酬指數，現金股利再投入。', 10),
  ('taiex', '台灣加權指數', 'TWD', 'price', 'finmind_tw_index', 'TAIEX',
   '發行量加權股價指數，只有價格變動，不含股利。', 20),
  ('voo_tr', 'VOO（S&P 500）含息', 'USD', 'total_return', 'finmind_us_adj_close', 'VOO',
   '以調整後收盤價計算，配息再投入（稅前，未扣台灣投資人被預扣的 30% 股利稅）。', 30),
  ('voo', 'VOO（S&P 500）不含息', 'USD', 'price', 'finmind_us_close', 'VOO',
   '收盤價變動，不含配息。', 40)
on conflict (id) do update set
  name = excluded.name, currency = excluded.currency, return_basis = excluded.return_basis, source = excluded.source,
  source_symbol = excluded.source_symbol, description = excluded.description, sort_order = excluded.sort_order;

create table if not exists stack.benchmark_prices (
  benchmark_id text not null references stack.benchmark_definitions (id) on delete cascade,
  price_date   date not null,
  value        numeric(28, 10) not null check (value > 0),
  fetched_at   timestamptz not null default now(),
  primary key (benchmark_id, price_date)
);

create table if not exists stack.portfolio_benchmark_settings (
  portfolio_id uuid primary key,
  user_id      uuid not null,
  benchmark_id text not null references stack.benchmark_definitions (id),
  updated_at   timestamptz not null default now(),
  foreign key (portfolio_id, user_id) references stack.portfolios (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 權限與 RLS：基準定義與基準值大家都讀得到（只有排程寫入）；投資組合的設定只看得到、改得到自己的。
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
  t text;
begin
  foreach t in array array['benchmark_definitions', 'benchmark_prices', 'portfolio_benchmark_settings'] loop
    execute format('revoke all on stack.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on stack.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end
$$;
grant select on stack.benchmark_definitions, stack.benchmark_prices to authenticated;
grant select, insert, update on stack.portfolio_benchmark_settings to authenticated;

alter table stack.benchmark_definitions        enable row level security;
alter table stack.benchmark_prices             enable row level security;
alter table stack.portfolio_benchmark_settings enable row level security;

drop policy if exists benchmark_definitions_read on stack.benchmark_definitions;
create policy benchmark_definitions_read on stack.benchmark_definitions for select to authenticated using (true);
drop policy if exists benchmark_prices_read on stack.benchmark_prices;
create policy benchmark_prices_read on stack.benchmark_prices for select to authenticated using (true);
drop policy if exists portfolio_benchmark_settings_own on stack.portfolio_benchmark_settings;
create policy portfolio_benchmark_settings_own on stack.portfolio_benchmark_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
