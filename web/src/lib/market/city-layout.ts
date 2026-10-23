export type CityGroup = {
  id: string;
  name: string;
  level: "sector" | "industry" | "theme";
  parentId: string | null;
  turnover: number | null;
  flow: { foreign: number | null; trust: number | null; dealer: number | null };
};

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
function netFlow(group: CityGroup): number | null {
  const values = [group.flow.foreign, group.flow.trust, group.flow.dealer].map(finite);
  if (values.some((value) => value === null)) return null;
  return finite((values[0] ?? 0) + (values[1] ?? 0) + (values[2] ?? 0));
}

/** Categorical district coordinates carry no financial meaning. */
export function buildCityDistricts(
  groups: readonly CityGroup[],
  level: "theme" | "industry",
  focusedSectorId: string | null = null,
  selectedGroupId: string | null = null,
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
  const rendered = districts.map(([id, bucket]) => {
    const sorted = [...bucket.groups].sort((a, b) => Math.max(0, finite(b.turnover) ?? 0) - Math.max(0, finite(a.turnover) ?? 0) || compareId(a, b));
    const visible = id === focusedSectorId ? sorted : sorted.filter((group, i) => i < 6 || group.id === selectedGroupId);
    return { id, name: bucket.name, totalGroups: sorted.length, visible };
  });
  let maxTurnover = 0;
  let maxFlow = 0;
  // One scale for the complete level; expanding a district must not resize existing towers.
  for (const [, district] of districts) {
    for (const group of district.groups) {
      maxTurnover = Math.max(maxTurnover, finite(group.turnover) ?? 0);
      maxFlow = Math.max(maxFlow, Math.abs(netFlow(group) ?? 0));
    }
  }

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
        const flow = netFlow(group);
        const turnover = finite(group.turnover);
        return {
          id: group.id,
          name: group.name,
          u: (i % columns) * 2.8,
          v: Math.floor(i / columns) * 2.8,
          footprint: 0.8 + (maxTurnover > 0 ? Math.sqrt(Math.max(0, turnover ?? 0) / maxTurnover) : 0) * 0.55,
          layers: flow === null ? null : flow === 0 ? 0 : Math.min(6, 1 + Math.floor(Math.sqrt(Math.abs(flow) / maxFlow) * 5)),
          flow,
          turnover,
        };
      }),
    };
  });
}
