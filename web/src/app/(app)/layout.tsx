import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { Brand } from "@/components/brand";
import { requireUser } from "@/lib/auth/session";
import { isLocalMode } from "@/lib/config";
import { ModuleNav } from "./module-nav";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // layout 只負責顯示；每個頁面仍會自己呼叫 requireUser
  const user = await requireUser();
  return (
    <>
      {isLocalMode() ? (
        <div className="bg-warn-bg text-warn text-xs text-center py-1.5 border-b-2 border-dashed border-warn">
          本機示範模式：資料只存在這台電腦，不是正式資料庫
        </div>
      ) : null}
      <header className="sticky top-0 z-30 border-b-[3px] border-ink bg-cream">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3 sm:flex-nowrap sm:px-6">
          <Link href="/" aria-label="STACK 首頁" className="shrink-0">
            <Brand />
          </Link>
          <ModuleNav />
          <div className="flex items-center gap-3">
            <span className="hidden max-w-48 truncate text-xs text-ink-2 md:inline">{user.email}</span>
            <form action={logoutAction}>
              <button className="btn btn-quiet" type="submit">
                登出
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 sm:px-6">{children}</main>
      <footer className="flex flex-wrap justify-between gap-2 border-t-[3px] border-ink px-4 py-5 font-mono text-[11.5px] tracking-[0.08em] sm:px-8">
        <span>STACK · Build Your Financial World.</span>
        <span className="text-ink-2">所有計算可追溯；缺少的資料會標示，不會用 0 代替。</span>
      </footer>
    </>
  );
}
