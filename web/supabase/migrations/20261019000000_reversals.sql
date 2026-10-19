-- STACK：沖銷、更正與稽核紀錄
--
-- 交易與現金帳本只能新增，所以「改錯」一律用沖銷：
-- * 沖銷交易是原交易的鏡像（同類型、同帳戶、同金額），reversal_of_id 指向原交易；
--   現金帳本另記一筆反向金額，持倉重播時原交易與沖銷交易成對排除。
-- * 更正 = 同一個資料庫交易內「沖銷原交易＋新增正確的一筆」，並寫一筆稽核紀錄把三者連起來。
-- * 一筆交易只能被沖銷一次；沖銷交易本身不能再被沖銷（要恢復就重新記一筆）。
--
-- 本檔可重複執行（if not exists、create or replace、drop ... if exists）。

-- ---------------------------------------------------------------------------
-- 沖銷規則
-- ---------------------------------------------------------------------------
create unique index if not exists transactions_reversal_uq on stack.transactions (reversal_of_id) where reversal_of_id is not null;

-- 就算繞過服務層直接寫 SQL，也不能用「沖銷」偷改金額或沖銷別的沖銷
create or replace function stack.check_reversal() returns trigger
language plpgsql as $$
declare
  o stack.transactions%rowtype;
begin
  if new.reversal_of_id is null then
    return new;
  end if;
  -- 複合外鍵已保證原交易屬於同一個使用者
  select * into o from stack.transactions where id = new.reversal_of_id;
  if not found then
    return new; -- 交給外鍵回報
  end if;
  if o.reversal_of_id is not null then
    raise exception '沖銷交易不能再被沖銷' using errcode = 'check_violation';
  end if;
  if new.account_id <> o.account_id
     or new.transaction_type <> o.transaction_type
     or new.asset_id is distinct from o.asset_id
     or new.quantity is distinct from o.quantity
     or new.unit_price is distinct from o.unit_price
     or new.gross_amount <> o.gross_amount
     or new.fee <> o.fee
     or new.tax <> o.tax
     or new.other_cost <> o.other_cost
     or new.currency <> o.currency then
    raise exception '沖銷交易必須與原交易內容相同' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists check_reversal on stack.transactions;
create trigger check_reversal before insert on stack.transactions for each row execute function stack.check_reversal();

-- ---------------------------------------------------------------------------
-- audit_log：稽核紀錄（只能新增）
-- 目前記沖銷與更正；之後的匯入、刪除、重算也記在這裡。
-- ---------------------------------------------------------------------------
create table if not exists stack.audit_log (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references stack.users (id) on delete cascade,
  action             text not null check (action in ('reverse', 'correct')),
  -- 被沖銷的原交易、沖銷交易、更正後的新交易
  transaction_id     uuid,
  reversal_id        uuid,
  replacement_id     uuid,
  reason             text check (reason is null or char_length(reason) <= 200),
  -- 因為這次操作，已實現損益被重新計算的其他賣出筆數
  recalculated_sells integer not null default 0 check (recalculated_sells >= 0),
  created_at         timestamptz not null default now(),
  foreign key (transaction_id, user_id) references stack.transactions (id, user_id),
  foreign key (reversal_id, user_id) references stack.transactions (id, user_id),
  foreign key (replacement_id, user_id) references stack.transactions (id, user_id),
  check (action not in ('reverse', 'correct') or (transaction_id is not null and reversal_id is not null)),
  check ((action = 'correct') = (replacement_id is not null))
);
create unique index if not exists audit_log_reversal_uq on stack.audit_log (reversal_id) where reversal_id is not null;
create unique index if not exists audit_log_replacement_uq on stack.audit_log (replacement_id) where replacement_id is not null;
create index if not exists audit_log_transaction_idx on stack.audit_log (transaction_id);

drop trigger if exists forbid_mutation on stack.audit_log;
create trigger forbid_mutation before update or delete on stack.audit_log for each row execute function stack.forbid_ledger_mutation();

revoke all on stack.audit_log from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on stack.audit_log from %I', r);
    end if;
  end loop;
end
$$;
grant select, insert on stack.audit_log to authenticated;

alter table stack.audit_log enable row level security;
drop policy if exists audit_log_select on stack.audit_log;
create policy audit_log_select on stack.audit_log for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists audit_log_insert on stack.audit_log;
create policy audit_log_insert on stack.audit_log for insert to authenticated with check (user_id = (select auth.uid()));
