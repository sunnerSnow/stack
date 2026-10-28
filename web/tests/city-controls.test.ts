import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrickCity, FlowBars, FlowChart } from "@/app/market/brick-city";
import type { MarketOverviewDto } from "@/lib/services/market-overview";
vi.stubGlobal("React", React);
const empty: MarketOverviewDto={date:null,previousDate:null,stocks:0,upCount:0,downCount:0,unchangedCount:0,unclassifiedCount:0,turnover:null,index:null,flow:{foreign:null,trust:null,dealer:null},groups:[],exchanges:[],replay:[]};
describe("city motion control",()=>{
  it.each([0, 1])("can turn animation off with %i historical days",(count)=>{
    const overview = { ...empty, replay: count ? [{ date: "2026-10-22", index: null, turnover: null, flow: empty.flow, upCount: 0, downCount: 0, unchangedCount: 0 }] : [] };
    const html=renderToStaticMarkup(React.createElement(BrickCity,{overview}));
    expect(html).toContain("動畫開");
    expect(html).not.toContain("播放最近交易日回放");
  });
});

describe("zero institutional flow",()=>{
  it("does not draw a buying or selling bar for a zero balance",()=>{
    const html=renderToStaticMarkup(React.createElement(FlowBars,{rows:[{id:"zero",name:"零",value:0}],onPick:()=>{},label:"flow"}));
    expect(html).not.toContain('class="is-buy"');
    expect(html).not.toContain('class="is-sell"');
  });
  it("does not draw a positive column for a zero day",()=>{
    const html=renderToStaticMarkup(React.createElement(FlowChart,{series:[{date:"2026-10-22",foreign:0,trust:0,dealer:0}],kind:"total",date:"2026-10-22"}));
    expect(html).not.toContain("<rect");
  });
});
