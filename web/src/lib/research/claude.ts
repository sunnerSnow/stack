import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { logError } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import type { ResearchInput } from "@/lib/research/input";
import { PROMPT_VERSION, SYSTEM_PROMPT, userPrompt } from "@/lib/research/prompt";
import { REPORT_SCHEMA, type ReportContent } from "@/lib/research/report";

/**
 * 呼叫 Claude 產生研究摘要（固定格式輸出）。
 * - 金鑰只從 ANTHROPIC_API_KEY 讀，不寫進程式也不記錄。
 * - 被安全機制拒絕時，由伺服器端改用備援模型重跑（fallbacks: "default"）。
 * - 沒有產生內容就失敗的錯誤（金鑰、流量、連線）丟 AppError，不留紀錄；
 *   已經產生內容但不能用的（拒絕、超過長度、格式不符）回傳 failed，照樣記成一份報告（用量也算）。
 */
export const RESEARCH_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 90_000;
const REPORT_FORMAT = betaZodOutputFormat(REPORT_SCHEMA);

export interface ReportUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface GeneratedReport {
  status: "completed" | "failed";
  /** 解析好的報告（還沒做引用檢查）；失敗時 null */
  content: ReportContent | null;
  /** 實際產生回應的模型（備援時會跟要求的不同） */
  model: string;
  promptVersion: string;
  usage: ReportUsage;
  stopReason: string | null;
  fallbackUsed: boolean;
  error: string | null;
}

export type ResearchGenerator = (input: ResearchInput) => Promise<GeneratedReport>;

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const generateWithClaude: ResearchGenerator = async (input) => {
  if (!isAiConfigured()) throw new AppError("ai_not_configured", "還沒有設定 AI 服務（ANTHROPIC_API_KEY）", 503);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: REPORT_FORMAT },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt(input) }],
    });
  } catch (error) {
    throw toAppError(error);
  }
  return interpretResponse(response);
};


/** 把 API 回應轉成報告：先看 stop_reason，再解析固定格式的 JSON */
export function interpretResponse(response: Anthropic.Beta.BetaMessage): GeneratedReport {
  const usage: ReportUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  };
  const fallbackUsed = (response.usage.iterations ?? []).some((e) => e.type === "fallback_message");
  const base = { model: response.model, promptVersion: PROMPT_VERSION, usage, stopReason: response.stop_reason, fallbackUsed };
  const failed = (error: string): GeneratedReport => ({ ...base, status: "failed", content: null, error });

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    return failed(`AI 拒絕產生這份摘要${category ? `（${category}）` : ""}`);
  }
  if (response.stop_reason === "max_tokens") return failed("AI 的輸出超過長度上限，沒有完成");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { ...base, status: "completed", content: REPORT_FORMAT.parse(text), error: null };
  } catch {
    return failed("AI 的輸出格式不符，無法解析");
  }
}

function toAppError(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AppError("ai_unavailable", "AI 服務的金鑰無效或沒有權限，請檢查 ANTHROPIC_API_KEY", 503);
  }
  if (error instanceof Anthropic.RateLimitError) return new AppError("ai_rate_limited", "AI 服務暫時太忙，請稍後再試", 429);
  if (error instanceof Anthropic.APIConnectionError) return new AppError("ai_timeout", "連不上 AI 服務或等太久，請稍後再試", 504);
  if (error instanceof Anthropic.BadRequestError) {
    logError(error);
    return new AppError("ai_bad_request", "AI 服務拒絕這次請求（可能是額度不足或設定錯誤），詳細原因記在伺服器紀錄", 502);
  }
  if (error instanceof Anthropic.APIError) {
    logError(error);
    return new AppError("ai_error", `AI 服務發生錯誤（${error.status ?? "未知"}），請稍後再試`, 502);
  }
  return error;
}
