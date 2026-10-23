<script>
/* =========================================================
   只有兩個維度：
   IP  ＝ 這來自什麼作品（角色、動漫、遊戲、原創）
   標籤 ＝ 這是什麼東西（GK、PVC、一番賞、景品盲盒、卡牌、娃娃、其他）
   ========================================================= */
/* ---------- 免費體驗測試池：100% 中獎，只在免費體驗區出現 ---------- */
(() => { const P = {id:'demo', title:'100% 中獎 免費體驗測試池', ip:'CHIAKI ORIGINAL', src:'s', play:'std', price:0, hue:300, seed:909, demoOnly:true, img:DEMO_IMG('cover'),
    ship:{home:0, cvs:0}, packs:[1,5,10],
    levels:[
      {name:'大獎', items:[{n:'iPhone Duo', q:1, img:DEMO_IMG('duo')}]},
      {name:'2 獎', items:[{n:'iPhone 18 Pro 512GB', q:2, img:DEMO_IMG('pro')}]},
      {name:'3 獎', items:[{n:'Apple AirPods 5 標準版', q:5, img:DEMO_IMG('pods')},{n:'Beats 360 耳罩式耳機', q:20, img:DEMO_IMG('beats')}]},
      {name:'4 獎', small:false, items:[{n:'Apple Watch Series 12', q:5, img:DEMO_IMG('watch')}]},
      {name:'5 獎', items:[{n:'iPhone Duo 保護殼', q:30, img:DEMO_IMG('case')},{n:'腕帶', q:100, img:DEMO_IMG('strap')},{n:'Lightning 對 USB 連接線', q:30, img:DEMO_IMG('cable')}]}], last:null};
  buildPool(P); P.prizes.forEach(pr => { pr.custom = true; pr.tag = '其他'; }); POOLS.push(P); })();
/* 自製一番賞：超萌宮崎駿（機率賞：1/30 大獎、1/50 2 獎，其餘依剩餘數量隨機） */
(() => { const G = {id:'gb', title:'超萌宮崎駿 ～100% 中獎 通通帶回家～', ip:'宮崎駿・吉卜力', src:'s', play:'prob', price:40, hue:28, seed:404, drawn:0, hot:true, isNew:true, img:DEMO_IMG('gbcover'),
    ship:{home:150, cvs:60}, packs:[1,5,10],
    levels:[
      {name:'大獎', odds:1/30, items:[{n:'神隱卡西法', q:5, rv:2000, tag:'PVC', img:DEMO_IMG('gbcalc')}]},
      {name:'2 獎', odds:1/50, items:[{n:'宮崎駿地毯', q:5, rv:300, tag:'其他', img:DEMO_IMG('gbrug')}]},
      {name:'3 獎', items:[{n:'宮崎駿盲盒', q:30, rv:100, tag:'景品盲盒', img:DEMO_IMG('gbbox')}]},
      {name:'4 獎', items:[{n:'宮崎駿同人貼紙', q:1960, rv:10, tag:'其他', img:DEMO_IMG('gbsticker')}]}], last:null};
  buildPool(G); POOLS.splice(1, 0, G); })();
/* 自製一番賞：雲頂終結谷（機率賞：70% 直接中 4 獎，其餘依剩餘數量隨機；寄送方式逐件預設） */
(() => { const N = {id:'nr', title:'雲頂終結谷', ip:'火影忍者', src:'s', play:'prob', price:200, hue:22, seed:707, drawn:0, hot:true, isNew:true, img:DEMO_IMG('nrcover'),
    desc:'鳴人 vs 佐助 終結谷決戰雙雕像。70% 機率直接獲得 4 獎「火影墨影霓亂徽章」（回收值 250），大獎佐助回收值高達 40,000。',
    ship:{home:0, cvs:0}, packs:[1,5,10],
    levels:[
      {name:'大獎', items:[{n:'雲頂終結谷 佐助', q:1, rv:40000, tag:'GK', ship:'home', img:DEMO_IMG('nrsasuke')}]},
      {name:'2 獎', items:[{n:'雲頂終結谷 鳴人', q:1, rv:18000, tag:'GK', ship:'home', img:DEMO_IMG('nrnaruto')}]},
      {name:'4 獎', small:false, odds:0.7, items:[{n:'火影墨影霓亂徽章（一枚）', q:500, rv:250, tag:'其他', ship:'c711', img:DEMO_IMG('nrbadge')}]},
      {name:'5 獎', items:[{n:'火影同人貼紙', q:9498, rv:10, tag:'其他', ship:'c711', img:DEMO_IMG('nrsticker')},
                         {n:'隨機一番賞小獎', q:10000, rv:100, tag:'一番賞', ship:'c711', img:DEMO_IMG('nrmystery')}]}], last:null};
  buildPool(N); POOLS.splice(1, 0, N); })();
/* 機率賞：先依公布機率決定等級（該級有剩才算），其餘依剩餘數量隨機 */
function probPick(p, used){
  const free = p.tickets.filter(t => !t.taken && !(used && used.has(t.no))), r = Math.random(); let acc = 0;
  const lvOf = t => p.prizes[t.pi].lv;
  for (let li = 0; li < p.levels.length; li++){ const L = p.levels[li]; if (!L.odds) continue; const c = free.filter(t => lvOf(t) === li + 1); if (!c.length) continue;
    acc += L.odds; if (r < acc) return c[Math.floor(Math.random() * c.length)]; }
  const fixed = new Set(p.levels.map((L, i) => L.odds ? i + 1 : 0)), rest = free.filter(t => !fixed.has(lvOf(t)));
  const pool = rest.length ? rest : free; return pool[Math.floor(Math.random() * pool.length)];
}
const pctF = x => !x ? '0%' : x < 0.01 ? '≈' + x.toPrecision(2) + '%' : x.toFixed(2) + '%';
function probPct(p, i){
  const free = p.tickets.filter(t => !t.taken), n = free.filter(t => t.pi === i).length; if (!free.length) return '—';
  if (p.play !== 'prob') return pctF(n / free.length * 100);
  const lv = p.prizes[i].lv, lvLeft = l => free.filter(t => p.prizes[t.pi].lv === l).length;
  const active = p.levels.map((L, k) => L.odds && lvLeft(k + 1) ? L.odds : 0), fixedSum = active.reduce((a, b) => a + b, 0);
  if (active[lv - 1]) return pctF(active[lv - 1] * n / lvLeft(lv) * 100);
  if (p.levels[lv - 1].odds) return '0.00%';
  const restN = free.filter(t => !active[p.prizes[t.pi].lv - 1] && !p.levels[p.prizes[t.pi].lv - 1].odds).length;
  return restN ? pctF((1 - fixedSum) * n / restN * 100) : '—';
}
/* IP: name + search aliases only; default order = name length, then zh-TW */
const IP_SEED = [
  ['航海王','海賊王 ONE PIECE 魯夫'],['七龍珠','DRAGON BALL 悟空'],['火影忍者','NARUTO 鳴人 疾風傳'],['死神','BLEACH 一護 千年血戰'],
  ['獵人','HUNTER×HUNTER 全職獵人'],['銀魂','GINTAMA'],['灌籃高手','SLAM DUNK'],['幽遊白書','YU YU HAKUSHO'],['名偵探柯南','CONAN 柯南'],
  ['遊戲王','YU-GI-OH'],['聖鬥士星矢','SAINT SEIYA'],['JOJO的奇妙冒險','JOJO JoJo 承太郎'],['烙印勇士','BERSERK 劍風傳奇 凱茲'],['神樂鉢','KAGURABACHI カグラバチ 六平千鑛'],
  ['鬼滅之刃','KIMETSU 炭治郎 無限城'],['咒術迴戰','JUJUTSU KAISEN 五條悟'],['鏈鋸人','CHAINSAW MAN 電次'],['膽大黨','DANDADAN'],
  ['怪獸8號','KAIJU NO.8'],['藍色監獄','BLUE LOCK'],['排球少年!!','HAIKYU 排球'],['我的英雄學院','MY HERO ACADEMIA 我英'],
  ['進擊的巨人','ATTACK ON TITAN'],['間諜家家酒','SPY×FAMILY 安妮亞'],['東京復仇者','TOKYO REVENGERS 東卍'],['葬送的芙莉蓮','FRIEREN 芙莉蓮'],
  ['我推的孩子','OSHI NO KO 星野愛'],['機動戰士鋼彈','GUNDAM 鋼彈 高達'],['新世紀福音戰士','EVANGELION EVA'],['假面騎士','KAMEN RIDER'],
  ['超人力霸王','ULTRAMAN 奧特曼'],['寶可夢','POKEMON 精靈寶可夢 皮卡丘'],['初音未來','HATSUNE MIKU VOCALOID'],['宮崎駿・吉卜力','GHIBLI 吉卜力 龍貓 神隱少女 卡西法 霍爾'],['CHIAKI ORIGINAL','CHIAKI 原創 自製']
];
const nameLen = s => Array.from(s.replace(/\s/g, '')).length;
const zhSort = new Intl.Collator('zh-Hant-TW');
const byLen = (a, b) => nameLen(a.n) - nameLen(b.n) || zhSort.compare(a.n, b.n);

/* 標籤 — auto-detected from the prize name, admins can override per prize */
const TAGS = [
  {k:'GK',     kw:/GK|雕像|胸像|樹脂/i, bulky:true},
  {k:'PVC',    kw:/公仔|比例模型|PVC|1\/\d/i},
  {k:'一番賞',  kw:/^$/},
  {k:'景品盲盒', kw:/景品|盲盒|盒玩|扭蛋|轉蛋/},
  {k:'卡牌',    kw:/卡牌|卡組|卡包|鑑定卡|PSA/i},
  {k:'娃娃',    kw:/娃娃|絨毛|玩偶|抱枕/},
  {k:'其他',    kw:/./}
];
const tagFor = name => TAGS.find(c => c.kw.test(name)).k;
const tagOfItem = pr => pr.tag || (pr.tag = tagFor(pr.name));
const poolTags = p => { const t = new Set(p.prizes.map(tagOfItem)); if (p.src === 'o') t.add('一番賞'); return TAGS.map(x => x.k).filter(k => t.has(k)); };
const isBulky = w => { const p = poolById(w.pool), pr = p && p.prizes.find(x => x.name === w.pname); const t = pr ? tagOfItem(pr) : tagFor(w.pname || w.name || ''); return t === 'GK' || w.lv === 1 || w.g === 'G' || w.rk === 'LAST'; };
POOLS.forEach(p => p.prizes.forEach(tagOfItem));
PRODUCTS.forEach(x => { x.tag = x.tag || tagFor(x.name); });

(() => { const old = S.ips || [];
  const list = IP_SEED.map(([n, al]) => ({n, al, vis:true}));
  POOLS.forEach(p => { if (!list.find(x => x.n === p.ip)) list.push({n:p.ip, al:'', vis:true}); });
  old.forEach(o => { const x = list.find(i => i.n === o.n); if (x) x.vis = o.vis; });
  S.ips = list; S.ipSort = 'len'; S.fOpen = {tag:true, ip:false};
})();
const ipInfo = n => S.ips.find(i => i.n === n);
const ipShownN = n => { const x = ipInfo(n); return !x || x.vis; };
function sortedIps(list){ return S.ipSort === 'manual' ? list.slice().sort((a,b) => S.ips.indexOf(a) - S.ips.indexOf(b)) : list.slice().sort(byLen); }
const poolsOfIp = n => POOLS.filter(p => p.ip === n && !p.off && !p.demoOnly);
function poolMatches(p, kwl){
  if (!kwl) return true;
  const ip = ipInfo(p.ip) || {}, hay = [p.title, p.ip, ip.al || '', ...poolTags(p), ...p.prizes.map(x => x.name), p.last || ''].join(' ').toLowerCase();
  return kwl.split(/\s+/).every(w => hay.includes(w));
}
const ipHits = kwl => kwl ? S.ips.filter(i => i.vis && (i.n + ' ' + (i.al || '')).toLowerCase().includes(kwl)).sort(byLen) : [];

/* ---------- LOBBY：只有「標籤」與「IP」，可展開／收合 ---------- */
routes.lobby = (r) => {
  const q = r.q, ip = q.get('ip') || '', tg = q.get('tag') || '', sort = q.get('sort') || 'hot', sf = q.get('src') || '', pf = q.get('play') || '', kw = (q.get('q') || '').trim(), kwl = kw.toLowerCase();
  const base = POOLS.filter(p => !p.off && !p.demoOnly && ipShownN(p.ip) && poolMatches(p, kwl));
  let list = base.filter(p => (!ip || p.ip === ip) && (!tg || poolTags(p).includes(tg)) && (!sf || p.src === sf) && (!pf || p.play === pf));
  const key = p => p.soon ? 9 : 0;
  if (sort === 'left') list.sort((a,b) => key(a)-key(b) || remaining(a)/a.total - remaining(b)/b.total);
  else if (sort === 'new') list.sort((a,b) => key(a)-key(b) || (b.isNew?1:0)-(a.isNew?1:0));
  else if (sort === 'pl') list.sort((a,b) => a.price - b.price);
  else if (sort === 'ph') list.sort((a,b) => b.price - a.price);
  else list.sort((a,b) => key(a)-key(b) || (b.hot?1:0)-(a.hot?1:0) || (b.total-remaining(b))/b.total - (a.total-remaining(a))/a.total);
  const link = (k, v) => { const n = new URLSearchParams(q); if (v) n.set(k, v); else n.delete(k); const s = n.toString(); return '#/lobby' + (s ? '?' + s : ''); };
  const chip = (k, v, t, n) => { const on = (q.get(k) || '') === v; return `<a class="chip ${on?'on':''} ${n === 0 ? 'zero' : ''}" href="${link(k, v)}" aria-current="${on}">${t}${n != null ? `<span class="cn">${n}</span>` : ''}</a>`; };
  const tagN = t => base.filter(p => poolTags(p).includes(t)).length, ipN = n => base.filter(p => p.ip === n).length;
  const ips = sortedIps(S.ips.filter(i => i.vis)), withPool = ips.filter(i => ipN(i.n)), shown = S.ipAll ? ips : withPool;
  const fg = (k, title, cur, body) => `<details class="fdet" data-f="${k}" ${S.fOpen[k] ? 'open' : ''}><summary><span>${title}</span><span class="fcur">${cur || '全部'}</span>${ic('down','width:16px;height:16px')}</summary><div class="opts">${body}</div></details>`;
  const hits = ipHits(kwl).slice(0, 6);
  return `<div class="wrap">
    <div class="page-h"><h1>抽賞大廳</h1><p>用「標籤」看是什麼東西、用「IP」看來自哪部作品，或直接搜尋。</p></div>
    <div class="lobby">
      <aside class="filters ${S.filterOpen ? 'open' : ''}" id="filters" aria-label="篩選">
        ${fg('tag', '標籤', tg, chip('tag','','全部') + TAGS.map(t => chip('tag', t.k, t.k, tagN(t.k))).join(''))}
        ${fg('ip', 'IP 作品', ip, chip('ip','','全部') + shown.map(x => chip('ip', x.n, x.n, ipN(x.n))).join('') +
          `<button class="chip ghost-chip" data-act="x-ipall">${S.ipAll ? '只看有賞池的作品' : `顯示全部作品（${ips.length}）`}</button>`)}
      </aside>
      <div>
        <form class="lsearch" data-act="search" role="search"><label class="sr" for="lq">搜尋賞池</label>${ic('search','width:18px;height:18px')}<input class="input" id="lq" name="q" type="search" value="${kw.replace(/"/g,'&quot;')}" placeholder="作品、角色、英文名或標籤，例如：海賊王、GK" autocomplete="off"><button class="btn s gold" type="submit">搜尋</button></form>
        ${hits.length ? `<div class="iphits"><span class="dim">相關作品</span>${hits.map(x => `<a class="chip" href="#/lobby?ip=${encodeURIComponent(x.n)}">${x.n}<span class="cn">${poolsOfIp(x.n).length}</span></a>`).join('')}</div>` : ''}
        <div class="toolbar">
          <span class="count">共 <b class="num">${list.length}</b> 個賞池${kw?`・「${kw}」`:''}${tg?`・${tg}`:''}${ip?`・${ip}`:''}${sf?`・${SRC[sf].t} <a href="${link('src','')}">清除</a>`:''}${pf?`・${PLAY[pf]} <a href="${link('play','')}">清除</a>`:''}</span>
          <button class="btn s ffilter-btn" data-act="toggle-filter" aria-controls="filters" aria-expanded="${!!S.filterOpen}">${ic('filter','width:16px;height:16px')}篩選${tg || ip ? `<span class="cn">${[tg, ip].filter(Boolean).length}</span>` : ''}</button>
          <label class="sr" for="sortSel">排序</label>
          <select class="input" id="sortSel" data-act="sort">
            ${[['hot','熱門優先'],['left','即將完售'],['new','最新上架'],['pl','價格低→高'],['ph','價格高→低']].map(([v,t]) => `<option value="${v}" ${sort===v?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        ${list.length ? `<div class="grid lgrid">${list.map(poolCard).join('')}</div>`
          : ip ? `<div class="empty">「${ip}」目前沒有進行中的賞池。<br><br><button class="btn gold" data-act="follow" data-ip="${ip}" aria-pressed="${S.follow.includes(ip)}">${ic('heart','width:18px;height:18px')}${S.follow.includes(ip) ? '已追蹤，上新會通知你' : '追蹤這個 IP，上新通知我'}</button></div>`
          : `<div class="empty">沒有符合條件的賞池，試試放寬篩選。</div>`}
      </div>
    </div></div>`;
};
document.addEventListener('toggle', e => { const d = e.target; if (d.matches && d.matches('details.fdet')) S.fOpen[d.dataset.f] = d.open; }, true);
document.addEventListener('click', e => { if (e.target.closest('[data-act="x-ipall"]')){ e.preventDefault(); S.ipAll = !S.ipAll; S.fOpen.ip = true; render(true); } });

/* pool cards show their 標籤 */
const _poolCard = poolCard;
poolCard = p => _poolCard(p).replace('<div class="body">', `<div class="body"><div class="pcats">${poolTags(p).slice(0,3).map(c => `<span>${c}</span>`).join('')}</div>`);
const _poolRoute = routes.pool, _poolAfter = routes.pool.after;
routes.pool = r => { const p = poolById(r.arg) || POOLS[0]; let h = _poolRoute(r);
  p.prizes.forEach(pr => { h = h.replace(`<div class="pname">${pr.name}<small>`, `<div class="pname">${pr.name}<small><span class="pc-tag">${tagOfItem(pr)}</span>`); });
  return h; };
routes.pool.after = _poolAfter;

/* ---------- 快速抽（測試頁）：只選 1／5／10 抽，系統隨機配籤 ---------- */
function levelsSummary(p, open){
  const lvs = [...new Set(p.prizes.map(x => x.lv))];
  return `<details class="fdet lvsum" ${open ? 'open' : ''}><summary><span>獎項（${lvs.length} 個等級${p.last ? '＋最後賞' : ''}）</span><span class="fcur">剩 ${remaining(p)} / ${p.total}</span>${ic('down','width:16px;height:16px')}</summary>
    <div class="lvlist">${lvs.map(lv => { const its = p.prizes.map((pr,i) => ({pr,i})).filter(x => x.pr.lv === lv);
      return `<div class="lvrow"><span class="lv-no">${lv}</span>${tagOf(its[0].pr, true)}<div class="lvitems">${its.map(({pr,i}) => `<span>${pr.img ? `<img class="lvimg" src="${pr.img}" alt="">` : ''}${pr.name}<b class="num">${remainOf(p,i)}/${pr.qty}</b></span>`).join('')}</div></div>`; }).join('')}
      ${p.last ? `<div class="lvrow"><span class="lv-no">L</span>${rankTag('LAST', true)}<div class="lvitems"><span>${p.last}<b class="num">${remaining(p) ? 1 : 0}/1</b></span></div></div>` : ''}</div></details>`;
}
/* 全站統一：不再選號，直接選 1／5／10 抽（後台可設定），系統隨機配籤 */
routes.quick = r => { setTimeout(() => { location.replace('#/pool/' + (r.arg || '')); }, 0); return ''; };
function packsSection(p){
  const left = remaining(p), packs = (p.packs || [1,5,10]);
  return `<section class="packs-wrap" id="packs" aria-labelledby="h-pk" tabindex="-1">
      <div class="sec-h"><h2 id="h-pk"><small>DRAW</small>選擇抽數${p.sets.length > 1 ? `<span class="muted" style="font-size:14px;font-weight:400;margin-left:8px">${p.sets[p.setIdx].name || `第 ${p.setIdx + 1} 套`}・剩 ${left} 抽</span>` : `<span class="muted" style="font-size:14px;font-weight:400;margin-left:8px">剩 ${left} 抽</span>`}</h2></div>
      <div class="packs" role="group" aria-label="選擇抽數">${packs.map(n => { const k = n === 'all' ? left : n, ok = k <= left && k > 0;
        return `<button class="pack ${n === 'all' ? 'all' : ''}" data-act="x-qd" data-n="${n}" ${ok ? '' : 'disabled'}><b>${n === 'all' ? '全包' : n + ' 抽'}</b><span><span class="coin" style="width:16px;height:16px;font-size:9px">C</span>${fmt(k * p.price)}</span>${n === 'all' && p.last ? '<small>含最後賞</small>' : ok ? '' : '<small>剩餘不足</small>'}</button>`; }).join('')}</div>
      <p class="dim" style="font-size:12px;margin:16px 0 0">選擇抽數後由系統隨機配籤，付款後撕開籤紙揭曉。${p.play === 'prob' ? '本賞池為機率賞，每抽依公布機率決定等級。' : '開賣前公布承諾雜湊，完售後公開完整籤表供驗證。'}</p>
    </section>`;
}
function quickDraw(n){
  const p = curPool(); if (!p) return;
  const free = p.tickets.filter(t => !t.taken && !t.held).map(t => t.no), k = n === 'all' ? free.length : Math.min(+n, free.length);
  if (!k) return toast('本套已完售');
  clearHold(); S.sel = shuffle(free.slice(), Math.random).slice(0, k); startHold(p); buyDialog();
}

/* ---------- 免費體驗：抽了不扣CC幣、不發獎品 ---------- */
routes.play = r => {
  const live = POOLS.filter(p => !p.soon && !p.off && !p.sets[p.setIdx].off && remaining(p)).sort((a, b) => (b.demoOnly ? 1 : 0) - (a.demoOnly ? 1 : 0)), p = poolById(S.playPool) && live.includes(poolById(S.playPool)) ? poolById(S.playPool) : live[0];
  S.playPool = p.id;
  return `<div class="wrap">
    <div class="page-h"><h1>免費體驗區</h1><p>先感受撕籤紙的手感與中獎演出。<b style="color:var(--gold-2)">不扣CC幣、獎品不會發放</b>，結果也不影響正式賞池。</p></div>
    <div class="play-pick" role="group" aria-label="選擇體驗賞池">${live.map(x => `<button class="chip ${x.id === p.id ? 'on' : ''}" data-act="x-playpool" data-k="${x.id}" aria-pressed="${x.id === p.id}">${x.demoOnly ? '★ ' : ''}${x.title.split(' ～')[0]}</button>`).join('')}</div>
    <div class="qd">
      <div class="qd-art">${art(p.hue, 'A', 'main', p.title + ' 主視覺', p.img)}</div>
      <div class="qd-main">
        <span class="tag ok">免費體驗</span>${p.demoOnly ? '<span class="tag hot" style="margin-left:8px">100% 中獎</span>' : ''}
        <h1>${p.title}</h1>
        <div class="packs" role="group" aria-label="體驗抽數">${[1,5,10].map(n => `<button class="pack" data-act="x-play" data-n="${n}"><b>${n} 抽</b><span>免費</span></button>`).join('')}</div>
        <p class="dim" style="font-size:12px;margin:16px 0 0">體驗結果依此賞池目前剩餘的獎項比例模擬，僅供娛樂。想要真的拿獎品，請到正式賞池抽賞。</p>
        ${p.demoOnly ? '' : `<a class="btn gold" style="margin-top:16px" href="#/pool/${p.id}">${ic('ticket')}真的去抽</a>`}
      </div>
    </div>
    ${levelsSummary(p, false)}
  </div>`;
};
function playDraw(n){
  const p = poolById(S.playPool); if (!p) return;
  const used = new Set(), free = p.play === 'prob' ? Array.from({length:Math.min(n, remaining(p))}, () => { const t = probPick(p, used); used.add(t.no); return t; }) : shuffle(p.tickets.filter(t => !t.taken).slice(), Math.random).slice(0, n);
  const results = free.map(t => { const pr = p.prizes[t.pi]; return {no:t.no, rk:pr.rk, g:pr.g, lv:pr.lv, lvName:pr.lvName, small:pr.small, custom:pr.custom, tier:pr.tier, rv:pr.rv, name:pr.name, pname:pr.name, img:pr.img, hue:p.hue}; });
  runDraw(p, results); D.demo = true;
  const tl = $('#stage .top .tl'); if (tl) tl.insertAdjacentHTML('beforeend', '<span class="tag ok demo-tag">免費體驗</span>');
}
document.addEventListener('click', e => { const el = e.target.closest('[data-act="x-qd"],[data-act="x-play"],[data-act="x-playpool"]'); if (!el) return; e.preventDefault();
  if (el.dataset.act === 'x-qd') quickDraw(el.dataset.n === 'all' ? 'all' : +el.dataset.n);
  else if (el.dataset.act === 'x-play') playDraw(+el.dataset.n);
  else { S.playPool = el.dataset.k; render(true); } });

/* ---------- ADMIN：IP 管理（只有名稱與搜尋別名） ---------- */
ADM_VIEWS.ip = () => {
  const kq = (S.ipQ || '').toLowerCase(), rows = sortedIps(S.ips.filter(x => !kq || (x.n + ' ' + (x.al||'')).toLowerCase().includes(kq))), manual = S.ipSort === 'manual';
  return `<div class="adm-bar">
      <div class="seg" role="group" aria-label="排序方式"><button data-act="x-ipsort" data-k="len" aria-pressed="${!manual}">依名稱字數</button><button data-act="x-ipsort" data-k="manual" aria-pressed="${manual}">自訂順序</button></div>
      <label class="sr" for="ipQ">搜尋 IP</label><input class="input" id="ipQ" data-act="x-ipq" value="${(S.ipQ||'').replace(/"/g,'&quot;')}" placeholder="搜尋名稱或別名" autocomplete="off">
      <button class="btn s gold" data-act="x-ipadd">${ic('plus','width:16px;height:16px')}新增 IP</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="r">#</th><th>IP（作品名稱）</th><th class="r">字數</th><th>搜尋別名</th><th class="r">賞池</th><th>前台</th>${manual ? '<th>順序</th>' : ''}</tr></thead><tbody>
    ${rows.map((x, i) => { const k = S.ips.indexOf(x); return `<tr class="${x.vis ? '' : 'muted-row'}"><td class="r num dim">${i+1}</td>
      <td><label class="sr" for="ipn${k}">IP 名稱</label><input class="input" id="ipn${k}" data-act="x-ipn" data-k="${k}" value="${x.n.replace(/"/g,'&quot;')}" style="min-width:168px"></td>
      <td class="r num">${nameLen(x.n)}</td>
      <td><label class="sr" for="ipa${k}">別名</label><input class="input" id="ipa${k}" data-act="x-ipal" data-k="${k}" value="${(x.al||'').replace(/"/g,'&quot;')}" placeholder="英文名、舊譯名、角色" style="min-width:240px"></td>
      <td class="r">${poolsOfIp(x.n).length || '<span class="dim">0</span>'}</td>
      <td><button class="btn s ${x.vis?'':'ghost'}" data-act="x-ipvis" data-k="${k}" aria-pressed="${x.vis}">${x.vis?'顯示':'隱藏'}</button></td>
      ${manual ? `<td><span class="row" style="gap:8px"><button class="ibtn" data-act="x-ipmv" data-k="${k}" data-d="-1" aria-label="上移">${ic('down','transform:rotate(180deg)')}</button><button class="ibtn" data-act="x-ipmv" data-k="${k}" data-d="1" aria-label="下移">${ic('down')}</button></span></td>` : ''}</tr>`; }).join('') || '<tr><td colspan="7" class="dim">沒有符合的 IP</td></tr>'}
    </tbody></table></div>
    <p class="dim" style="font-size:12px;margin-top:12px">IP 就是「來自哪部作品」（動漫、遊戲、角色、原創）。預設依名稱字數排列；別名只用於搜尋，例如「海賊王、ONE PIECE」都會找到「航海王」。</p>`;
};

/* ---------- ADMIN：獎品管理（1～9 等級，每級可放多個獎品） ---------- */
ADM_VIEWS.prize = () => {
  const p = poolById(S.admPool) || POOLS[0], edit = soldAll(p) === 0, out = i => p.sets.reduce((s, x) => s + x.tickets.filter(t => t.taken && t.pi === i).length, 0);
  let pi = 0;
  return `<div class="adm-bar"><label class="sr" for="admP">選擇賞池</label><select class="input" id="admP" data-act="x-admpool" style="max-width:360px">${POOLS.map(x => `<option value="${x.id}" ${x.id===p.id?'selected':''}>${x.title.split(' ～')[0]}</option>`).join('')}</select>
      <span class="dim" style="font-size:12px">${edit ? '尚未開賣：可調整等級、獎品與數量' : '已開賣：等級結構與數量已鎖定，名稱、標籤、回收值仍可修改（寫入操作日誌）'}</span></div>
    <div class="lvedit">${p.levels.map((L, li) => { const its = L.items.map(it => ({it, i: pi++})); const small = L.small != null ? !!L.small : li >= 3;
      return `<section class="lvbox"><div class="lvhd"><span class="lv-no">${li + 1}</span>
        <label class="sr" for="lvn${li}">等級名稱</label><input class="input" id="lvn${li}" data-act="x-lvname" data-l="${li}" value="${(L.name||'').replace(/"/g,'&quot;')}" placeholder="例如 A賞、大獎" style="max-width:200px">
        <label class="chk-chip"><input type="checkbox" data-act="x-lvsmall" data-l="${li}" ${small ? 'checked' : ''}><span>小獎（可回收）</span></label>
        ${p.play === 'prob' ? `<label class="odds" for="lvo${li}"><span>固定機率</span><input class="input num" type="number" min="0" max="100" step="0.01" id="lvo${li}" data-act="x-lvodds" data-l="${li}" value="${L.odds ? +(L.odds * 100).toFixed(4) : ''}" placeholder="隨機"><span>%</span></label>` : ''}
        <span class="dim" style="margin-left:auto;font-size:12px">${its.length} 種・${its.reduce((s,x) => s + x.it.q, 0)} 件</span>
        ${edit && p.levels.length > 1 ? `<button class="btn s ghost" data-act="x-lvdel" data-l="${li}">刪除等級</button>` : ''}</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>圖片（1200×1200）</th><th>獎品名稱</th><th>標籤</th><th class="r">數量</th><th class="r">回收值</th><th class="r">已抽出</th>${edit ? '<th></th>' : ''}</tr></thead><tbody>
        ${its.map(({it, i}, ii) => `<tr><td>${uploader('prize', `pz${li}_${ii}`)}</td>
          <td><label class="sr" for="itn${li}_${ii}">獎品名稱</label><input class="input" id="itn${li}_${ii}" data-act="x-itn" data-l="${li}" data-i="${ii}" value="${it.n.replace(/"/g,'&quot;')}" style="min-width:220px"></td>
          <td><label class="sr" for="itt${li}_${ii}">標籤</label><select class="input" id="itt${li}_${ii}" data-act="x-ittag" data-l="${li}" data-i="${ii}">${TAGS.map(t => `<option ${t.k === (it.tag || tagFor(it.n)) ? 'selected' : ''}>${t.k}</option>`).join('')}</select></td>
          <td class="r"><label class="sr" for="itq${li}_${ii}">數量</label><input class="input num" type="number" min="1" id="itq${li}_${ii}" data-act="x-itq" data-l="${li}" data-i="${ii}" value="${it.q}" ${edit ? '' : 'disabled'} style="width:88px"></td>
          <td class="r"><label class="sr" for="itr${li}_${ii}">回收值</label><input class="input num" type="number" min="0" id="itr${li}_${ii}" data-act="x-itrv" data-l="${li}" data-i="${ii}" value="${it.rv || 0}" style="width:104px"></td>
          <td class="r num">${out(i)}</td>
          ${edit ? `<td>${L.items.length > 1 ? `<button class="btn s ghost" data-act="x-itdel" data-l="${li}" data-i="${ii}">移除</button>` : ''}</td>` : ''}</tr>`).join('')}
        </tbody></table></div>
        ${edit ? `<button class="btn s" style="margin-top:12px" data-act="x-itadd" data-l="${li}">${ic('plus','width:16px;height:16px')}在第 ${li + 1} 等新增獎品</button>` : ''}</section>`; }).join('')}</div>
    ${edit ? `<button class="btn gold" style="margin-top:24px" data-act="x-lvadd" ${p.levels.length >= 9 ? 'disabled' : ''}>${ic('plus','width:16px;height:16px')}新增等級（${p.levels.length} / 8）</button>` : ''}
    <p class="dim" style="font-size:12px;margin-top:12px">每個賞池分 1～9 個等級（1 最高），同一等級可以放 1 個或多個不同獎品，機率依各獎品剩餘數量計算。1 等與 GK 預設為大件（限宅配）。</p>`;
};
function lvChanged(p, structural){
  if (structural) buildPool(p); else { const sets = p.sets; flattenLevels(p); p.prizes.forEach(pr => { pr.custom = p.src === 's'; tagOfItem(pr); }); p.sets = sets; }
  p.prizes.forEach(tagOfItem);
  S.audit.unshift({t:'剛剛', who:'輝', a:`${structural ? '調整獎項結構' : '更新獎品資料'}：${p.title.split(' ～')[0]}`});
}
document.addEventListener('change', e => { const el = e.target, a = el.dataset.act; if (!a || !/^x-(lv|it)/.test(a)) return;
  const p = poolById(S.admPool) || POOLS[0], L = p.levels[+el.dataset.l], it = L && L.items[+el.dataset.i];
  if (a === 'x-lvodds'){ const v = +el.value; L.odds = v > 0 ? Math.min(100, v) / 100 : 0; const sum = p.levels.reduce((s, x) => s + (x.odds || 0), 0); if (sum >= 1){ L.odds = 0; el.value = ''; return toast('固定機率合計需小於 100%'); } lvChanged(p); toast(L.odds ? `已設定 ${L.name} 機率 ${(L.odds*100).toFixed(2)}%` : '已改為隨機'); }
  if (a === 'x-lvname'){ L.name = el.value.trim() || `${+el.dataset.l + 1} 等`; lvChanged(p); toast('已更新等級名稱'); }
  if (a === 'x-lvsmall'){ L.small = el.checked; lvChanged(p); toast(el.checked ? '已設為小獎' : '已取消小獎'); render(true); }
  if (a === 'x-itn'){ if (!el.value.trim()){ el.value = it.n; return toast('獎品名稱不可空白'); } it.n = el.value.trim(); lvChanged(p); toast('已更新獎品名稱'); }
  if (a === 'x-ittag'){ it.tag = el.value; lvChanged(p); toast('已更新標籤'); }
  if (a === 'x-itrv'){ it.rv = Math.max(0, Math.floor(+el.value || 0)); el.value = it.rv; lvChanged(p); toast('已更新回收值'); }
  if (a === 'x-itq'){ const v = Math.floor(+el.value); if (!(v >= 1)){ el.value = it.q; return toast('數量需為正整數'); } it.q = v; lvChanged(p, true); render(true); toast('已更新數量，籤表已重新產生'); }
  if (a === 'x-ipal'){ S.ips[+el.dataset.k].al = el.value.trim(); toast('已更新搜尋別名'); }
});
document.addEventListener('click', e => { const el = e.target.closest('[data-act="x-lvadd"],[data-act="x-lvdel"],[data-act="x-itadd"],[data-act="x-itdel"]'); if (!el) return;
  const p = poolById(S.admPool) || POOLS[0], l = +el.dataset.l, a = el.dataset.act;
  if (a === 'x-lvadd' && p.levels.length < 9) p.levels.push({name:`${p.src === 'o' ? LV_RK[p.levels.length] + '賞' : (p.levels.length + 1) + ' 等'}`, items:[{n:'新獎品', q:1}]});
  if (a === 'x-lvdel') p.levels.splice(l, 1);
  if (a === 'x-itadd') p.levels[l].items.push({n:'新獎品', q:1});
  if (a === 'x-itdel') p.levels[l].items.splice(+el.dataset.i, 1);
  lvChanged(p, true); render(true); toast('已更新獎項結構'); });
document.addEventListener('input', e => { if (e.target.matches('[data-act="x-ipq"]')){ S.ipQ = e.target.value; clearTimeout(window.__ipq); window.__ipq = setTimeout(() => { const pos = e.target.selectionStart; render(true); const n = $('#ipQ'); if (n){ n.focus(); n.setSelectionRange(pos, pos); } }, 200); } });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="x-ipsort"]'); if (!el) return; S.ipSort = el.dataset.k; render(true); });
</script>
