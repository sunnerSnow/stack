import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn(async () => ({ id: "test-user" })) }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock("@/lib/services/market", () => ({ getRotation: vi.fn(async () => ({})), getStockScreens: vi.fn(async () => ({})), getGroupDetail: vi.fn(async () => ({})) }));

import { GET as rotation } from "@/app/api/market/rotation/route";
import { GET as stocks } from "@/app/api/market/stocks/route";
import { GET as group } from "@/app/api/market/groups/[id]/route";
import { getSessionUser } from "@/lib/auth/session";
import { getRotation, getStockScreens, getGroupDetail } from "@/lib/services/market";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "test-user" } as Awaited<ReturnType<typeof getSessionUser>>);
});

describe.each([
  { name: "族群輪動", get: (request: Request) => rotation(request, undefined), service: getRotation },
  { name: "個股篩選", get: (request: Request) => stocks(request, undefined), service: getStockScreens },
  { name: "族群明細", get: (request: Request) => group(request, { params: Promise.resolve({ id: "theme-test" }) }), service: getGroupDetail },
])("$name 日期驗證", ({ get, service }) => {
  it("未登入也能查市場", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await get(new Request("http://localhost/api/market"))).status).toBe(200);
    expect(service).toHaveBeenCalledWith(expect.anything(), null, ...(service === getGroupDetail ? ["theme-test"] : []), expect.anything());
  });
  it("未登入的無效日期仍回 400", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await get(new Request("http://localhost/api/market?date=2026-02-31"))).status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });
  it.each(["2026-02-31", "2025-02-29", "2026-13-01", "yesterday", ""])("無效日期 %s 回 400 而非查最新行情", async (date) => {
    const response = await get(new Request(`http://localhost/api/market?date=${date}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ data: null, errors: [{ code: "validation_failed", field: "date" }] });
    expect(service).not.toHaveBeenCalled();
  });
  it("有效閏日照原日期查詢", async () => {
    const response = await get(new Request("http://localhost/api/market?date=2024-02-29"));
    expect(response.status).toBe(200);
    const resource = service === getGroupDetail ? ["theme-test"] : [];
    expect(service).toHaveBeenCalledWith(expect.anything(), "test-user", ...resource, expect.objectContaining({ date: "2024-02-29" }));
  });
  it("省略日期可查最新行情", async () => {
    expect((await get(new Request("http://localhost/api/market"))).status).toBe(200);
    expect(service).toHaveBeenCalled();
  });
});
