-- 只給本機示範模式與測試用（PGlite）：模擬 Supabase 的 auth schema 與 authenticated 角色。
-- 正式 Supabase 已經有這些，不要在 Supabase 上執行本檔。
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

-- 與 Supabase 相同：從 request.jwt.claim.sub 或 request.jwt.claims 取使用者 ID
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
