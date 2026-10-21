-- STACK Phase 2：庫存快照（快速淨值）與匯入紀錄
--
-- * 快照模式（accounts.tracking_mode = 'snapshot'）的帳戶不記逐筆交易，只記「某天持有多少、成本與價格（可不填）、現金」。
--   每次更新都是一份新的 account_snapshots＋position_snapshots，只能新增，舊的快照不會被覆寫。
-- * 成本、價格、市值不知道就留 null（畫面顯示「成本未完整」「尚無行情」），不把空值當成 0。
--   規格 5.10 的 market_value 是 NOT NULL；在接上行情（Phase 4）之前改成可為 null。
-- * import_batches／import_rows：每次匯入的檔案與每一列都留著，可以追溯；同一個檔案確認匯入一次後不能再匯。
--
-- 本檔可重複執行。

-- ---------------------------------------------------------------------------
-- import_batches：一次匯入（一個檔案）
-- ---------------------------------------------------------------------------
create table if not exists stack.import_batches (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references stack.users (id) on delete cascade,
  account_id    uuid not null,
  -- 目前只有集保 e 存摺登摺資料（PDF，在瀏覽器解析）；之後的券商 CSV 也放這裡
  broker_format text not null check (broker_format in ('tdcc_passbook_pdf')),
  file_name     text check (file_name is null or char_length(file_name) <= 200),
  -- 原始檔案的 SHA-256（瀏覽器算），用來擋重複匯入
  file_hash     text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  row_count     integer not null default 0 check (row_count >= 0),
  valid_count   integer not null default 0 check (valid_count >= 0),
  error_count   integer not null default 0 check (error_count >= 0),
  -- 檔頭（券商、查詢期間、產製時間）與推算結果；不存戶名、帳號、身分證字號
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  unique (id, user_id),
  foreign key (account_id, user_id) references stack.accounts (id, user_id),
  check ((status = 'confirmed') = (confirmed_at is not null))
);
create index if not exists import_batches_account_idx on stack.import_batches (account_id, created_at desc);
-- 同一個檔案只能確認匯入一次
create unique index if not exists import_batches_confirmed_file_uq on stack.import_batches (user_id, file_hash) where status = 'confirmed';

-- ---------------------------------------------------------------------------
-- import_rows：匯入檔案的每一列（原始內容＋解析結果）
-- ---------------------------------------------------------------------------
create table if not exists stack.import_rows (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  batch_id          uuid not null,
  row_number        integer not null check (row_number >= 1),
  raw_data          jsonb not null,
  parsed_data       jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  dedupe_key        text,
  status            text not null check (status in ('valid', 'error', 'duplicate', 'skipped', 'imported')),
  transaction_id    uuid,
  created_at        timestamptz not null default now(),
  unique (batch_id, row_number),
  foreign key (batch_id, user_id) references stack.import_batches (id, user_id),
  foreign key (transaction_id, user_id) references stack.transactions (id, user_id)
);

-- ---------------------------------------------------------------------------
-- account_snapshots：某個帳戶在某天的庫存快照（只能新增）
-- ---------------------------------------------------------------------------
create table if not exists stack.account_snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  account_id        uuid not null,
  as_of_date        date not null,
  -- 現金餘額（帳戶幣別）；null 表示沒填
  cash_balance      numeric(28, 10),
  source            text not null default 'manual' check (source in ('manual', 'tdcc_pdf')),
  import_batch_id   uuid,
  notes             text check (notes is null or char_length(notes) <= 500),
  client_request_id uuid,
  created_at        timestamptz not null default now(),
  unique (id, user_id),
  unique (id, account_id, user_id),
  unique (user_id, client_request_id),
  foreign key (account_id, user_id) references stack.accounts (id, user_id),
  foreign key (import_batch_id, user_id) references stack.import_batches (id, user_id),
  check ((source = 'tdcc_pdf') = (import_batch_id is not null))
);
create index if not exists account_snapshots_account_idx on stack.account_snapshots (account_id, as_of_date desc, created_at desc);
-- 一個匯入批次只會產生一份快照
create unique index if not exists account_snapshots_batch_uq on stack.account_snapshots (import_batch_id) where import_batch_id is not null;

-- ---------------------------------------------------------------------------
-- position_snapshots：快照裡的每一檔（規格 5.10）
-- ---------------------------------------------------------------------------
create table if not exists stack.position_snapshots (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  snapshot_id  uuid not null,
  account_id   uuid not null,
  asset_id     uuid not null references stack.assets (id),
  quantity     numeric(28, 10) not null check (quantity > 0),
  -- 平均成本（每股，帳戶幣別）；未知為 null
  unit_cost    numeric(28, 10) check (unit_cost is null or unit_cost >= 0),
  -- 使用者提供的價格與市值；未知為 null
  market_price numeric(28, 10) check (market_price is null or market_price >= 0),
  market_value numeric(28, 10) check (market_value is null or market_value >= 0),
  currency     char(3) not null check (currency ~ '^[A-Z]{3}$'),
  notes        text check (notes is null or char_length(notes) <= 200),
  created_at   timestamptz not null default now(),
  unique (snapshot_id, asset_id),
  -- 快照與持倉一定屬於同一個帳戶、同一個使用者
  foreign key (snapshot_id, account_id, user_id) references stack.account_snapshots (id, account_id, user_id)
);
create index if not exists position_snapshots_snapshot_idx on stack.position_snapshots (snapshot_id);

-- 快照只能新增（改錯就再建一份新的）
drop trigger if exists forbid_mutation on stack.account_snapshots;
create trigger forbid_mutation before update or delete on stack.account_snapshots for each row execute function stack.forbid_ledger_mutation();
drop trigger if exists forbid_mutation on stack.position_snapshots;
create trigger forbid_mutation before update or delete on stack.position_snapshots for each row execute function stack.forbid_ledger_mutation();
drop trigger if exists forbid_mutation on stack.import_rows;
create trigger forbid_mutation before update or delete on stack.import_rows for each row execute function stack.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------
-- 權限與 RLS
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
  t text;
begin
  foreach t in array array['import_batches', 'import_rows', 'account_snapshots', 'position_snapshots'] loop
    execute format('revoke all on stack.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on stack.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end
$$;
-- 匯入批次要能從 pending 改成 confirmed／cancelled；其他都只能新增
grant select, insert, update on stack.import_batches to authenticated;
grant select, insert on stack.import_rows, stack.account_snapshots, stack.position_snapshots to authenticated;

alter table stack.import_batches     enable row level security;
alter table stack.import_rows        enable row level security;
alter table stack.account_snapshots  enable row level security;
alter table stack.position_snapshots enable row level security;

drop policy if exists import_batches_own on stack.import_batches;
create policy import_batches_own on stack.import_batches for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists import_rows_select on stack.import_rows;
create policy import_rows_select on stack.import_rows for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists import_rows_insert on stack.import_rows;
create policy import_rows_insert on stack.import_rows for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists account_snapshots_select on stack.account_snapshots;
create policy account_snapshots_select on stack.account_snapshots for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists account_snapshots_insert on stack.account_snapshots;
create policy account_snapshots_insert on stack.account_snapshots for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists position_snapshots_select on stack.position_snapshots;
create policy position_snapshots_select on stack.position_snapshots for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists position_snapshots_insert on stack.position_snapshots;
create policy position_snapshots_insert on stack.position_snapshots for insert to authenticated with check (user_id = (select auth.uid()));
