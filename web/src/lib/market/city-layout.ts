import { type Flow, flowValue } from "@/lib/market/flows";

export type CityGroup = {
  id: string;
  name: string;
  level: "sector" | "industry" | "theme";
  parentId: string | null;
  turnover: number | null;
  flow: Flow;
  /** Ordering key (defaults to turnover); replayed days keep today's order so towers stay put. */
  rank?: number | null;
};

export type FlowKind = "total" | keyof Flow;
export type CityScale = { turnover: number; flow: number };
export const OVERVIEW_TOWERS = 9;

export type CityBuilding = {
  id: string;
  name: string;
  u: number;
  v: number;
  footprint: number;
  layers: number | null;
  flow: number | null;
  turnover: number | null;
};

export type CityDistrict = {
  id: string;
  name: string;
  x: number;
  y: number;
  groups: CityBuilding[];
  totalGroups: number;
  columns: number;
  rows: number;
};

const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const finite = (value: number | null): number | null => value !== null && Number.isFinite(value) ? value : null;

/** A partially missing institution breakdown cannot establish total net flow. */
const netFlow = (group: CityGroup, kind: FlowKind): number | null => finite(flowValue({
  foreign: finite(group.flow.foreign), trust: finite(group.flow.trust), dealer: finite(group.flow.dealer),
}, kind));

/** One scale for the complete level; expanding a district or replaying a day must not resize existing towers. */
export function cityScale(groups: readonly CityGroup[], level: "theme" | "industry", kind: FlowKind = "total"): CityScale {
  let turnover = 0;
  let flow = 0;
  for (const group of groups) {
    if (group.level !== level) continue;
    turnover = Math.max(turnover, finite(group.turnover) ?? 0);
    flow = Math.max(flow, Math.abs(netFlow(group, kind) ?? 0));
  }
  return { turnover, flow };
}

/** Categorical district coordinates carry no financial meaning. */
export function buildCityDistricts(
  groups: readonly CityGroup[],
  level: "theme" | "industry",
  focusedSectorId: string | null = null,
  selectedGroupId: string | null = null,
  { kind = "total", scale = cityScale(groups, level, kind) }: { kind?: FlowKind; scale?: CityScale } = {},
): CityDistrict[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const buckets = new Map<string, { name: string; groups: CityGroup[] }>();
  for (const group of groups) {
    if (group.level !== level) continue;
    const visited = new Set<string>();
    let ancestor: CityGroup | undefined = group;
    while (ancestor && ancestor.level !== "sector" && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
    }
    const sector = ancestor?.level === "sector" ? ancestor : undefined;
    const id = sector?.id ?? "other";
    const bucket = buckets.get(id) ?? { name: sector?.name ?? "其他", groups: [] };
    bucket.groups.push(group);
    buckets.set(id, bucket);
  }

  const districts = [...buckets].sort(([a], [b]) => compareId({ id: a }, { id: b }));
  const rankOf = (group: CityGroup) => Math.max(0, finite(group.rank === undefined ? group.turnover : group.rank) ?? 0);
  const rendered = districts.map(([id, bucket]) => {
    const sorted = [...bucket.groups].sort((a, b) => rankOf(b) - rankOf(a) || compareId(a, b));
    const visible = id === focusedSectorId ? sorted : sorted.filter((group, i) => i < OVERVIEW_TOWERS || group.id === selectedGroupId);
    return { id, name: bucket.name, totalGroups: sorted.length, visible };
  });
  const { turnover: maxTurnover, flow: maxFlow } = scale;

  return rendered.map((district, index) => {
    // Start at the back of the market and proceed clockwise around it.
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(7, rendered.length);
    const columns = district.id === focusedSectorId ? Math.ceil(Math.sqrt(district.visible.length)) : 3;
    return {
      id: district.id,
      name: district.name,
      x: Math.cos(angle) * 560 - 40,
      y: Math.sin(angle) * 310,
      totalGroups: district.totalGroups,
      columns,
      rows: Math.ceil(district.visible.length / columns),
      groups: district.visible.map((group, i) => {
        const flow = netFlow(group, kind);
        const turnover = finite(group.turnover);
        return {
          id: group.id,
          name: group.name,
          u: (i % columns) * 2.8,
          v: Math.floor(i / columns) * 2.8,
          footprint: 0.8 + (maxTurnover > 0 ? Math.min(1, Math.sqrt(Math.max(0, turnover ?? 0) / maxTurnover)) : 0) * 0.55,
          layers: flow === null ? null : flow === 0 ? 0 : Math.min(6, 1 + Math.floor(Math.min(1, Math.sqrt(Math.abs(flow) / maxFlow)) * 5)),
          flow,
          turnover,
        };
      }),
    };
  });
}
