import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { isLocalMode } from "@/lib/config";

/** Supabase 註冊確認信的回呼：PKCE 的 code，或 token_hash＋type */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  if (isLocalMode()) return NextResponse.redirect(new URL("/login", url));
  const supabase = await createSupabaseServerClient();
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  let confirmed = false;
  if (code) confirmed = !(await supabase.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash && type) confirmed = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  return NextResponse.redirect(new URL(confirmed ? "/portfolios" : "/login?error=confirm", url));
}
