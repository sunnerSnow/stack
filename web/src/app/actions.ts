"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logError } from "@/lib/api/http";
import { LOCAL_SESSION_COOKIE, LOCAL_USERS } from "@/lib/auth/local-users";
import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { isLocalMode } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { isPhase1Type, TRANSACTION_RULES } from "@/lib/ledger/rules";
import { createAccount, createPortfolio } from "@/lib/services/portfolios";
import { correctTransaction, postTransaction, reverseTransaction } from "@/lib/services/transactions";

/**
 * Server Actions 都是公開的 POST 端點：每一個都自己檢查登入，輸入一律交給服務層驗證。
 */
export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  done?: boolean;
}

function toFormState(error: unknown): FormState {
  if (error instanceof AppError) {
    return { error: error.message, fieldErrors: Object.fromEntries(error.issues.map((i) => [i.field, i.message])) };
  }
  logError(error);
  return { error: "系統發生錯誤，請稍後再試" };
}

async function sessionOrRedirect() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

const text = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
};

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------

export async function loginLocalAction(formData: FormData): Promise<void> {
  if (!isLocalMode()) redirect("/login");
  const user = LOCAL_USERS.find((u) => u.key === text(formData, "user"));
  if (!user) redirect("/login");
  (await cookies()).set(LOCAL_SESSION_COOKIE, user.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  redirect("/portfolios");
}

const credentialsSchema = z.object({
  email: z.email("請輸入有效的 Email"),
  password: z.string().min(8, "密碼至少 8 個字元").max(72, "密碼最多 72 個字元"),
});

export async function loginSupabaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentialsSchema.safeParse({ email: text(formData, "email"), password: text(formData, "password") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  const supabase = await createSupabaseServerClient();
  if (text(formData, "intent") === "signup") {
    const origin = (await headers()).get("origin") ?? "";
    const { data, error } = await supabase.auth.signUp({ ...parsed.data, options: { emailRedirectTo: `${origin}/auth/callback` } });
    if (error) return { error: `註冊失敗：${error.message}` };
    if (!data.session) return { done: true, error: undefined, fieldErrors: {} };
  } else {
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    if (error) return { error: "Email 或密碼不正確" };
  }
  redirect("/portfolios");
}

export async function logoutAction(): Promise<void> {
  if (isLocalMode()) {
    (await cookies()).delete(LOCAL_SESSION_COOKIE);
  } else {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

// ---------------------------------------------------------------------------
// 投資組合與帳戶
// ---------------------------------------------------------------------------

export async function createPortfolioAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await sessionOrRedirect();
  let id: string;
  try {
    const portfolio = await createPortfolio(await getDb(), user.id, { name: text(formData, "name"), baseCurrency: text(formData, "baseCurrency") });
    id = portfolio.id;
  } catch (error) {
    return toFormState(error);
  }
  redirect(`/portfolios/${id}`);
}

export async function createAccountAction(portfolioId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await sessionOrRedirect();
  try {
    await createAccount(await getDb(), user.id, portfolioId, {
      name: text(formData, "name"),
      brokerName: text(formData, "brokerName"),
      accountType: text(formData, "accountType"),
      currency: text(formData, "currency"),
    });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath(`/portfolios/${portfolioId}`);
  return { done: true };
}

// ---------------------------------------------------------------------------
// 交易
// ---------------------------------------------------------------------------

/** 只取這個交易類型需要的欄位；正負號與成交金額由服務層決定 */
function transactionInputFromForm(formData: FormData) {
  const type = text(formData, "type") ?? "";
  const rule = isPhase1Type(type) ? TRANSACTION_RULES[type] : null;
  return {
    clientRequestId: text(formData, "clientRequestId"),
    accountId: text(formData, "accountId"),
    type,
    tradeDate: text(formData, "tradeDate"),
    settlementDate: text(formData, "settlementDate"),
    asset:
      rule?.asset === "required"
        ? { market: text(formData, "market"), symbol: text(formData, "symbol"), name: text(formData, "assetName"), assetType: text(formData, "assetType") }
        : undefined,
    quantity: rule?.trade ? text(formData, "quantity") : undefined,
    unitPrice: rule?.trade ? text(formData, "unitPrice") : undefined,
    amount: rule && !rule.trade ? text(formData, "amount") : undefined,
    fee: rule?.allowsCosts ? text(formData, "fee") : undefined,
    tax: rule?.allowsCosts ? text(formData, "tax") : undefined,
    otherCost: rule?.allowsCosts ? text(formData, "otherCost") : undefined,
    notes: text(formData, "notes"),
  };
}

export async function createTransactionAction(portfolioId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await sessionOrRedirect();
  let target: string;
  try {
    const { transaction, duplicate, recalculatedSells } = await postTransaction(await getDb(), user.id, transactionInputFromForm(formData));
    const params = new URLSearchParams({ posted: transaction.id });
    if (duplicate) params.set("duplicate", "1");
    if (recalculatedSells > 0) params.set("recalc", String(recalculatedSells));
    target = `/portfolios/${portfolioId}?${params}`;
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath(`/portfolios/${portfolioId}`);
  redirect(target);
}

/** 更正：沖銷原交易，再依表單內容新增一筆 */
export async function correctTransactionAction(portfolioId: string, transactionId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await sessionOrRedirect();
  let target: string;
  try {
    const { replacement, recalculatedSells } = await correctTransaction(await getDb(), user.id, transactionId, {
      ...transactionInputFromForm(formData),
      reason: text(formData, "reason"),
    });
    const params = new URLSearchParams({ posted: replacement.id, corrected: "1" });
    if (recalculatedSells > 0) params.set("recalc", String(recalculatedSells));
    target = `/portfolios/${portfolioId}?${params}`;
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath(`/portfolios/${portfolioId}`);
  redirect(target);
}

export async function reverseTransactionAction(portfolioId: string, transactionId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await sessionOrRedirect();
  let target: string;
  try {
    const { recalculatedSells } = await reverseTransaction(await getDb(), user.id, transactionId, {
      clientRequestId: text(formData, "clientRequestId"),
      reason: text(formData, "reason"),
    });
    const params = new URLSearchParams({ reversed: "1" });
    if (recalculatedSells > 0) params.set("recalc", String(recalculatedSells));
    target = `/portfolios/${portfolioId}/transactions/${transactionId}?${params}`;
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath(`/portfolios/${portfolioId}`);
  redirect(target);
}
