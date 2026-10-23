export interface Flow {
  foreign: number | null;
  trust: number | null;
  dealer: number | null;
}

/** 缺少任何一種法人就不能計算合計；個別法人仍可顯示已知值。 */
export function flowValue(flow: Flow, kind: "total" | keyof Flow): number | null {
  if (kind !== "total") return flow[kind];
  return flow.foreign === null || flow.trust === null || flow.dealer === null
    ? null
    : flow.foreign + flow.trust + flow.dealer;
}
