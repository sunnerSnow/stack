import "server-only";
import Groq from "groq-sdk";
import { z } from "zod";
import { logError } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { PROMPT_VERSION, SYSTEM_PROMPT, userPrompt } from "@/lib/research/prompt";
import { REPORT_SCHEMA } from "@/lib/research/report";
import type { GeneratedReport, ResearchGenerator } from "@/lib/research/types";

/**
 * 呼叫 Groq（免費方案）產生研究摘要：gpt-oss-120b，嚴格的 JSON Schema 輸出。
 * - 金鑰只從 GROQ_API_KEY 讀。Groq 預設不保留推論請求的內容。
 * - 免費方案每分鐘約 8,000 tokens，Groq 以「輸入＋max_completion_tokens」檢查，
 *   所以輸出上限壓在 3,500、推理強度用 low（輸入約 3,000～4,000 tokens）。
 */
export const GROQ_MODEL = "openai/gpt-oss-120b";
const MAX_COMPLETION_TOKENS = 3_500;
const TIMEOUT_MS = 60_000;

// zod 轉出的 schema 每個物件都是 additionalProperties: false、欄位全列在 required，符合嚴格模式
const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(REPORT_SCHEMA);
export const REPORT_JSON_SCHEMA: Record<string, unknown> = jsonSchema;

export const generateWithGroq: ResearchGenerator = async (input) => {
  if (!process.env.GROQ_API_KEY) throw new AppError("ai_not_configured", "還沒有設定 Groq（GROQ_API_KEY）", 503);
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
  let response: Groq.Chat.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      reasoning_effort: "low",
      include_reasoning: false,
      response_format: { type: "json_schema", json_schema: { name: "holding_research", strict: true, schema: REPORT_JSON_SCHEMA } },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input) },
      ],
    });
  } catch (error) {
    throw toAppError(error);
  }
  return interpretGroqResponse(response);
};

/** 把 Groq 的回應轉成報告：先看 finish_reason，再解析並驗證 JSON */
export function interpretGroqResponse(response: Groq.Chat.ChatCompletion): GeneratedReport {
  const choice = response.choices[0];
  const finish = choice?.finish_reason ?? null;
  const base = {
    model: response.model,
    promptVersion: PROMPT_VERSION,
    usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: finish,
    fallbackUsed: false,
  };
  const failed = (error: string): GeneratedReport => ({ ...base, status: "failed", content: null, error });
  if (finish === "length") return failed("AI 的輸出超過長度上限，沒有完成");
  if (finish !== "stop") return failed(`AI 沒有正常結束（${finish ?? "沒有回應"}）`);
  let json: unknown;
  try {
    json = JSON.parse(choice.message.content ?? "");
  } catch {
    return failed("AI 的輸出格式不符，無法解析");
  }
  const parsed = REPORT_SCHEMA.safeParse(json);
  return parsed.success ? { ...base, status: "completed", content: parsed.data, error: null } : failed("AI 的輸出格式不符，無法解析");
}

function toAppError(error: unknown): unknown {
  if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
    return new AppError("ai_unavailable", "AI 服務的金鑰無效或沒有權限，請檢查 GROQ_API_KEY", 503);
  }
  if (error instanceof Groq.RateLimitError) return new AppError("ai_rate_limited", "已經用到 Groq 免費方案的額度上限，請過一分鐘（或明天）再試", 429);
  if (error instanceof Groq.APIConnectionError) return new AppError("ai_timeout", "連不上 AI 服務或等太久，請稍後再試", 504);
  if (error instanceof Groq.APIError) {
    logError(error);
    return error.status === 413
      ? new AppError("ai_too_large", "這次的資料超過 Groq 免費方案一次能處理的量，請稍後再試或回報", 502)
      : new AppError("ai_error", `AI 服務發生錯誤（${error.status ?? "未知"}），詳細原因記在伺服器紀錄`, 502);
  }
  return error;
}
