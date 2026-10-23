import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalMode } from "@/lib/config";

beforeEach(() => {
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_URL", "STACK_LOCAL_MODE"]) vi.stubEnv(key, "");
  vi.stubEnv("NODE_ENV", "development");
});
afterEach(() => vi.unstubAllEnvs());

describe("執行模式設定", () => {
  it("全部未設定才能使用本機模式", () => {
    expect(isLocalMode()).toBe(true);
  });
  it.each(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_URL"])("只設定 %s 應報錯", (key) => {
    vi.stubEnv(key, "configured");
    expect(() => isLocalMode()).toThrow("設定不完整");
  });
  it.each(["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"])("完整設定支援 %s", (key) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv(key, "configured");
    vi.stubEnv("DATABASE_URL", "postgres://example");
    expect(isLocalMode()).toBe(false);
  });
  it("空白的新金鑰可退回舊金鑰", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "configured");
    vi.stubEnv("DATABASE_URL", "postgres://example");
    expect(isLocalMode()).toBe(false);
  });
  it("正式環境須明確允許才能使用本機示範模式", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => isLocalMode()).toThrow("正式環境必須設定");
    vi.stubEnv("STACK_LOCAL_MODE", "1");
    expect(isLocalMode()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "configured");
    expect(() => isLocalMode()).toThrow("設定不完整");
  });
});
