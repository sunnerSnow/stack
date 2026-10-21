/**
 * 等角 2×2 積木（與首頁原型 design/landing-stack.html 同一套畫法）。
 *
 * 一塊積木：上面＋左面＋右面＋四顆凸點；沿牆方向一格在畫面上是 (+60, +18)，一層是 (0, −40)。
 * 積木牆排成錯縫的金字塔，最上面是虛線的「下一塊」。
 */

export const BRICK = { cash: "#F5D548", tw: "#187F7C", us: "#173451", cream: "#F5F0E5" } as const;
const NAVY = "#173451";

const TOP = "60,40 0,22 60,4 120,22";
const LEFT = "0,22 60,40 60,80 0,62";
const RIGHT = "60,40 120,22 120,62 60,80";

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * (1 + k)))));
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function BrickShape({ color, line = NAVY, ghost = false }: { color: string; line?: string; ghost?: boolean }) {
  const [top, left, right] = ghost ? ["#FFFDF8", "#E9E1CF", "#F2ECDF"] : [color, shade(color, -0.28), shade(color, -0.14)];
  const dash = ghost ? "5 4" : undefined;
  return (
    <>
      <polygon points={TOP} fill={top} />
      <polygon points={LEFT} fill={left} />
      <polygon points={RIGHT} fill={right} />
      <g fill={top} stroke={line} strokeWidth={2} strokeDasharray={dash}>
        <ellipse cx={36} cy={22} rx={11} ry={5.5} />
        <ellipse cx={60} cy={15} rx={11} ry={5.5} />
        <ellipse cx={60} cy={29} rx={11} ry={5.5} />
        <ellipse cx={84} cy={22} rx={11} ry={5.5} />
      </g>
      <g fill="none" stroke={line} strokeWidth={2.5} strokeLinejoin="round" strokeDasharray={dash}>
        <polygon points={TOP} />
        <polygon points={LEFT} />
        <polygon points={RIGHT} />
      </g>
    </>
  );
}

/** 單獨一塊（卡片上的小積木） */
export function MiniBrick({ color, line = NAVY, className }: { color: string; line?: string; className?: string }) {
  return (
    <svg viewBox="0 0 120 84" className={className} aria-hidden="true">
      <BrickShape color={color} line={line} />
    </svg>
  );
}

export interface WallBrick {
  label: string;
  color: string;
  /** 滑過時的完整說明 */
  title?: string;
}

/**
 * 積木牆：依序由下往上、由左往右疊成金字塔，最上面一塊是虛線的「下一塊」（ghostLabel）。
 * 最底層的寬度取「放得下全部」的最小值。
 */
export function BrickWall({ bricks, ghostLabel, animate = true, className }: { bricks: WallBrick[]; ghostLabel?: string; animate?: boolean; className?: string }) {
  const items = [...bricks.map((b) => ({ ...b, ghost: false })), ...(ghostLabel ? [{ label: ghostLabel, color: "#FFFDF8", ghost: true, title: undefined }] : [])];
  let base = 1;
  while ((base * (base + 1)) / 2 < items.length) base++;
  const slots: { c: number; L: number }[] = [];
  for (let L = 0; L < base; L++) for (let i = 0; i < base - L; i++) slots.push({ c: L * 0.5 + i, L });
  // 最上一層沒放滿時置中
  const placed = items.map((item, k) => ({ item, ...slots[k] }));
  const topLayer = placed.at(-1)?.L ?? 0;
  const inTop = placed.filter((p) => p.L === topLayer);
  const shift = ((base - topLayer) - inTop.length) / 2;
  for (const p of inTop) p.c += shift;

  const pos = placed.map((p) => ({ ...p, x: p.c * 60, y: p.c * 18 - p.L * 40 }));
  const minX = Math.min(...pos.map((p) => p.x)) - 6;
  const maxX = Math.max(...pos.map((p) => p.x)) + 126;
  const minY = Math.min(...pos.map((p) => p.y)) - (animate ? 30 : 8);
  const maxY = Math.max(...pos.map((p) => p.y)) + 86;

  return (
    <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className={className} role="img" aria-label={`積木牆：${bricks.map((b) => b.label).join("、")}`}>
      {pos.map((p, k) => {
        const text = p.item.ghost ? NAVY : p.item.color === BRICK.cash || p.item.color === BRICK.cream ? NAVY : BRICK.cream;
        return (
          // 位置放外層 g 的 transform 屬性；掉落動畫放內層 g（同一層的話 CSS transform 會蓋掉 SVG 的 translate）
          <g key={`${p.item.label}-${k}`} transform={`translate(${p.x} ${p.y})`}>
            <g className={animate ? (p.item.ghost ? "brick brick-ghost" : "brick") : undefined} style={animate ? { animationDelay: `${k * 110 + 150}ms` } : undefined}>
              {p.item.title ? <title>{p.item.title}</title> : null}
              <BrickShape color={p.item.color} ghost={p.item.ghost} />
              {/* 代號貼在左面：斜率 18/60 = 0.3，跟著面一起斜 */}
              <text x={7} y={48} transform="matrix(1 0.3 0 1 0 0)" fill={text} fontFamily="var(--font-mono)" fontSize={11} fontWeight={500} letterSpacing="0.04em">
                {p.item.label.length > 8 ? `${p.item.label.slice(0, 7)}…` : p.item.label}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
