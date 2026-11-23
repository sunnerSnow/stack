-- STACK Phase 6：AI 研究報告
--
-- * 每份報告保存完整的輸入快照（程式整理好的事實清單：持股比重、技術指標、族群資金、新聞標題與網址）、
--   模型、提示版本與 token 用量，事後可以重現當時的分析（規格 10.3、5.18）。
-- * 只能新增：重新產生就是新的一份，舊版本都留著。產生失敗（AI 拒絕、格式不符）也記一份，content 為 null。
-- * 輸入快照只有比重與報酬率，沒有持股金額與股數。
--
-- 本檔可重複執行。

create table if not exists stack.ai_research_reports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references stack.users (id) on delete cascade,
  portfolio_id    uuid not null,
  asset_id        uuid not null references stack.assets (id),
  -- 研究範圍：目前只有單一持股
  scope           text not null check (scope in ('holding')),
  status          text not null check (status in ('completed', 'failed')),
  -- 實際產生回應的模型（備援時可能跟要求的不同）
  model           text not null check (char_length(model) <= 100),
  prompt_version  text not null check (char_length(prompt_version) <= 100),
  input_version   text not null check (char_length(input_version) <= 100),
  -- 輸入快照的 SHA-256（畫面顯示前 8 碼當快照編號）
  input_hash      text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot  jsonb not null,
  -- 報告內容（引用檢查後）；失敗時 null
  content         jsonb,
  -- 引用檢查拿掉的句子、是否用了備援模型等
  validation      jsonb not null default '{}'::jsonb,
  usage           jsonb not null default '{}'::jsonb,
  error           text check (error is null or char_length(error) <= 500),
  created_at      timestamptz not null default now(),
  unique (id, user_id),
  foreign key (portfolio_id, user_id) references stack.portfolios (id, user_id),
  check ((status = 'completed') = (content is not null)),
  check ((status = 'failed') = (error is not null))
);
create index if not exists ai_research_reports_holding_idx on stack.ai_research_reports (portfolio_id, asset_id, created_at desc);
create index if not exists ai_research_reports_user_day_idx on stack.ai_research_reports (user_id, created_at desc);

-- 只能新增（刪除只在 stack.allow_purge='on' 時允許，跟其他原始紀錄一樣）
create or replace function stack.forbid_report_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('stack.allow_purge', true) = 'on' then
    return old;
  end if;
  raise exception '% 只能新增，不能 %；重新產生會另存一份', tg_table_name, lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$$;
drop trigger if exists forbid_mutation on stack.ai_research_reports;
create trigger forbid_mutation before update or delete on stack.ai_research_reports for each row execute function stack.forbid_report_mutation();

revoke all on stack.ai_research_reports from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on stack.ai_research_reports from %I', r);
    end if;
  end loop;
end
$$;
grant select, insert on stack.ai_research_reports to authenticated;

alter table stack.ai_research_reports enable row level security;
drop policy if exists ai_research_reports_select on stack.ai_research_reports;
create policy ai_research_reports_select on stack.ai_research_reports for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists ai_research_reports_insert on stack.ai_research_reports;
create policy ai_research_reports_insert on stack.ai_research_reports for insert to authenticated with check (user_id = (select auth.uid()));
