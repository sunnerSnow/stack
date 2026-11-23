import type { ResearchInput } from "@/lib/research/input";
import type { ReportContent } from "@/lib/research/report";

/** 各家 AI 服務共用的回傳格式：服務層只看這個，不管背後是 Claude 還是 Groq */
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

/**
 * 產生一份報告。沒有產生內容就失敗的錯誤（金鑰、流量、連線）丟 AppError，不留紀錄；
 * 已經產生內容但不能用的（拒絕、超過長度、格式不符）回傳 failed，照樣記成一份報告。
 */
export type ResearchGenerator = (input: ResearchInput) => Promise<GeneratedReport>;
