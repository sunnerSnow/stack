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

/** 玩具積木的幾何（scale = 1）：W 半寬、D 頂面半深、H 身高、S 凸點高 */
function toyGeometry(units: 1 | 2) {
  return { W: units === 2 ? 56 : 30, D: units === 2 ? 20 : 12, H: 28, S: 7 };
}

/** 積木在畫面上的範圍（像素，相對於中心）：給圖表把積木整塊留在框內 */
export function toyBrickExtent(units: 1 | 2, scale: number) {
  const { W, D, H, S } = toyGeometry(units);
  return { halfW: (W + 3) * scale, top: (D + H / 2 + S + 3) * scale, bottom: (D + H / 2 + 6) * scale };
}

/**
 * 圖表用的玩具積木：圓角、胖一點、凸點是有光澤的小圓柱，底下有影子；以中心為原點。
 * - glass：半透明＋虛線（下跌用，跟實心的上漲一眼分得出來）
 * - mood：在正面畫小臉（smile 上漲、sad 下跌、flat 平盤），只給比較大的積木
 */
export function ToyBrick({
  units = 2,
  scale = 1,
  color,
  line = NAVY,
  glass = false,
  outline,
  mood,
}: {
  units?: 1 | 2;
  scale?: number;
  color: string;
  line?: string;
  glass?: boolean;
  /** 額外的外框（含我的持股用黃色、選取用奶油白） */
  outline?: string;
  mood?: "smile" | "sad" | "flat";
}) {
  const { W, D, H, S } = toyGeometry(units);
  // 小積木的臉放大一點，才看得到
  const faceScale = (units === 2 ? 1 : 0.75) * Math.min(1.35, Math.max(1, 0.36 / scale));
  const y0 = -H / 2;
  const L: [number, number] = [-W, y0];
  const F: [number, number] = [0, D + y0];
  const R: [number, number] = [W, y0];
  const B: [number, number] = [0, -D + y0];
  const down = ([x, y]: [number, number]): [number, number] => [x, y + H];
  const pts = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(" ");
  const silhouette = pts([B, L, down(L), down(F), down(R), R]);
  const sw = 2.4 / Math.max(scale, 0.3);
  const top = glass ? color : color;
  const leftFill = glass ? color : shade(color, -0.2);
  const rightFill = glass ? color : shade(color, -0.08);
  const fillOpacity = glass ? 0.2 : 1;
  const stroke = glass ? color : line;
  const dash = glass ? "5 3" : undefined;
  // 凸點：頂面每一格的中心
  const cells = units === 2 ? [0.25, 0.75].flatMap((s) => [0.25, 0.75].map((t) => [s, t])) : [[0.5, 0.5]];
  const studs = cells
    .map(([s, t]) => [(t - s) * W, -D + y0 + (s + t) * D] as [number, number])
    .sort((p, q) => p[1] - q[1]);
  const rx = units === 2 ? 11.5 : 10.5;
  const ry = rx * 0.5;
  const faceColor = glass ? color : line;
  return (
    <g transform={`scale(${scale})`}>
      {/* 底板上的影子 */}
      <ellipse cx={0} cy={D + H / 2 + 3} rx={W * 0.92} ry={D * 0.55} fill="rgba(0,0,0,0.28)" />
      {outline ? <polygon points={silhouette} fill="none" stroke={outline} strokeWidth={sw * 2.6} strokeLinejoin="round" /> : null}
      <polygon points={pts([L, F, down(F), down(L)])} fill={leftFill} fillOpacity={fillOpacity} />
      <polygon points={pts([F, R, down(R), down(F)])} fill={rightFill} fillOpacity={fillOpacity} />
      <polygon points={pts([B, L, F, R])} fill={top} fillOpacity={glass ? 0.28 : 1} />
      {/* 頂面左上緣的反光 */}
      {glass ? null : <polyline points={pts([[L[0] + 6, L[1] - 1], [B[0], B[1] + 3], [R[0] - 6, R[1] - 1]])} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth={sw * 0.9} strokeLinecap="round" strokeLinejoin="round" />}
      {/* 凸點：小圓柱＋頂部亮面＋一點高光 */}
      {studs.map(([cx, cy], i) => (
        <g key={i}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={glass ? color : shade(color, -0.18)} fillOpacity={glass ? 0.25 : 1} stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={dash} />
          <rect x={cx - rx} y={cy - S} width={rx * 2} height={S} fill={glass ? color : shade(color, -0.18)} fillOpacity={glass ? 0.25 : 1} />
          <line x1={cx - rx} y1={cy - S} x2={cx - rx} y2={cy} stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={dash} />
          <line x1={cx + rx} y1={cy - S} x2={cx + rx} y2={cy} stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={dash} />
          <ellipse cx={cx} cy={cy - S} rx={rx} ry={ry} fill={glass ? color : shade(color, 0.12)} fillOpacity={glass ? 0.35 : 1} stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={dash} />
          {glass ? null : <ellipse cx={cx - rx * 0.35} cy={cy - S - ry * 0.25} rx={rx * 0.28} ry={ry * 0.32} fill="rgba(255,255,255,0.7)" />}
        </g>
      ))}
      <polygon points={silhouette} fill="none" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" strokeDasharray={dash} />
      <polyline points={pts([L, F, R])} fill="none" stroke={stroke} strokeWidth={sw * 0.8} strokeLinejoin="round" strokeDasharray={dash} />
      <line x1={F[0]} y1={F[1]} x2={F[0]} y2={F[1] + H} stroke={stroke} strokeWidth={sw * 0.8} strokeDasharray={dash} />
      {/* 正面的小臉（跟著左側面一起斜） */}
      {mood ? (
        <g transform={`translate(${-W / 2} ${D / 2 + 2}) matrix(1 ${D / W} 0 1 0 0) scale(${faceScale})`} fill="none" stroke={faceColor} strokeWidth={2.2} strokeLinecap="round">
          <circle cx={-6.5} cy={-3} r={2.3} fill={faceColor} stroke="none" />
          <circle cx={6.5} cy={-3} r={2.3} fill={faceColor} stroke="none" />
          {mood === "smile" ? (
            <>
              <path d="M -4.5 2 Q 0 6.5 4.5 2" />
              <ellipse cx={-11} cy={2} rx={2.6} ry={1.6} fill="rgba(255,255,255,0.45)" stroke="none" />
              <ellipse cx={11} cy={2} rx={2.6} ry={1.6} fill="rgba(255,255,255,0.45)" stroke="none" />
            </>
          ) : mood === "sad" ? (
            <path d="M -4.5 5.5 Q 0 1.5 4.5 5.5" />
          ) : (
            <path d="M -4 4 L 4 4" />
          )}
        </g>
      ) : null}
    </g>
  );
}
