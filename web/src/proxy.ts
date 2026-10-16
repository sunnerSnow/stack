import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { LOCAL_SESSION_COOKIE } from "@/lib/auth/local-users";
import { isLocalMode, supabaseEnv } from "@/lib/config";

/**
 * 只做兩件事：更新 Supabase session cookie，以及「樂觀的」未登入導向 /login。
 * 真正的權限檢查在每個頁面、API 與 Server Action 裡（requireUser / getSessionUser）。
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // API 自己回 401（不轉址）；/auth/callback 是 Email 確認信的回呼
  const isPublic = pathname === "/login" || pathname.startsWith("/api/") || pathname.startsWith("/auth/");

  if (isLocalMode()) {
    if (!isPublic && !request.cookies.has(LOCAL_SESSION_COOKIE)) return redirectToLogin(request);
    return NextResponse.next();
  }

  const env = supabaseEnv()!;
  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims && !isPublic) return redirectToLogin(request);
  return response;
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
