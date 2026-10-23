<script>
"use strict";
const GUAR_IMG = "__GUAR__";
/* product photos (inlined at build time from media/*.b64) */
const DEMO_IMG = k => ({bdcover:'__DEMO_bdcover__', bdgold:'__DEMO_bdgold__', bdbracelet:'__DEMO_bdbracelet__', bdflight:'__DEMO_bdflight__', bddate:'__DEMO_bddate__', bdcloth:'__DEMO_bdcloth__', bdphone:'__DEMO_bdphone__', bdpt:'__DEMO_bdpt__', bdpad:'__DEMO_bdpad__', bdkose:'__DEMO_bdkose__', bdrefa:'__DEMO_bdrefa__', bdring:'__DEMO_bdring__', bdbuffet:'__DEMO_bdbuffet__', bddonki:'__DEMO_bddonki__', bdagain:'__DEMO_bdagain__', bdhbd:'__DEMO_bdhbd__', beats:'__DEMO_beats__', bkart:'__DEMO_bkart__', bkbeast:'__DEMO_bkbeast__', bkboard:'__DEMO_bkboard__', bkcover:'__DEMO_bkcover__', bkguts:'__DEMO_bkguts__', bkmagnet:'__DEMO_bkmagnet__', bksword:'__DEMO_bksword__', bktowel:'__DEMO_bktowel__', bktowelL:'__DEMO_bktowelL__', bkzodd:'__DEMO_bkzodd__', bkzoddh:'__DEMO_bkzoddh__', cable:'__DEMO_cable__', case:'__DEMO_case__', cover:'__DEMO_cover__', duo:'__DEMO_duo__', gbbox:'__DEMO_gbbox__', gbcalc:'__DEMO_gbcalc__', gbcover:'__DEMO_gbcover__', gbrug:'__DEMO_gbrug__', gbsticker:'__DEMO_gbsticker__', kgbook:'__DEMO_kgbook__', kgcharm:'__DEMO_kgcharm__', kgchihiro:'__DEMO_kgchihiro__', kgcover:'__DEMO_kgcover__', kgfolder:'__DEMO_kgfolder__', kghakuri:'__DEMO_kghakuri__', kglast:'__DEMO_kglast__', kgposter:'__DEMO_kgposter__', kgpouch:'__DEMO_kgpouch__', kgstand:'__DEMO_kgstand__', kgtowel:'__DEMO_kgtowel__', nrbadge:'__DEMO_nrbadge__', nrblind:'__DEMO_nrblind__', nrcover:'__DEMO_nrcover__', nrmystery:'__DEMO_nrmystery__', nrnaruto:'__DEMO_nrnaruto__', nrsasuke:'__DEMO_nrsasuke__', nrsticker:'__DEMO_nrsticker__', pods:'__DEMO_pods__', pro:'__DEMO_pro__', strap:'__DEMO_strap__', watch:'__DEMO_watch__'}[k] || '').replace(/^__DEMO_.*__$/, '');
const LINKS = {
  ig:'https://www.instagram.com/chiaki_gk.studies/',
  line:'https://line.me/ti/g2/onOPVpRAYARR2bqRz3DKN4IP-XTIayGKwt9QRw?utm_source=invitation&utm_medium=link_copy&utm_campaign=default',
  fb:'https://www.facebook.com/profile.php?id=61554304767569'
};
const PARTNERS = [
  {role:'合作塗裝師', h:'rrrrryan2d', url:'https://www.instagram.com/rrrrryan2d/', av:''},
  {role:'合作塗裝師', h:'best.do7788', url:'https://www.instagram.com/best.do7788/'},
  {role:'合作維修師', h:'_space_box', url:'https://www.instagram.com/_space_box/'},
  {role:'合作維修師', h:'dual_unbound_studio', url:'https://www.instagram.com/dual_unbound_studio/'}
];
/* =========================================================
   CHIAKI prototype — front-end only; every number is sample data.
   In production the draw result is decided server-side (atomic),
   the front end only plays the animation.
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = n => Number(n).toLocaleString('zh-TW');
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function shuffle(arr, rnd){for(let i=arr.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]]}return arr}
const RM = () => document.body.classList.contains('rm') || matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Icons ---------- */
const IP = {
  home:'<path d="M3 10.5 12 3l9 7.5V21H3z"/><path d="M9 21v-6h6v6"/>',
  ticket:'<path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z"/><path d="M13 7v10" stroke-dasharray="2 2"/>',
  box:'<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  wallet:'<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  users:'<circle cx="9" cy="8" r="3.5"/><path d="M2 20c.8-3.5 3.5-5 7-5s6.2 1.5 7 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3.4 2.2 4 5"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  down:'<path d="m6 9 6 6 6-6"/>', right:'<path d="m9 6 6 6-6 6"/>', x:'<path d="M6 6l12 12M18 6 6 18"/>',
  shield:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  truck:'<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  store:'<path d="M4 9h16l-1-5H5zM5 9v11h14V9"/><path d="M10 20v-6h4v6"/>',
  gift:'<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M3 12h18M12 8v13M12 8S10 3 7.5 4.5 9 8 12 8zm0 0s2-5 4.5-3.5S15 8 12 8z"/>',
  star:'<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  fire:'<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 1 1 2 2 2 3 1-2 1-5 1-7z"/>',
  crown:'<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
  bag:'<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell:'<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17.5v.01"/>',
  heart:'<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  recycle:'<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  list:'<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  filter:'<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  dice:'<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  chart:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  alert:'<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
  check:'<path d="m5 12 5 5 9-10"/>',
  motion:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  skip:'<path d="M5 5l9 7-9 7zM17 5v14"/>',
  share:'<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  cart:'<path d="M3 4h2l2.4 11h11l2-8H6.2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>',
  mega:'<path d="M3 10v4h4l8 5V5L7 10z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  card:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  bank:'<path d="M3 10 12 4l9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>',
  doc:'<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  expand:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  grid:'<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  api:'<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  ticketbox:'<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v5"/>',
  ig:'<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5v.01"/>',
  fb:'<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z"/>',
  chat:'<path d="M12 4c5 0 9 3.1 9 7s-4 7-9 7c-.8 0-1.6-.1-2.3-.2L6 20v-3.3C4.2 15.4 3 13.3 3 11c0-3.9 4-7 9-7z"/>',
  brush:'<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 6 2 8 0 1.5-1.5 1.5-3.5 2-4"/>',
  wrench:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>'
};
const ic = (n, s) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${s?` style="${s}"`:''}>${IP[n]||''}</svg>`;

/* ---------- Rank system ---------- */
const RK = {
  LAST:{cls:'rk-last',label:'最後賞',tier:4},
  A:{cls:'rk-a',label:'A賞',tier:3}, B:{cls:'rk-b',label:'B賞',tier:2}, C:{cls:'rk-c',label:'C賞',tier:1},
  D:{cls:'rk-d',label:'D賞',tier:0}, E:{cls:'rk-e',label:'E賞',tier:0}, F:{cls:'rk-e',label:'F賞',tier:0},
  G:{cls:'rk-e',label:'G賞',tier:0}, H:{cls:'rk-e',label:'H賞',tier:0}, I:{cls:'rk-e',label:'I賞',tier:0},
  P:{cls:'rk-e',label:'參加獎',tier:0}
};
const rankTag = (rk, small) => `<span class="rank ${RK[rk].cls}"${small?' style="min-width:0;height:24px;font-size:11px;padding:0 6px"':''}>${RK[rk].label}</span>`;
const GRADE = {G:{label:'大獎',cls:'rk-a',tier:3}, M:{label:'中獎',cls:'rk-b',tier:2}, S:{label:'小獎',cls:'rk-e',tier:0}};
const gradeFromRk = rk => (rk === 'LAST' || rk === 'A') ? 'G' : (rk === 'B' || rk === 'C') ? 'M' : 'S';
/* item = a prize instance (pool prize, draw result or warehouse item) */
const lvCls = x => x.lv ? (x.lv === 1 ? 'rk-a' : x.lv === 2 ? 'rk-b' : x.lv === 3 && !x.small ? 'rk-c' : 'rk-e') : x.custom ? GRADE[x.g].cls : RK[x.rk].cls;
const lvLabel = x => x.lvName || (x.custom ? GRADE[x.g].label : RK[x.rk].label);
const tagOf = (x, small) => x.rk === 'LAST' ? rankTag('LAST', small)
  : `<span class="rank ${lvCls(x)}"${small?' style="min-width:0;height:24px;font-size:11px;padding:0 6px"':''}>${lvLabel(x)}</span>`;
const labelOf = x => x.rk === 'LAST' ? '最後賞' : x.custom ? x.name : lvLabel(x);
const glyphOf = x => x.rk === 'LAST' ? 'L' : x.custom ? ({G:'★',M:'◆',S:'・'}[x.g]) : (x.rk === 'P' ? 'P' : x.rk);
const SHIP_M = {home:'宅配到府', c711:'7-11 交貨便', fami:'全家店到店'};
const STORE_DAYS_DEFAULT = 30;
const storeDays = () => ((S.cfg && S.cfg.storeDays) || STORE_DAYS_DEFAULT) + (typeof vipExtraDays === 'function' ? vipExtraDays() : 0);
const SRC = {o:{t:'官方套組',c:'src-o'}, s:{t:'自製套組',c:'src-s'}, m:{t:'混合套組',c:'src-m'}};
const PLAY = {std:'標準賞', guar:'保底挑戰', solo:'單挑賞池', prob:'機率賞'};

/* ---------- Sample data (fictional IPs; replace with real catalog) ---------- */
const NOW = Date.now();
/* 每個賞池都分 1～9 個等級（1 最高）；每個等級可放 1 個或多個不同獎品。
   small = 是否屬「小獎」（計入運費 20 件規則、可按件退運費），未設定時 4 等以後為小獎。
   items: n 名稱、q 數量、rv 回收值、keep 示範用保留數、tag 標籤（未填自動判斷） */
const POOLS = [
  {id:'bk', title:'一番賞 烙印勇士 ～宿命的雙極～', ip:'烙印勇士', src:'o', play:'std', price:420, hue:356, seed:211, setCount:3, setDrawn:[6,0,0], hot:true, isNew:true, img:DEMO_IMG('bkcover'),
   desc:'凱茲與索特宿命對決，A 賞複製原畫、B 賞凱茲雙版本隨機、最後賞索特（人類姿態）。本套獎項皆不提供回收。',
   ship:{home:0, cvs:0}, packs:[1,5,10],
   levels:[
     {name:'A賞', items:[{n:'複製原畫', q:1, tag:'其他', ship:'home', img:DEMO_IMG('bkart')}]},
     {name:'B賞', items:[{n:'凱茲（雙版本隨機）', q:2, tag:'PVC', ship:'home', img:DEMO_IMG('bkguts')}]},
     {name:'C賞', items:[{n:'斬龍劍', q:1, tag:'PVC', ship:'home', img:DEMO_IMG('bksword')}]},
     {name:'D賞', small:false, items:[{n:'夢之獸', q:1, tag:'PVC', ship:'home', img:DEMO_IMG('bkbeast')}]},
     {name:'E賞', small:false, items:[{n:'索特', q:1, tag:'PVC', ship:'home', img:DEMO_IMG('bkzodd')}]},
     {name:'F賞', items:[{n:'100cm 大型緹花毛巾', q:2, tag:'其他', ship:'c711', img:DEMO_IMG('bktowelL')}]},
     {name:'G賞', items:[{n:'頭像磁鐵（全 6 種隨機）', q:20, tag:'其他', ship:'c711', img:DEMO_IMG('bkmagnet')}]},
     {name:'H賞', items:[{n:'緹花毛巾（全 8 種隨機）', q:24, tag:'其他', ship:'c711', img:DEMO_IMG('bktowel')}]},
     {name:'I賞', items:[{n:'畫布風格展示板（全 25 種隨機）', q:28, tag:'其他', ship:'c711', img:DEMO_IMG('bkboard')}]}],
   last:'索特（人類姿態）', lastImg:DEMO_IMG('bkzoddh')},
  {id:'kg', title:'一番賞 神樂鉢', ip:'神樂鉢', src:'o', play:'std', price:420, hue:220, seed:233, drawn:0, isNew:true, img:DEMO_IMG('kgcover'),
   desc:'六平千鑛、漣伯理雙公仔登場，A 賞為連載三周年紀念書本造型展示板。本套獎項皆不提供回收。',
   ship:{home:0, cvs:0}, packs:[1,5,10],
   levels:[
     {name:'A賞', items:[{n:'連載三周年紀念 書本造型展示板', q:3, tag:'其他', ship:'home', img:DEMO_IMG('kgbook')}]},
     {name:'B賞', items:[{n:'六平千鑛', q:1, tag:'PVC', ship:'home', img:DEMO_IMG('kgchihiro')}]},
     {name:'C賞', items:[{n:'漣伯理', q:2, tag:'PVC', ship:'home', img:DEMO_IMG('kghakuri')}]},
     {name:'D賞', items:[{n:'大毛巾（全兩款）', q:2, tag:'其他', ship:'c711', img:DEMO_IMG('kgtowel')}]},
     {name:'E賞', items:[{n:'網布收納袋', q:4, tag:'其他', ship:'c711', img:DEMO_IMG('kgpouch')}]},
     {name:'F賞', items:[{n:'透明海報', q:20, tag:'其他', ship:'c711', img:DEMO_IMG('kgposter')}]},
     {name:'G賞', items:[{n:'壓克力立牌', q:16, tag:'其他', ship:'c711', img:DEMO_IMG('kgstand')}]},
     {name:'H賞', items:[{n:'壓克力吊飾', q:14, tag:'其他', ship:'c711', img:DEMO_IMG('kgcharm')}]},
     {name:'I賞', items:[{n:'透明資料夾＆貼紙組', q:18, tag:'其他', ship:'c711', img:DEMO_IMG('kgfolder')}]}],
   last:'六平千鑛', lastImg:DEMO_IMG('kglast')},
];
const LV_RK = 'ABCDEFGHI';
/* levels → flat prize list (each prize knows its level) */
function flattenLevels(p){
  p.prizes = [];
  p.levels.forEach((L, i) => { const lv = i + 1, small = L.small != null ? !!L.small : lv >= 4;
    L.items.forEach(it => p.prizes.push({name:it.n, qty:it.q, keep:it.keep || 0, rv:it.rv || 0, tag:it.tag || null, img:it.img || null, ship:it.ship || (lv === 1 || it.tag === 'GK' ? 'home' : 'c711'),
      lv, lvName:L.name || `${lv} 等`, small, rk:LV_RK[i], g: small ? 'S' : lv === 1 ? 'G' : 'M', tier: small ? 0 : lv === 1 ? 3 : lv === 2 ? 2 : 1})); });
}
const PRODUCTS = [
  {id:'s2', name:'CHIAKI 黑金 收藏展示盒', ip:'CHIAKI ORIGINAL', price:1280, hue:42, stock:12},
];

/* Build fixed ticket lists (no replacement), mark already-drawn & held tickets */
function buildSet(p, seed, drawn){
  const rnd = mulberry32(seed);
  const list = [];
  p.prizes.forEach((pr, i) => { for (let k = 0; k < pr.qty; k++) list.push(i); });
  shuffle(list, rnd);
  const tickets = list.map((pi, n) => ({no:n+1, pi, taken:false, held:false, by:null}));
  if (p.soon) return {tickets, total:list.length};
  if (drawn >= list.length){ tickets.forEach(t => { t.taken = true; t.by = 'other'; }); return {tickets, total:list.length}; }
  // pre-drawn by other players (protect 'keep' qty of top prizes for demo)
  const protect = p.prizes.map(pr => pr.keep || 0);
  const order = shuffle([...tickets.keys()], rnd);
  let done = 0;
  for (const idx of order){
    if (done >= drawn) break;
    const t = tickets[idx];
    const left = tickets.filter(x => !x.taken && x.pi === t.pi).length;
    if (left <= protect[t.pi]) continue;
    t.taken = true; t.by = 'other'; done++;
  }
  if (drawn > 0){ const free = tickets.filter(t => !t.taken); shuffle(free, rnd).slice(0, Math.min(3, Math.floor(free.length/8))).forEach(t => t.held = true); }
  return {tickets, total:list.length};
}
function buildPool(p){
  if (p.levels) flattenLevels(p);
  p.prizes.forEach(pr => { pr.custom = p.src === 's'; pr.g = pr.g || gradeFromRk(pr.rk); if (pr.tier == null) pr.tier = pr.custom ? GRADE[pr.g].tier : RK[pr.rk].tier; pr.rv = pr.rv || 0; });
  const n = p.setCount || 1;
  p.sets = Array.from({length:n}, (_, s) => buildSet(p, p.seed + s*7919, p.setDrawn ? p.setDrawn[s] : (p.drawn || 0)));
  p.setIdx = Math.max(0, p.sets.findIndex(s => s.tickets.some(t => !t.taken)));
  Object.defineProperty(p, 'tickets', {get(){ return this.sets[this.setIdx].tickets; }, configurable:true});
  Object.defineProperty(p, 'total', {get(){ return this.sets[this.setIdx].total; }, configurable:true});
}
POOLS.forEach(buildPool);
const poolById = id => POOLS.find(p => p.id === id);
const remaining = p => p.tickets.filter(t => !t.taken).length;
const remainOf = (p, i) => p.tickets.filter(t => !t.taken && t.pi === i).length;
const topLeft = p => p.prizes.map((pr,i)=>({pr,i})).filter(x => x.pr.tier >= 2).map(x => ({rk:x.pr.rk, g:x.pr.g, lv:x.pr.lv, lvName:x.pr.lvName, custom:x.pr.custom, n:remainOf(p,x.i), q:x.pr.qty}));
/* shipping is pre-collected per set; one fee covers 20 small prizes (recycled ones don't count) */
const prizeOfItem = w => { const p = poolById(w.pool); return p ? p.prizes.find(x => x.name === w.pname) : null; };
function shipQuote(p, n, pick){
  const key = p.id + ':' + p.setIdx, rec = S.shipPaid[key] || {n:0, m:null};
  const m = rec.m || pick || 'home', fee = m === 'home' ? p.ship.home : p.ship.cvs;
  const small = S.wh.filter(w => w.pool === p.id && w.set === p.setIdx && w.g === 'S').length;   // 已回收的小獎已按件退還運費，仍計入件數
  const need = Math.floor((small + n) / 20) + 1;   // 滿 20 件小獎即再收一份
  const add = Math.max(0, need - rec.n);
  return {key, m, fee, add, cost:add*fee, paid:rec.n, locked:!!rec.m, small, cap:rec.n*20};
}
/* all dates are Taiwan time (UTC+8), regardless of the device clock's zone */
const twISO = (d = new Date()) => new Date(d.getTime() + 8 * 36e5).toISOString();
const twDate = d => twISO(d).slice(0,10);
const twNow = d => { const s = twISO(d); return s.slice(0,10) + ' ' + s.slice(11,16); };
const daysLeft = at => { const end = new Date(at.slice(0,10) + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + storeDays()); return {end:end.toISOString().slice(0,10), d:Math.round((end - new Date(twDate() + 'T00:00:00Z')) / 864e5)}; };
/* copy follows the admin settings (系統設定) instead of hard-coded numbers */
function cfgFill(h){
  const c = (typeof S !== 'undefined' && S.cfg) || {}, warn = c.warnDays || 7, age = c.ageMin || 18;
  const hold = typeof holdSec === 'function' ? holdSec() : 180, holdTxt = hold % 60 ? `${hold} 秒` : `${hold/60} 分鐘`;
  return String(h).replace(/保管 30 天/g, `保管 ${storeDays()} 天`).replace(/前 7 天/g, `前 ${warn} 天`).replace(/（7 天前／當天）/g, `（${warn} 天前／當天）`)
    .replace(/保留 3 分鐘/g, `保留 ${holdTxt}`).replace(/(年滿|未滿) 18 歲/g, `$1 ${age} 歲`)
    .replace(/1\/20/g, `1/${(typeof shipRefundDiv === 'function') ? shipRefundDiv() : 20}`).replace(/累計達 <strong>20 位<\/strong>/g, `累計達 <strong>${c.inviteGoal || 20} 位</strong>`).replace(/1,000 不可退款 CC幣/g, `${fmt(c.inviteReward != null ? c.inviteReward : 1000)} 不可退款 CC幣`);
}
/* copy that reports failure honestly (clipboard is often blocked in in-app browsers) */
async function copyText(v, okMsg){
  let ok = false;
  try { if (navigator.clipboard && window.isSecureContext){ await navigator.clipboard.writeText(v); ok = true; } } catch(_){}
  if (!ok){ try { const t = document.createElement('textarea'); t.value = v; t.setAttribute('readonly',''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove(); } catch(_){} }
  toast(ok ? okMsg : `無法自動複製，請長按選取：${v}`);
  return ok;
}
/* a selector that finds "the same control" again after a re-render */
function focusKey(el){
  if (!el || el === document.body || !el.matches) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const attrs = ['data-act','data-tk','data-id','data-k','data-n','data-v','data-ip','data-to','data-doc'].filter(a => el.hasAttribute(a));
  return attrs.length ? attrs.map(a => `[${a}="${CSS.escape(el.getAttribute(a))}"]`).join('') : null;
}

/* ---------- App state (demo user) ---------- */
const S = {
  coins: 5320, verified: false, rulesOk: false,
  sel: [], holdUntil: 0, holdTimer: null,
  guar: {},
  cart: [],
  follow: ['烙印勇士','火影忍者'],
  wh: [
    {id:'w2', pool:'bk', set:0, rk:'H', lv:8, lvName:'H賞', small:true, g:'S', rv:0, sm:'c711', pname:'緹花毛巾（全 8 種隨機）', name:'烙印勇士 緹花毛巾（狂戰士紋章）', hue:356, at:'2026-10-21', st:'stored'},
    {id:'w4', pool:'gb', set:0, custom:true, lv:3, lvName:'3 獎', g:'M', rv:100, sm:'c711', pname:'宮崎駿盲盒', name:'宮崎駿・吉卜力 宮崎駿盲盒', hue:28, at:'2026-10-02', st:'ship', track:'7-ELEVEN 交貨便 F2610231188'},
    {id:'w5', pool:'nr', set:0, custom:true, lv:5, lvName:'5 獎', small:true, g:'S', rv:10, sm:'c711', pname:'火影同人貼紙', name:'火影忍者 火影同人貼紙', hue:22, at:'2026-09-20', st:'done'},
    {id:'w6', pool:'gb', set:0, custom:true, lv:4, lvName:'4 獎', small:true, g:'S', rv:10, sm:'c711', pname:'宮崎駿同人貼紙', name:'宮崎駿・吉卜力 宮崎駿同人貼紙', hue:28, at:'2026-09-14', st:'recycled'},
  ],
  shipPaid: {},
  shipPick: 'home',
  whSel: [], whTab:'stored',
  tx: [
    {t:'儲值 ・ 信用卡（綠界）', d:'2026-10-20 21:14', a:+3000, ic:'card'},
    {t:'抽賞 ・ 一番賞 烙印勇士 ～宿命的雙極～ ×3', d:'2026-10-18 22:40', a:-1260, ic:'ticket'},
    {t:'回收獎品 ・ 宮崎駿同人貼紙 → 不可退款 CC幣', d:'2026-09-14 13:02', a:+10, ic:'recycle', pt:true},
  ],
  pick: {pack:1000, pay:'card'},
  admin: 'dash',
  binds: {line:false, group:false, ig:false, fb:false, phone:'done'}
};
/* lifetime sales across every set of a pool (admin numbers) */
const soldAll = p => p.soon ? 0 : p.sets.reduce((s, x) => s + x.tickets.filter(t => t.taken).length, 0);
const totalAll = p => p.sets.reduce((s, x) => s + (x.total || p.total), 0);
/* sample items carry a fixed ticket number like real draws do */
S.wh.forEach((w, i) => { if (!w.no){ const p = poolById(w.pool); w.no = p ? (i * 7 + 3) % p.total + 1 : i + 1; } });
let drawLog = [
  {u:'k***a', pool:'烙印勇士', txt:'B賞 凱茲'},{u:'r***n', pool:'火影忍者', txt:'4 獎 徽章'},{u:'y***i', pool:'宮崎駿・吉卜力', txt:'神隱卡西法'},
  {u:'t***2', pool:'神樂鉢', txt:'C賞 漣伯理'},{u:'s***o', pool:'烙印勇士', txt:'最後賞 索特（人類姿態）'}
]

/* ---------- Generic UI helpers ---------- */
function toast(msg){
  const r = $('#toastRoot'); r.innerHTML = `<div class="toast">${ic('check','width:18px;height:18px')}${msg}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => r.innerHTML = '', 2400);
}
let lastFocus = null;
function openModal(html, opts = {}){
  const ae = document.activeElement, inside = $('#modalRoot').contains(ae) && ae !== document.body;
  const again = inside ? focusKey(ae) : null;
  if (!inside) lastFocus = ae;
  $('#modalRoot').innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mdlT">
    <div class="scrim" data-act="close-modal"></div>
    <div class="dlg ${opts.wide?'wide':''}">
      <button class="ibtn x" data-act="close-modal" aria-label="關閉">${ic('x')}</button>${cfgFill(html)}</div></div>`;
  document.documentElement.style.overflow = 'hidden';
  setTimeout(() => { const g = again && $('#modalRoot .dlg ' + again); if (g){ g.focus(); return; } const f = $('#modalRoot .dlg h3') ; if (f){ f.setAttribute('tabindex','-1'); f.focus(); } }, 30);
}
function closeModal(){
  $('#modalRoot').innerHTML = ''; document.documentElement.style.overflow = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
/* keyboard focus stays inside an open dialog / the draw stage */
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const box = $('#modalRoot .dlg') || $('#sum.show') || $('#stage'); if (!box) return;
  const f = $$('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])', box)
    .filter(x => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], cur = document.activeElement;
  if (!box.contains(cur)){ e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && cur === first){ e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && cur === last){ e.preventDefault(); first.focus(); }
});
function syncBal(){ $('#navBal').textContent = fmt(S.coins); }

const art = (hue, glyph, cls = '', label = '', img = '') =>
  `<div class="art ${cls}" style="--h:${hue}" ${label?`role="img" aria-label="${label}"`:'aria-hidden="true"'}><div class="fig"></div><span class="glyph" aria-hidden="true">${glyph}</span>${img && img.startsWith('<svg') ? `<div class="tkart">${img}</div>` : img?`<img class="cover" src="${img}" alt="" loading="lazy">`:''}</div>`;

/* ---------- Pool card ---------- */
function poolCard(p){
  if (p.soon){
    return `<a class="pc reveal" href="#/pool/${p.id}">
      <div class="badges"><span class="tag ${SRC[p.src].c}">${SRC[p.src].t}</span></div>
      <span class="status tag info">即將登場</span>
      ${art(p.hue,'A','', p.title+' 商品圖')}
      <div class="body"><h3>${p.title}</h3>
        <div class="price"><span class="coin">C</span>${fmt(p.price)}<small>/ 抽</small></div>
        <div class="meta"><span>開賣倒數</span></div>
        <div class="cd" data-cd="${p.soon}"></div></div></a>`;
  }
  const left = remaining(p), pct = left / p.total * 100, low = pct <= 20;
  const tops = p.src === 's' ? (() => { const t = topLeft(p).reduce((s,x)=>s+x.n,0); return t ? `${t} 件` : ''; })() : topLeft(p).filter(x => x.n > 0).map(x => (x.lvName || RK[x.rk].label).replace(/賞$/,'')).join('・');
  return `<a class="pc reveal" href="#/pool/${p.id}">
    <div class="badges"><span class="tag ${SRC[p.src].c}">${SRC[p.src].t}</span>${p.play!=='std'?`<span class="tag play" style="background:rgba(0,0,0,.5)">${PLAY[p.play]}</span>`:''}</div>
    ${low ? '<span class="status tag hot">即將完售</span>' : p.isNew ? '<span class="status tag ok">NEW</span>' : p.hot ? '<span class="status tag hot">熱門</span>' : ''}
    ${art(p.hue, p.play==='solo'?'1':'A','', p.title+' 商品圖', p.img)}
    <div class="body">
      <h3>${p.title}</h3>${p.sets.length>1?`<span class="dim" style="font-size:12px;line-height:1">第 ${p.setIdx+1} / ${p.sets.length} 套進行中</span>`:''}
      <div class="price"><span class="coin">C</span>${fmt(p.price)}<small>/ 抽</small></div>
      <div class="meter ${low?'low':''}" role="img" aria-label="剩餘 ${left} / ${p.total} 抽"><i style="width:${pct}%"></i></div>
      <div class="meta"><span>剩餘 <b class="num">${left}</b> / ${p.total} 抽</span></div>
      ${tops?`<div class="top">${ic('crown','width:14px;height:14px')}${p.src==='s'?'大獎・中獎剩餘':'大賞剩餘'} ${tops}${p.last?'・Last':''}</div>`:'<div class="top dim">大賞已出完</div>'}
    </div></a>`;
}

/* ---------- Router ---------- */
const routes = {};
function parseHash(){
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = h.split('?');
  const parts = path.split('/');
  return {name: parts[0] || 'home', arg: parts[1], q: new URLSearchParams(qs || '')};
}
let cleanup = [];
function render(keep){
  const ae = document.activeElement, back = keep && $('#app').contains(ae) ? focusKey(ae) : null;
  cleanup.forEach(f => f()); cleanup = [];
  const r = parseHash();
  const fn = routes[r.name] || routes.home;
  const app = $('#app');
  app.innerHTML = cfgFill(fn(r));
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r.name || (r.name==='pool' && a.dataset.nav==='lobby')));
  $$('[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === r.name || (r.name==='pool' && a.dataset.tab==='lobby')));
  $('#footer').style.display = r.name === 'admin' ? 'none' : '';
  if (fn.after) fn.after(r);
  if (keep) $$('.reveal', app).forEach(e => e.classList.add('in'));
  if (back){ const t = $(back, app); if (t) t.focus({preventScroll:true}); }
  observeReveal();
}
function observeReveal(){
  const els = $$('.reveal:not(.in)');
  if (!('IntersectionObserver' in window) || RM()) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver(es => es.forEach((e) => { if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target);} }), {rootMargin:'0px 0px -40px 0px'});
  els.forEach((e, i) => { e.style.transitionDelay = (i % 4) * 60 + 'ms'; io.observe(e); });
  cleanup.push(() => io.disconnect());
}
/* countdowns */
setInterval(() => {
  $$('[data-cd]').forEach(el => {
    let s = Math.max(0, Math.floor((+el.dataset.cd - Date.now()) / 1000));
    const d = Math.floor(s / 86400); s %= 86400; const h = Math.floor(s / 3600); s %= 3600; const m = Math.floor(s / 60); s %= 60;
    el.innerHTML = `<span>${d}天</span><span>${pad(h)}</span><span>${pad(m)}</span><span>${pad(s)}</span>`;
    el.setAttribute('aria-label', `剩餘 ${d} 天 ${h} 小時 ${m} 分`);
  });
}, 1000);

/* =========================================================
   HOME
   ========================================================= */
routes.home = () => {
  const live = POOLS.filter(p => !p.soon && !p.off && !p.demoOnly);
  const used = new Set();
  const pick = arr => { const p = arr.find(x => !used.has(x.id)) || arr[0]; used.add(p.id); return p; };
  const hot = pick([...live].sort((a,b) => (b.hot?1:0)-(a.hot?1:0)));
  const ending = pick([...live].sort((a,b) => remaining(a)/a.total - remaining(b)/b.total));
  const fresh = pick(live.filter(p => p.isNew).concat(live.filter(p => !p.isNew)));
  const soon = POOLS.filter(p => p.soon && !p.off);
  const slides = [
    {p:'bk', k:'官方一番賞', t:'烙印勇士<br>宿命的雙極', d:'A～I 賞＋最後賞，每抽 420 CC幣。'}
  ];
  const tick = drawLog.map(x => `<span>${x.u} 在 <b>${x.pool}</b> 抽中 <em>${x.txt}</em></span>`).join('');
  return `
  <section class="hero" id="hero" aria-label="CHIAKI 主視覺">
    <canvas id="heroCv" aria-hidden="true"></canvas>
    <div class="fog" aria-hidden="true"></div>
    <div class="vtext l" aria-hidden="true">一番賞 ・ 透明獎池</div>
    <div class="vtext r" aria-hidden="true">每一籤，皆可追溯</div>
    <div class="center">
      <div class="kicker" aria-hidden="true"><i></i>ONLINE ICHIBAN KUJI<i></i></div>
      <h1 id="heroLogo" class="brand hero-brand">CHIAKI</h1>
      <div class="tagline" aria-label="為大家的青春與夢想而存在">${[...'為大家的青春與夢想而存在'].map((c,i)=>`<span style="animation-delay:${1+i*.06}s">${c}</span>`).join('')}</div>
      <div class="sub"><span>官方・自製一番賞</span>　<span>機率即時公開｜結果事前鎖定</span></div>
      <div class="cta"><a class="btn gold" href="#/lobby">${ic('ticket')}進入抽賞大廳</a><a class="btn ghost" href="#/support">抽賞規則說明</a></div>
    </div>
    <div class="scroll" aria-hidden="true">SCROLL<i></i></div>
  </section>

  <div class="ticker" aria-label="近期中獎動態"><div class="lab"><i></i>LIVE</div><div class="track">${tick}${tick}</div></div>

  <div class="wrap">
    <section class="sec" aria-label="活動 Banner">
      <div class="carousel" id="car" aria-roledescription="carousel">
        ${slides.map((s,i) => { const p = poolById(s.p); return `
        <div class="slide ${i===0?'on':''}" role="group" aria-roledescription="slide" aria-label="${i+1} / ${slides.length}">
          ${art(p.hue, p.play==='guar'?'保':'A', '', '', p.img)}
          <div class="txt"${p.img?' style="background:linear-gradient(90deg,rgba(0,0,0,.75),transparent);border-radius:0 0 0 var(--r-3)"':''}><div class="k">${s.k}</div><h3>${s.t}</h3><p>${s.d}</p><a class="btn gold" href="#/pool/${p.id}">立即查看</a></div>
        </div>`}).join('')}
        ${slides.length > 1 ? `<div class="dots">${slides.map((s,i)=>`<button data-slide="${i}" aria-label="第 ${i+1} 張" aria-current="${i===0}"><i></i></button>`).join('')}</div>` : ''}
      </div>
    </section>

    <section class="sec" aria-labelledby="h-cat">
      <div class="sec-h"><h2 id="h-cat"><small>CATEGORY</small>玩法分類</h2></div>
      <div class="cats">
        <a class="cat" href="#/lobby?src=o"><span class="ic">${ic('shield')}</span><b>官方一番賞</b><span>正版來源憑證</span></a>
        <a class="cat" href="#/lobby?src=s"><span class="ic">${ic('star')}</span><b>自製一番賞</b><span>CHIAKI 企劃</span></a>
        <a class="cat" href="#/lobby?play=prob"><span class="ic">${ic('fire')}</span><b>機率賞</b><span>機率事先公開</span></a>
        <a class="cat" href="#/forum"><span class="ic">${ic('users')}</span><b>討論區</b><span>開箱與情報</span></a>
        <a class="cat" href="#/warehouse"><span class="ic">${ic('grid')}</span><b>中獎倉庫</b><span>合併出貨</span></a>
        <a class="cat" href="#/shop"><span class="ic">${ic('bag')}</span><b>直購商城</b><span>無機率・定價</span></a>
      </div>
    </section>

    <section class="sec" aria-label="精選賞池">
      <div class="picks">
        ${[['HOT','熱門抽賞','hot',hot],['LAST CHANCE','即將完售','left',ending],['NEW','最新上架','new',fresh]].map(([en,zh,s,p]) => `<div class="pick">
          <div class="sec-h"><h2><small>${en}</small>${zh}</h2><a href="#/lobby?sort=${s}">全部${ic('right','width:16px;height:16px')}</a></div>
          ${poolCard(p)}</div>`).join('')}
      </div>
    </section>

    <section class="sec">
      <div class="two">
        <div>
          <div class="sec-h"><h2><small>COMING SOON</small>即將登場</h2></div>
          <div style="display:grid;gap:16px">${soon.map(p => `
            <a class="soon reveal" href="#/pool/${p.id}" style="color:inherit">
              ${art(p.hue,'A')}
              <div class="info"><span class="tag ${SRC[p.src].c}" style="align-self:flex-start">${SRC[p.src].t}</span><b>${p.title}</b><div class="cd" data-cd="${p.soon}"></div></div>
            </a>`).join('')}</div>
        </div>
        <div>
          <div class="sec-h"><h2><small>NEWS</small>限時活動與公告</h2><a href="#/support">全部${ic('right','width:16px;height:16px')}</a></div>
          <div class="notice">
            <a href="#/support"><span class="tag info">公告</span><span>抽賞規則 v1.0.3 更新：多抽逐張揭曉與略過動畫</span><time>10/18</time></a>
          </div>
        </div>
      </div>
    </section>

    <section class="sec" aria-labelledby="h-trust">
      <div class="sec-h"><h2 id="h-trust"><small>TRUST</small>為什麼選 CHIAKI</h2></div>
      <div class="trust">
        <div class="reveal"><span class="ic">${ic('list')}</span><b>獎池完全公開</b><p>總數、剩餘數、機率、來源與商品狀況即時同步。</p></div>
        <div class="reveal"><span class="ic">${ic('lock')}</span><b>結果事前鎖定</b><p>發布時產生承諾雜湊，完售後公開籤表供驗證。</p></div>
        <div class="reveal"><span class="ic">${ic('box')}</span><b>收藏倉庫</b><p>中獎即入庫，可合併出貨、追蹤物流。</p></div>
        <div class="reveal"><span class="ic">${ic('shield')}</span><b>交易可追溯</b><p>每筆儲值、扣款、出貨皆可查詢與對帳。</p></div>
      </div>
    </section>

    <section class="sec" aria-labelledby="h-pt">
      <div class="sec-h"><h2 id="h-pt"><small>PARTNERS</small>合作塗裝師與維修師</h2></div>
      <div class="partners">${PARTNERS.map(x => `<a class="pt reveal" href="${x.url}" target="_blank" rel="noopener"><span class="av">${x.av ? `<img src="${x.av}" alt="@${x.h} 的 Instagram 頭像" loading="lazy">` : `<i aria-hidden="true">${x.h.replace(/[^a-z]/i,'').charAt(0).toUpperCase()}</i>`}<span class="role-ic">${ic(x.role.includes('塗裝')?'brush':'wrench','width:12px;height:12px')}</span></span><span class="tag">${x.role}</span><b>@${x.h}</b><span class="dim" style="font-size:12px;display:inline-flex;align-items:center;gap:4px">${ic('ig','width:14px;height:14px')}Instagram</span></a>`).join('')}</div>
    </section>
  </div>`;
};
routes.home.after = () => { heroFx(); carousel();
  let seen = false; try { seen = sessionStorage.getItem('ck_bind') === '1'; } catch(_){}
  if (!seen && !/nobind/.test(location.search)){ setTimeout(() => { if (parseHash().name === 'home' && !$('#modalRoot').innerHTML){ bindPopup(); try { sessionStorage.setItem('ck_bind','1'); } catch(_){} } }, RM() ? 400 : 4200); }
};

/* =========================================================
   LOBBY
   ========================================================= */
routes.lobby = (r) => {
  const q = r.q, src = q.get('src') || '', play = q.get('play') || '', ip = q.get('ip') || '', sort = q.get('sort') || 'hot', kw = (q.get('q') || '').trim(), price = q.get('price') || '';
  const kwl = kw.toLowerCase(), ipShown = n => { const x = (S.ips||[]).find(i => i.n === n); return !x || x.vis; };
  let list = POOLS.filter(p => ipShown(p.ip) && (!src || p.src === src) && (!play || p.play === play) && (!ip || p.ip === ip) && (!kwl || [p.title, p.ip, ...p.prizes.map(x => x.name), p.last || ''].join(' ').toLowerCase().includes(kwl)));
  if (price === 'l') list = list.filter(p => p.price < 250); else if (price === 'm') list = list.filter(p => p.price >= 250 && p.price <= 350); else if (price === 'h') list = list.filter(p => p.price > 350);
  const key = p => p.soon ? 9 : 0;
  if (sort === 'left') list.sort((a,b) => key(a)-key(b) || remaining(a)/a.total - remaining(b)/b.total);
  else if (sort === 'new') list.sort((a,b) => key(a)-key(b) || (b.isNew?1:0)-(a.isNew?1:0));
  else if (sort === 'pl') list.sort((a,b) => a.price - b.price);
  else if (sort === 'ph') list.sort((a,b) => b.price - a.price);
  else list.sort((a,b) => key(a)-key(b) || (b.hot?1:0)-(a.hot?1:0) || (b.total-remaining(b))/b.total - (a.total-remaining(a))/a.total);
  const link = (k, v) => { const n = new URLSearchParams(q); if (v) n.set(k, v); else n.delete(k); const s = n.toString(); return '#/lobby' + (s ? '?' + s : ''); };
  const chip = (k, v, t) => { const on = (q.get(k) || '') === v; return `<a class="chip ${on?'on':''}" href="${link(k, v)}" aria-current="${on}">${t}</a>`; };
  const ips = [...new Set(POOLS.map(p => p.ip))].filter(n => { const x = (S.ips||[]).find(i => i.n === n); return !x || x.vis; }).sort((a,b) => ipOrder(a) - ipOrder(b));
  return `<div class="wrap">
    <div class="page-h"><h1>抽賞大廳</h1><p>依商品來源、玩法、價格與作品篩選，找到你的下一抽。</p></div>
    <div class="lobby">
      <aside class="filters ${S.filterOpen ? 'open' : ''}" id="filters" aria-label="篩選">
        <div class="fgroup"><h4>商品來源</h4><div class="opts">${chip('src','','全部')}${chip('src','o','官方')}${chip('src','s','自製')}${chip('src','m','混合')}</div></div>
        <div class="fgroup"><h4>玩法</h4><div class="opts">${chip('play','','全部')}${chip('play','std','標準選籤')}${chip('play','guar','保底挑戰')}${chip('play','solo','單挑賞池')}</div></div>
        <div class="fgroup"><h4>單抽價格</h4><div class="opts">${chip('price','','不限')}${chip('price','l','250 以下')}${chip('price','m','250–350')}${chip('price','h','350 以上')}</div></div>
        <div class="fgroup"><h4>IP 作品</h4><div class="opts">${chip('ip','','全部')}${ips.map(x => chip('ip', x, x)).join('')}</div></div>
      </aside>
      <div>
        <div class="toolbar">
          <span class="count">共 <b class="num">${list.length}</b> 個賞池${kw?`・關鍵字「${kw}」`:''}</span>
          <button class="btn s ffilter-btn" data-act="toggle-filter" aria-controls="filters" aria-expanded="${!!S.filterOpen}">${ic('filter','width:16px;height:16px')}篩選</button>
          <label class="sr" for="sortSel">排序</label>
          <select class="input" id="sortSel" data-act="sort">
            ${[['hot','熱門優先'],['left','即將完售'],['new','最新上架'],['pl','價格低→高'],['ph','價格高→低']].map(([v,t]) => `<option value="${v}" ${sort===v?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        ${list.length ? `<div class="grid lgrid">${list.map(poolCard).join('')}</div>` : `<div class="empty">沒有符合條件的賞池，試試放寬篩選。</div>`}
      </div>
    </div></div>`;
};
</script>
