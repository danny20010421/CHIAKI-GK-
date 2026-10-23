<script>
/* =========================================================
   限定賞池：漩漩生日一番賞（輸入通關密碼才看得到）
   每輪 3 抽・3 抽保底一個獎品（最大獎權重較低）・抽到「再來兩抽」本輪 +2 抽
   每輪結束後需等 30 秒・獎項皆不可回收・抽獎紀錄保留
   ========================================================= */
PLAY.bday = '生日限定';
const _probPctB = probPct; probPct = (p, i) => p.play === 'bday' ? '依規則' : _probPctB(p, i);
(() => { const I = k => DEMO_IMG(k);
  const B = {id:'bday', title:'漩漩生日一番賞', ip:'CHIAKI 限定', src:'s', play:'bday', price:0, hue:330, seed:1126, drawn:0, locked:true, isNew:true, img:I('bdcover'),
    desc:'每輪 3 抽，3 抽保底一個獎品；抽到「再來兩抽」本輪再抽 2 次。每輪結束後需等待 30 秒才能再玩。獎項皆不提供回收，抽中紀錄會保留。',
    ship:{home:0, cvs:0}, packs:[3],
    levels:[
      {name:'最大獎', items:[{n:'黃金（8000 元抵用券）', q:1, img:I('bdgold'), tag:'其他'}]},
      {name:'一獎', items:[
        {n:'長記銀樓 14K 玫瑰金鑲鑽手鍊（8000 元抵用券）', q:1, img:I('bdbracelet'), tag:'其他'},
        {n:'日本機票 50%（7000 元抵用券）', q:1, img:I('bdflight'), tag:'其他'},
        {n:'當天約會費全部', q:1, img:I('bddate'), tag:'其他'},
        {n:'14K／18K 玫瑰金或香檳金戒指（5000 元抵用券）', q:1, img:I('bdring'), tag:'其他'}]},
      {name:'二獎', items:[
        {n:'長記銀樓 14K 玫瑰金鑲鑽手鍊（4000 元抵用券）', q:1, img:I('bdbracelet'), tag:'其他'},
        {n:'續約三星手機（4000 元抵用券）', q:1, img:I('bdphone'), tag:'其他'},
        {n:'鉑金 PT950 戒指或鍊墜（4000 元抵用券）', q:1, img:I('bdpt'), tag:'其他'},
        {n:'日本機票 25%（3500 元抵用券）', q:1, img:I('bdflight'), tag:'其他'},
        {n:'當天約會費 50%', q:1, img:I('bddate'), tag:'其他'},
        {n:'不限品牌衣物任選（3000 元抵用券）', q:1, img:I('bdcloth'), tag:'其他'}]},
      {name:'三獎', small:false, items:[
        {n:'14K／18K 玫瑰金或香檳金戒指（2500 元抵用券）', q:1, img:I('bdring'), tag:'其他'},
        {n:'長記銀樓 14K 玫瑰金鑲鑽手鍊（2000 元抵用券）', q:1, img:I('bdbracelet'), tag:'其他'},
        {n:'鉑金 PT950 戒指或鍊墜（2000 元抵用券）', q:2, img:I('bdpt'), tag:'其他'},
        {n:'不限品牌衣物任選（1500 元抵用券）', q:2, img:I('bdcloth'), tag:'其他'},
        {n:'半年份衛生棉', q:1, img:I('bdpad'), tag:'其他'}]},
      {name:'四獎', small:false, items:[
        {n:'Kose 雪肌精 臉部保濕保養品＋頭髮（1000 元抵用券）', q:3, img:I('bdkose'), tag:'其他'},
        {n:'DONKI DONKI 購物（1000 元抵用券）', q:3, img:I('bddonki'), tag:'其他'},
        {n:'ReFa 輕護髮油（800 元抵用券）', q:5, img:I('bdrefa'), tag:'其他'},
        {n:'響食天堂（一餐）', q:2, img:I('bdbuffet'), tag:'其他'},
        {n:'一個月衛生棉', q:3, img:I('bdpad'), tag:'其他'}]},
      {name:'參加獎', small:true, items:[
        {n:'再來兩抽', q:67, img:I('bdagain'), tag:'其他', again:true},
        {n:'生日快樂（銘謝惠顧）', q:900, img:I('bdhbd'), tag:'其他', miss:true}]}], last:null};
  buildPool(B);
  B.levels.forEach((L, li) => L.items.forEach(it => { const pr = B.prizes.find(x => x.lv === li + 1 && x.name === it.n); if (pr){ pr.again = !!it.again; pr.miss = !!it.miss; } }));
  POOLS.push(B); })();

/* ---------- 解鎖（密碼只存雜湊；靜態網站僅能隱藏，不是真正的權限控管） ---------- */
const BD_HASH = '77de9c41af602e47';
const fnv = s => { let h1 = 0x811c9dc5, h2 = 0x01000193; for (const c of s){ h1 ^= c.charCodeAt(0); h1 = Math.imul(h1, 16777619) >>> 0; h2 = Math.imul(h2 ^ c.charCodeAt(0), 2246822519) >>> 0; } return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'); };
S.unlocked = (() => { try { return JSON.parse(localStorage.getItem('ck_unlock') || '[]'); } catch(_){ return []; } })();
const isUnlocked = p => !p.locked || S.unlocked.includes(p.id);
const hiddenPool = p => p.locked && !isUnlocked(p);
function unlockModal(goto){
  openModal(`<h3 id="mdlT">限定賞池</h3><p class="muted" style="font-size:13px;margin:0 0 16px">請輸入通關密碼，解鎖後會出現在抽賞大廳。</p>
    <form data-act="bd-unlock" data-go="${goto || ''}" class="cfg" style="gap:16px"><div class="field"><label for="bdPw">通關密碼</label><input class="input num" id="bdPw" type="password" inputmode="numeric" autocomplete="off" maxlength="16" placeholder="請輸入密碼"></div>
    <button class="btn gold block" type="submit">${ic('lock','width:18px;height:18px')}解鎖</button></form>`);
  setTimeout(() => { const f = $('#bdPw'); f && f.focus(); }, 60); }
document.addEventListener('submit', e => { const f = e.target; if (f.dataset.act !== 'bd-unlock') return; e.preventDefault();
  const v = ($('#bdPw').value || '').trim(); if (!v){ toast('請輸入通關密碼'); return $('#bdPw').focus(); }
  if (fnv(v) !== BD_HASH){ toast('密碼不正確'); $('#bdPw').value = ''; return $('#bdPw').focus(); }
  POOLS.filter(p => p.locked).forEach(p => { if (!S.unlocked.includes(p.id)) S.unlocked.push(p.id); }); try { localStorage.setItem('ck_unlock', JSON.stringify(S.unlocked)); } catch(_){}
  closeModal(); toast('已解鎖限定賞池'); location.hash = '#/pool/bday'; if (parseHash().arg === 'bday') render(); });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="bd-lock"]'); if (!el) return; e.preventDefault(); unlockModal(); });

/* 大廳／首頁／IP 列表都不顯示未解鎖的限定池；大廳最後放一張「輸入通關密碼」卡 */
const _lobby = routes.lobby;
routes.lobby = r => { const keep = POOLS.slice(); const hid = POOLS.filter(hiddenPool);
  hid.forEach(p => POOLS.splice(POOLS.indexOf(p), 1)); let h; try { h = _lobby(r); } finally { POOLS.length = 0; keep.forEach(p => POOLS.push(p)); }
  const q = r.q, filtered = ['ip','tag','src','play','q'].some(k => q.get(k));
  if (hid.length && !filtered){ const lock = `<button type="button" class="pc lockcard" data-act="bd-lock"><span class="lk-ic">${ic('lock','width:28px;height:28px')}</span><b>限定賞池</b><span>輸入通關密碼解鎖</span></button>`;
    const i = h.indexOf('<div class="grid lgrid">');
    if (i > -1){ let depth = 0, k = i; while (k < h.length){ const o = h.indexOf('<div', k), c = h.indexOf('</div>', k); if (o > -1 && o < c){ depth++; k = o + 4; } else { depth--; if (depth === 0) break; k = c + 6; } }
      h = h.slice(0, k) + lock + h.slice(k); } }
  return h; };
const _homeB = routes.home, _homeBA = routes.home.after;
routes.home = r => { const keep = POOLS.slice(); POOLS.filter(hiddenPool).forEach(p => POOLS.splice(POOLS.indexOf(p), 1)); try { return _homeB(r); } finally { POOLS.length = 0; keep.forEach(p => POOLS.push(p)); } };
routes.home.after = _homeBA;
const _playB = routes.play;
routes.play = r => { const keep = POOLS.slice(); POOLS.filter(p => hiddenPool(p) || p.play === 'bday').forEach(p => POOLS.splice(POOLS.indexOf(p), 1)); try { return _playB(r); } finally { POOLS.length = 0; keep.forEach(p => POOLS.push(p)); } };
if (_playB.after) routes.play.after = _playB.after;

/* ---------- 賞池頁 ---------- */
S.bdLog = (() => { try { return JSON.parse(localStorage.getItem('ck_bdlog') || '[]'); } catch(_){ return []; } })();
const bdSave = () => { try { localStorage.setItem('ck_bdlog', JSON.stringify(S.bdLog.slice(0, 200))); } catch(_){} };
S.bdCd = 0;
const BD_CD = 30;
const bdLeft = () => Math.max(0, Math.ceil((S.bdCd - Date.now()) / 1000));
const _poolB = routes.pool, _poolBA = routes.pool.after;
routes.pool = r => { const p = poolById(r.arg);
  if (p && hiddenPool(p)) return `<div class="wrap"><div class="empty lockpage">${ic('lock','width:40px;height:40px')}<h2>限定賞池</h2><p>這是限定賞池，請先輸入通關密碼。</p><button class="btn gold" type="button" data-act="bd-lock">輸入通關密碼</button></div></div>`;
  let h = _poolB(r); if (!p || p.play !== 'bday') return h;
  h = h.replace(/<span class="coin" style="width:28px;height:28px;font-size:14px;align-self:center">C<\/span>\s*<b class="num" style="font-size:32px;line-height:1">0<\/b><span class="muted">CC幣 \/ 抽<\/span>/, '<b class="bd-free">免費</b><span class="muted">每輪 3 抽・保底 1 個獎品</span>');
  h = h.replace(/<small class="shipm">[\s\S]*?<\/small>/g, '').replace(/CHIAKI 原創設計/g, '生日限定').replace(/<a class="odds-lock"[\s\S]*?<\/a>/g, '<span class="dim">依規則</span>');
  const log = S.bdLog.length ? S.bdLog.map(x => `<li><span class="dim num">${x.at}</span><div class="bd-items">${x.items.map(n => `<span class="tag ${/再來兩抽|銘謝惠顧/.test(n) ? '' : 'ok'}">${hx(n)}</span>`).join('')}</div></li>`).join('') : '<li class="dim">還沒有抽獎紀錄</li>';
  const sec = `<section class="panel bd-log" aria-labelledby="h-bdlog"><h3 id="h-bdlog">我的抽獎紀錄</h3><ol>${log}</ol></section>`;
  const i = h.indexOf('<section class="prizes"'); if (i > -1) h = h.slice(0, i) + sec + h.slice(i);
  return h; };
routes.pool.after = r => { if (_poolBA) _poolBA(r); const p = poolById(r.arg); if (!p || p.play !== 'bday') return;
  const tick = () => { const b = $('#bdGo'); if (!b) return; const s = bdLeft(), left = remaining(p);
    b.disabled = !!s || !left; b.innerHTML = !left ? '已全部抽完' : s ? `${ic('clock','width:18px;height:18px')}${s} 秒後可再抽` : `${ic('ticket','width:18px;height:18px')}抽 3 抽（免費）`; };
  tick(); const iv = setInterval(tick, 500); cleanup.push(() => clearInterval(iv)); };
const _packsB = packsSection;
packsSection = function(p){ if (p.play !== 'bday') return _packsB(p);
  return `<section class="packs-wrap" id="packs" aria-labelledby="h-pk" tabindex="-1"><div class="sec-h"><h2 id="h-pk"><small>DRAW</small>開始抽獎<span class="muted" style="font-size:14px;font-weight:400;margin-left:8px">剩 ${remaining(p)} 籤</span></h2></div>
    <button class="btn gold block bd-go" id="bdGo" type="button" data-act="bd-go">${ic('ticket','width:18px;height:18px')}抽 3 抽（免費）</button>
    <ul class="bd-rules"><li>每輪 3 抽，3 抽保底一個獎品（最大獎的機率比其他獎品低）。</li><li>抽到「再來兩抽」，本輪再多抽 2 次。</li><li>每輪結束後需等待 ${BD_CD} 秒才能再玩。</li><li>獎項皆不提供回收；抽中的獎品會記錄在下方「我的抽獎紀錄」。</li></ul></section>`; };

/* 一輪：前 2 抽隨機（最大獎權重 0.35），第 3 抽若前面都沒中獎則只從獎品中抽；再來兩抽 → 追加 2 抽 */
const BD_W_TOP = .35;
function bdPick(p, onlyPrize){ const free = p.tickets.filter(t => !t.taken), pool = onlyPrize ? free.filter(t => { const pr = p.prizes[t.pi]; return !pr.again && !pr.miss; }) : free;
  const L = pool.length ? pool : free; if (!L.length) return null;
  const w = L.map(t => p.prizes[t.pi].lv === 1 ? BD_W_TOP : 1), sum = w.reduce((a, b) => a + b, 0); let r = Math.random() * sum;
  for (let k = 0; k < L.length; k++){ r -= w[k]; if (r <= 0) return L[k]; } return L[L.length - 1]; }
function bdRound(p){
  const out = []; let hit = false, extra = 0;
  const take = (t, bonus) => { t.taken = true; t.by = 'me'; const pr = p.prizes[t.pi]; if (!pr.again && !pr.miss) hit = true; if (pr.again) extra += 2;
    out.push({no:t.no, rk:pr.rk, g:pr.g, lv:pr.lv, lvName:pr.lvName, small:pr.small, tag:pr.tag, img:pr.img, custom:true, tier:pr.tier, rv:0, name:pr.name, pname:pr.name, hue:p.hue, bonus:bonus || ''}); };
  for (let k = 0; k < 3; k++){ const t = bdPick(p, k === 2 && !hit); if (!t) break; take(t); }
  while (extra > 0){ extra--; const t = bdPick(p, false); if (!t) break; take(t, '再來兩抽'); }
  return out; }
document.addEventListener('click', e => { const el = e.target.closest('[data-act="bd-go"]'); if (!el || el.disabled) return; const p = curPool(); if (!p || p.play !== 'bday') return;
  if (bdLeft()) return toast(`請再等 ${bdLeft()} 秒`); if (!remaining(p)) return toast('已全部抽完');
  const res = bdRound(p); if (!res.length) return;
  S.bdLog.unshift({at:twNow(), items:res.map(x => x.name)}); bdSave();
  S.audit.unshift({t:'剛剛', who:'Chiaki 玩家', a:`漩漩生日一番賞：${res.filter(x => x.lv < 6).map(x => x.name).join('、') || '未中獎'}`});
  S.bdCd = Date.now() + 864e5;   // 演出期間先鎖住，結束後才開始 30 秒倒數
  runDraw(p, res); });
const _closeStageB = closeStage;
closeStage = function(){ const was = D && D.p && D.p.play === 'bday'; if (was) S.bdCd = Date.now() + BD_CD * 1000; _closeStageB(); };
const _sumB = showSummary;
showSummary = function(){ _sumB(); if (!D || !D.p || D.p.play !== 'bday') return; const s = $('#sum'); if (!s) return;
  const sub = s.querySelector('.sub'); if (sub){ const n = D.results.filter(x => x.lv < 6).length; sub.innerHTML = `本輪共 ${D.results.length} 抽，中獎 <b style="color:var(--gold-2)">${n}</b> 個 ・ 已記錄在「我的抽獎紀錄」`; }
  const w = s.querySelector('.acts a[href="#/warehouse"]'); if (w){ w.setAttribute('href', '#/pool/bday'); w.innerHTML = `${ic('list','width:18px;height:18px')}查看抽獎紀錄`; }
  const again = s.querySelector('.acts [data-act="close-stage"]'); if (again && !again.getAttribute('href')) again.textContent = `完成（${BD_CD} 秒後可再抽）`; };
</script>
