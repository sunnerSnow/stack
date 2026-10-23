import type { Metadata } from "next";
import { IBM_Plex_Mono, Noto_Sans_TC, Noto_Serif_TC, Unbounded } from "next/font/google";
import "./globals.css";

const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"], weight: ["500", "700", "900"] });
const notoTC = Noto_Sans_TC({ variable: "--font-noto-tc", weight: ["400", "500", "700", "900"], preload: false });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });
// 只有首頁的「疊」用到
const notoSerifTC = Noto_Serif_TC({ variable: "--font-noto-serif-tc", weight: ["900"], preload: false });

export const metadata: Metadata = {
  title: { default: "STACK", template: "%s · STACK" },
  description: "Build Your Financial World. 把投資，一塊一塊拼起來。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-Hant" className={`${unbounded.variable} ${notoTC.variable} ${notoSerifTC.variable} ${plexMono.variable} h-full`}>
      {/* Browser extensions may add body attributes (e.g. cz-shortcut-listen) before hydration.
          Tolerate only this root element; application descendants still get hydration checks. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>{children}</body>
    </html>
  );
}
