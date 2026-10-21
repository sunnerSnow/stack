-- STACK：族群輪動（EXPLORE 探索市場，規格 5.18）
--
-- * market_daily：上市櫃每一檔（只存資產主檔裡的共用台股）每天的收盤價、成交股數、成交金額與三大法人買賣超股數。
--   來源：證交所每日收盤行情（MI_INDEX）＋三大法人買賣超日報（T86）、櫃買中心上櫃股票行情＋三大法人買賣明細。
--   只保留最近約 260 天（排程會刪更早的），資料量約每天 2,400 列。
-- * market_ex_rights：除權息的「除權息前收盤價」與「參考價」，算還原報酬用（除權息那天用參考價，不會被當成下跌）。
-- * market_sync_log：哪一天的哪個來源抓過了（回補進度；抓到 0 列的不記，下次再抓）。
-- * market_groups／market_group_members：板塊 > 產業 > 族群 > 個股。產業取自證交所的產業別，族群是整理過的清單。
-- * market_group_daily：族群每天的等權重指數、強度、動能、成交金額與法人金額（排程計算，不在畫面上即時算）。
--   market_daily 的 strength／momentum 是個股的強度與動能。計算方式改了就換 calc_version。
--
-- 都是公開市場資料：登入的使用者都讀得到；只有排程（資料庫擁有者）寫入。本檔可重複執行。

create table if not exists stack.market_daily (
  asset_id    uuid not null references stack.assets (id) on delete cascade,
  trade_date  date not null,
  close       numeric(14, 4) check (close > 0),
  volume      bigint check (volume >= 0),
  turnover    bigint check (turnover >= 0),
  foreign_net bigint,
  trust_net   bigint,
  dealer_net  bigint,
  strength    numeric(10, 4),
  momentum    numeric(10, 4),
  primary key (asset_id, trade_date)
);
create index if not exists market_daily_date_idx on stack.market_daily (trade_date);

create table if not exists stack.market_ex_rights (
  asset_id   uuid not null references stack.assets (id) on delete cascade,
  ex_date    date not null,
  prev_close numeric(14, 4) not null check (prev_close > 0),
  ref_price  numeric(14, 4) not null check (ref_price > 0),
  primary key (asset_id, ex_date)
);

create table if not exists stack.market_sync_log (
  trade_date date not null,
  source     text not null check (source in ('twse_quotes', 'twse_inst', 'tpex_quotes', 'tpex_inst')),
  rows       integer not null check (rows > 0),
  fetched_at timestamptz not null default now(),
  primary key (trade_date, source)
);

create table if not exists stack.market_groups (
  id          text primary key check (id ~ '^[a-z0-9_:-]{2,60}$'),
  name        text not null,
  -- market：全市場（一個，用來看漲跌家數，也是「這一天算過了」的標記）
  level       text not null check (level in ('market', 'sector', 'industry', 'theme')),
  parent_id   text references stack.market_groups (id) on delete set null,
  description text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now()
);

create table if not exists stack.market_group_members (
  group_id text not null references stack.market_groups (id) on delete cascade,
  asset_id uuid not null references stack.assets (id) on delete cascade,
  primary key (group_id, asset_id)
);
create index if not exists market_group_members_asset_idx on stack.market_group_members (asset_id);

create table if not exists stack.market_group_daily (
  group_id     text not null references stack.market_groups (id) on delete cascade,
  trade_date   date not null,
  index_level  numeric(18, 6) not null check (index_level > 0),
  ret          numeric(12, 8),
  strength     numeric(10, 4),
  momentum     numeric(10, 4),
  turnover     bigint,
  -- 法人買賣超金額（股數 × 收盤價，元）
  foreign_net  bigint,
  trust_net    bigint,
  dealer_net   bigint,
  members      integer not null,
  up_count     integer not null,
  strong_count integer not null,
  calc_version text not null,
  primary key (group_id, trade_date)
);
create index if not exists market_group_daily_date_idx on stack.market_group_daily (trade_date);

-- ---------------------------------------------------------------------------
-- 權限與 RLS：大家都讀得到，只有排程寫入
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
  t text;
begin
  foreach t in array array['market_daily', 'market_ex_rights', 'market_sync_log', 'market_groups', 'market_group_members', 'market_group_daily'] loop
    execute format('revoke all on stack.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on stack.%I from %I', t, r);
      end if;
    end loop;
    execute format('grant select on stack.%I to authenticated', t);
    execute format('alter table stack.%I enable row level security', t);
    execute format('drop policy if exists %I on stack.%I', t || '_read', t);
    execute format('create policy %I on stack.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end
$$;
