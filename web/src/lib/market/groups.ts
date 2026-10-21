/**
 * 板塊 > 產業 > 族群 > 個股。
 *
 * - 產業：證交所／櫃買中心的產業別（資產主檔 metadata.industry），成員是該產業的普通股。
 * - 板塊：把產業歸成幾大類（下面的 SECTORS）。
 * - 族群：整理過的清單（THEMES，草稿，要經過使用者審核）。成員寫「代號 名稱」，
 *   同步時會跟資產主檔比對名稱，代號打錯（名稱對不上）或已下市的會列出來，不會默默加錯。
 *
 * 一檔股票可以屬於多個族群。改清單只要改這個檔案，排程同步時會更新資料庫。
 */

export interface SectorDef {
  id: string;
  name: string;
  industries: string[];
}

export const SECTORS: SectorDef[] = [
  {
    id: "tech",
    name: "電子科技",
    industries: ["半導體業", "電腦及週邊設備業", "光電業", "通信網路業", "電子零組件業", "電子通路業", "資訊服務業", "其他電子業", "數位雲端"],
  },
  { id: "materials", name: "原物料", industries: ["水泥工業", "塑膠工業", "化學工業", "玻璃陶瓷", "造紙工業", "鋼鐵工業", "橡膠工業", "紡織纖維"] },
  { id: "industrial", name: "工業與運輸", industries: ["電機機械", "電器電纜", "汽車工業", "航運業", "建材營造業", "綠能環保", "油電燃氣業"] },
  { id: "consumer", name: "民生消費", industries: ["食品工業", "觀光餐旅", "觀光事業", "貿易百貨業", "運動休閒", "居家生活", "文化創意業", "農業科技業", "電子商務"] },
  { id: "finance", name: "金融", industries: ["金融保險業"] },
  { id: "health", name: "生技醫療", industries: ["生技醫療業"] },
];
export const OTHER_SECTOR: SectorDef = { id: "other", name: "其他", industries: [] };

/** 常見產業別的英文代號（族群的上層用）；沒列到的產業用名稱的雜湊當代號 */
export const INDUSTRY_IDS: Record<string, string> = {
  半導體業: "ind-semi",
  電腦及週邊設備業: "ind-computer",
  光電業: "ind-opto",
  通信網路業: "ind-network",
  電子零組件業: "ind-component",
  電子通路業: "ind-distribution",
  資訊服務業: "ind-it-service",
  其他電子業: "ind-other-elec",
  數位雲端: "ind-cloud",
  水泥工業: "ind-cement",
  塑膠工業: "ind-plastic",
  化學工業: "ind-chemical",
  玻璃陶瓷: "ind-glass",
  造紙工業: "ind-paper",
  鋼鐵工業: "ind-steel",
  橡膠工業: "ind-rubber",
  紡織纖維: "ind-textile",
  電機機械: "ind-machinery",
  電器電纜: "ind-cable",
  汽車工業: "ind-auto",
  航運業: "ind-shipping",
  建材營造業: "ind-construction",
  綠能環保: "ind-green",
  油電燃氣業: "ind-utility",
  食品工業: "ind-food",
  觀光餐旅: "ind-tourism",
  觀光事業: "ind-tourism2",
  貿易百貨業: "ind-retail",
  運動休閒: "ind-sports",
  居家生活: "ind-home",
  文化創意業: "ind-culture",
  農業科技業: "ind-agri",
  電子商務: "ind-ecommerce",
  金融保險業: "ind-finance",
  生技醫療業: "ind-biotech",
  其他業: "ind-other",
};

export function industryId(name: string): string {
  if (INDUSTRY_IDS[name]) return INDUSTRY_IDS[name];
  // FNV-1a：同一個名稱永遠得到同一個代號
  let h = 0x811c9dc5;
  for (const ch of name) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `ind-x${h.toString(16)}`;
}

export function sectorOf(industry: string): SectorDef {
  return SECTORS.find((s) => s.industries.includes(industry)) ?? OTHER_SECTOR;
}

export interface ThemeDef {
  id: string;
  name: string;
  /** 上層：產業別名稱或板塊代號（跨產業的族群掛在板塊下） */
  parent: string;
  /** 「代號 名稱」 */
  members: string[];
}

/** 族群清單（草稿，2026-10-21 起草並用資產主檔核對過代號與名稱，待使用者審核） */
export const THEMES: ThemeDef[] = [
  // ---- 半導體 ----
  { id: "foundry", name: "晶圓代工", parent: "半導體業", members: ["2330 台積電", "2303 聯電", "5347 世界", "6770 力積電"] },
  { id: "asic", name: "ASIC 設計服務", parent: "半導體業", members: ["3443 創意", "3661 世芯-KY", "3035 智原", "2454 聯發科"] },
  { id: "silicon-ip", name: "矽智財 IP", parent: "半導體業", members: ["3529 力旺", "6643 M31", "6533 晶心科", "6531 愛普"] },
  { id: "dram", name: "記憶體製造", parent: "半導體業", members: ["2408 南亞科", "2344 華邦電", "2337 旺宏"] },
  { id: "memory-module", name: "記憶體模組與控制", parent: "半導體業", members: ["3260 威剛", "8299 群聯", "4967 十銓", "2451 創見", "8271 宇瞻"] },
  { id: "niche-memory", name: "利基型記憶體 IC", parent: "半導體業", members: ["3006 晶豪科", "5351 鈺創", "8277 商丞"] },
  { id: "osat", name: "IC 封裝", parent: "半導體業", members: ["3711 日月光投控", "6239 力成", "6147 頎邦", "8150 南茂", "2441 超豐", "3374 精材"] },
  { id: "ic-test", name: "IC 測試", parent: "半導體業", members: ["2449 京元電子", "6257 矽格", "3264 欣銓"] },
  { id: "probe-card", name: "測試介面與探針卡", parent: "半導體業", members: ["6510 精測", "6223 旺矽", "6515 穎崴"] },
  { id: "adv-pkg-equip", name: "先進封裝設備", parent: "半導體業", members: ["3131 弘塑", "3583 辛耘", "6187 萬潤", "2467 志聖", "6640 均華", "1560 中砂"] },
  { id: "fab-facility", name: "廠務與半導體設備", parent: "半導體業", members: ["6196 帆宣", "2404 漢唐", "6139 亞翔", "3413 京鼎", "3680 家登", "5443 均豪"] },
  { id: "wafer", name: "矽晶圓", parent: "半導體業", members: ["6488 環球晶", "5483 中美晶", "3532 台勝科", "6182 合晶", "3016 嘉晶"] },
  { id: "compound-semi", name: "化合物半導體", parent: "半導體業", members: ["3105 穩懋", "8086 宏捷科", "2455 全新", "4991 環宇-KY", "3707 漢磊"] },
  { id: "mosfet", name: "功率元件 MOSFET", parent: "半導體業", members: ["6435 大中", "5299 杰力", "8261 富鼎", "3317 尼克森"] },
  { id: "diode", name: "二極體", parent: "半導體業", members: ["2481 強茂", "5425 台半", "8255 朋程"] },
  { id: "display-ic", name: "顯示驅動 IC", parent: "半導體業", members: ["3034 聯詠", "4961 天鈺", "8016 矽創", "3545 敦泰", "3592 瑞鼎"] },
  { id: "hs-interface", name: "高速傳輸 IC", parent: "半導體業", members: ["4966 譜瑞-KY", "5269 祥碩", "6756 威鋒電子"] },
  { id: "network-ic", name: "網通 IC", parent: "半導體業", members: ["2379 瑞昱"] },
  { id: "pmic", name: "電源管理 IC", parent: "半導體業", members: ["6415 矽力*-KY", "6719 力智", "3588 通嘉", "6138 茂達"] },
  { id: "mcu", name: "MCU 微控制器", parent: "半導體業", members: ["6202 盛群", "4919 新唐", "2401 凌陽", "5471 松翰"] },
  { id: "bmc", name: "伺服器管理晶片", parent: "半導體業", members: ["5274 信驊"] },
  { id: "semi-chem", name: "半導體材料與特化", parent: "化學工業", members: ["4755 三福化", "1773 勝一", "1711 永光", "4770 上品"] },

  // ---- 電腦與伺服器 ----
  { id: "ai-server", name: "AI 伺服器", parent: "tech", members: ["2382 廣達", "3231 緯創", "6669 緯穎", "2317 鴻海", "2356 英業達", "2376 技嘉", "3706 神達"] },
  { id: "server-chassis", name: "伺服器機殼與滑軌", parent: "電腦及週邊設備業", members: ["8210 勤誠", "2059 川湖", "3693 營邦", "6584 南俊國際"] },
  { id: "thermal", name: "散熱", parent: "電腦及週邊設備業", members: ["3017 奇鋐", "3324 雙鴻", "3653 健策", "6230 尼得科超眾", "2421 建準", "8996 高力", "3338 泰碩"] },
  { id: "power-supply", name: "電源供應器", parent: "電子零組件業", members: ["2308 台達電", "2301 光寶科", "6412 群電", "3015 全漢", "6282 康舒"] },
  { id: "pc-brand-odm", name: "PC 品牌與代工", parent: "電腦及週邊設備業", members: ["2357 華碩", "2353 宏碁", "2324 仁寶", "4938 和碩", "2377 微星"] },
  { id: "ipc", name: "工業電腦", parent: "電腦及週邊設備業", members: ["2395 研華", "6414 樺漢", "3088 艾訊", "6166 凌華", "8050 廣積", "6579 研揚", "2397 友通"] },
  { id: "gpu-board", name: "主機板與顯示卡", parent: "電腦及週邊設備業", members: ["2376 技嘉", "2377 微星", "2357 華碩", "3515 華擎", "6150 撼訊"] },

  // ---- 電子零組件 ----
  { id: "mlcc", name: "被動元件", parent: "電子零組件業", members: ["2327 國巨", "2492 華新科", "3026 禾伸堂", "6173 信昌電", "2375 凱美"] },
  { id: "abf", name: "ABF 載板", parent: "電子零組件業", members: ["3037 欣興", "8046 南電", "3189 景碩"] },
  { id: "pcb", name: "PCB 板廠", parent: "電子零組件業", members: ["2313 華通", "3044 健鼎", "2368 金像電", "4958 臻鼎-KY", "2316 楠梓電"] },
  { id: "ccl", name: "銅箔基板", parent: "電子零組件業", members: ["2383 台光電", "6274 台燿", "6213 聯茂"] },
  { id: "copper-glass", name: "銅箔與玻纖布", parent: "電子零組件業", members: ["8358 金居", "1815 富喬", "1802 台玻"] },
  { id: "fpc", name: "軟板", parent: "電子零組件業", members: ["6153 嘉聯益", "6269 台郡"] },
  { id: "pcb-equip", name: "PCB 設備", parent: "電子零組件業", members: ["3167 大量", "6664 群翊"] },
  { id: "connector", name: "連接器與線材", parent: "電子零組件業", members: ["3665 貿聯-KY", "3533 嘉澤", "2392 正崴", "6197 佳必琪", "3023 信邦", "3605 宏致"] },
  { id: "quartz", name: "石英元件", parent: "電子零組件業", members: ["3042 晶技", "8182 加高", "3221 台嘉碩"] },
  { id: "leadframe", name: "導線架", parent: "電子零組件業", members: ["2351 順德", "8070 長華*"] },
  { id: "hinge", name: "樞紐與機構件", parent: "電子零組件業", members: ["3376 新日興", "2474 可成", "2354 鴻準"] },

  // ---- 通信網路與光電 ----
  { id: "optical-comm", name: "光通訊與矽光子", parent: "通信網路業", members: ["3081 聯亞", "4979 華星光", "3450 聯鈞", "3363 上詮", "4908 前鼎", "6442 光聖", "3163 波若威"] },
  { id: "switch", name: "網通設備", parent: "通信網路業", members: ["2345 智邦", "6285 啟碁", "3596 智易", "4906 正文", "5388 中磊", "3380 明泰"] },
  { id: "leo-sat", name: "低軌衛星", parent: "通信網路業", members: ["3491 昇達科", "2314 台揚", "6285 啟碁", "2313 華通", "3138 耀登"] },
  { id: "lens", name: "光學鏡頭", parent: "光電業", members: ["3008 大立光", "3406 玉晶光", "3362 先進光"] },
  { id: "panel", name: "面板", parent: "光電業", members: ["2409 友達", "3481 群創", "6116 彩晶"] },
  { id: "led", name: "LED", parent: "光電業", members: ["3714 富采", "2393 億光"] },
  { id: "epaper", name: "電子紙", parent: "光電業", members: ["8069 元太"] },
  { id: "apple", name: "蘋果供應鏈", parent: "tech", members: ["2317 鴻海", "4938 和碩", "3008 大立光", "2474 可成", "3406 玉晶光", "4958 臻鼎-KY", "6269 台郡"] },

  // ---- 電子通路、軟體、測試 ----
  { id: "distribution", name: "電子通路", parent: "電子通路業", members: ["3036 文曄", "3702 大聯大", "3010 華立", "6189 豐藝"] },
  { id: "software", name: "軟體與資安", parent: "資訊服務業", members: ["6214 精誠", "2471 資通", "5203 訊連", "6690 安碁資訊"] },
  { id: "test-equip", name: "測試與量測設備", parent: "其他電子業", members: ["2360 致茂", "3030 德律"] },
  { id: "gaming", name: "遊戲", parent: "文化創意業", members: ["3293 鈊象", "5478 智冠", "6180 橘子", "3546 宇峻"] },

  // ---- 工業 ----
  { id: "robot", name: "機器人與自動化", parent: "電機機械", members: ["2049 上銀", "1590 亞德客-KY", "4583 台灣精銳", "2359 所羅門", "8374 羅昇", "4576 大銀微系統"] },
  { id: "machine-tool", name: "工具機", parent: "電機機械", members: ["1583 程泰", "4526 東台", "1540 喬福", "4510 高鋒"] },
  { id: "heavy-electric", name: "重電", parent: "電機機械", members: ["1503 士電", "1519 華城", "1513 中興電", "1514 亞力", "1504 東元"] },
  { id: "cable", name: "電線電纜", parent: "電器電纜", members: ["1605 華新", "1609 大亞", "1608 華榮"] },
  { id: "solar", name: "太陽能", parent: "綠能環保", members: ["6443 元晶", "3576 聯合再生", "6244 茂迪"] },
  { id: "wind-energy", name: "風電與綠能工程", parent: "綠能環保", members: ["9958 世紀鋼", "3708 上緯投控"] },
  { id: "ev-parts", name: "電動車零組件", parent: "汽車工業", members: ["1536 和大", "1537 廣隆", "8255 朋程", "1533 車王電", "3665 貿聯-KY"] },
  { id: "auto-am", name: "汽車售後零件", parent: "汽車工業", members: ["1522 堤維西", "1524 耿鼎", "1525 江申", "2231 為升"] },
  { id: "defense", name: "國防與航太", parent: "其他業", members: ["2634 漢翔", "8033 雷虎", "2645 長榮航太"] },
  { id: "container-ship", name: "貨櫃航運", parent: "航運業", members: ["2603 長榮", "2609 陽明", "2615 萬海"] },
  { id: "bulk-ship", name: "散裝航運", parent: "航運業", members: ["2606 裕民", "2637 慧洋-KY", "2605 新興", "2612 中航", "5608 四維航"] },
  { id: "airline", name: "航空", parent: "航運業", members: ["2618 長榮航", "2610 華航", "2646 星宇航空"] },
  { id: "construction", name: "營建", parent: "建材營造業", members: ["2542 興富發", "2548 華固", "5534 長虹", "2501 國建", "2520 冠德", "2545 皇翔"] },
  { id: "gas-utility", name: "燃氣與電力", parent: "油電燃氣業", members: ["9908 大台北", "9918 欣天然", "8926 台汽電"] },
  { id: "environment", name: "環保處理", parent: "綠能環保", members: ["8422 可寧衛", "8341 日友"] },

  // ---- 原物料 ----
  { id: "steel", name: "鋼鐵", parent: "鋼鐵工業", members: ["2002 中鋼", "2014 中鴻", "2006 東和鋼鐵", "2031 新光鋼", "2015 豐興"] },
  { id: "stainless", name: "不鏽鋼", parent: "鋼鐵工業", members: ["2027 大成鋼", "2034 允強", "2030 彰源", "2025 千興"] },
  { id: "petrochem", name: "塑化", parent: "塑膠工業", members: ["1301 台塑", "1303 南亞", "1326 台化", "6505 台塑化", "1304 台聚", "1308 亞聚"] },
  { id: "cement", name: "水泥", parent: "水泥工業", members: ["1101 台泥", "1102 亞泥", "1104 環泥", "1108 幸福", "1110 東泥"] },
  { id: "textile", name: "機能紡織與成衣", parent: "紡織纖維", members: ["1476 儒鴻", "1477 聚陽", "1402 遠東新", "1434 福懋"] },

  // ---- 民生消費 ----
  { id: "shoes", name: "製鞋", parent: "居家生活", members: ["9910 豐泰", "9904 寶成", "9802 鈺齊-KY"] },
  { id: "bicycle", name: "自行車", parent: "運動休閒", members: ["9921 巨大", "9914 美利達"] },
  { id: "fitness", name: "運動器材", parent: "運動休閒", members: ["1736 喬山", "8462 柏文"] },
  { id: "food", name: "食品", parent: "食品工業", members: ["1216 統一", "1210 大成", "1227 佳格", "1201 味全", "1231 聯華食"] },
  { id: "retail", name: "零售通路", parent: "貿易百貨業", members: ["2912 統一超", "5903 全家", "8454 富邦媒"] },
  { id: "dining", name: "餐飲與觀光", parent: "觀光餐旅", members: ["2727 王品", "2723 美食-KY", "2707 晶華", "2731 雄獅"] },

  // ---- 金融 ----
  {
    id: "fin-holding",
    name: "金控",
    parent: "金融保險業",
    members: ["2881 富邦金", "2882 國泰金", "2891 中信金", "2886 兆豐金", "2884 玉山金", "2885 元大金", "2892 第一金", "2880 華南金", "2887 台新新光金", "2883 凱基金", "5880 合庫金", "2890 永豐金"],
  },
  { id: "bank", name: "銀行", parent: "金融保險業", members: ["2834 臺企銀", "2801 彰銀", "2812 台中銀", "5876 上海商銀"] },
  { id: "securities", name: "證券期貨", parent: "金融保險業", members: ["6005 群益證", "2855 統一證", "6024 群益期"] },

  // ---- 生技醫療 ----
  { id: "new-drug", name: "新藥", parent: "生技醫療業", members: ["6446 藥華藥", "4743 合一", "4174 浩鼎", "4162 智擎"] },
  { id: "cdmo", name: "學名藥與 CDMO", parent: "生技醫療業", members: ["6472 保瑞", "1795 美時", "1789 神隆"] },
  { id: "contact-lens", name: "隱形眼鏡", parent: "生技醫療業", members: ["1565 精華", "6491 晶碩"] },
  { id: "medical-device", name: "醫療器材", parent: "生技醫療業", members: ["4107 邦特", "4106 雃博"] },
];

/** 名稱比對：去掉空白、星號、-KY 後相同，或一邊是另一邊的開頭（「日月光投控」與「日月光」） */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, "").replace(/\*/g, "").replace(/-KY$/i, "").toUpperCase();
  const [x, y] = [n(a), n(b)];
  return x === y || (x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x)));
}

export function parseMember(member: string): { symbol: string; name: string } {
  const [symbol, ...rest] = member.trim().split(/\s+/);
  return { symbol: symbol.toUpperCase(), name: rest.join(" ") };
}
