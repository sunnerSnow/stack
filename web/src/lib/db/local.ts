import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { schema } from "@/lib/db/schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const ROOT = process.cwd();

/** 本機（PGlite）：先建 auth 模擬，再依序跑所有 migration（migration 本身可重複執行） */
export async function bootstrapLocal(client: PGlite): Promise<void> {
  await client.exec(await readFile(path.join(ROOT, "supabase", "local", "auth_stub.sql"), "utf8"));
  const dir = path.join(ROOT, "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await client.exec(await readFile(path.join(dir, file), "utf8"));
  }
}

export async function openLocalDb(client: PGlite): Promise<Db> {
  await bootstrapLocal(client);
  return drizzle(client, { schema }) as unknown as Db;
}

/** 本機示範模式：在模擬的 auth.users 建一個使用者（Supabase 上由 Auth 負責） */
export async function ensureLocalAuthUser(db: Db, id: string, email: string): Promise<void> {
  await db.execute(sql`insert into auth.users (id, email) values (${id}, ${email}) on conflict (id) do nothing`);
}
