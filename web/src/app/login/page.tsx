import type { Metadata } from "next";
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
    <main className="flex-1 grid place-items-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <Brand />
        </div>
        <section className="panel p-6 sm:p-8">
          <p className="kicker">Build your financial world</p>
          <h1 className="mt-3 text-[26px] font-black leading-snug">把投資，一塊一塊拼起來。</h1>
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
        <p className="mt-6 text-center text-xs text-ink-3">STACK 不保存券商帳號密碼，也不代替你下單。</p>
      </div>
    </main>
  );
}
