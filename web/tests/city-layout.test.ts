import { describe, expect, it } from "vitest";
import { buildCityDistricts, cityScale, type CityGroup } from "../src/lib/market/city-layout";

const group = (id: string, parentId: string | null, turnover = 100, amount: number | null = 1): CityGroup => ({
  id, name: id, parentId, level: "industry", turnover,
  flow: { foreign: amount, trust: amount === null ? null : 0, dealer: amount === null ? null : 0 },
});
const sector: CityGroup = { ...group("sector", null), level: "sector" };

describe("brick city districts", () => {
  it("resolves sector ancestors and falls back safely for missing parents and cycles", () => {
    const groups: CityGroup[] = [sector, group("parent", "sector"), { ...group("theme", "parent"), level: "theme" },
      { ...group("orphan", "missing"), level: "theme" }, { ...group("a", "b"), level: "theme" }, { ...group("b", "a"), level: "theme" }];
    const result = buildCityDistricts(groups, "theme");
    expect(result.find((district) => district.id === "sector")!.groups.map((item) => item.id)).toEqual(["theme"]);
    expect(result.find((district) => district.id === "other")!.groups.map((item) => item.id)).toEqual(["a", "b", "orphan"]);
  });

  it("limits overview to nine, preserves selected groups, and expands the focused district", () => {
    const groups = [sector, ...Array.from({ length: 12 }, (_, i) => group(`g${i}`, "sector", i))];
    const overview = buildCityDistricts(groups, "industry")[0];
    expect(overview.groups.map((item) => item.id)).toEqual(["g11", "g10", "g9", "g8", "g7", "g6", "g5", "g4", "g3"]);
    expect(overview.totalGroups).toBe(12);
    expect([overview.columns, overview.rows]).toEqual([3, 3]);
    expect(buildCityDistricts(groups, "industry", null, "g0")[0].groups.map((item) => item.id)).toContain("g0");
    const focused = buildCityDistricts(groups, "industry", "sector")[0];
    expect(focused.groups).toHaveLength(12);
    expect([focused.columns, focused.rows]).toEqual([4, 3]);
  });

  it("is stable under reorder and uses spaced categorical slots", () => {
    const groups = [sector, ...Array.from({ length: 8 }, (_, i) => group(`g${i}`, "sector"))];
    const result = buildCityDistricts(groups, "industry");
    expect(buildCityDistricts([...groups].reverse(), "industry")).toEqual(result);
    expect(result[0].groups.slice(0, 4).map(({ u, v }) => [u, v])).toEqual([[0, 0], [2.8, 0], [5.6, 0], [0, 2.8]]);
    expect(Number.isFinite(result[0].x + result[0].y)).toBe(true);
  });

  it("scales raw turnover and flow magnitudes while preserving flow signs and missing values", () => {
    const result = buildCityDistricts([sector, group("small", "sector", 1e8, 1), group("medium", "sector", 1e10, -25),
      group("large", "sector", 1e11, 100), group("zero", "sector", 0, 0), group("missing", "sector", 0, null)], "industry")[0];
    const get = (id: string) => result.groups.find((item) => item.id === id)!;
    expect(get("small").footprint).toBeLessThan(get("medium").footprint);
    expect(get("medium").footprint).toBeLessThan(get("large").footprint);
    expect(get("large").footprint).toBe(1.35);
    expect(get("medium").layers).toBe(3);
    expect(get("medium").flow).toBe(-25);
    expect(get("large").layers).toBe(6);
    expect(get("zero").layers).toBe(0);
    expect(get("missing").layers).toBeNull();
    expect(get("missing").flow).toBeNull();
  });

  it("keeps scales fixed when a district expands to reveal a high-flow low-turnover group", () => {
    const groups = [sector, ...Array.from({ length: 9 }, (_, i) => group(`g${i}`, "sector", 100 + i, 1)), group("hidden", "sector", 1, 100)];
    const initial = buildCityDistricts(groups, "industry")[0].groups.find((g) => g.id === "g0")!;
    const expanded = buildCityDistricts(groups, "industry", "sector")[0].groups.find((g) => g.id === "g0")!;
    expect(initial.layers).toBe(expanded.layers);
    expect(initial.footprint).toBe(expanded.footprint);
  });

  it("reads one institution at a time; a missing institution only blocks its own value and the total", () => {
    const mixed: CityGroup = { ...group("mixed", "sector", 100), flow: { foreign: -40, trust: null, dealer: 10 } };
    const pick = (kind: "total" | "foreign" | "trust" | "dealer") => buildCityDistricts([sector, mixed, group("big", "sector", 100, 80)], "industry", null, null, { kind })[0].groups.find((g) => g.id === "mixed")!;
    expect(pick("foreign")).toMatchObject({ flow: -40, layers: 4 });
    expect(pick("dealer")).toMatchObject({ flow: 10, layers: 6 });
    expect(pick("trust")).toMatchObject({ flow: null, layers: null });
    expect(pick("total")).toMatchObject({ flow: null, layers: null });
  });

  it("replays other days on a shared scale while keeping today's tower order", () => {
    const today = [sector, group("a", "sector", 100, 10), group("b", "sector", 50, 10)];
    const before = [sector, { ...group("a", "sector", 10, 5), rank: 100 }, { ...group("b", "sector", 200, 40), rank: 50 }];
    const scale = cityScale([...today, ...before], "industry", "total");
    expect(scale).toEqual({ turnover: 200, flow: 40 });
    const replay = buildCityDistricts(before, "industry", null, null, { scale })[0];
    expect(replay.groups.map((g) => g.id)).toEqual(["a", "b"]);
    expect(replay.groups.find((g) => g.id === "b")).toMatchObject({ footprint: 1.35, layers: 6 });
    expect(buildCityDistricts(today, "industry", null, null, { scale })[0].groups.find((g) => g.id === "a")!.layers).toBe(3);
  });
});
