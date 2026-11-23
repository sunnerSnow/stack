import "server-only";
import { CLAUDE_MODEL, generateWithClaude } from "@/lib/research/claude";
import { generateWithGroq, GROQ_MODEL } from "@/lib/research/groq";
import type { ResearchGenerator } from "@/lib/research/types";

/**
 * 依環境變數選 AI 服務：設了 ANTHROPIC_API_KEY 用 Claude（付費），否則設了 GROQ_API_KEY 用 Groq（免費方案），都沒設就是 null。
 * label 會顯示在頁面上，告訴使用者資料會送到哪裡（規格 13）。
 */
export interface AiProvider {
  id: "claude" | "groq";
  label: string;
  model: string;
  generate: ResearchGenerator;
}

export function aiProvider(env: Record<string, string | undefined> = process.env): AiProvider | null {
  if (env.ANTHROPIC_API_KEY) return { id: "claude", label: "Anthropic 的 Claude", model: CLAUDE_MODEL, generate: generateWithClaude };
  if (env.GROQ_API_KEY) return { id: "groq", label: "Groq（模型 gpt-oss-120b）", model: GROQ_MODEL, generate: generateWithGroq };
  return null;
}
