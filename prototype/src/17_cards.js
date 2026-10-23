<script>
/* =========================================================
   自製一番賞（卡牌）：航海王「世界之王」
   機率賞：4 獎（含以上）50%・一抽 200・1／10／100 抽
   抽卡演出改為播放影片 → 漸黑 → 結算畫面（不使用籤紙）
   ========================================================= */
const GACHA_VIDEO = '__VIDEO_gacha__';
(() => { const I = k => DEMO_IMG(k);
  const W = {id:'wk', title:'世界之王', ip:'航海王', src:'s', play:'prob', price:200, hue:42, seed:1024, drawn:0, hot:true, isNew:true, anim:'video', img:I('wkcover'),
    desc:'航海王卡牌自製一番賞。大獎 PSA10 漫畫尼卡、漫畫洛克斯，2 獎 PSA10 漫畫女帝、漫畫紅髮；50% 機率獲得 4 獎（含以上）。',
    ship:{home:0, cvs:0}, packs:[1, 10, 100],
    levels:[
      {name:'大獎', items:[{n:'PSA10 漫畫尼卡', q:1, rv:300000, tag:'卡牌', ship:'home', img:I('wknika')},
                          {n:'PSA10 漫畫洛克斯', q:1, rv:160000, tag:'卡牌', ship:'home', img:I('wkrocks')}]},
      {name:'2 獎', items:[{n:'PSA10 漫畫女帝', q:1, rv:50000, tag:'卡牌', ship:'home', img:I('wkhancock')},
                          {n:'PSA10 漫畫紅髮', q:1, rv:50000, tag:'卡牌', ship:'home', img:I('wkshanks')}]},
      {name:'3 獎', items:[{n:'隨機未開封卡盒', q:1, rv:3000, tag:'卡牌', ship:'c711', img:I('wkbox')}]},
      {name:'4 獎', small:false, odds:.5, items:[{n:'隨機 SR 卡', q:100005, rv:250, tag:'卡牌', ship:'c711', img:I('wksr')}]},
      {name:'5 獎', items:[{n:'隨機普卡', q:100000, rv:100, tag:'卡牌', ship:'c711', img:I('wkcommon')}]}], last:null};
  buildPool(W); POOLS.splice(1, 0, W); })();

/* ---------- 大型賞池（數萬籤以上）改用計數抽選，避免每抽掃描整個籤表 ---------- */
const BIG = 20000;
function bigIndex(p){ const key = p.id + ':' + p.setIdx; if (p._bi && p._bi.key === key) return p._bi;
  const by = p.prizes.map(() => []), cnt = p.prizes.map(() => 0);
  p.tickets.forEach((t, i) => { by[t.pi].push(i); if (!t.taken) cnt[t.pi]++; });
  return (p._bi = {key, by, cnt}); }
function bigTake(p, pi, used){ const b = bigIndex(p), L = b.by[pi];
  for (let n = 0; n < 64; n++){ const t = p.tickets[L[Math.floor(Math.random() * L.length)]]; if (!t.taken && !t.held && !(used && used.has(t.no))) return t; }
  return L.map(i => p.tickets[i]).find(t => !t.taken && !(used && used.has(t.no))) || null; }
const _probPickC = probPick;
probPick = function(p, used){ if (p.tickets.length < BIG) return _probPickC(p, used);
  const b = bigIndex(p), lvLeft = lv => p.prizes.reduce((s, pr, i) => s + (pr.lv === lv ? b.cnt[i] : 0), 0);
  const pickIn = lvs => { const idx = p.prizes.map((pr, i) => lvs(pr) ? i : -1).filter(i => i > -1 && b.cnt[i] > 0), tot = idx.reduce((s, i) => s + b.cnt[i], 0);
    if (!tot) return null; let r = Math.random() * tot; for (const i of idx){ r -= b.cnt[i]; if (r < 0) return i; } return idx[idx.length - 1]; };
  let pi = null, r = Math.random(), acc = 0;
  for (let li = 0; li < p.levels.length && pi == null; li++){ const L = p.levels[li]; if (!L.odds || !lvLeft(li + 1)) continue; acc += L.odds; if (r < acc) pi = pickIn(pr => pr.lv === li + 1); }
  if (pi == null){ const fixed = new Set(p.levels.map((L, i) => L.odds ? i + 1 : 0)); pi = pickIn(pr => !fixed.has(pr.lv)); if (pi == null) pi = pickIn(() => true); }
  if (pi == null) return null; const t = bigTake(p, pi, used); if (t) b.cnt[pi]--; return t; };
const _quickDrawC = quickDraw;
quickDraw = function(n){ const p = curPool(); if (!p || p.tickets.length < BIG) return _quickDrawC(n);
  const left = remaining(p), k = n === 'all' ? left : Math.min(+n, left); if (!k) return toast('本套已完售');
  clearHold(); const pick = new Set(); let guard = 0; while (pick.size < k && guard++ < k * 50){ const t = p.tickets[Math.floor(Math.random() * p.tickets.length)]; if (!t.taken && !t.held) pick.add(t.no); }
  S.sel = [...pick]; startHold(p); buyDialog(); };
/* 機率賞實際以 probPick 決定獎項，所以大型池的機率顯示也用計數算，避免重複掃描 */
const _probPctC = probPct;
probPct = function(p, i){ if (p.tickets.length < BIG || p.play === 'bday') return _probPctC(p, i);
  const b = bigIndex(p), free = b.cnt.reduce((s, c) => s + c, 0); if (!free) return '—';
  const lvLeft = lv => p.prizes.reduce((s, pr, k) => s + (pr.lv === lv ? b.cnt[k] : 0), 0), lv = p.prizes[i].lv;
  const active = p.levels.map((L, k) => L.odds && lvLeft(k + 1) ? L.odds : 0), fixedSum = active.reduce((a, c) => a + c, 0);
  if (active[lv - 1]) return pctF(active[lv - 1] * b.cnt[i] / lvLeft(lv) * 100);
  const restN = p.prizes.reduce((s, pr, k) => s + (!active[pr.lv - 1] && !p.levels[pr.lv - 1].odds ? b.cnt[k] : 0), 0);
  return restN ? pctF((1 - fixedSum) * b.cnt[i] / restN * 100) : '—'; };

/* ---------- 影片抽卡演出 ---------- */
const _runDrawC = runDraw;
runDraw = function(p, results){ if (p.anim !== 'video') return _runDrawC(p, results);
  D = {p, results, i:results.length, auto:false, busy:false, done:true, video:true, txn:'CK' + twDate().replace(/-/g,'') + '-' + String(Math.floor(Math.random()*1e6)).padStart(6,'0')};
  document.documentElement.style.overflow = 'hidden'; $('#toastRoot').innerHTML = '';
  $('#stageRoot').innerHTML = `<div class="stage vstage" id="stage" role="dialog" aria-modal="true" aria-label="抽卡演出">
    <video id="gVid" src="${GACHA_VIDEO}" playsinline webkit-playsinline preload="auto" aria-hidden="true"></video>
    <div class="vblack" aria-hidden="true"></div>
    <button type="button" class="btn s ghost vskip" data-act="vskip">${ic('right','width:16px;height:16px')}跳過</button>
    <div class="vsum" id="vsum" hidden></div></div>`;
  const v = $('#gVid'), st = $('#stage'); let ended = false;
  const end = () => { if (ended) return; ended = true; try { v.pause(); } catch(_){} st.classList.add('dark'); const sk = $('.vskip', st); if (sk) sk.remove();
    setTimeout(() => vSummary(), RM() ? 50 : 700); };
  v.addEventListener('ended', end); v.addEventListener('error', end); st._end = end;
  if (RM() || !GACHA_VIDEO) return end();
  const p1 = v.play(); if (p1 && p1.catch) p1.catch(() => { v.muted = true; v.play().catch(end); });
  setTimeout(() => { if (!ended && v.paused && v.currentTime === 0) end(); }, 4000);   // 無法播放時直接進結算
};
function vSummary(){ if (!D || !D.video) return; const p = D.p, box = $('#vsum'); if (!box) return;
  const g = {}; D.results.forEach(x => { const k = x.name; (g[k] = g[k] || {x, n:0}).n++; });
  const L = Object.values(g).sort((a, b) => (a.x.lv || 99) - (b.x.lv || 99)), hi = D.results.filter(x => x.lv && x.lv <= 4).length;
  box.innerHTML = `<div class="vs-in"><h2>抽卡結果</h2><p class="vs-sub">共 ${D.results.length} 張${hi ? `，其中 <b>${hi}</b> 張為 4 獎（含）以上` : ''} ・ 已存入中獎倉庫</p>
    <div class="vs-grid">${L.map(({x, n}, i) => `<div class="vs-it ${x.lv && x.lv <= 2 ? 'hi' : ''}" style="animation-delay:${Math.min(i, 12) * 60}ms"><div class="vs-img">${x.img ? `<img src="${x.img}" alt="">` : ''}${n > 1 ? `<span class="vs-n">×${fmt(n)}</span>` : ''}</div>
      <span class="vs-lv">${x.lvName || ''}</span><b>${hx(x.name)}</b><span class="vs-rv">${x.rv ? '回收值 ' + fmt(x.rv) + ' CC幣' : '不可回收'}</span></div>`).join('')}</div>
    <dl class="vs-stub"><dt>交易編號</dt><dd class="num">${D.txn}</dd><dt>賞池</dt><dd>${hx(p.title)}</dd>${D.paid != null ? `<dt>扣款</dt><dd class="num">${fmt(D.paid)} CC幣</dd>` : ''}<dt>時間</dt><dd class="num">${twNow()}</dd></dl>
    <div class="acts"><button class="btn" type="button" data-act="close-stage">再抽一次</button><a class="btn gold" href="#/warehouse" data-act="close-stage">${ic('box')}前往中獎倉庫</a></div></div>`;
  box.hidden = false; requestAnimationFrame(() => box.classList.add('show')); setTimeout(() => { const b = $('.acts .btn', box); b && b.focus(); }, 60); }
document.addEventListener('click', e => { const el = e.target.closest('[data-act="vskip"]'); if (!el) return; const st = $('#stage'); st && st._end && st._end(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && D && D.video && !$('#vsum:not([hidden])')){ const st = $('#stage'); st && st._end && st._end(); } });
document.head.insertAdjacentHTML('beforeend', `<style>
.vstage{position:fixed;inset:0;z-index:200;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.vstage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.vstage .vblack{position:absolute;inset:0;background:#000;opacity:0;transition:opacity .7s ease;pointer-events:none}
.vstage.dark .vblack{opacity:1}
.vskip{position:absolute;right:16px;top:16px;z-index:3;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:4px;background:rgba(0,0,0,.55)}
.vsum{position:absolute;inset:0;z-index:4;overflow:auto;padding:32px 16px;opacity:0;transition:opacity .5s ease;display:flex;justify-content:center}
.vsum.show{opacity:1}
.vs-in{width:min(960px,100%);display:flex;flex-direction:column;align-items:center;gap:16px;margin:auto 0}
.vs-in h2{margin:0;font-family:var(--serif-tc);font-size:28px;line-height:36px;color:var(--gold-2);text-align:center}
.vs-sub{margin:0;text-align:center;color:var(--tx-2);font-size:14px;line-height:20px}
.vs-sub b{color:var(--gold-2)}
.vs-grid{width:100%;display:flex;flex-wrap:wrap;justify-content:center;gap:16px}
.vs-grid .vs-it{width:136px}
.vs-it{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;animation:vsIn .45s cubic-bezier(.2,.8,.2,1) both}
.vs-img{position:relative;width:100%;aspect-ratio:1/1;border-radius:12px;background:#fff;overflow:hidden;display:flex;align-items:center;justify-content:center;border:1px solid var(--line)}
.vs-img img{width:100%;height:100%;object-fit:contain;display:block}
.vs-it.hi .vs-img{border-color:var(--gold-2);box-shadow:0 0 0 2px rgba(201,164,92,.35),0 0 32px rgba(230,199,127,.35)}
.vs-n{position:absolute;right:6px;bottom:6px;display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:24px;padding:0 8px;border-radius:999px;background:rgba(11,11,12,.85);color:#fff;font-size:12px;font-weight:700;line-height:1}
.vs-lv{display:inline-flex;align-items:center;justify-content:center;height:20px;padding:0 8px;border-radius:999px;background:rgba(201,164,92,.16);color:var(--gold-2);font-size:11px;font-weight:700;line-height:1}
.vs-it b{font-size:13px;line-height:18px}
.vs-rv{font-size:11px;line-height:16px;color:var(--gold-2)}
.vs-stub{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:8px 0 0;padding:16px;border:1px solid var(--line);border-radius:12px;font-size:12px;line-height:18px;width:min(480px,100%)}
.vs-stub dt{color:var(--tx-3)}
.vs-stub dd{margin:0}
.vs-in .acts{display:flex;gap:8px;width:min(480px,100%)}
.vs-in .acts .btn{flex:1;min-height:48px}
@keyframes vsIn{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
@media (max-width:599px){.vs-grid{gap:8px}.vs-grid .vs-it{width:calc((100% - 16px) / 3)}.vs-it b{font-size:12px}}
@media (prefers-reduced-motion:reduce){.vs-it{animation:none}.vsum,.vstage .vblack{transition:none}}
</style>`);
</script>
