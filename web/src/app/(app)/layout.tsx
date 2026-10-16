import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { Brand } from "@/components/brand";
import { requireUser } from "@/lib/auth/session";
import { isLocalMode } from "@/lib/config";

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
      <header className="border-b-[3px] border-ink bg-cream">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/portfolios" aria-label="STACK 首頁">
            <Brand />
          </Link>
          <nav className="flex items-center gap-3 sm:gap-5">
            <Link href="/portfolios" className="display text-[11px] tracking-[0.1em] hover:underline">
              投資組合
            </Link>
            <span className="hidden text-xs text-ink-2 sm:inline">{user.email}</span>
            <form action={logoutAction}>
              <button className="btn btn-quiet" type="submit">
                登出
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6">{children}</main>
      <footer className="border-t-2 border-ink px-4 py-4 text-center text-xs text-ink-3">
        STACK · Build Your Financial World. 所有計算可追溯；缺少的資料會標示，不會用 0 代替。
      </footer>
    </>
  );
}
