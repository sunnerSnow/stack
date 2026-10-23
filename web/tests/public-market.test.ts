import { sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { withMarket } from "@/lib/db/with-market";
import { createLedger, createTestDb, createUser } from "./helpers/db";

let db: Db;
let alice: string;
let bob: string;
beforeAll(async () => {
  db = await createTestDb();
  alice = (await createLedger(db)).userId;
  bob = await createUser(db);
  await db.execute(sql`insert into stack.assets (symbol, name, asset_type, market, currency, created_by) values ('PRIVATE', 'Private', 'stock', 'TW', 'TWD', ${alice})`);
  await db.execute(sql`insert into stack.assets (symbol, name, asset_type, market, currency, is_active) values ('INACTIVE', 'Inactive', 'stock', 'TW', 'TWD', false)`);
  await db.execute(sql`insert into stack.market_groups (id, name, level) values ('test-market', 'Market', 'market')`);
});

it("anonymous market transactions read shared assets including inactive, market tables and calendar", async () => {
  const result = await withMarket(db, null, async (tx) => {
    const rows = await tx.execute(sql`select symbol from stack.assets where symbol in ('PRIVATE', 'INACTIVE', '2330') order by symbol`);
    for (const table of ['market_daily', 'market_ex_rights', 'market_groups', 'market_group_members', 'market_group_daily', 'benchmark_prices']) {
      await tx.execute(sql.raw(`select * from stack.${table} limit 1`));
    }
    return rows;
  });
  expect((result as unknown as { rows: unknown[] }).rows).toEqual([{ symbol: '2330' }, { symbol: 'INACTIVE' }]);
});

it("anonymous transactions clear stale JWT claims and enforce read-only", async () => {
  await db.execute(sql`select set_config('request.jwt.claim.sub', ${alice}, false), set_config('request.jwt.claims', ${JSON.stringify({ sub: alice })}, false)`);
  const result = await withMarket(db, null, (tx) => tx.execute(sql`select current_user role, current_setting('request.jwt.claim.sub') sub, current_setting('request.jwt.claims') claims, current_setting('transaction_read_only') readonly`));
  expect((result as unknown as { rows: unknown[] }).rows[0]).toEqual({ role: 'anon', sub: '', claims: '{}', readonly: 'on' });
});

it.each(['portfolios', 'position_lots', 'position_snapshots', 'transactions', 'market_sync_log'])("anonymous cannot access %s", async (table) => {
  await expect(withMarket(db, null, (tx) => tx.execute(sql.raw(`select * from stack.${table}`)))).rejects.toThrow();
});

it("anonymous has no write grants on market or shared assets", async () => {
  const result = await db.execute(sql`select has_table_privilege('anon', 'stack.market_groups', 'INSERT, UPDATE, DELETE') market_write, has_table_privilege('anon', 'stack.assets', 'INSERT, UPDATE, DELETE') asset_write`);
  expect((result as unknown as { rows: unknown[] }).rows[0]).toEqual({ market_write: false, asset_write: false });
});

it("anonymous cannot write market or shared assets", async () => {
  await expect(withMarket(db, null, (tx) => tx.execute(sql`update stack.market_groups set name = 'changed'`))).rejects.toThrow();
  await expect(withMarket(db, null, (tx) => tx.execute(sql`update stack.assets set name = 'changed'`))).rejects.toThrow();
});

it("signed-in market transactions retain RLS isolation", async () => {
  const own = await withMarket(db, alice, (tx) => tx.execute(sql`select count(*)::int n from stack.portfolios`));
  const other = await withMarket(db, bob, (tx) => tx.execute(sql`select count(*)::int n from stack.portfolios`));
  expect((own as unknown as { rows: { n: number }[] }).rows[0].n).toBe(1);
  expect((other as unknown as { rows: { n: number }[] }).rows[0].n).toBe(0);
  const privateAssets = await withMarket(db, bob, (tx) => tx.execute(sql`select * from stack.assets where symbol = 'PRIVATE'`));
  expect((privateAssets as unknown as { rows: unknown[] }).rows).toEqual([]);
});
