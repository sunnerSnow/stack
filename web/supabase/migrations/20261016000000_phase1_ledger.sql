-- STACK Phase 1：基礎帳本
-- 投資組合、帳戶、資產、交易、現金帳本、FIFO 持倉批次與賣出分配。
--
-- 設計重點：
-- * 全部放在 stack schema：Supabase 的 Data API 只公開 public，這些表不會被前端直接讀寫，
--   一律經過伺服器的交易服務（禁止前端自行決定正負號）。
-- * 每張使用者資料表都帶 user_id，並用 (父表 id, user_id) 的複合外鍵連到上層，
--   資料庫本身保證「子資料一定屬於同一個使用者」；RLS 只認 user_id = auth.uid()。
-- * 伺服器以 postgres 連線後，每個請求在交易內 set local role authenticated 並帶入 JWT claims，
--   所以就算服務層漏寫條件，RLS 仍會擋下跨使用者存取。
-- * 金額、數量、價格一律 numeric，不用浮點數。
-- * 交易與現金帳本是原始紀錄：只能新增，不給 update / delete。
--   持倉批次與賣出分配是由交易重算出來的衍生資料，所以可以刪除重建。
--
-- 本檔可重複執行（if not exists、drop policy if exists）。

create schema if not exists stack;

-- ---------------------------------------------------------------------------
-- 共用：updated_at
-- ---------------------------------------------------------------------------
create or replace function stack.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users：對應 auth.users 的個人設定
-- ---------------------------------------------------------------------------
create table if not exists stack.users (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  base_currency char(3) not null default 'TWD' check (base_currency ~ '^[A-Z]{3}$'),
  timezone      text not null default 'Asia/Taipei',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- portfolios
-- ---------------------------------------------------------------------------
create table if not exists stack.portfolios (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references stack.users (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  tracking_mode text not null default 'transaction' check (tracking_mode in ('transaction', 'snapshot', 'hybrid')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (id, user_id)
);
create unique index if not exists portfolios_user_name_active_uq
  on stack.portfolios (user_id, lower(btrim(name))) where archived_at is null;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
create table if not exists stack.accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  portfolio_id  uuid not null,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  broker_name   text check (broker_name is null or char_length(broker_name) <= 80),
  account_type  text not null check (account_type in ('brokerage', 'cash', 'other')),
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  tracking_mode text not null default 'transaction' check (tracking_mode in ('transaction', 'snapshot')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (id, user_id),
  foreign key (portfolio_id, user_id) references stack.portfolios (id, user_id) on delete cascade
);
create index if not exists accounts_portfolio_idx on stack.accounts (portfolio_id);

-- ---------------------------------------------------------------------------
-- assets：資產主檔
-- * created_by 為 null：可信任的共用主檔（本檔下方的種子資料；Phase 4 起由行情資料來源維護），
--   同一市場＋代號只有一筆。
-- * created_by 為使用者：使用者自己新增的代號，只有本人看得到，名稱與類別不會影響別人，
--   也不會讓別人知道你持有冷門代號。同一使用者的市場＋代號唯一。
-- 規格寫的是全域 UNIQUE (market, symbol)；在還沒有可信任的資料來源之前，改成下面兩個部分唯一索引。
-- ---------------------------------------------------------------------------
create table if not exists stack.assets (
  id          uuid primary key default gen_random_uuid(),
  symbol      text not null check (symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,19}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  asset_type  text not null check (asset_type in ('stock', 'etf', 'cash')),
  market      text not null check (market ~ '^[A-Z]{2,10}$'),
  exchange    text,
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  industry_id uuid,
  is_active   boolean not null default true,
  metadata    jsonb not null default '{}'::jsonb,
  -- 刪除使用者時一併刪除（不可 set null，否則私人代號會變成共用主檔）
  created_by  uuid references stack.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists assets_shared_market_symbol_uq on stack.assets (market, symbol) where created_by is null;
create unique index if not exists assets_private_market_symbol_uq on stack.assets (created_by, market, symbol) where created_by is not null;

-- 種子：常見的台股與美股（名稱為交易所公告的簡稱）
insert into stack.assets (market, symbol, name, asset_type, currency) values
  ('TW', '2330', '台積電', 'stock', 'TWD'),
  ('TW', '2317', '鴻海', 'stock', 'TWD'),
  ('TW', '2454', '聯發科', 'stock', 'TWD'),
  ('TW', '2308', '台達電', 'stock', 'TWD'),
  ('TW', '2303', '聯電', 'stock', 'TWD'),
  ('TW', '2412', '中華電', 'stock', 'TWD'),
  ('TW', '2881', '富邦金', 'stock', 'TWD'),
  ('TW', '2882', '國泰金', 'stock', 'TWD'),
  ('TW', '2891', '中信金', 'stock', 'TWD'),
  ('TW', '2886', '兆豐金', 'stock', 'TWD'),
  ('TW', '2603', '長榮', 'stock', 'TWD'),
  ('TW', '0050', '元大台灣50', 'etf', 'TWD'),
  ('TW', '0056', '元大高股息', 'etf', 'TWD'),
  ('TW', '006208', '富邦台50', 'etf', 'TWD'),
  ('TW', '00878', '國泰永續高股息', 'etf', 'TWD'),
  ('TW', '00919', '群益台灣精選高息', 'etf', 'TWD'),
  ('US', 'AAPL', 'Apple', 'stock', 'USD'),
  ('US', 'MSFT', 'Microsoft', 'stock', 'USD'),
  ('US', 'NVDA', 'NVIDIA', 'stock', 'USD'),
  ('US', 'AMZN', 'Amazon.com', 'stock', 'USD'),
  ('US', 'GOOGL', 'Alphabet Class A', 'stock', 'USD'),
  ('US', 'META', 'Meta Platforms', 'stock', 'USD'),
  ('US', 'TSLA', 'Tesla', 'stock', 'USD'),
  ('US', 'VOO', 'Vanguard S&P 500 ETF', 'etf', 'USD'),
  ('US', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 'USD'),
  ('US', 'VT', 'Vanguard Total World Stock ETF', 'etf', 'USD'),
  ('US', 'QQQ', 'Invesco QQQ Trust', 'etf', 'USD'),
  ('US', 'SPY', 'SPDR S&P 500 ETF Trust', 'etf', 'USD')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- transactions：原始交易紀錄（只能新增）
-- ---------------------------------------------------------------------------
create table if not exists stack.transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  account_id         uuid not null,
  asset_id           uuid references stack.assets (id),
  transaction_type   text not null check (transaction_type in (
                       'buy', 'sell', 'deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'tax',
                       'transfer_in', 'transfer_out', 'split', 'cash_in_lieu', 'adjustment')),
  trade_date         date not null,
  trade_at           timestamptz,
  settlement_date    date,
  quantity           numeric(28, 10) check (quantity is null or quantity > 0),
  unit_price         numeric(28, 10) check (unit_price is null or unit_price >= 0),
  gross_amount       numeric(28, 10) not null check (gross_amount >= 0),
  fee                numeric(28, 10) not null default 0 check (fee >= 0),
  tax                numeric(28, 10) not null default 0 check (tax >= 0),
  tax_kind           text check (tax_kind in ('transaction_tax', 'withholding_tax', 'other')),
  other_cost         numeric(28, 10) not null default 0 check (other_cost >= 0),
  currency           char(3) not null check (currency ~ '^[A-Z]{3}$'),
  fx_rate_to_base    numeric(28, 12) check (fx_rate_to_base is null or fx_rate_to_base > 0),
  external_flow_type text check (external_flow_type in ('contribution', 'withdrawal')),
  notes              text check (notes is null or char_length(notes) <= 500),
  source             text not null default 'manual' check (source in ('manual', 'csv', 'snapshot_adjustment')),
  import_row_id      uuid,
  reversal_of_id     uuid,
  client_request_id  uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, client_request_id),
  foreign key (account_id, user_id) references stack.accounts (id, user_id),
  -- 沖銷只能指向同一個使用者的交易
  foreign key (reversal_of_id, user_id) references stack.transactions (id, user_id),
  check (settlement_date is null or settlement_date >= trade_date),
  check (tax = 0 or tax_kind is not null),
  check (transaction_type not in ('buy', 'sell')
         or (asset_id is not null and quantity is not null and unit_price is not null)),
  check (transaction_type <> 'dividend' or asset_id is not null)
);
create index if not exists transactions_account_date_idx on stack.transactions (account_id, trade_date, created_at);
create index if not exists transactions_account_asset_idx on stack.transactions (account_id, asset_id) where asset_id is not null;

-- ---------------------------------------------------------------------------
-- cash_ledger：現金帳本（正數入帳、負數支出；只能新增）
-- ---------------------------------------------------------------------------
create table if not exists stack.cash_ledger (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  account_id        uuid not null,
  transaction_id    uuid,
  event_date        date not null,
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount            numeric(28, 10) not null check (amount <> 0),
  event_type        text not null check (event_type in (
                      'deposit', 'withdrawal', 'buy', 'sell', 'dividend', 'interest', 'fee', 'tax',
                      'transfer_in', 'transfer_out', 'adjustment')),
  transfer_group_id uuid,
  created_at        timestamptz not null default now(),
  foreign key (account_id, user_id) references stack.accounts (id, user_id),
  foreign key (transaction_id, user_id) references stack.transactions (id, user_id)
);
-- 一筆交易的現金效果只能入帳一次（費用與稅費不會重複扣）
create unique index if not exists cash_ledger_transaction_uq on stack.cash_ledger (transaction_id) where transaction_id is not null;
create index if not exists cash_ledger_account_idx on stack.cash_ledger (account_id, currency);

-- ---------------------------------------------------------------------------
-- position_lots：FIFO 持倉批次（由交易重算的衍生資料）
-- remaining_cost 不在原規格表中：記住每批剩餘成本，分批賣出時不會累積捨入誤差。
-- ---------------------------------------------------------------------------
create table if not exists stack.position_lots (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  account_id            uuid not null,
  asset_id              uuid not null references stack.assets (id),
  source_transaction_id uuid not null,
  acquired_date         date not null,
  original_quantity     numeric(28, 10) not null check (original_quantity > 0),
  remaining_quantity    numeric(28, 10) not null check (remaining_quantity >= 0),
  total_cost            numeric(28, 10) not null check (total_cost >= 0),
  remaining_cost        numeric(28, 10) not null check (remaining_cost >= 0),
  cost_currency         char(3) not null check (cost_currency ~ '^[A-Z]{3}$'),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (id, user_id),
  unique (source_transaction_id),
  foreign key (account_id, user_id) references stack.accounts (id, user_id),
  foreign key (source_transaction_id, user_id) references stack.transactions (id, user_id),
  check (remaining_quantity <= original_quantity),
  check (remaining_cost <= total_cost)
);
create index if not exists position_lots_account_asset_idx on stack.position_lots (account_id, asset_id);

-- ---------------------------------------------------------------------------
-- lot_disposals：賣出時每個被消耗批次的分配（衍生資料）
-- allocated_other_cost 不在原規格表中：其他費用與手續費分開記，保持可追溯。
-- ---------------------------------------------------------------------------
create table if not exists stack.lot_disposals (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  sell_transaction_id  uuid not null,
  lot_id               uuid not null,
  quantity             numeric(28, 10) not null check (quantity > 0),
  allocated_cost       numeric(28, 10) not null check (allocated_cost >= 0),
  allocated_proceeds   numeric(28, 10) not null check (allocated_proceeds >= 0),
  allocated_fee        numeric(28, 10) not null default 0 check (allocated_fee >= 0),
  allocated_tax        numeric(28, 10) not null default 0 check (allocated_tax >= 0),
  allocated_other_cost numeric(28, 10) not null default 0 check (allocated_other_cost >= 0),
  realized_pnl         numeric(28, 10) not null,
  created_at           timestamptz not null default now(),
  unique (sell_transaction_id, lot_id),
  foreign key (sell_transaction_id, user_id) references stack.transactions (id, user_id),
  foreign key (lot_id, user_id) references stack.position_lots (id, user_id) on delete cascade
);
create index if not exists lot_disposals_sell_idx on stack.lot_disposals (sell_transaction_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on stack.users;
create trigger set_updated_at before update on stack.users for each row execute function stack.set_updated_at();
drop trigger if exists set_updated_at on stack.portfolios;
create trigger set_updated_at before update on stack.portfolios for each row execute function stack.set_updated_at();
drop trigger if exists set_updated_at on stack.accounts;
create trigger set_updated_at before update on stack.accounts for each row execute function stack.set_updated_at();
drop trigger if exists set_updated_at on stack.assets;
create trigger set_updated_at before update on stack.assets for each row execute function stack.set_updated_at();
drop trigger if exists set_updated_at on stack.position_lots;
create trigger set_updated_at before update on stack.position_lots for each row execute function stack.set_updated_at();

-- ---------------------------------------------------------------------------
-- 原始紀錄不可改寫：就算是有權限的角色（例如在 SQL Editor）也不能 update；
-- delete 只有在同一個交易內明確 set local stack.allow_purge = 'on' 時允許（給之後的「刪除我的資料」流程用）。
-- 更正請用沖銷交易（reversal_of_id）。
-- ---------------------------------------------------------------------------
create or replace function stack.forbid_ledger_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('stack.allow_purge', true) = 'on' then
    return old;
  end if;
  raise exception '% 是原始帳本紀錄，不能 %；請用沖銷交易更正', tg_table_name, lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$$;
drop trigger if exists forbid_mutation on stack.transactions;
create trigger forbid_mutation before update or delete on stack.transactions for each row execute function stack.forbid_ledger_mutation();
drop trigger if exists forbid_mutation on stack.cash_ledger;
create trigger forbid_mutation before update or delete on stack.cash_ledger for each row execute function stack.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------
-- 權限：只開給 authenticated（伺服器 set local role 進來），anon 什麼都沒有
-- ---------------------------------------------------------------------------
revoke all on schema stack from public;
revoke all on all tables in schema stack from public;
-- 明確收回平台角色的權限（避免預設權限讓 anon／service_role 碰到帳本，或讓 authenticated 能改寫原始紀錄）
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema stack from %I', r);
    end if;
  end loop;
end
$$;
grant usage on schema stack to authenticated;
grant select, insert, update on stack.users, stack.portfolios, stack.accounts to authenticated;
grant select, insert on stack.assets to authenticated;
grant select, insert on stack.transactions, stack.cash_ledger to authenticated;
grant select, insert, update, delete on stack.position_lots to authenticated;
grant select, insert, delete on stack.lot_disposals to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table stack.users         enable row level security;
alter table stack.portfolios    enable row level security;
alter table stack.accounts      enable row level security;
alter table stack.assets        enable row level security;
alter table stack.transactions  enable row level security;
alter table stack.cash_ledger   enable row level security;
alter table stack.position_lots enable row level security;
alter table stack.lot_disposals enable row level security;

drop policy if exists users_own on stack.users;
create policy users_own on stack.users for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists portfolios_own on stack.portfolios;
create policy portfolios_own on stack.portfolios for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists accounts_own on stack.accounts;
create policy accounts_own on stack.accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 共用主檔大家都看得到；私人代號只有建立者看得到
drop policy if exists assets_read on stack.assets;
create policy assets_read on stack.assets for select to authenticated
  using (created_by is null or created_by = (select auth.uid()));
drop policy if exists assets_create on stack.assets;
create policy assets_create on stack.assets for insert to authenticated with check (created_by = (select auth.uid()));

-- 原始紀錄只開 select 與 insert（權限也只給這兩個）
drop policy if exists transactions_own on stack.transactions;
drop policy if exists transactions_select on stack.transactions;
create policy transactions_select on stack.transactions for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists transactions_insert on stack.transactions;
create policy transactions_insert on stack.transactions for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists cash_ledger_own on stack.cash_ledger;
drop policy if exists cash_ledger_select on stack.cash_ledger;
create policy cash_ledger_select on stack.cash_ledger for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists cash_ledger_insert on stack.cash_ledger;
create policy cash_ledger_insert on stack.cash_ledger for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists position_lots_own on stack.position_lots;
create policy position_lots_own on stack.position_lots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists lot_disposals_own on stack.lot_disposals;
create policy lot_disposals_own on stack.lot_disposals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
