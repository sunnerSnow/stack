/** STACK 標誌：三塊錯縫往上疊的積木 */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#173451" />
      <rect x="5" y="20" width="22" height="6" rx="1.5" fill="#F5D548" />
      <rect x="8.5" y="13" width="15" height="6" rx="1.5" fill="#187F7C" />
      <rect x="12" y="6" width="8" height="6" rx="1.5" fill="#F5F0E5" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark />
      <span className="display text-[19px] tracking-[0.04em]">STACK</span>
    </span>
  );
}
