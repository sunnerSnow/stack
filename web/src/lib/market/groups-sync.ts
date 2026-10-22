import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets, marketGroupMembers, marketGroups } from "@/lib/db/schema";
import { industryId, OTHER_SECTOR, parseMember, sameName, SECTORS, sectorOf, THEMES } from "@/lib/market/groups";

/**
 * 把板塊、產業、族群與成員寫進資料庫（排程以資料庫擁有者身分執行，每天跑一次）。
 * 族群成員的代號找不到、或名稱跟資產主檔對不上（多半是代號打錯），不加入並列在 issues。
 */

export interface GroupSyncReport {
  sectors: number;
  industries: number;
  themes: number;
  members: number;
  issues: string[];
}

type GroupRow = typeof marketGroups.$inferInsert;

export async function syncGroups(db: Db): Promise<GroupSyncReport> {
  const tw = await db
    .select({ id: assets.id, symbol: assets.symbol, name: assets.name, kind: sql<string | null>`${assets.metadata}->>'kind'`, industry: sql<string | null>`${assets.metadata}->>'industry'` })
    .from(assets)
    .where(and(eq(assets.market, "TW"), isNull(assets.createdBy), eq(assets.isActive, true)));
  const stocks = tw.filter((a) => a.kind === "stock");
  const bySymbol = new Map(tw.map((a) => [a.symbol, a]));
  const issues: string[] = [];

  const groups: GroupRow[] = [{ id: "market", name: "上市櫃全部", level: "market", parentId: null, sortOrder: 0 }];
  const members = new Map<string, Set<string>>([["market", new Set(stocks.map((s) => s.id))]]);

  // 產業（只算普通股）與板塊
  const industries = [...new Set(stocks.map((s) => s.industry).filter((x): x is string => Boolean(x)))].sort();
  const usedSectors = new Set(industries.map((i) => sectorOf(i).id));
  [...SECTORS, OTHER_SECTOR]
    .filter((s) => usedSectors.has(s.id) || s.id !== OTHER_SECTOR.id)
    .forEach((s, i) => {
      groups.push({ id: `sector-${s.id}`, name: s.name, level: "sector", parentId: null, sortOrder: i + 1 });
      // 板塊的成員＝底下各產業的普通股
      members.set(`sector-${s.id}`, new Set(stocks.filter((x) => x.industry && sectorOf(x.industry).id === s.id).map((x) => x.id)));
    });
  industries.forEach((name, i) => {
    const id = industryId(name);
    groups.push({ id, name, level: "industry", parentId: `sector-${sectorOf(name).id}`, sortOrder: 100 + i });
    members.set(id, new Set(stocks.filter((s) => s.industry === name).map((s) => s.id)));
  });
  const ids = new Set(groups.map((g) => g.id));

  // 族群
  THEMES.forEach((t, i) => {
    const parent = SECTORS.some((s) => s.id === t.parent) ? `sector-${t.parent}` : industryId(t.parent);
    if (!ids.has(parent)) issues.push(`族群「${t.name}」的上層「${t.parent}」不存在，改成不掛上層`);
    const set = new Set<string>();
    for (const m of t.members) {
      const { symbol, name } = parseMember(m);
      const asset = bySymbol.get(symbol);
      if (!asset) issues.push(`族群「${t.name}」：找不到 ${symbol}（${name}），可能下市或代號錯誤`);
      else if (name && !sameName(name, asset.name)) issues.push(`族群「${t.name}」：${symbol} 在資產主檔是「${asset.name}」，不是「${name}」，沒有加入`);
      else set.add(asset.id);
    }
    groups.push({ id: `theme-${t.id}`, name: t.name, level: "theme", parentId: ids.has(parent) ? parent : null, sortOrder: 1000 + i });
    members.set(`theme-${t.id}`, set);
  });

  // 寫入：群組（依層級順序，上層先存在）→ 停用不在清單裡的 → 成員
  for (const level of ["market", "sector", "industry", "theme"] as const) {
    const rows = groups.filter((g) => g.level === level);
    if (rows.length === 0) continue;
    await db
      .insert(marketGroups)
      .values(rows.map((g) => ({ ...g, isActive: true })))
      .onConflictDoUpdate({
        target: marketGroups.id,
        set: { name: sql`excluded.name`, level: sql`excluded.level`, parentId: sql`excluded.parent_id`, sortOrder: sql`excluded.sort_order`, isActive: sql`true`, updatedAt: sql`now()` },
      });
  }
  const allIds = groups.map((g) => g.id!);
  await db.update(marketGroups).set({ isActive: false }).where(notInArray(marketGroups.id, allIds));

  let count = 0;
  for (const [gid, set] of members) {
    const want = [...set];
    if (want.length > 0) {
      await db.delete(marketGroupMembers).where(and(eq(marketGroupMembers.groupId, gid), notInArray(marketGroupMembers.assetId, want)));
      for (let k = 0; k < want.length; k += 2000) {
        await db
          .insert(marketGroupMembers)
          .values(want.slice(k, k + 2000).map((a) => ({ groupId: gid, assetId: a })))
          .onConflictDoNothing();
      }
    } else {
      await db.delete(marketGroupMembers).where(eq(marketGroupMembers.groupId, gid));
    }
    count += want.length;
  }
  // 停用的群組不留成員
  await db.delete(marketGroupMembers).where(notInArray(marketGroupMembers.groupId, allIds));

  return {
    sectors: groups.filter((g) => g.level === "sector").length,
    industries: industries.length,
    themes: THEMES.length,
    members: count,
    issues,
  };
}

/** 族群成員的代號與名稱（審核用） */
export async function themeReview(db: Db): Promise<{ id: string; name: string; members: { symbol: string; name: string }[] }[]> {
  const rows = await db
    .select({ g: marketGroups.id, gname: marketGroups.name, symbol: assets.symbol, name: assets.name })
    .from(marketGroups)
    .innerJoin(marketGroupMembers, eq(marketGroupMembers.groupId, marketGroups.id))
    .innerJoin(assets, eq(assets.id, marketGroupMembers.assetId))
    .where(and(eq(marketGroups.level, "theme"), inArray(marketGroups.id, THEMES.map((t) => `theme-${t.id}`))));
  return THEMES.map((t) => ({
    id: t.id,
    name: t.name,
    members: rows.filter((r) => r.g === `theme-${t.id}`).map((r) => ({ symbol: r.symbol, name: r.name })),
  }));
}
