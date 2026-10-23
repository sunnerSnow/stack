"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import Link from "next/link";
import "./brick-city.css";
import { buildCityDistricts, type CityBuilding, type CityDistrict } from "@/lib/market/city-layout";
import { flowValue } from "@/lib/market/flows";
import type { GroupDetailDto } from "@/lib/services/market";
import type { MarketOverviewDto } from "@/lib/services/market-overview";

const BUY = "#D9534F";
const INK = "#173451", SUN = "#F5D548", SEA = "#187F7C", CREAM = "#F5F0E5";
const money = (n: number | null, signed = true) => {
  if (n === null) return "—";
  const small = n !== 0 && Math.abs(n) < 1e7;
  return `${signed && n > 0 ? "+" : ""}${(n / (small ? 1e4 : 1e8)).toLocaleString("zh-TW", { maximumFractionDigits: 1 })} ${small ? "萬" : "億"}`;
};
const pct = (n: number | null) => n === null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const color = (n: number | null) => n === null || n === 0 ? CREAM : n > 0 ? BUY : SEA;
const signClass = (n: number | null) => n === null ? "" : n > 0 ? "city-gain" : n < 0 ? "city-loss" : "";
// Category addresses form adjoining isometric blocks around the market square.
// Their location and ground colour encode categories, never price or fund flow.
const neighbourhoods: Record<string, { x: number; y: number; ground: string; mark: string }> = {
  "電子科技": {x:-220,y:-120,ground:"#F0D878",mark:"▦"},
  "民生消費": {x:220,y:-120,ground:"#D7E2EE",mark:"▤"},
  "金融": {x:220,y:155,ground:"#DFE8E4",mark:"▥"},
  "工業與運輸": {x:-220,y:155,ground:"#CCDCE9",mark:"▰"},
  "原物料": {x:0,y:305,ground:"#D4DFB7",mark:"▧"},
  "生技醫療": {x:440,y:20,ground:"#C0DDD3",mark:"✚"},
  "其他": {x:-440,y:20,ground:"#E8D4BE",mark:"◇"},
};
const address = (d: CityDistrict) => neighbourhoods[d.name] ?? {x:Math.round(d.x),y:Math.round(d.y),ground:CREAM,mark:"▦"};


/** A studded isometric brick. Origin is the centre of its top; depth and height are separate. */
function Block({ w, d, h, fill, studs = true, ghost = false }: { w: number; d: number; h: number; fill: string; studs?: boolean; ghost?: boolean }) {
  const points = `${-w/2},0 0,${-d/2} ${w/2},0 0,${d/2}`;
  return <g stroke={INK} strokeWidth="1.5" strokeLinejoin="round" strokeDasharray={ghost ? "4 3" : undefined}>
    <polygon points={`${-w/2},0 0,${d/2} 0,${d/2+h} ${-w/2},${h}`} fill={fill}/>
    <polygon points={`${-w/2},0 0,${d/2} 0,${d/2+h} ${-w/2},${h}`} fill={INK} opacity=".18" stroke="none"/>
    <polygon points={`0,${d/2} ${w/2},0 ${w/2},${h} 0,${d/2+h}`} fill={fill}/>
    <polygon points={`0,${d/2} ${w/2},0 ${w/2},${h} 0,${d/2+h}`} fill={INK} opacity=".32" stroke="none"/>
    <polygon points={points} fill={fill}/>
    <polygon points={points} fill="url(#city-top-light)" stroke="none"/>
    <path d={`M ${-w/2+2} 1 L 0 ${-d/2+2} L ${w/2-2} 1`} fill="none" stroke="#fffdf8" strokeOpacity=".55" strokeWidth="1.2"/>
    {studs && [-1,1].flatMap((u) => [-1,1].map((v) => <g key={`${u}:${v}`} transform={`translate(${(u-v)*w/8} ${(u+v)*d/8})`}>
      <path d={`M ${-w*.085} 0 v -6 a ${w*.085} ${d*.085} 0 0 1 ${w*.17} 0 v 4`} fill={fill}/>
      <ellipse cy="-6" rx={w*.085} ry={d*.085} fill={fill}/>
      <ellipse cy="-6" rx={w*.085} ry={d*.085} fill="url(#city-top-light)" stroke="none"/>
    </g>))}
  </g>;
}

function Tower({ building, selected, delay, pick }: { building: CityBuilding; selected: boolean; delay: number; pick: () => void }) {
  const layers = Math.max(1, building.layers ?? 0);
  const w = 83 * building.footprint, d = 48 * building.footprint;
  const layerHeight = building.flow === null || building.flow === 0 ? 18 : 29;
  const dark = building.flow !== null && building.flow !== 0;
  return <g className={`city-tower ${selected ? "is-selected" : ""}`} role="button" tabIndex={0} aria-label={`查看族群 ${building.name}`} aria-pressed={selected}
    onClick={pick} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }} data-city-action="true">
    <title>{`${building.name} · 法人合計 ${money(building.flow)} · 成交額 ${money(building.turnover,false)}`}</title>
    <ellipse cy="20" rx={w*.68} ry="16" fill={INK} opacity=".12"/>
    {Array.from({length: layers}, (_, i) => <g key={i} transform={`translate(0 ${-i*layerHeight})`}><g className="city-assemble" style={{animationDelay:`${delay+i*55}ms`} as CSSProperties}>
      <Block w={w} d={d} h={layerHeight} fill={color(building.flow)} studs={i === layers-1} ghost={building.flow === null}/>
    </g></g>)}
    {selected ? <path d={`M ${-w/2-7} 3 L 0 ${d/2+25} L ${w/2+7} 3`} fill="none" stroke={SUN} strokeWidth="5"/> : null}
    <text y={-(layers-1)*layerHeight+19} fill={dark ? CREAM : INK} textAnchor="middle" className="city-tower-name" paintOrder="stroke" stroke={color(building.flow)} strokeWidth="3">{building.name}</text>

  </g>;
}

function DistrictSign({ district, depth }: {district: CityDistrict; depth: number}) {
  const width = depth === 175 ? 280 : depth >= 290 ? 570 + (depth-290)*2 : 420;
  // Mount signage on the front face, following the same isometric slope as the plate.
  return <g transform={`matrix(1 ${depth/width} 0 1 ${-width/2} 8)`}>
    <rect x="5" y="0" width={width/2-10} height="39" rx="5" fill={INK} stroke={CREAM} strokeWidth="1.5"/>
    <text x={width/4} y="19" textAnchor="middle" fill={CREAM} fontSize="19" fontWeight="800">{address(district).mark} {district.name} <tspan fill={SUN}>↗</tspan></text>
    <text x={width/4} y="32" textAnchor="middle" fill={CREAM} fontSize="9">{district.groups.length} / {district.totalGroups} 個族群 · 點選展開</text>
  </g>;
}

function District({ district, selectedId, focused, onFocus, onPick, showLabel=true }: { district: CityDistrict; selectedId: string | null; focused: boolean; onFocus: () => void; onPick: (id: string) => void; showLabel?: boolean }) {
  const single = district.groups.length === 1;
  const columns = focused ? 3 : single ? 1 : 2;
  const rows = single ? 1 : Math.max(2, Math.ceil(district.groups.length / columns));
  const w = focused ? 570 + Math.max(0,rows-2)*100 : single ? 280 : 420;
  const d = focused ? 290 + Math.max(0,rows-2)*50 : single ? 175 : 240;
  const palette = address(district);
  return <g>
    <g role="button" tabIndex={0} aria-label={`展開產業 ${district.name}`} onClick={onFocus} data-city-action="true" onKeyDown={(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onFocus();}}} className="city-base">
      <ellipse cy={d/2+30} rx={w/2+18} ry="30" fill={INK} opacity=".08"/>
      <Block w={w} d={d} h={27} fill={focused ? SUN : INK} studs={false}/>
      <g transform="translate(0 -9)"><Block w={w-13} d={d-13} h={9} fill={palette.ground} studs={false}/></g>
      <g transform="translate(0 -11)" aria-hidden="true">{Array.from({length: focused ? 9 : single ? 4 : 7},(_,u)=>Array.from({length:focused ? 7 : single ? 4 : 7},(_,v)=>{
        const cols=focused?9:single?4:7, rows=focused?7:single?4:7;
        const x=((u-(cols-1)/2)-(v-(rows-1)/2))*24;
        const y=((u-(cols-1)/2)+(v-(rows-1)/2))*13;
        return <g key={`${u}:${v}`} transform={`translate(${x} ${y})`} fill={palette.ground} stroke={INK} strokeWidth=".8" opacity=".55"><path d="M -7 0 v -3 a 7 3 0 0 1 14 0 v 3"/><ellipse cy="-3" rx="7" ry="3"/></g>;
      }))}</g>
      {showLabel ? <DistrictSign district={district} depth={d}/> : null}
    </g>
    {district.groups.map((b, i) => ({b,i})).sort((a,b)=>(Math.floor(a.i/columns)+a.i%columns)-(Math.floor(b.i/columns)+b.i%columns)).map(({b,i}) => {
      const row = Math.floor(i/columns), col=i%columns;
      return <g key={b.id} transform={`translate(${(col-row)*100-(columns-rows)*50} ${(col+row)*53-(rows+columns-2)*26.5})`}>
        <Tower building={b} selected={selectedId===b.id} delay={i*45} pick={()=>onPick(b.id)}/>
      </g>;
    })}
  </g>;
}

export function BrickCity({ overview }: { overview: MarketOverviewDto }) {
  const [level,setLevel] = useState<"theme"|"industry">("theme");
  const [focus,setFocus] = useState<string|null>(null);
  const [selectedId,setSelectedId] = useState<string|null>(null);
  const [closing,setClosing] = useState(false);
  const [stockId,setStockId] = useState<string|null>(null);
  const [query,setQuery] = useState("");
  const [animated,setAnimated] = useState(true);
  const [assembly,setAssembly] = useState(0);
  const [page,setPage] = useState(0);
  const [retry,setRetry] = useState(0);
  const [response,setResponse] = useState<{key:string;data?:GroupDetailDto;error?:boolean}|null>(null);
  const [view,setView] = useState({x:0,y:0,scale:1});
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{id:number;x:number;y:number}|null>(null);
  const districts = useMemo(()=>buildCityDistricts(overview.groups,level,focus,selectedId),[overview.groups,level,focus,selectedId]);
  const focused = districts.find(d=>d.id===focus);
  const selected = overview.groups.find(g=>g.id===selectedId);
  const key = `${selectedId}:${overview.date}:${retry}`;
  const detail = response?.key===key ? response.data : undefined;
  const failed = response?.key===key && response.error;
  const focusedIds = new Set(focused?.groups.map(g=>g.id));
  const candidates = overview.groups.filter(g=>g.level===level && (!focused || focusedIds.has(g.id)) && g.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>(b.turnover??-1)-(a.turnover??-1));
  const members = useMemo(()=>[...(detail?.members??[])].sort((a,b)=>(b.turnover??-1)-(a.turnover??-1)),[detail]);
  const selectedStock = members.find(m=>m.assetId===stockId);
  const groupFlow = selected ? flowValue(selected.flow,"total") : null;

  useEffect(()=>{
    if(!selectedId || !overview.date) return;
    const controller=new AbortController();
    fetch(`/api/market/groups/${encodeURIComponent(selectedId)}?date=${overview.date}`,{signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error("request");const body=await r.json();if(!body.data)throw new Error("data");return body.data as GroupDetailDto;})
      .then(data=>{if(!controller.signal.aborted)setResponse({key,data});})
      .catch(()=>{if(!controller.signal.aborted)setResponse({key,error:true});});
    return ()=>controller.abort();
  },[selectedId,overview.date,key]);

  useEffect(()=>{
    if(!closing)return;
    const timer=setTimeout(()=>{setSelectedId(null);setStockId(null);setClosing(false);},240);
    return ()=>clearTimeout(timer);
  },[closing]);
  function closeGroup(){
    if(animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)setClosing(true);
    else {setSelectedId(null);setStockId(null);}
  }
  function reset(){setClosing(false);setFocus(null);setSelectedId(null);setStockId(null);setPage(0);setQuery("");setView({x:0,y:0,scale:1});}
  function focusDistrict(id:string){setClosing(false);setFocus(id);setSelectedId(null);setStockId(null);setPage(0);setQuery("");setView({x:0,y:0,scale:1});}
  function pick(id:string){
    setClosing(false);
    // Find the district even when this group is outside the overview's top six.
    const district=buildCityDistricts(overview.groups,level,null,id).find(d=>d.groups.some(b=>b.id===id));
    if(!district)return;
    const full=buildCityDistricts(overview.groups,level,district.id,id).find(d=>d.id===district.id)!;
    setPage(Math.floor(full.groups.findIndex(b=>b.id===id)/9));setFocus(district.id);setSelectedId(id);setStockId(null);setView({x:0,y:0,scale:1});
  }
  function point(e:PointerEvent<SVGSVGElement>){const matrix=svg.current?.getScreenCTM();return matrix ? new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()) : {x:0,y:0};}
  function zoom(factor:number){setView(v=>({...v,scale:Math.max(.65,Math.min(2.5,v.scale*factor))}));}
  const visibleDistrict = focused ? {...focused,groups:focused.groups.slice(page*9,page*9+9)} : null;
  const focusRows = Math.max(2,Math.ceil((visibleDistrict?.groups.length??0)/3));
  const overviewDistricts = districts.map(d=>({...d,groups:d.groups.slice(0,4)}));
  const cityViewBox = focused ? `-430 -350 860 ${selectedId ? 820+(focusRows-2)*82 : 660+(focusRows-2)*82}` : "-710 -420 1420 980";

  return <section className={`brick-city ${animated?"city-motion":""} ${closing?"city-closing":""}`} aria-label="市場積木城市" onKeyDown={e=>{if(e.key==="Escape"){if(selectedId){closeGroup();}else reset();}}}>
    <div className="city-toolbar">
      <div className="city-title"><span className="city-eyebrow">BUILD YOUR MARKET VIEW</span><h2>市場，一塊一塊看懂。</h2><p>從大盤底板，拆開每一層資訊。</p></div>
      <div className="city-actions">
        <div className="city-segment" role="group" aria-label="積木分類">{([['theme','族群'],['industry','產業']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={level===value} onClick={()=>{setLevel(value);reset();}}>{label}</button>)}</div>
        <button type="button" aria-pressed={animated} onClick={()=>setAnimated(!animated)}>{animated?"Ⅱ 動畫":"▷ 動畫"}</button>
        <button type="button" disabled={!animated} onClick={()=>setAssembly(n=>n+1)}>↻ 重新組裝</button>
      </div>
    </div>
    <div className="city-workspace">
      <div className="city-scene-wrap">
        <div className="city-mobile-nav"><div><small>TAIEX · 大盤</small><strong>{overview.index?Number(overview.index.value).toLocaleString("zh-TW",{maximumFractionDigits:2}):"—"}</strong><b className={signClass(overview.index?.change??null)}>{pct(overview.index?.change??null)}</b></div><label>選擇產業底板<select aria-label="選擇產業底板" value={focus??""} onChange={e=>e.target.value?focusDistrict(e.target.value):reset()}><option value="">全市場總覽</option>{districts.map(d=><option value={d.id} key={d.id}>{d.name} · {d.totalGroups} 群</option>)}</select></label></div>
        <nav className="city-breadcrumb" aria-label="城市導覽"><button onClick={reset} aria-current={!focus?"page":undefined}>全市場</button>{focused?<><span>/</span><button onClick={()=>focusDistrict(focused.id)} aria-current={!selectedId?"page":undefined}>{focused.name}</button></>:null}{selected?<><span>/</span><span>{selected.name}</span></>:null}</nav>
        <div className="city-scene">
          {overview.groups.length ? <svg ref={svg} role="group" viewBox={cityViewBox} className={`city-svg ${focused?"city-svg-focused":""}`} aria-label={focused?`${focused.name}的族群積木` : "全市場產業積木城市"}
            onPointerDown={e=>{if(e.button!==0||(e.target as Element).closest('[data-city-action]'))return;const p=point(e);drag.current={id:e.pointerId,...p};e.currentTarget.setPointerCapture(e.pointerId);}}
            onPointerMove={e=>{const prev=drag.current;if(!prev||prev.id!==e.pointerId)return;const p=point(e);setView(v=>({...v,x:v.x+p.x-prev.x,y:v.y+p.y-prev.y}));drag.current={id:e.pointerId,...p};}}
            onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
            <defs><linearGradient id="city-top-light" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fffdf8" stopOpacity=".34"/><stop offset="1" stopColor="#fffdf8" stopOpacity="0"/></linearGradient></defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {!focused ? <>
                <g aria-hidden="true" className="city-walkways">
                  {/* Broad studded walkways join adjacent districts, rather than drawing fund-flow spokes. */}
                  {[[0,20,-220,-120],[0,20,220,-120],[0,20,-220,155],[0,20,220,155],[-220,155,0,305],[220,155,0,305],[-440,20,-220,155],[440,20,220,155]].map(([x1,y1,x2,y2],i)=><g key={i}>
                    <path d={`M ${x1} ${y1+9} L ${x2} ${y2+9}`} stroke={INK} strokeWidth="42" strokeLinecap="round"/>
                    <path d={`M ${x1} ${y1} L ${x2} ${y2}`} stroke="#C8BDA5" strokeWidth="40" strokeLinecap="round"/>
                    <path d={`M ${x1} ${y1-3} L ${x2} ${y2-3}`} stroke="#FFF7DF" strokeWidth="29" strokeLinecap="round"/>
                    <path d={`M ${x1} ${y1-3} L ${x2} ${y2-3}`} stroke="#9E8D70" strokeWidth="29" strokeDasharray="2 12" opacity=".6"/>
                  </g>)}
                </g>
                {[...overviewDistricts.map(d=>({d,...address(d)})),{d:null,x:0,y:20}].sort((a,b)=>a.y-b.y||a.x-b.x).map((p,i)=>p.d ? <g key={`${p.d.id}:${assembly}`} transform={`translate(${p.x} ${p.y})`}><District district={p.d} selectedId={null} focused={false} showLabel={false} onFocus={()=>focusDistrict(p.d!.id)} onPick={pick}/></g> :
                  <g key={`market:${i}`} transform={`translate(${p.x} ${p.y})`} className="city-market" role="button" tabIndex={0} aria-label="查看大盤摘要" onClick={reset} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();reset();}}} data-city-action="true">
                    <Block w={340} d={205} h={29} fill={INK} studs={false}/>
                    <g aria-hidden="true" fill="#345574" stroke={INK} strokeWidth="1">{Array.from({length:7},(_,u)=>Array.from({length:5},(_,v)=>{
                      const x=(u-3)*23-(v-2)*23,y=(u-3)*13+(v-2)*13;
                      return <g key={`${u}:${v}`} transform={`translate(${x} ${y})`}><ellipse rx="6" ry="3"/><ellipse cy="-3" rx="6" ry="3"/></g>;
                    }))}</g>
                    <path d="M -100 -44 L 100 -44 L 100 48 L -100 48 Z" fill={INK} opacity=".92"/>
                    <g transform="translate(-126 1)"><Block w={29} d={17} h={17} fill={SUN}/></g>
                    <g transform="translate(126 1)"><Block w={29} d={17} h={17} fill={SUN}/></g>
                    <text y="-18" textAnchor="middle" fill={CREAM} fontSize="24" fontWeight="900">大 盤</text>
                    <text y="16" textAnchor="middle" fill={CREAM} fontSize="29" fontWeight="900">{overview.index ? Number(overview.index.value).toLocaleString("zh-TW",{maximumFractionDigits:2}) : "尚無行情"}</text>
                    <text y="43" textAnchor="middle" fill={SUN} fontSize="15">TAIEX · {pct(overview.index?.change??null)}</text>
                  </g>)}
                {overviewDistricts.map(d=><g key={`sign:${d.id}`} transform={`translate(${address(d).x} ${address(d).y})`} onClick={()=>focusDistrict(d.id)} data-city-action="true" className="city-district-sign" aria-hidden="true"><DistrictSign district={d} depth={d.groups.length===1?175:240}/></g>)}
              </> : visibleDistrict ? <>
                <g key={`${focused.id}:${page}:${assembly}`}><District district={visibleDistrict} selectedId={selectedId} focused onFocus={()=>focusDistrict(focused.id)} onPick={pick}/></g>
                {selectedId ? <g transform={`translate(0 ${270+(focusRows-2)*82})`}>
                  <path d="M 0 -85 v 40" stroke={INK} strokeWidth="2" strokeDasharray="4 5"/>
                  <text textAnchor="middle" y="-28" fontSize="14" fontWeight="800">{selected?.name} → 成分股拆解{members.length>6?` · 成交額前 6 / ${members.length} 檔`:""}</text>
                  {members.slice(0,6).map((m,i)=><g key={m.assetId} transform={`translate(${(i-(Math.min(members.length,6)-1)/2)*119} ${i%2?30:0})`}>
                    <g className="city-stock city-assemble" style={{animationDelay:`${i*85}ms`}} role="button" tabIndex={0} aria-label={`查看個股 ${m.symbol} ${m.name}`} aria-pressed={stockId===m.assetId} data-city-action="true" onClick={()=>setStockId(m.assetId)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setStockId(m.assetId);}}}>
                      <Block w={75} d={43} h={22} fill={stockId===m.assetId?SUN:CREAM}/><text y="45" textAnchor="middle" fontSize="12" fontWeight="800">{m.name}</text><text y="62" textAnchor="middle" fontSize="11">{m.symbol} · {pct(m.ret)}</text>
                    </g>
                  </g>)}
                  {!detail?<text y="35" textAnchor="middle" fontSize="14">{failed?"資料讀取失敗，請於右側重試":"正在拆開成分股…"}</text>:!members.length?<text y="35" textAnchor="middle" fontSize="14">目前沒有成分股資料</text>:null}
                </g>:null}
              </> : null}
            </g>
          </svg> : <div className="city-empty">尚未取得市場行情，資料同步後將自動建立積木城市。</div>}
        </div>
        <div className="city-scene-footer"><span>{focused?"點選積木塔，拆開成分股":"點底板看產業 · 點積木看族群"}</span><div className="city-zoom"><button onClick={()=>zoom(.8)} aria-label="縮小城市">−</button><button onClick={()=>setView({x:0,y:0,scale:1})} aria-label="重設城市視角">{Math.round(view.scale*100)}%</button><button onClick={()=>zoom(1.25)} aria-label="放大城市">＋</button></div></div>
        {focused && focused.groups.length>9?<div className="city-pagination"><button disabled={page===0} onClick={()=>{setSelectedId(null);setStockId(null);setClosing(false);setPage(p=>p-1);setView({x:0,y:0,scale:1});}}>← 上一組</button><span>{page*9+1}–{Math.min((page+1)*9,focused.groups.length)} / {focused.groups.length} 族群</span><button disabled={(page+1)*9>=focused.groups.length} onClick={()=>{setSelectedId(null);setStockId(null);setClosing(false);setPage(p=>p+1);setView({x:0,y:0,scale:1});}}>下一組 →</button></div>:null}
      </div>
      <aside className="city-panel" aria-label="市場與族群詳細資料">
        {selected ? <>
          <div className="city-panel-heading"><span className="city-eyebrow">GROUP / 拆開看</span><button aria-label="合攏族群" onClick={closeGroup}>×</button></div>
          <h3>{selected.name}</h3><p className="city-caption">{overview.date} 收盤 · {selected.quoted} / {selected.members} 檔有行情</p>
          <div className="city-stat-pair"><div><small>法人合計 · 當日估算</small><strong className={signClass(groupFlow)}>{money(groupFlow)}</strong></div><div><small>總成交額</small><strong>{money(selected.turnover,false)}</strong></div></div>
          <div className="city-flow-breakdown">{([['foreign','外資'],['trust','投信'],['dealer','自營商']] as const).map(([kind,label])=><div key={kind}><span>{label}</span><b className={signClass(selected.flow[kind])}>{money(selected.flow[kind])}</b></div>)}</div>
          <div className="city-panel-subhead"><h4>成分股</h4><span>依成交額排序</span></div>
          <div aria-live="polite">{failed?<div className="city-empty">讀取失敗 <button onClick={()=>setRetry(n=>n+1)}>重新載入</button></div>:!detail?<p className="city-caption" role="status">正在載入成分股…</p>:<>
            {detail.date!==overview.date?<p className="city-caption">成分股資料日：{detail.date??"尚無行情"}</p>:null}
            {members.length?<div className="city-member-list">{members.map(m=><button key={m.assetId} className={stockId===m.assetId?"is-active":""} onClick={()=>setStockId(m.assetId)} aria-pressed={stockId===m.assetId}><span><b>{m.name}</b><small>{m.symbol}{m.held?" · 我的持股":""}</small></span><span><b className={signClass(m.ret)}>{pct(m.ret)}</b><small>{money(m.turnover,false)}</small></span></button>)}</div>:<p className="city-caption">目前沒有成分股資料。</p>}
          </>}</div>
          {selectedStock?<div className="city-stock-detail"><div className="city-panel-subhead"><h4>{selectedStock.symbol} {selectedStock.name}</h4><button onClick={()=>setStockId(null)} aria-label="關閉個股明細">×</button></div><p>收盤 <b>{selectedStock.close??"—"}</b> · <b className={signClass(selectedStock.ret)}>{pct(selectedStock.ret)}</b></p><div className="city-flow-breakdown">{([['foreign','外資'],['trust','投信'],['dealer','自營商']] as const).map(([kind,label])=><div key={kind}><span>{label} · 近 20 交易日</span><b className={signClass(selectedStock.flows20[kind])}>{money(selectedStock.flows20[kind])}</b></div>)}</div><small>20 日法人與城市的當日法人期間不同；資料不足顯示 —。</small></div>:null}
          <button className="city-back" onClick={closeGroup}>← 合攏，返回{focused?.name}</button>
        </> : <>
          <span className="city-eyebrow">{focused?"DISTRICT / 產業底板":"MARKET / 今天的底板"}</span><h3>{focused?.name??"大盤總覽"}</h3>
          {!focused?<><p className="city-caption">TAIEX 加權指數 · {overview.index?.date??overview.date??"尚未同步"}</p><div className="city-index">{overview.index?Number(overview.index.value).toLocaleString("zh-TW",{maximumFractionDigits:2}):"—"}</div><b className={signClass(overview.index?.change??null)}>{pct(overview.index?.change??null)}</b><div className="city-stat-pair"><div><small>市場成交額</small><strong>{overview.turnover?money(Number(overview.turnover),false):"—"}</strong></div><div><small>有行情個股</small><strong>{overview.stocks.toLocaleString()} 檔</strong></div></div><div className="city-breadth"><span>漲 <b className="city-gain">{overview.upCount}</b></span><span>跌 <b className="city-loss">{overview.downCount}</b></span><span>平 {overview.unchangedCount}</span></div></>:<p className="city-caption">共 {focused.totalGroups} 個{level==="theme"?"族群":"產業"}，點選積木或下方名稱深入。</p>}
          <div className="city-panel-subhead"><h4>{focused?"全部積木":"探索產業底板"}</h4><span>{focused?"依成交額排序":`${districts.length} 個區域`}</span></div>
          {!focused?<div className="city-district-list">{districts.map((d,i)=><button key={d.id} onClick={()=>focusDistrict(d.id)}><span className="city-district-number">{String(i+1).padStart(2,"0")}</span><b>{d.name}</b><span>{d.totalGroups} 群 ↗</span></button>)}</div>:null}
        </>}
        <div className="city-search"><label htmlFor="city-search">搜尋{level==="theme"?"族群":"產業"}{focused?` · ${focused.name}`:" · 全市場"}</label><input id="city-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="輸入名稱，找到那塊積木…"/>
          {query.trim() || (focused&&!selected) ? <div className="city-search-results">{candidates.length?candidates.map(g=><button key={g.id} onClick={()=>pick(g.id)}><span>{g.name}</span><small>{money(g.turnover,false)} ↗</small></button>):<p>沒有符合的積木</p>}</div>:null}
        </div>
        <p className="city-panel-note">族群可能重疊，金額不能直接加總成全市場。— 表示資料不足。<Link href="/market#market-reading">閱讀方式 ↗</Link></p>
      </aside>
    </div>
    <div className="city-legend" aria-label="積木資料圖例"><div><span className="city-key city-key-in"/><b>紅 · 法人買超</b></div><div><span className="city-key city-key-out"/><b>海綠 · 法人賣超</b></div><div><span className="city-key city-key-zero"/>零 · 奶油白</div><div><span className="city-key city-key-missing"/>缺值 · 虛線</div><p><b>底板色</b>＝產業　<b>占地</b>＝成交額　<b>層數</b>＝法人幅度（相對 1–6 級）<br/><small>地點只表分類；組裝動畫不是歷史資金回放。</small></p></div>
  </section>;
}
