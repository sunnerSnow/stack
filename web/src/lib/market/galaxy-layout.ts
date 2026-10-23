export type GalaxyLayoutNode = {
  id: string;
  x: number;
  y: number;
  size: number;
  kind: "group" | "member";
};

export type GalaxyLayoutPoint = {
  id: string;
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  radius: number;
};

export type GalaxyLayout = {
  center: { x: number; y: number };
  points: GalaxyLayoutPoint[];
  xRange: [number, number];
  yRange: [number, number];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const dimension = (value: number, min: number) => Number.isFinite(value) ? clamp(value, min, 10000) : min;

function angleFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296 * Math.PI * 2;
}

/** Metric anchors remain exact; only display centers move for legibility.
 * Dimensions below 720 × 560 use that minimum canvas size.
 */
export function layoutGalaxy(nodes: readonly GalaxyLayoutNode[], width: number, height: number, mode: "rs" | "is"): GalaxyLayout {
  const w = dimension(width, 720);
  const h = dimension(height, 560);
  const center = { x: w / 2, y: h / 2 };
  const baselineY = mode === "rs" ? 100 : 0;
  const valid = nodes.filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y))
    .map((node) => ({ ...node, x: clamp(node.x, -10000, 10000), y: clamp(node.y, -10000, 10000) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.x - b.x || a.y - b.y || a.kind.localeCompare(b.kind) || a.size - b.size);
  let extentX = 2;
  let extentY = mode === "rs" ? 1.5 : 0.02;
  const maxSize = { group: 0, member: 0 };
  for (const node of valid) {
    extentX = Math.max(extentX, Math.abs(node.x - 100));
    extentY = Math.max(extentY, Math.abs(node.y - baselineY));
    if (Number.isFinite(node.size)) maxSize[node.kind] = Math.max(maxSize[node.kind], node.size);
  }
  const points = valid.map((node): GalaxyLayoutPoint => {
    const size = Number.isFinite(node.size) ? Math.max(0, node.size) : 0;
    const fraction = maxSize[node.kind] > 0 ? size / maxSize[node.kind] : 0;
    const radius = node.kind === "group" ? clamp(12 + Math.sqrt(fraction) * 18, 12, 30) : clamp(7 + Math.sqrt(fraction) * 8, 7, 15);
    const anchorX = center.x + (node.x - 100) / extentX * (center.x - 76);
    const anchorY = center.y - (node.y - baselineY) / extentY * (center.y - 76);
    return { id: node.id, anchorX, anchorY, x: anchorX, y: anchorY, radius };
  });

  function constrain(point: GalaxyLayoutPoint): void {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const distance = Math.hypot(dx, dy);
    const minimum = 85 + point.radius;
    if (distance < minimum) {
      const angle = distance < 1e-9 ? angleFor(point.id) : Math.atan2(dy, dx);
      point.x = center.x + Math.cos(angle) * minimum;
      point.y = center.y + Math.sin(angle) * minimum;
    }
    point.x = clamp(point.x, 44 + point.radius, w - 44 - point.radius);
    point.y = clamp(point.y, 44 + point.radius, h - 44 - point.radius);
  }

  for (const point of points) constrain(point);
  for (let iteration = 0; iteration < 30; iteration++) {
    for (const point of points) {
      point.x += (point.anchorX - point.x) * 0.025;
      point.y += (point.anchorY - point.y) * 0.025;
    }
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        const minimum = a.radius + b.radius + 10;
        if (distance >= minimum) continue;
        const angle = distance < 1e-9 ? angleFor(`${a.id}:${b.id}`) : Math.atan2(dy, dx);
        const push = (minimum - distance) / 2;
        a.x -= Math.cos(angle) * push;
        a.y -= Math.sin(angle) * push;
        b.x += Math.cos(angle) * push;
        b.y += Math.sin(angle) * push;
      }
    }
    for (const point of points) constrain(point);
  }
  return {
    center,
    points,
    xRange: [100 - extentX, 100 + extentX],
    yRange: [baselineY - extentY, baselineY + extentY],
  };
}
