import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";

const cache = globalThis as unknown as { __stackDb?: ReturnType<typeof getDb> };
let directory: string;
let client: PGlite | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "stack-local-startup-"));
  delete cache.__stackDb;
  for (const key of ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  delete cache.__stackDb;
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("本機首次啟動", () => {
  it("資料庫父目錄不存在時，也能初始化磁碟資料庫及 migration", async () => {
    const dataDir = path.join(directory, ".data", "pglite");
    vi.stubEnv("PGLITE_DATA_DIR", dataDir);
    const db = await getDb();
    client = (db as unknown as { $client: PGlite }).$client;
    expect((await stat(dataDir)).isDirectory()).toBe(true);
    await expect(db.execute(sql`select id from stack.portfolios limit 1`)).resolves.toBeDefined();
  });

  it("仍支援 memory://，不建立磁碟資料庫", async () => {
    vi.stubEnv("PGLITE_DATA_DIR", "memory://");
    const db = await getDb();
    client = (db as unknown as { $client: PGlite }).$client;
    await expect(db.execute(sql`select id from stack.portfolios limit 1`)).resolves.toBeDefined();
  });
});
