import { describe, expect, it } from "vitest";
import { arrangeIslands, flyoutSpots, grid, ITEM, islandBox, islandSilhouettes, shift, slotAt, type Box } from "@/app/market/islands";

const overlaps = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const hub: Box = { x0: -150, y0: -90, x1: 150, y1: 120 };

describe("brick city islands", () => {
  it("sizes a grid by tower count and can turn it", () => {
    expect([1, 2, 3, 4, 6, 7, 9].map((n) => grid(n))).toEqual([
      { cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 2 }, { cols: 3, rows: 2 }, { cols: 3, rows: 3 }, { cols: 3, rows: 3 },
    ]);
    expect(grid(5, true)).toEqual({ cols: 2, rows: 3 });
  });

  it("fills slots from the back corner forward", () => {
    const shape = { ...grid(9), slot: 130, terrace: "right" as const };
    expect(slotAt(shape, 0).y).toBeLessThan(slotAt(shape, 4).y);
    expect(slotAt(shape, 4)).toEqual({ x: 0, y: 0 });
    expect(slotAt(shape, 8).y).toBeGreaterThan(slotAt(shape, 4).y);
  });

  it("spreads crowded islands apart without touching the square, the same way every time", () => {
    const islands = [9, 1, 7, 3, 6, 4, 9].map((count, i) => ({
      id: `d${i}`, angle: -140 + i * 50, reach: 1, box: islandBox({ ...grid(count, i % 2 === 1), slot: 130, terrace: i < 3 ? "left" : "right" }, 90),
    }));
    const placed = arrangeIslands(islands, hub, { x: 300, y: 200 });
    const boxes = islands.map((island) => shift(island.box, placed.get(island.id)!));
    boxes.forEach((box, i) => {
      expect(overlaps(box, hub)).toBe(false);
      boxes.slice(i + 1).forEach((other) => expect(overlaps(box, other)).toBe(false));
    });
    expect(arrangeIslands(islands, hub, { x: 300, y: 200 })).toEqual(placed);
  });

  it("traces what an island covers, towers included", () => {
    const shape = { ...grid(4), slot: 130, terrace: "right" as const };
    const [plate] = islandSilhouettes(shape, { x: 1000, y: 0 }, 150);
    const box = shift(islandBox(shape, 150), { x: 1000, y: 0 });
    expect(Math.min(...plate.map((p) => p.y))).toBeCloseTo(box.y0, 0);
    expect(Math.min(...plate.map((p) => p.x))).toBeGreaterThanOrEqual(box.x0);
  });

  it("settles stocks into free space beside the island, leaning away from the square", () => {
    const target: Box = { x0: 0, y0: 0, x1: 300, y1: 200 };
    const frame: Box = { x0: -900, y0: -700, x1: 1200, y1: 900 };
    const island = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }];
    const clear = (spots: { x: number; y: number }[]) => spots.every((p) => p.x + ITEM.w / 2 <= target.x0 || p.x - ITEM.w / 2 >= target.x1 || p.y + ITEM.h / 2 <= target.y0 || p.y - ITEM.h / 2 >= target.y1);
    const right = flyoutSpots(target, [island], frame, { x: 1, y: 0 }, 4);
    expect(clear(right)).toBe(true);
    expect(right.filter((p) => p.x > 150).length).toBeGreaterThanOrEqual(3);
    // A neighbour fills the right-hand side, so the stocks move elsewhere.
    const wall = [{ x: 320, y: -700 }, { x: 1200, y: -700 }, { x: 1200, y: 900 }, { x: 320, y: 900 }];
    const moved = flyoutSpots(target, [island, wall], frame, { x: 1, y: 0 }, 4);
    expect(clear(moved)).toBe(true);
    expect(moved.every((p) => p.x + ITEM.w / 2 <= 330)).toBe(true);
    moved.forEach((p, i) => moved.slice(i + 1).forEach((q) => expect(Math.abs(p.x - q.x) >= ITEM.w || Math.abs(p.y - q.y) >= ITEM.h).toBe(true)));
    expect(flyoutSpots(target, [island], frame, { x: 1, y: 0 }, 0)).toEqual([]);
  });
});
