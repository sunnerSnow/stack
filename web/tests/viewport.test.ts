import { describe, expect, it } from "vitest";
import {
  clampViewportScale,
  createDefaultViewport,
  panBy,
  zoomAt,
} from "../src/lib/market/viewport";

describe("galaxy viewport", () => {
  it("returns a fresh overview viewport", () => {
    const viewport = createDefaultViewport();
    viewport.x = 10;
    expect(createDefaultViewport()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("clamps zoom to the supported range and defaults invalid scales", () => {
    expect(clampViewportScale(0.1)).toBe(0.55);
    expect(clampViewportScale(5)).toBe(3);
    expect(clampViewportScale(1.5)).toBe(1.5);
    expect(clampViewportScale(NaN)).toBe(1);
    expect(clampViewportScale(Infinity)).toBe(1);
  });

  it("pans in screen pixels without mutating its input", () => {
    const viewport = { x: 20, y: -10, scale: 2 };
    expect(panBy(viewport, 30, -40)).toEqual({ x: 50, y: -50, scale: 2 });
    expect(viewport).toEqual({ x: 20, y: -10, scale: 2 });
  });

  it("keeps the world point under the zoom anchor stationary", () => {
    const viewport = { x: 20, y: -10, scale: 2 };
    const anchor = { x: 100, y: 70 };
    const zoomed = zoomAt(viewport, anchor, 3);
    expect(zoomed).toEqual({ x: -20, y: -50, scale: 3 });
    expect((anchor.x - zoomed.x) / zoomed.scale).toBe(40);
    expect((anchor.y - zoomed.y) / zoomed.scale).toBe(40);
    expect(zoomAt(viewport, anchor, 20)).toEqual(zoomed);
  });

  it("normalizes nonfinite inputs and prevents arithmetic overflow", () => {
    expect(panBy({ x: NaN, y: Infinity, scale: -1 }, NaN, 4)).toEqual({ x: 0, y: 4, scale: 0.55 });
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: NaN, y: Infinity }, 2)).toEqual({ x: 0, y: 0, scale: 2 });
    const overflow = panBy({ x: Number.MAX_VALUE, y: 0, scale: 1 }, Number.MAX_VALUE, 0);
    expect(Number.isFinite(overflow.x)).toBe(true);
  });
});
