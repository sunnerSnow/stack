import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { LOCAL_SESSION_COOKIE, LOCAL_USERS } from "@/lib/auth/local-users";
import { isLocalMode } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { ensureLocalAuthUser } from "@/lib/db/local";
import { ensureUserProfile } from "@/lib/services/portfolios";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * 取得目前登入的使用者（同一個請求內只查一次）。
 * 頁面、Route Handler 與每個 Server Action 都要自己呼叫，不依賴 proxy 或 layout 擋人。
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  // 先讀 cookie：讓 next build 知道這是每個請求動態渲染的頁面，再檢查執行模式
  const cookieStore = await cookies();
  if (isLocalMode()) {
    const key = cookieStore.get(LOCAL_SESSION_COOKIE)?.value;
    const user = LOCAL_USERS.find((u) => u.id === key);
    if (!user) return null;
    const db = await getDb();
    await ensureLocalAuthUser(db, user.id, user.email);
    await ensureUserProfile(db, user.id, user.email);
    return { id: user.id, email: user.email };
  }

  const supabase = await createSupabaseServerClient();
  // getUser 會向 Supabase Auth 驗證 token，不只是讀 cookie
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  await ensureUserProfile(await getDb(), data.user.id, data.user.email ?? null);
  return { id: data.user.id, email: data.user.email ?? null };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}
