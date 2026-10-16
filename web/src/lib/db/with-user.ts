import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 以某個使用者的身分執行一段資料庫交易。
 * 交易內切換成 authenticated 角色並帶入 JWT claims，RLS 會以 auth.uid() = userId 生效；
 * 服務層仍然每個查詢都自己帶 user_id 條件，RLS 是第二道防線。
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(userId)) throw new Error("無效的使用者 ID");
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    // 兩種寫法都設（交易內有效）：auth.uid() 會先讀 claim.sub，連線池上殘留的舊值不能蓋過這次的身分
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${userId}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}
