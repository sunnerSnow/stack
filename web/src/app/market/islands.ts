/**
 * Brick-city islands. Each category block is a studded plate sized by how many towers it carries, with a
 * lower terrace in front for its name sign. Islands sit on a loose ring around the market square; position
 * and shape encode category only, never price or fund flow.
 */

/** Brick depth ÷ width: the city's isometric slope. */
export const R = 0.578;
export const RIM = 22;
export const TERRACE = 104;
export const PLATE_H = 34;
/** A stock that flies out of an island: brick plus name card. */
export const ITEM = { w: 184, h: 140 };

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Rect = { s0: number; s1: number; t0: number; t1: number };
export type Shape = { cols: number; rows: number; slot: number; terrace: "left" | "right" };
export type Point = { x: number; y: number };

/** Isometric plane → screen: s runs down-right, t runs down-left. */
export const iso = (s: number, t: number): Point => ({ x: (s - t) / 2, y: (s + t) * R / 2 });
export const corners = (r: Rect) => [iso(r.s0, r.t0), iso(r.s1, r.t0), iso(r.s1, r.t1), iso(r.s0, r.t1)];

/** Tower grid for a number of towers; `flip` turns a non-square grid the other way. */
export function grid(count: number, flip = false): Pick<Shape, "cols" | "rows"> {
  const [a, b] = count <= 1 ? [1, 1] : count === 2 ? [2, 1] : count <= 4 ? [2, 2] : count <= 6 ? [3, 2] : [3, 3];
  return flip ? { cols: b, rows: a } : { cols: a, rows: b };
}

/** The tower plate and the terrace along one of its front edges, centred on the island origin. */
export function plates({ cols, rows, slot, terrace }: Shape): { main: Rect; terrace: Rect } {
  const a = cols * slot + RIM * 2, b = rows * slot + RIM * 2;
  const edge = terrace === "right" ? b : a;
  const length = Math.min(edge, Math.max(240, edge * .65));
  return {
    main: { s0: -a / 2, s1: a / 2, t0: -b / 2, t1: b / 2 },
    terrace: terrace === "right"
      ? { s0: a / 2, s1: a / 2 + TERRACE, t0: b / 2 - length, t1: b / 2 }
      : { s0: a / 2 - length, s1: a / 2, t0: b / 2, t1: b / 2 + TERRACE },
  };
}

/** Centre of tower slot i, filled row by row from the back corner. */
export function slotAt({ cols, rows, slot }: Shape, i: number): Point {
  const a = cols * slot + RIM * 2, b = rows * slot + RIM * 2;
  return iso(-a / 2 + RIM + (i % cols + .5) * slot, -b / 2 + RIM + (Math.floor(i / cols) + .5) * slot);
}

/** Screen bounds of an island's plates, with `room` above for its towers. */
export function islandBox(shape: Shape, room: number): Box {
  const { main, terrace } = plates(shape);
  const points = [...corners(main), ...corners(terrace)];
  return {
    x0: Math.min(...points.map((p) => p.x)), x1: Math.max(...points.map((p) => p.x)),
    y0: Math.min(...points.map((p) => p.y)) - room, y1: Math.max(...points.map((p) => p.y)) + PLATE_H,
  };
}

export const shift = (b: Box, p: Point): Box => ({ x0: b.x0 + p.x, y0: b.y0 + p.y, x1: b.x1 + p.x, y1: b.y1 + p.y });
export const union = (boxes: Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
});
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * Start each island on an ellipse at its own angle and reach, then push apart any that crowd each other or
 * the square in the middle. Deterministic, so the city looks the same on every visit.
 */
export function arrangeIslands(islands: { id: string; angle: number; reach: number; box: Box }[], hub: Box, ring = { x: 620, y: 390 }, gap = 26): Map<string, Point> {
  const pos = islands.map((i) => ({ x: Math.cos(i.angle * Math.PI / 180) * ring.x * i.reach, y: Math.sin(i.angle * Math.PI / 180) * ring.y * i.reach }));
  // Push `p` (and `q` unless it is fixed) apart along the axis that needs the shorter move.
  const separate = (a: Box, b: Box, p: Point, q: Point | null) => {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + gap, oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + gap;
    if (ox <= 0 || oy <= 0) return false;
    const share = q ? .5 : 1;
    if (ox < oy) {
      const dir = (a.x0 + a.x1) / 2 < (b.x0 + b.x1) / 2 ? -1 : 1;
      p.x += dir * ox * share; if (q) q.x -= dir * ox * share;
    } else {
      const dir = (a.y0 + a.y1) / 2 < (b.y0 + b.y1) / 2 ? -1 : 1;
      p.y += dir * oy * share; if (q) q.y -= dir * oy * share;
    }
    return true;
  };
  for (let pass = 0; pass < 300; pass++) {
    let moved = false;
    islands.forEach((island, i) => {
      moved = separate(shift(island.box, pos[i]), hub, pos[i], null) || moved;
      for (let j = i + 1; j < islands.length; j++) moved = separate(shift(island.box, pos[i]), shift(islands[j].box, pos[j]), pos[i], pos[j]) || moved;
    });
    if (!moved) break;
  }
  return new Map(islands.map((island, i) => [island.id, pos[i]]));
}

/** Convex hull (monotone chain), counter-clockwise in screen coordinates. */
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: Point[]) => list.reduce<Point[]>((h, p) => {
    while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
    return [...h, p];
  }, []);
  const lower = half(sorted), upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const inside = (poly: Point[], p: Point) => poly.every((a, i) => {
  const b = poly[(i + 1) % poly.length];
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
});

/** What a slab really covers on screen: its top and sides, plus whatever stands up to `room` above it. */
export function silhouette(rect: Rect, at: Point, room: number, drop = 0): Point[] {
  const top = corners(rect).map((p) => ({ x: p.x + at.x, y: p.y + at.y + drop }));
  return hull([...top.map((p) => ({ x: p.x, y: p.y + PLATE_H - drop })), ...top.map((p) => ({ x: p.x, y: p.y - room }))]);
}

/** The silhouettes of an island: towers on the plate, the name plate on the terrace. */
export function islandSilhouettes(shape: Shape, at: Point, room: number): Point[][] {
  const { main, terrace } = plates(shape);
  return [silhouette(main, at, room), silhouette(terrace, at, 70, 10)];
}

/**
 * Where a group's stocks fly out. Each stock in turn takes the free spot around its island that covers the
 * least of any blocked shape, stays in the frame, sits close to the island and to the stock before it, and
 * leans toward `outward` — the side of the island its tower stands on.
 */
export function flyoutSpots(target: Box, blocked: Point[][], frame: Box, outward: Point, count: number): Point[] {
  const cx = (target.x0 + target.x1) / 2, cy = (target.y0 + target.y1) / 2;
  const hw = (target.x1 - target.x0) / 2, hh = (target.y1 - target.y0) / 2;
  const length = Math.hypot(outward.x, outward.y) || 1;
  const candidates = [0, 1, 2, 3].flatMap((ring) => Array.from({ length: 30 }, (_, k) => {
    const a = k * Math.PI / 15;
    return { ring, dir: { x: Math.cos(a), y: Math.sin(a) }, x: cx + Math.cos(a) * (hw * .8 + ITEM.w / 2 + ring * 70), y: cy + Math.sin(a) * (hh * .8 + ITEM.h / 2 + ring * 55) };
  }));
  const samples = [0, .25, .5, .75, 1].flatMap((u) => [0, .33, .67, 1].map((v) => ({ u, v })));
  const spots: Point[] = [];
  for (let n = 0; n < count; n++) {
    const score = (c: (typeof candidates)[number]) => {
      const item = { x0: c.x - ITEM.w / 2, y0: c.y - ITEM.h / 2, x1: c.x + ITEM.w / 2, y1: c.y + ITEM.h / 2 };
      const covered = samples.filter(({ u, v }) => blocked.some((poly) => inside(poly, { x: item.x0 + u * ITEM.w, y: item.y0 + v * ITEM.h }))).length / samples.length;
      const outside = 1 - overlap(item, frame) / (ITEM.w * ITEM.h);
      const crowded = spots.some((p) => Math.abs(p.x - c.x) < ITEM.w + 10 && Math.abs(p.y - c.y) < ITEM.h + 8);
      const apart = spots.length ? Math.min(...spots.map((p) => Math.hypot(p.x - c.x, p.y - c.y))) : 0;
      return covered * 8000 + outside * 6000 + (crowded ? 10000 : 0) + c.ring * 260 + apart * 1.2 - (c.dir.x * outward.x + c.dir.y * outward.y) / length * 900;
    };
    const best = candidates.reduce((a, b) => score(b) < score(a) ? b : a);
    spots.push({ x: best.x, y: best.y });
  }
  return spots;
}
