import { describe, expect, it } from "vitest";
import { buildCityDistricts, type CityGroup } from "../src/lib/market/city-layout";

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

  it("limits overview to six, preserves selected groups, and expands the focused district", () => {
    const groups = [sector, ...Array.from({ length: 10 }, (_, i) => group(`g${i}`, "sector", i))];
    const overview = buildCityDistricts(groups, "industry")[0];
    expect(overview.groups.map((item) => item.id)).toEqual(["g9", "g8", "g7", "g6", "g5", "g4"]);
    expect(overview.totalGroups).toBe(10);
    expect([overview.columns, overview.rows]).toEqual([3, 2]);
    expect(buildCityDistricts(groups, "industry", null, "g0")[0].groups.map((item) => item.id)).toContain("g0");
    const focused = buildCityDistricts(groups, "industry", "sector")[0];
    expect(focused.groups).toHaveLength(10);
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
    const groups = [sector, ...Array.from({ length: 6 }, (_, i) => group(`g${i}`, "sector", 100 + i, 1)), group("hidden", "sector", 1, 100)];
    const initial = buildCityDistricts(groups, "industry")[0].groups.find((g) => g.id === "g0")!;
    const expanded = buildCityDistricts(groups, "industry", "sector")[0].groups.find((g) => g.id === "g0")!;
    expect(initial.layers).toBe(expanded.layers);
    expect(initial.footprint).toBe(expanded.footprint);
  });
});
