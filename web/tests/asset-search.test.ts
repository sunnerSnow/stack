import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAssetSearch } from "@/lib/assets/search";

afterEach(() => vi.unstubAllGlobals());

describe("資產搜尋請求", () => {
  it("成功但沒有結果與查詢失敗可區分", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    expect(await loadAssetSearch("TW", "2330", new AbortController().signal)).toEqual({ hits: [], error: null });
  });
  it.each([
    { name: "網路失敗", fetcher: async () => { throw new TypeError("Failed to fetch"); } },
    { name: "HTTP 失敗", fetcher: async () => new Response("Unavailable", { status: 503 }) },
    { name: "無效 JSON", fetcher: async () => new Response("not json") },
    { name: "缺少資料", fetcher: async () => Response.json({ errors: [] }) },
  ])("$name 會回傳可顯示的錯誤，結束等待", async ({ fetcher }) => {
    vi.stubGlobal("fetch", vi.fn(fetcher));
    expect(await loadAssetSearch("TW", "2330", new AbortController().signal)).toEqual({ hits: [], error: "資產查詢失敗，請重試" });
  });
  it("取消後即使舊請求成功，也不回傳過時結果", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); return Response.json({ data: [] }); }));
    expect(await loadAssetSearch("TW", "2330", controller.signal)).toBeNull();
  });
  it("取消請求不顯示錯誤", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); }));
    expect(await loadAssetSearch("TW", "2330", controller.signal)).toBeNull();
  });
});
