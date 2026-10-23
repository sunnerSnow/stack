import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { withUser, type Tx } from "@/lib/db/with-user";

/** Public market reads use a read-only anonymous role; signed-in reads retain personal RLS. */
export async function withMarket<T>(db: Db, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (userId !== null) return withUser(db, userId, fn);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`select set_config('request.jwt.claims', '{}', true), set_config('request.jwt.claim.sub', '', true)`);
    await tx.execute(sql`set local role anon`);
    return fn(tx);
  });
}
