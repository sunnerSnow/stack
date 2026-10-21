import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { loginLocalAction } from "@/app/actions";
import { Brand } from "@/components/brand";
import { LOCAL_USERS } from "@/lib/auth/local-users";
import { getSessionUser } from "@/lib/auth/session";
import { isLocalMode } from "@/lib/config";
import { SupabaseLoginForm } from "./supabase-login-form";

export const metadata: Metadata = { title: "登入" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getSessionUser()) redirect("/portfolios");
  const { error } = await searchParams;
  const local = isLocalMode();

  return (
    <div className="flex min-h-full flex-col">
      <nav className="flex items-center justify-between border-b-[3px] border-ink bg-cream px-4 py-3.5 sm:px-8">
        <Link href="/" aria-label="STACK 首頁">
          <Brand />
        </Link>
        <Link href="/" className="nav-mod">
          ← 首頁
        </Link>
      </nav>
      <main className="grid flex-1 items-center gap-10 px-4 py-12 sm:px-8 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div>
          <p className="kicker">Build — 組合資產</p>
          <h1 className="hero-en mt-4 text-[clamp(36px,5vw,76px)]">
            Build your
            <br />
            financial <span className="hl-sun">world</span>.
          </h1>
          <p className="mt-6 text-[clamp(20px,2vw,26px)] font-black leading-snug tracking-[0.04em]">
            把投資，<em className="bg-ink px-2 not-italic text-sun">一塊一塊</em>拼起來。
          </p>
          <p className="mt-3 max-w-[30em] text-sm leading-[1.85] text-ink-2">STACK 不保存券商帳號密碼，也不代替你下單。</p>
        </div>
        <section className="panel w-full max-w-[460px] p-6 sm:p-8 lg:justify-self-end">
          <p className="sh-n">Sign in — 登入</p>
          <h2 className="mt-2 text-[24px] font-black leading-snug">放上第一塊</h2>
          {error === "confirm" ? <p className="alert mt-5">確認連結無效或已過期，請重新登入或註冊。</p> : null}

          {local ? (
            <>
              <p className="notice mt-5">
                本機示範模式：資料存在這台電腦的 <span className="num">web/.data/pglite</span>，不是正式資料庫。選一位示範使用者登入；兩位的資料互相看不到。
              </p>
              <div className="mt-6 grid gap-3">
                {LOCAL_USERS.map((u) => (
                  <form key={u.key} action={loginLocalAction}>
                    <input type="hidden" name="user" value={u.key} />
                    <button className={`btn w-full ${u.key === "a" ? "btn-ink" : ""}`} type="submit">
                      以{u.label}登入
                    </button>
                  </form>
                ))}
              </div>
            </>
          ) : (
            <SupabaseLoginForm />
          )}
        </section>
      </main>
    </div>
  );
}
