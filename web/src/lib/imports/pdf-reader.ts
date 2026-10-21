import type { PdfPage } from "@/lib/imports/tdcc";

/**
 * 在瀏覽器裡讀 PDF 的文字（pdf.js）。PDF 與密碼都不會離開使用者的電腦：
 * 這裡只回傳每頁的文字項目（字串、座標、寬度），交給解析器挑出需要的欄位。
 */

export class PdfPasswordError extends Error {
  constructor(readonly reason: "need" | "incorrect") {
    super(reason === "need" ? "這個 PDF 有密碼" : "密碼不對");
    this.name = "PdfPasswordError";
  }
}

export async function readPdfText(data: ArrayBuffer, password?: string): Promise<PdfPage[]> {
  // 先載入 worker 模組：它會掛在 globalThis.pdfjsWorker，pdf.js 就直接在主執行緒解析，不必另外設定 worker 檔案
  await import("pdfjs-dist/build/pdf.worker.min.mjs");
  const pdfjs = await import("pdfjs-dist");
  let doc;
  try {
    // 每次都給一份複本：pdf.js 會把 buffer 轉移走，輸錯密碼重試時還要用
    doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), password, isEvalSupported: false }).promise;
  } catch (error) {
    const e = error as { name?: string; code?: number };
    if (e?.name === "PasswordException") throw new PdfPasswordError(e.code === 2 ? "incorrect" : "need");
    throw error;
  }
  try {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      pages.push({
        items: content.items.flatMap((item) =>
          "str" in item && item.str.trim() ? [{ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width }] : [],
        ),
      });
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

/** 原始檔案的 SHA-256（十六進位），用來擋同一個檔案重複匯入 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
