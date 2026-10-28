<script>
/* =========================================================
   限定賞池：漩漩生日一番賞（輸入通關密碼才看得到）
   每輪 5 抽・5 抽保底至少一個 4 獎以上（最大獎權重較低）・抽到「再來兩抽／再來三抽」本輪 +2／+3 抽
   每輪結束後需等 10 秒・每輪抽完恢復原配率・獎項皆不可回收・抽獎紀錄保留
   ========================================================= */
PLAY.bday = '生日限定';
const _probPctB = probPct; probPct = (p, i) => p.play === 'bday' ? '<span style="white-space:nowrap">依規則</span>' : _probPctB(p, i);
(() => { const I = k => DEMO_IMG(k);
  const B = {id:'bday', title:'漩漩生日一番賞', ip:'CHIAKI 限定', src:'s', play:'bday', price:0, hue:330, seed:1126, drawn:0, locked:true, isNew:true, img:I('bdcover'),
    desc:'每輪 5 抽，有機會中多個獎品，每輪保底至少一個 4 獎以上；抽到「再來兩抽」本輪再多抽 2 次、「再來三抽」再多抽 3 次。每輪結束後需等待 10 秒才能再玩，每次抽完都會恢復原配率。獎項皆不提供回收，抽中紀錄會保留。',
    ship:{home:0, cvs:0}, packs:[3],
    levels:[
      {name:'最大獎', items:[{n:'黃金（8000 元抵用券）', q:1, img:I('bdgold'), tag:'其他'}]},
      {name:'一獎', items:[
        {n:'玫瑰金飾品（不限品牌8000 元抵用券）', q:1, img:I('bdbracelet'), tag:'其他'},
        {n:'日本機票 50%（7000 元抵用券）', q:1, img:I('bdflight'), tag:'其他'},
        {n:'當天約會經費 5000 元', q:1, img:I('bddate'), tag:'其他'}]},
      {name:'二獎', items:[
        {n:'玫瑰金飾品（不限品牌4000 元抵用券）', q:1, img:I('bdbracelet'), tag:'其他'},
        {n:'14K／18K 玫瑰香檳金飾品（不限品牌4000 元抵用券）', q:1, img:I('bdring'), tag:'其他'},
        {n:'續約三星手機（4000 元抵用券）', q:1, img:I('bdphone'), tag:'其他'},
        {n:'PT950飾品（不限品牌4000 元抵用券）', q:1, img:I('bdpt'), tag:'其他'},
        {n:'日本機票 25%（3500 元抵用券）', q:1, img:I('bdflight'), tag:'其他'},
        {n:'不限品牌衣物任選（3000 元抵用券）', q:1, img:I('bdcloth'), tag:'其他'},
        {n:'百貨公司全館（3000 元抵用券）', q:2, img:I('bdcloth'), tag:'其他'}]},
      {name:'三獎', small:false, items:[
        {n:'14K／18K 玫瑰香檳金飾品（不限品牌2500 元抵用券）', q:1, img:I('bdring'), tag:'其他'},
        {n:'玫瑰金飾品（不限品牌2000 元抵用券）', q:1, img:I('bdbracelet'), tag:'其他'},
        {n:'PT950飾品（不限品牌2000 元抵用券）', q:2, img:I('bdpt'), tag:'其他'},
        {n:'不限品牌衣物任選（1500 元抵用券）', q:2, img:I('bdcloth'), tag:'其他'},
        {n:'半年份衛生棉', q:1, img:I('bdpad'), tag:'其他'},
        {n:'當天約會經費 2500 元', q:1, img:I('bddate'), tag:'其他'},
        {n:'重抽券', q:100, img:I('bdreroll'), tag:'其他', reroll:true, noGuar:true}]},
      {name:'四獎', small:false, items:[
        {n:'保濕保養品（不限品牌1000 元抵用券）', q:3, img:I('bdkose'), tag:'其他'},
        {n:'DONKI DONKI 購物（1000 元抵用券）', q:3, img:I('bddonki'), tag:'其他'},
        {n:'頭髮用品（不限品牌1000 元抵用券）', q:5, img:I('bdrefa'), tag:'其他'},
        {n:'全聯（1000 元抵用券）', q:6, img:I('bddonki'), tag:'其他'},
        {n:'響食天堂（一餐）', q:2, img:I('bdbuffet'), tag:'其他'},
        {n:'一個月衛生棉', q:3, img:I('bdpad'), tag:'其他'}]},
      {name:'參加獎', small:true, items:[
        {n:'馬卡龍（1 顆）', q:13, img:I('bdmacaron'), tag:'其他', noGuar:true},
        {n:'糖葫蘆（1 枝）', q:13, img:I('bdtanghulu'), tag:'其他', noGuar:true},
        {n:'再來兩抽', q:150, img:I('bdagain'), tag:'其他', again:2},
        {n:'再來三抽', q:82, img:I('bdagain'), tag:'其他', again:3},
        {n:'生日快樂（銘謝惠顧）', q:600, img:I('bdhbd'), tag:'其他', miss:true}]}], last:null};
  buildPool(B);
  B.levels.forEach((L, li) => L.items.forEach(it => { const pr = B.prizes.find(x => x.lv === li + 1 && x.name === it.n); if (pr){ pr.again = it.again === true ? 2 : (it.again || 0); pr.miss = !!it.miss; pr.reroll = !!it.reroll; pr.noGuar = !!it.noGuar; } }));
  POOLS.push(B); })();

/* ---------- 解鎖（密碼只存雜湊；靜態網站僅能隱藏，不是真正的權限控管） ---------- */
const BD_HASH = '77de9c41af602e47';
const fnv = s => { let h1 = 0x811c9dc5, h2 = 0x01000193; for (const c of s){ h1 ^= c.charCodeAt(0); h1 = Math.imul(h1, 16777619) >>> 0; h2 = Math.imul(h2 ^ c.charCodeAt(0), 2246822519) >>> 0; } return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'); };
/* 解鎖只在停留於該賞池頁時有效：離開頁面或重新整理就會重新上鎖 */
S.unlocked = [];
try { localStorage.removeItem('ck_unlock'); } catch(_){}
const isUnlocked = p => !p.locked || (S.unlocked.includes(p.id) && parseHash().name === 'pool' && parseHash().arg === p.id);
const hiddenPool = p => p.locked && !isUnlocked(p);
function unlockModal(goto){
  openModal(`<h3 id="mdlT">限定賞池</h3><p class="muted" style="font-size:13px;margin:0 0 16px">請輸入通關密碼。離開賞池頁後會自動重新上鎖。</p>
    <form data-act="bd-unlock" data-go="${goto || ''}" class="cfg" style="gap:16px"><div class="field"><label for="bdPw">通關密碼</label><input class="input num" id="bdPw" type="password" inputmode="numeric" autocomplete="off" maxlength="16" placeholder="請輸入密碼"></div>
    <button class="btn gold block" type="submit">${ic('lock','width:18px;height:18px')}解鎖</button></form>`);
  setTimeout(() => { const f = $('#bdPw'); f && f.focus(); }, 60); }
document.addEventListener('submit', e => { const f = e.target; if (f.dataset.act !== 'bd-unlock') return; e.preventDefault();
  const v = ($('#bdPw').value || '').trim(); if (!v){ toast('請輸入通關密碼'); return $('#bdPw').focus(); }
  if (fnv(v) !== BD_HASH){ toast('密碼不正確'); $('#bdPw').value = ''; return $('#bdPw').focus(); }
  POOLS.filter(p => p.locked).forEach(p => { if (!S.unlocked.includes(p.id)) S.unlocked.push(p.id); });
  closeModal(); toast('已解鎖限定賞池'); location.hash = '#/pool/bday'; if (parseHash().arg === 'bday') render(); });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="bd-lock"]'); if (!el) return; e.preventDefault(); unlockModal(); });

/* 大廳／首頁／IP 列表都不顯示未解鎖的限定池；大廳最後放一張「輸入通關密碼」卡 */
const _lobby = routes.lobby;
routes.lobby = r => { const keep = POOLS.slice(); const hid = POOLS.filter(hiddenPool);
  hid.forEach(p => POOLS.splice(POOLS.indexOf(p), 1)); let h; try { h = _lobby(r); } finally { POOLS.length = 0; keep.forEach(p => POOLS.push(p)); }
  const q = r.q, filtered = ['ip','tag','src','play','q'].some(k => q.get(k));
  if (hid.length && !filtered){ const lock = `<section class="lock-sec" aria-labelledby="h-lock"><h3 id="h-lock">限定賞池</h3><button type="button" class="lockrow" data-act="bd-lock"><span class="lk-ic">${ic('lock','width:24px;height:24px')}</span><span class="lk-t"><b>輸入通關密碼</b><span>限定賞池不會出現在一般列表，需密碼才能進入</span></span><span class="lk-go">${ic('right','width:20px;height:20px')}</span></button></section>`;
    const i = h.indexOf('<div class="grid lgrid">');
    if (i > -1){ let depth = 0, k = i; while (k < h.length){ const o = h.indexOf('<div', k), c = h.indexOf('</div>', k); if (o > -1 && o < c){ depth++; k = o + 4; } else { depth--; k = c + 6; if (depth === 0) break; } }
      h = h.slice(0, k) + lock + h.slice(k); } }
  return h; };
const _homeB = routes.home, _homeBA = routes.home.after;
routes.home = r => { const keep = POOLS.slice(); POOLS.filter(hiddenPool).forEach(p => POOLS.splice(POOLS.indexOf(p), 1)); try { return _homeB(r); } finally { POOLS.length = 0; keep.forEach(p => POOLS.push(p)); } };
routes.home.after = _homeBA;
const _playB = routes.play;
routes.play = r => { const keep = POOLS.slice(); POOLS.filter(p => hiddenPool(p) || p.play === 'bday').forEach(p => POOLS.splice(POOLS.indexOf(p), 1)); try { return _playB(r); } finally { POOLS.length = 0; keep.forEach(p => POOLS.push(p)); } };
if (_playB.after) routes.play.after = _playB.after;

/* ---------- 賞池頁 ---------- */
/* 抽獎紀錄每 30 分鐘清除一次：以整點、半點為界（例如 23:00–23:29 一段，23:30 起清空） */
const BD_WIN = 30 * 60 * 1000, bdWin = () => Math.floor(Date.now() / BD_WIN);
const bdNextClear = () => twISO(new Date((bdWin() + 1) * BD_WIN)).slice(11, 16);
const bdLoad = () => { try { const o = JSON.parse(localStorage.getItem('ck_bdlog') || 'null'); return o && o.win === bdWin() && Array.isArray(o.items) ? o.items : []; } catch(_){ return []; } };
S.bdLog = bdLoad(); S.bdLogWin = bdWin();
const bdSave = () => { try { localStorage.setItem('ck_bdlog', JSON.stringify({win:S.bdLogWin, items:S.bdLog.slice(0, 200)})); } catch(_){} };
const bdCheckClear = () => { if (S.bdLogWin === bdWin()) return false; S.bdLog = []; S.bdLogWin = bdWin(); bdSave(); return true; };
S.bdCd = 0;
const BD_CD = 10;
const bdLeft = () => Math.max(0, Math.ceil((S.bdCd - Date.now()) / 1000));
const _poolB = routes.pool, _poolBA = routes.pool.after;
routes.pool = r => { const p = poolById(r.arg);
  if (p && hiddenPool(p)) return `<div class="wrap"><div class="empty lockpage">${ic('lock','width:40px;height:40px')}<h2>限定賞池</h2><p>這是限定賞池，請先輸入通關密碼。</p><button class="btn gold" type="button" data-act="bd-lock">輸入通關密碼</button></div></div>`;
  let h = _poolB(r); if (!p || p.play !== 'bday') return h;
  bdCheckClear();
  h = h.replace(/<span class="coin" style="width:28px;height:28px;font-size:14px;align-self:center">U<\/span>\s*<b class="num" style="font-size:32px;line-height:1">0<\/b><span class="muted">UC幣 \/ 抽<\/span>/, '<b class="bd-free">免費</b><span class="muted">每輪 5 抽・保底 4 獎以上</span>');
  h = h.replace('機率 = 該賞剩餘數 ÷ 總剩餘數，每抽即時更新', '每輪抽完恢復原配率');
  h = h.replace(/<small class="shipm">[\s\S]*?<\/small>/g, '').replace(/CHIAKI 原創設計/g, '生日限定').replace(/<a class="odds-lock"[\s\S]*?<\/a>/g, '<span class="dim" style="white-space:nowrap">依規則</span>');
  const log = S.bdLog.length ? S.bdLog.map(x => `<li class="${x.void ? 'void' : ''}"><span class="dim num">${x.at}${x.redo ? '・重抽' : ''}${x.void ? '・已重抽作廢' : ''}</span><div class="bd-items">${x.items.map(n => `<span class="tag ${/再來[兩三]抽|銘謝惠顧/.test(n) ? '' : 'ok'}">${hx(n)}</span>`).join('')}</div></li>`).join('') : '<li class="dim">還沒有抽獎紀錄</li>';
  const sec = `<section class="panel bd-log" aria-labelledby="h-bdlog"><div class="row between bd-log-h"><h3 id="h-bdlog">我的抽獎紀錄</h3><span class="dim">每 30 分鐘清除・下次清除 ${bdNextClear()}</span></div><ol>${log}</ol></section>`;
  const i = h.indexOf('<section class="prizes"'); if (i > -1) h = h.slice(0, i) + sec + h.slice(i);
  /* 獎品內容可展開／收合（預設收合） */
  const t0 = h.indexOf('<table class="ptable">'), t1 = h.indexOf('</table>', t0);
  if (t0 > -1 && t1 > -1){ const n = p.prizes.length;
    h = h.slice(0, t0) + `<details class="pz-det"${S.bdPzOpen ? ' open' : ''}><summary><span class="pz-c">展開獎品內容（${n} 項）</span><span class="pz-o">收合獎品內容</span>${ic('down','width:18px;height:18px')}</summary><div class="tbl-wrap">` + h.slice(t0, t1 + 8) + '</div></details>' + h.slice(t1 + 8); }
  return h; };
document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('pz-det')) S.bdPzOpen = e.target.open; }, true);
routes.pool.after = r => { if (_poolBA) _poolBA(r); const p = poolById(r.arg); if (!p || p.play !== 'bday') return;
  const tick = () => { const b = $('#bdGo'); if (!b) return; const s = bdLeft(), left = remaining(p);
    b.disabled = !!s || !left; b.innerHTML = !left ? '已全部抽完' : s ? `${ic('clock','width:18px;height:18px')}${s} 秒後可再抽` : `${ic('ticket','width:18px;height:18px')}抽 5 抽（免費）`; };
  tick(); const iv = setInterval(() => { tick(); if (bdCheckClear() && !$('#stage')) render(true); }, 500); cleanup.push(() => clearInterval(iv)); BGM.ui(); };

/* ---------- 背景音樂：生日快樂歌（旋律為公有領域，Web Audio 即時合成，不需音檔） ---------- */
const BGM = {
  on: (() => { try { return localStorage.getItem('ck_bdbgm') !== '0'; } catch(_){ return true; } })(),
  ctx: null, bus: null, tm: 0, playing: false,
  /* 3/4 拍，數字為拍數；F = 頻率 */
  seq: [['G4',.75],['G4',.25],['A4',1],['G4',1],['C5',1],['B4',2],['G4',.75],['G4',.25],['A4',1],['G4',1],['D5',1],['C5',2],
        ['G4',.75],['G4',.25],['G5',1],['E5',1],['C5',1],['B4',1],['A4',1],['F5',.75],['F5',.25],['E5',1],['C5',1],['D5',1],['C5',3]],
  bass: [['C3',3],['G2',3],['G2',3],['C3',3],['C3',3],['F2',3],['C3',2],['G2',1],['C3',3]],
  F: n => { const m = {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[n[0]], o = +n.slice(-1); return 440 * Math.pow(2, (m + (o - 4) * 12 - 9) / 12); },
  note(t, f, d, g, type){ const c = this.ctx, o = c.createOscillator(), o2 = c.createOscillator(), v = c.createGain();
    o.type = type || 'sine'; o.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f * 2;
    const v2 = c.createGain(); v2.gain.value = .18; o2.connect(v2).connect(v); o.connect(v); v.connect(this.loop);
    v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(g, t + .015); v.gain.exponentialRampToValueAtTime(.0008, t + Math.max(.35, d * 1.1));
    o.start(t); o2.start(t); o.stop(t + d * 1.2 + .4); o2.stop(t + d * 1.2 + .4); },
  schedule(){ const c = this.ctx, beat = 60 / 104, t0 = c.currentTime + .08;
    this.loop = c.createGain(); this.loop.connect(this.bus);
    let t = t0; this.seq.forEach(([n, b]) => { this.note(t, this.F(n), b * beat, .32); t += b * beat; });
    let tb = t0 + beat; this.bass.forEach(([n, b]) => { this.note(tb, this.F(n), b * beat * .9, .16, 'sine'); tb += b * beat; });
    const len = (t - t0) + beat * 2;   // 段落之間留 2 拍
    clearTimeout(this.tm); this.tm = setTimeout(() => { if (this.playing) this.schedule(); }, Math.max(200, (len - .3) * 1000)); },
  start(){ if (!this.on || this.playing) return; try {
      if (!this.ctx){ const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; this.ctx = new AC(); this.bus = this.ctx.createGain(); this.bus.gain.value = .5; this.bus.connect(this.ctx.destination); }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.playing = true; this.bus.gain.cancelScheduledValues(this.ctx.currentTime); this.bus.gain.setValueAtTime(.5, this.ctx.currentTime); this.schedule(); this.ui(); } catch(_){} },
  stop(){ if (!this.playing) return; this.playing = false; clearTimeout(this.tm);
    try { const c = this.ctx, g = this.bus.gain; g.cancelScheduledValues(c.currentTime); g.setValueAtTime(g.value, c.currentTime); g.linearRampToValueAtTime(0, c.currentTime + .25);
      const old = this.loop; setTimeout(() => { try { old.disconnect(); } catch(_){} }, 300); } catch(_){} this.ui(); },
  toggle(){ this.on = !this.on; try { localStorage.setItem('ck_bdbgm', this.on ? '1' : '0'); } catch(_){} if (this.on) this.start(); else this.stop(); this.ui(); },
  ui(){ const b = $('#bdBgm'); if (!b) return; b.setAttribute('aria-pressed', this.on); b.innerHTML = `${ic(this.on ? 'sound' : 'mute','width:16px;height:16px')}<span>${this.on ? '生日快樂歌' : '音樂已關閉'}</span>`; }
};
const onBday = () => { const r = parseHash(); return r.name === 'pool' && r.arg === 'bday'; };
/* 瀏覽器規定要先有使用者操作才能出聲：在生日賞池頁第一次點擊／觸控時開始播放 */
document.addEventListener('pointerdown', e => { if (onBday() && BGM.on && !BGM.playing && !e.target.closest('[data-act="bd-bgm"]')) BGM.start(); }, true);
document.addEventListener('click', e => { const el = e.target.closest('[data-act="bd-bgm"]'); if (!el) return; e.preventDefault(); BGM.toggle(); });
addEventListener('hashchange', () => { if (!onBday()){ BGM.stop(); if (S.unlocked.length){ S.unlocked = []; } } });
document.addEventListener('visibilitychange', () => { if (document.hidden) BGM.stop(); else if (onBday() && BGM.on && BGM.ctx) BGM.start(); });
const _packsB = packsSection;
packsSection = function(p){ if (p.play !== 'bday') return _packsB(p);
  return `<section class="packs-wrap" id="packs" aria-labelledby="h-pk" tabindex="-1"><div class="sec-h"><h2 id="h-pk"><small>DRAW</small>開始抽獎<span class="muted" style="font-size:14px;font-weight:400;margin-left:8px">共 ${p.total} 籤・每輪恢復原配率</span></h2><button type="button" class="btn s ghost bd-bgm" id="bdBgm" data-act="bd-bgm" aria-pressed="${BGM.on}">${ic(BGM.on ? 'sound' : 'mute','width:16px;height:16px')}<span>${BGM.on ? '生日快樂歌' : '音樂已關閉'}</span></button></div>
    <button class="btn gold block bd-go" id="bdGo" type="button" data-act="bd-go">${ic('ticket','width:18px;height:18px')}抽 5 抽（免費）</button>
    <ul class="bd-rules"><li>每輪 5 抽，有機會中多個獎品，每輪保底至少一個 4 獎以上（重抽券不算保底）。</li><li>抽到「再來兩抽」本輪再多抽 2 次；抽到「再來三抽」再多抽 3 次。</li><li>每輪結束後需等待 ${BD_CD} 秒才能再玩。</li><li>每次抽完都會恢復原配率。</li><li>抽中「重抽券」須在該輪結算時立即使用：不滿意可重抽本輪，該輪獎品作廢、以新結果為準；關閉結果後即失效。</li><li>獎項皆不提供回收；抽中的獎品會記錄在下方「我的抽獎紀錄」。</li></ul></section>`; };

/* 一輪：前 4 抽隨機（最大獎權重 0.35），第 5 抽若前面都沒中 4 獎以上則只從獎品中抽；再來兩抽／三抽 → 追加 2／3 抽 */
const BD_W_TOP = .35, BD_N = 5;
function bdPick(p, onlyPrize){ const free = p.tickets.filter(t => !t.taken), pool = onlyPrize ? free.filter(t => { const pr = p.prizes[t.pi]; return !pr.again && !pr.miss && !pr.noGuar; }) : free;
  const L = pool.length ? pool : free; if (!L.length) return null;
  const w = L.map(t => p.prizes[t.pi].lv === 1 ? BD_W_TOP : 1), sum = w.reduce((a, b) => a + b, 0); let r = Math.random() * sum;
  for (let k = 0; k < L.length; k++){ r -= w[k]; if (r <= 0) return L[k]; } return L[L.length - 1]; }
function bdRound(p){
  const out = [], lbl = []; let hit = false, extra = 0;
  const take = (t, bonus) => { t.taken = true; t.by = 'me'; const pr = p.prizes[t.pi]; if (!pr.again && !pr.miss && !pr.noGuar) hit = true; if (pr.again){ extra += pr.again; lbl.push(...Array(pr.again).fill(pr.name)); }
    out.push({no:t.no, rk:pr.rk, g:pr.g, lv:pr.lv, lvName:pr.lvName, small:pr.small, tag:pr.tag, img:pr.img, custom:true, tier:pr.tier, rv:0, name:pr.name, pname:pr.name, hue:p.hue, bonus:bonus || ''}); };
  for (let k = 0; k < BD_N; k++){ const t = bdPick(p, k === BD_N - 1 && !hit); if (!t) break; take(t); }
  while (extra > 0){ extra--; const t = bdPick(p, false); if (!t) break; take(t, lbl.shift() || '再來兩抽'); }
  return out; }
/* 重抽券：抽中後可保留；對某一輪結果不滿意時使用，該輪獎品全部作廢（含該輪抽中的重抽券），立即重抽一輪 */
try { localStorage.removeItem('ck_bdreroll'); } catch(_){}
function bdRun(p, redo){
  const snap = p.tickets.map(t => t.taken), res = bdRound(p); p.tickets.forEach((t, i) => { t.taken = snap[i]; if (!snap[i]) delete t.by; });   // 每輪抽完恢復原配率
  if (!res.length) return;
  bdCheckClear(); const id = 'r' + Date.now(); S.bdLog.unshift({id, at:twNow(), items:res.map(x => x.name), redo:!!redo}); bdSave();
  const won = res.filter(x => x.name === '重抽券').length;
  S.audit.unshift({t:'剛剛', who:'Chiaki 玩家', a:`漩漩生日一番賞${redo ? '（重抽）' : ''}：${res.filter(x => x.lv < 6 || !/再來[兩三]抽|銘謝惠顧/.test(x.name)).map(x => x.name).join('、') || '未中獎'}`});
  S.bdCd = Date.now() + 864e5;   // 演出期間先鎖住，結束後才開始 10 秒倒數
  runDraw(p, res); D.bdId = id; D.bdWon = won; }
document.addEventListener('click', e => { const el = e.target.closest('[data-act="bd-go"]'); if (!el || el.disabled) return; const p = curPool(); if (!p || p.play !== 'bday') return;
  if (bdLeft()) return toast(`請再等 ${bdLeft()} 秒`); if (!remaining(p)) return toast('已全部抽完');
  bdRun(p); });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="bd-reroll"]'); if (!el || !D || !D.bdId) return; e.preventDefault();
  if (!D.bdWon) return toast('本輪沒有重抽券');
  const p = D.p, id = D.bdId; const L = S.bdLog.find(x => x.id === id); if (L){ L.void = true; bdSave(); }
  fx.stop(); $('#stageRoot').innerHTML = ''; document.documentElement.style.overflow = ''; D = null;
  toast('已使用重抽券，本輪結果作廢，重新抽獎'); bdRun(p, true); });
const _closeStageB = closeStage;
closeStage = function(){ const was = D && D.p && D.p.play === 'bday'; if (was) S.bdCd = Date.now() + BD_CD * 1000; _closeStageB(); };
const _sumB = showSummary;
showSummary = function(){ _sumB(); if (!D || !D.p || D.p.play !== 'bday') return; const s = $('#sum'); if (!s) return;
  const sub = s.querySelector('.sub'); if (sub){ const n = D.results.filter(x => x.lv < 6).length; sub.innerHTML = `本輪共 ${D.results.length} 抽，中獎 <b style="color:var(--gold-2)">${n}</b> 個 ・ 已記錄在「我的抽獎紀錄」`; }
  const w = s.querySelector('.acts a[href="#/warehouse"]'); if (w){ w.setAttribute('href', '#/pool/bday'); w.innerHTML = `${ic('list','width:18px;height:18px')}查看抽獎紀錄`; }
  const again = s.querySelector('.acts [data-act="close-stage"]'); if (again && !again.getAttribute('href')) again.textContent = `完成（${BD_CD} 秒後可再抽）`;
  if (D.bdWon > 0){ const acts = s.querySelector('.acts'); if (acts) acts.insertAdjacentHTML('beforebegin', `<button type="button" class="btn block bd-rr" data-act="bd-reroll">${ic('recycle','width:18px;height:18px')}使用重抽券重抽本輪</button><p class="bd-rr-note">重抽券只能在本輪結算時使用，關閉結果後即失效。使用後本輪獎品全部作廢，以重抽結果為準。</p>`); } };
</script>
<script>
/* 漩漩：再來兩抽／三抽不提前曝光 — 進度點、張數與下方疊籤只顯示「已揭曉」的抽數 */
const bdAgainOf = x => /再來三抽/.test(x.name) ? 3 : /再來兩抽/.test(x.name) ? 2 : 0;
function bdVisible(){ if (!D || !D.p || D.p.play !== 'bday') return 0; let v = BD_N; for (let k = 0; k < D.i; k++) v += bdAgainOf(D.results[k]); return Math.min(v, D.results.length); }
const _ntB = nextTicket;
nextTicket = function(){ _ntB.apply(this, arguments); if (!D || !D.p || D.p.play !== 'bday' || !D.results[D.i]) return;
  const vis = bdVisible(), left = vis - D.i - 1, w = $('#tixWrap');
  if (w){ w.querySelectorAll('.tix-stack').forEach(e => e.remove()); w.insertAdjacentHTML('afterbegin', `${left > 1 ? '<div class="tix-stack s2"></div>' : ''}${left > 0 ? '<div class="tix-stack"></div>' : ''}`); }
  const c = $('#ctr'); if (c) c.innerHTML = Array.from({length:vis}, (_, k) => `<i class="${k < D.i ? 'done' : k === D.i ? 'on' : ''}"></i>`).join('') + `<span style="margin-left:8px">${D.i + 1} / ${vis}</span>`; };
</script>
