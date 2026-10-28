import { describe, expect, it } from "vitest";
import type { GroupDetailDto } from "@/lib/services/market";
import { replayMembers } from "@/lib/market/replay-members";
const detail: GroupDetailDto = {
  id: "group-a", name: "A", level: "theme", date: "2026-10-22", warmingUp: 0, flowSeries: [],
  members: [{assetId:"stock-a",symbol:"A",name:"股票 A",close:100,ret:0,strength:null,momentum:null,prevStrength:null,quadrant:null,turnover:100,
    flow:{foreign:100,trust:0,dealer:0},flows20:{foreign:null,trust:null,dealer:null},trail:[],held:false}],
};
describe("replay flyout values",()=>{
  it("keeps identities in place while another date loads without showing stale amounts",()=>{
    expect(replayMembers("group-a","2026-10-21",undefined,detail)).toEqual([
      {assetId:"stock-a",symbol:"A",name:"股票 A",flow:{foreign:null,trust:null,dealer:null}},
    ]);
  });
  it("uses matching-day amounts and never carries members into another group",()=>{
    expect(replayMembers("group-a","2026-10-22",detail,undefined)[0].flow.foreign).toBe(100);
    expect(replayMembers("group-b","2026-10-22",undefined,detail)).toEqual([]);
    expect(replayMembers("group-a","2026-10-21",detail,undefined)[0].flow.foreign).toBeNull();
  });
});
