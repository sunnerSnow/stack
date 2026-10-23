import { describe, expect, it } from "vitest";
import { layoutGalaxy, type GalaxyLayoutNode } from "../src/lib/market/galaxy-layout";

const node = (id: string, x: number, y: number, size = 10): GalaxyLayoutNode => ({ id, x, y, size, kind: "group" });

describe("galaxy metric layout", () => {
  it("projects the actual RS centerlines and separates display positions from anchors", () => {
    const result = layoutGalaxy([node("center", 100, 100), node("right", 110, 100), node("up", 100, 110)], 900, 600, "rs");
    const [center, right, up] = ["center", "right", "up"].map((id) => result.points.find((point) => point.id === id)!);
    expect(center.anchorX).toBe(result.center.x);
    expect(center.anchorY).toBe(result.center.y);
    expect(right.anchorX).toBeGreaterThan(center.anchorX);
    expect(right.anchorY).toBe(center.anchorY);
    expect(up.anchorX).toBe(center.anchorX);
    expect(up.anchorY).toBeLessThan(center.anchorY);
    expect(Math.hypot(center.x - center.anchorX, center.y - center.anchorY)).toBeGreaterThan(85);
  });

  it("centers IS strength at 100 and daily return at zero", () => {
    const result = layoutGalaxy([node("zero", 100, 0), node("gain", 105, 0.01)], 900, 600, "is");
    const zero = result.points.find((point) => point.id === "zero")!;
    expect([zero.anchorX, zero.anchorY]).toEqual([result.center.x, result.center.y]);
    expect(result.xRange[0] + result.xRange[1]).toBe(200);
    expect(result.yRange[0] + result.yRange[1]).toBe(0);
    expect(result.yRange).toEqual([-0.02, 0.02]);
    const gain = result.points.find((point) => point.id === "gain")!;
    expect(gain.anchorY).toBe(188);
  });

  it("uses bounded area-based sizes separately for groups and members", () => {
    const result = layoutGalaxy([
      node("small", 100, 100, 1), node("large", 100, 100, 100),
      { ...node("member", 100, 100, 100), kind: "member" },
      node("invalid", 100, 100, NaN),
    ], 900, 600, "rs");
    const radius = (id: string) => result.points.find((point) => point.id === id)!.radius;
    expect(radius("large")).toBeGreaterThan(radius("small"));
    expect(radius("large")).toBeLessThanOrEqual(30);
    expect(radius("member")).toBeLessThanOrEqual(15);
    expect(radius("invalid")).toBe(12);
  });

  it("preserves turnover size differences and scales members independently", () => {
    const result = layoutGalaxy([
      node("small", 101, 101, 1e8), node("medium", 101, 101, 1e10), node("large", 101, 101, 1e11),
      { ...node("member", 101, 101, 1e8), kind: "member" },
    ], 900, 600, "rs");
    const radius = (id: string) => result.points.find((point) => point.id === id)!.radius;
    expect(radius("small")).toBeLessThan(radius("medium"));
    expect(radius("medium")).toBeLessThan(radius("large"));
    expect(radius("large")).toBe(30);
    expect(radius("member")).toBe(15);
  });

  it("keeps near-neutral RS changes legible using narrow minimum ranges", () => {
    const result = layoutGalaxy([node("near", 101, 100.75)], 900, 600, "rs");
    expect(result.xRange).toEqual([98, 102]);
    expect(result.yRange).toEqual([98.5, 101.5]);
    expect(result.points[0].anchorX).toBe(637);
    expect(result.points[0].anchorY).toBe(188);
  });

  it("is deterministic under input reorder, bounded, and clear of the hub", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(`node-${i}`, 100, 100, i));
    const result = layoutGalaxy(nodes, 720, 560, "rs");
    expect(layoutGalaxy([...nodes].reverse(), 720, 560, "rs")).toEqual(result);
    for (const point of result.points) {
      expect(point.x - point.radius).toBeGreaterThanOrEqual(44);
      expect(point.x + point.radius).toBeLessThanOrEqual(676);
      expect(point.y - point.radius).toBeGreaterThanOrEqual(44);
      expect(point.y + point.radius).toBeLessThanOrEqual(516);
      expect(Math.hypot(point.x - result.center.x, point.y - result.center.y)).toBeGreaterThanOrEqual(85 + point.radius - 0.001);
    }
    expect(new Set(result.points.map((point) => `${point.x},${point.y}`)).size).toBe(nodes.length);
  });

  it("filters invalid coordinates and handles empty, extreme, or invalid dimensions", () => {
    expect(layoutGalaxy([], NaN, Infinity, "rs").points).toEqual([]);
    const result = layoutGalaxy([node("bad", NaN, 100), node("infinite", 100, Infinity), node("extreme", 1e300, -1e300)], 0, -1, "rs");
    expect(result.points.map((point) => point.id)).toEqual(["extreme"]);
    for (const value of Object.values(result.points[0]).filter((value) => typeof value === "number")) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
