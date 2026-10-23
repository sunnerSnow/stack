export type ViewportPoint = { x: number; y: number };

/** Screen coordinates are world coordinates * scale + { x, y }. */
export type Viewport = ViewportPoint & { scale: number };

/** Optional zoom range; scenes that fit a large world into a small screen need their own bounds. */
export type ViewportLimits = { min: number; max: number };

export const MIN_VIEWPORT_SCALE = 0.55;
export const MAX_VIEWPORT_SCALE = 3;
const DEFAULT_LIMITS: ViewportLimits = { min: MIN_VIEWPORT_SCALE, max: MAX_VIEWPORT_SCALE };

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function createDefaultViewport(): Viewport {
  return { x: 0, y: 0, scale: 1 };
}

export function clampViewportScale(scale: number, limits: ViewportLimits = DEFAULT_LIMITS): number {
  return Math.min(limits.max, Math.max(limits.min, finiteOr(scale, 1)));
}

function normalize(viewport: Viewport, limits: ViewportLimits): Viewport {
  return {
    x: finiteOr(viewport.x, 0),
    y: finiteOr(viewport.y, 0),
    scale: clampViewportScale(viewport.scale, limits),
  };
}

/** Pan deltas are screen pixels, independent of the current zoom. */
export function panBy(viewport: Viewport, dx: number, dy: number, limits: ViewportLimits = DEFAULT_LIMITS): Viewport {
  const current = normalize(viewport, limits);
  return {
    x: finiteOr(current.x + finiteOr(dx, 0), current.x),
    y: finiteOr(current.y + finiteOr(dy, 0), current.y),
    scale: current.scale,
  };
}

/** Anchor uses local screen coordinates relative to the transform origin. */
export function zoomAt(viewport: Viewport, anchor: ViewportPoint, nextScale: number, limits: ViewportLimits = DEFAULT_LIMITS): Viewport {
  const current = normalize(viewport, limits);
  const scale = clampViewportScale(nextScale, limits);
  const ratio = scale / current.scale;
  const anchorX = finiteOr(anchor.x, 0);
  const anchorY = finiteOr(anchor.y, 0);
  return {
    x: finiteOr(anchorX - (anchorX - current.x) * ratio, current.x),
    y: finiteOr(anchorY - (anchorY - current.y) * ratio, current.y),
    scale,
  };
}

/**
 * Viewport that shows a world-space box centered inside a screen rectangle.
 * `area` is the unobstructed part of the screen (e.g. excluding a side panel).
 */
export function fitBox(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  area: { x: number; y: number; width: number; height: number },
  limits: ViewportLimits = DEFAULT_LIMITS,
  padding = 24,
): Viewport {
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const scale = clampViewportScale(Math.min(Math.max(1, area.width - padding * 2) / w, Math.max(1, area.height - padding * 2) / h), limits);
  return {
    x: finiteOr(area.x + area.width / 2 - (box.minX + w / 2) * scale, 0),
    y: finiteOr(area.y + area.height / 2 - (box.minY + h / 2) * scale, 0),
    scale,
  };
}
