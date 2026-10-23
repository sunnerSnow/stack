import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock("@/lib/market/benchmarks", () => ({ syncBenchmarks: vi.fn() }));
vi.mock("@/lib/market/groups-sync", () => ({ syncGroups: vi.fn(async () => ({ issues: [] })) }));
vi.mock("@/lib/market/market-sync", () => ({ syncMarket: vi.fn(async () => ({ errors: [] })) }));
vi.mock("@/lib/market/rotation-compute", () => ({ computeRotation: vi.fn(async () => ({})) }));
import { GET } from "@/app/api/cron/sync-market/route";
import { syncBenchmarks } from "@/lib/market/benchmarks";
import { syncMarket } from "@/lib/market/market-sync";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-market-secret");
  vi.mocked(syncBenchmarks).mockResolvedValue({ benchmarks: 2, stored: 10, errors: [] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const request = () => new Request("http://localhost/api/cron/sync-market", { headers: { authorization: "Bearer test-market-secret" } });

it("bootstraps market calendar before market sync and includes benchmark report", async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(syncBenchmarks).toHaveBeenCalledWith(expect.anything(), undefined, { benchmarkIds: ["taiex", "taiex_tr"] });
  expect(vi.mocked(syncBenchmarks).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(syncMarket).mock.invocationCallOrder[0]);
  expect(await response.json()).toMatchObject({ data: { benchmarks: { benchmarks: 2, stored: 10, errors: [] } } });
});
it("reports benchmark failures as a failed sync", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(syncBenchmarks).mockResolvedValue({ benchmarks: 2, stored: 0, errors: ["taiex: unavailable"] });
  const response = await GET(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ data: { benchmarks: { errors: ["taiex: unavailable"] } } });
});
it("subtracts benchmark and group setup time from the market fetch budget", async () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(syncBenchmarks).mockImplementation(async () => { now = 12_000; return { benchmarks: 2, stored: 10, errors: [] }; });
  await GET(request());
  expect(syncMarket).toHaveBeenCalledWith(expect.anything(), undefined, { budgetMs: 20_000 });
});
it("rejects unauthorized callers before syncing", async () => {
  expect((await GET(new Request("http://localhost/api/cron/sync-market"))).status).toBe(401);
  expect(syncBenchmarks).not.toHaveBeenCalled();
  expect(syncMarket).not.toHaveBeenCalled();
});
