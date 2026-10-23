-- Public Explore reads only. Personal tables and authenticated write policies stay unchanged.
grant usage on schema stack to anon;
grant select on stack.assets to anon;
drop policy if exists assets_public_read on stack.assets;
create policy assets_public_read on stack.assets for select to anon using (created_by is null);

-- The sync log is an operational table and is intentionally excluded.
do $$
declare
  t text;
begin
  foreach t in array array['market_daily', 'market_ex_rights', 'market_groups', 'market_group_members', 'market_group_daily', 'benchmark_prices'] loop
    execute format('grant select on stack.%I to anon', t);
    execute format('drop policy if exists %I on stack.%I', t || '_public_read', t);
    execute format('create policy %I on stack.%I for select to anon using (true)', t || '_public_read', t);
  end loop;
end
$$;
