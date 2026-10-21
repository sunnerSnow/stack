"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** 三個模組（首頁的 EXPLORE／BUILD／DISCOVER）；還沒做的標「即將推出」 */
export function ModuleNav() {
  const path = usePathname();
  const explore = path.startsWith("/market");
  return (
    <nav aria-label="模組" className="order-3 flex w-full items-center justify-between gap-4 border-t-2 border-ink pt-2.5 sm:order-none sm:w-auto sm:justify-start sm:gap-7 sm:border-t-0 sm:pt-0">
      <Link href="/market" className="nav-mod" aria-current={explore ? "page" : undefined}>
        Explore<span className="hidden lg:inline"> 探索市場</span>
      </Link>
      <Link href="/portfolios" className="nav-mod" aria-current={explore ? undefined : "page"}>
        Build<span className="hidden lg:inline"> 組合資產</span>
      </Link>
      <span className="nav-mod soon" title="發掘觀點：即將推出">
        Discover<span className="hidden lg:inline"> 發掘觀點</span>
      </span>
    </nav>
  );
}
