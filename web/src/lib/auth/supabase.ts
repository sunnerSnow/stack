import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "@/lib/config";

/** Server Component／Server Action／Route Handler 用的 Supabase client（session 存在 cookie） */
export async function createSupabaseServerClient() {
  const env = supabaseEnv();
  if (!env) throw new Error("缺少 Supabase 設定");
  const cookieStore = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Component 不能寫 cookie；session 會由 proxy 更新
        }
      },
    },
  });
}
