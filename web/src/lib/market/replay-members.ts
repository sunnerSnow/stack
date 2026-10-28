import type { GroupDetailDto, MemberRow } from "@/lib/services/market";

export type FlyoutMember = Pick<MemberRow, "assetId" | "symbol" | "name" | "flow">;

/** Preserve the flyout's identities during a date request, but never carry old amounts into that date. */
export function replayMembers(
  groupId: string | null,
  date: string | null,
  detail: GroupDetailDto | undefined,
  previous: GroupDetailDto | undefined,
): FlyoutMember[] {
  const source = detail ?? previous;
  if (!source || source.id !== groupId) return [];
  const current = source === detail && source.date === date;
  return [...source.members].sort((a, b) => (b.turnover ?? -1) - (a.turnover ?? -1))
    .map(({ assetId, symbol, name, flow }) => ({ assetId, symbol, name,
      flow: current ? flow : { foreign: null, trust: null, dealer: null },
    }));
}
