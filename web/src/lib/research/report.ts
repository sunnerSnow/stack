import { z } from "zod";
import type { ResearchInput } from "@/lib/research/input";

/**
 * AI 研究報告的固定格式（structured outputs）與引用檢查。
 * 每一句結論都要引用輸入快照裡的事實編號；引用對不上、沒有引用的句子不顯示，並記在 validation。
 */
const Claim = z.object({
  text: z.string().describe("一句結論，繁體中文，80 字以內"),
  refs: z.array(z.string()).describe("這句結論根據的事實編號，例如 T3、F2、N5；至少一個"),
});

export const REPORT_SCHEMA = z.object({
  summary: z.array(Claim).describe("整體摘要，2～4 句"),
  technical: z.array(Claim).describe("技術面（價格、均線、報酬、RSI、量能），0～5 句"),
  flows: z.array(Claim).describe("資金面（個股與所屬族群的強度、動能、法人買賣超），0～5 句"),
  news: z.array(Claim).describe("新聞重點（只根據標題），0～5 句"),
  risks: z.array(Claim).describe("風險與不確定性，1～5 句"),
  dataGaps: z.array(z.string()).describe("缺少、過舊或不足以判斷的資料"),
});

export type ReportContent = z.infer<typeof REPORT_SCHEMA>;
export type ReportSection = Exclude<keyof ReportContent, "dataGaps">;
export const REPORT_SECTIONS: ReportSection[] = ["summary", "technical", "flows", "news", "risks"];
export const SECTION_LABEL: Record<ReportSection, string> = {
  summary: "摘要",
  technical: "技術面",
  flows: "資金面",
  news: "新聞重點",
  risks: "風險與不確定性",
};

const MAX_CLAIMS = 8;
const MAX_TEXT = 300;
const MAX_GAPS = 12;

export interface DroppedClaim {
  section: ReportSection;
  text: string;
  refs: string[];
  reason: "no_refs" | "unknown_refs" | "too_long" | "too_many";
}

export interface ReportValidation {
  dropped: DroppedClaim[];
}

/** 只留引用得到的句子；引用去重、保持順序 */
export function validateReport(raw: ReportContent, input: ResearchInput): { content: ReportContent; validation: ReportValidation } {
  const known = new Set(input.facts.map((f) => f.id));
  const dropped: DroppedClaim[] = [];
  const clean = (section: ReportSection) => {
    const kept: ReportContent[ReportSection] = [];
    for (const c of raw[section]) {
      const text = c.text.trim();
      const refs = [...new Set(c.refs.map((r) => r.trim().toUpperCase()))];
      let reason: DroppedClaim["reason"] | null = null;
      if (refs.length === 0) reason = "no_refs";
      else if (refs.some((r) => !known.has(r))) reason = "unknown_refs";
      else if (text.length > MAX_TEXT) reason = "too_long";
      else if (kept.length >= MAX_CLAIMS) reason = "too_many";
      if (reason) dropped.push({ section, text, refs, reason });
      else if (text) kept.push({ text, refs });
    }
    return kept;
  };
  const content: ReportContent = {
    summary: clean("summary"),
    technical: clean("technical"),
    flows: clean("flows"),
    news: clean("news"),
    risks: clean("risks"),
    dataGaps: raw.dataGaps.map((g) => g.trim()).filter((g) => g && g.length <= MAX_TEXT).slice(0, MAX_GAPS),
  };
  return { content, validation: { dropped } };
}

export function hasClaims(content: ReportContent): boolean {
  return REPORT_SECTIONS.some((s) => content[s].length > 0);
}
