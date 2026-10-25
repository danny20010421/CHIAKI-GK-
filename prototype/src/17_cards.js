<script>
/* =========================================================
   自製一番賞（卡牌）：航海王「世界之王」
   機率賞：4 獎（含以上）50%・一抽 200・1／10／100 抽
   抽卡演出改為播放影片 → 漸黑 → 結算畫面（不使用籤紙）
   ========================================================= */
/* 兩支抽卡影片隨機播放；最高獎項決定演出：
   影片一（光束）：白光＝小獎、紫光（原色）＝3～4 獎、彩光＝大獎／2 獎；光束約 7.4 秒出現
   影片二（擊殺怪物）：小獎在擊殺第 1 隻後結束、3～4 獎在擊殺第 2 隻後結束、大獎／2 獎看到擊殺綠色巨人 */
const GACHA_VIDS = [
  {src:'__VIDEO_gacha1__', kind:'beam', beamAt:7.4},
  {src:'__VIDEO_gacha2__', kind:'kills', stop:{low:13.9, mid:15.6}}];
const GACHA_VIDEO = GACHA_VIDS[0].src;
const gTier = res => { const b = Math.min(...res.map(x => x.lv || 99)); return b <= 2 ? 'top' : b <= 4 ? 'mid' : 'low'; };
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
quickDraw = function(n){ S.lastQd = n === 'all' ? null : +n; const p = curPool(); if (!p || p.tickets.length < BIG) return _quickDrawC(n);
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
  const vid = GACHA_VIDS[Math.floor(Math.random() * GACHA_VIDS.length)], tier = gTier(results);
  D = {p, results, i:results.length, auto:false, busy:false, done:true, video:true, tier, vid:vid.kind, packN:S.lastQd || results.length, whIds:S.wh.slice(0, results.length).filter(w => w.pool === p.id).map(w => w.id), conv:{},
    txn:'CK' + twDate().replace(/-/g,'') + '-' + String(Math.floor(Math.random()*1e6)).padStart(6,'0')};
  document.documentElement.style.overflow = 'hidden'; $('#toastRoot').innerHTML = '';
  $('#stageRoot').innerHTML = `<div class="stage vstage" id="stage" role="dialog" aria-modal="true" aria-label="抽卡演出">
    <video id="gVid" src="${vid.src}" playsinline webkit-playsinline preload="auto" aria-hidden="true"></video>
    <div class="vblack" aria-hidden="true"></div>
    <button type="button" class="btn s ghost vskip" data-act="vskip">${ic('right','width:16px;height:16px')}跳過</button>
    <span class="vff" aria-hidden="true">▶▶ 2 倍速</span><span class="vhint" aria-hidden="true">長按畫面 2 倍速</span>
    <div class="vsum" id="vsum" hidden></div></div>`;
  const v = $('#gVid'), st = $('#stage'); let ended = false, raf = 0;
  const end = () => { if (ended) return; ended = true; cancelAnimationFrame(raf); try { v.pause(); } catch(_){} st.classList.add('dark'); const sk = $('.vskip', st); if (sk) sk.remove();
    setTimeout(() => vSummary(), RM() ? 50 : 700); };
  /* 依結果調整演出：光束換色、或在對應的怪物擊殺後結束 */
  const watch = () => { if (ended) return; const t = v.currentTime;
    if (vid.kind === 'beam' && t >= vid.beamAt && !v.classList.contains('fx-on')){ v.classList.add('fx-on', tier === 'top' ? 'fx-rainbow' : tier === 'low' ? 'fx-white' : 'fx-purple'); }
    if (vid.kind === 'kills' && vid.stop[tier] && t >= vid.stop[tier]) return end();
    raf = requestAnimationFrame(watch); };
  v.addEventListener('ended', end); v.addEventListener('error', end); st._end = end;
  /* 長按影片 2 倍速，放開恢復 */
  const fast = on => { if (ended) return; v.playbackRate = on ? 2 : 1; st.classList.toggle('ff', on); };
  st.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; fast(true); });
  ['pointerup','pointercancel','pointerleave'].forEach(t => st.addEventListener(t, () => fast(false)));
  st.addEventListener('contextmenu', e => e.preventDefault());
  if (RM() || !vid.src) return end();
  const p1 = v.play(); if (p1 && p1.catch) p1.catch(() => { v.muted = true; v.play().catch(end); });
  raf = requestAnimationFrame(watch);
  setTimeout(() => { if (!ended && v.paused && v.currentTime === 0) end(); }, 4000);   // 無法播放時直接進結算
};
/* 結算畫面：可直接把抽到的獎品轉成不可退款 UC幣，不用回倉庫 */
function vGroups(){ const g = {}; D.results.forEach(x => { (g[x.name] = g[x.name] || {x, n:0}).n++; }); return Object.values(g).sort((a, b) => (a.x.lv || 99) - (b.x.lv || 99)); }
function vConvTotal(){ return [...document.querySelectorAll('#vsum .vs-ck:checked:not(:disabled)')].reduce((s, c) => s + (+c.dataset.v), 0); }
function vSyncBar(){ const t = vConvTotal(), b = $('#vsConv'); if (!b) return; b.disabled = !t; b.innerHTML = `${ic('recycle','width:18px;height:18px')}<span>${t ? `轉成 UC幣 +${fmt(t)}` : '請勾選要轉換的獎品'}</span>`;
  const left = [...document.querySelectorAll('#vsum .vs-ck:not(:disabled)')]; const all = $('#vsAll'); if (all){ all.disabled = !left.length; all.textContent = left.length && left.every(c => c.checked) ? '取消全選' : '全選可轉換'; } }
function vSummary(){ if (!D || !D.video) return; const p = D.p, box = $('#vsum'); if (!box) return;
  const L = vGroups(), hi = D.results.filter(x => x.lv && x.lv <= 4).length;
  box.innerHTML = `<div class="vs-in"><h2>抽卡結果</h2><p class="vs-sub" id="vsSub">共 ${D.results.length} 張${hi ? `，其中 <b>${hi}</b> 張為 4 獎（含）以上` : ''} ・ 已存入中獎倉庫</p>
    <div class="vs-grid">${L.map(({x, n}, i) => { const done = D.conv[x.name], can = x.rv > 0 && !done, def = can && (x.lv || 99) >= 3;
      return `<label class="vs-it ${x.lv && x.lv <= 2 ? 'hi' : ''} ${done ? 'done' : ''}" style="animation-delay:${Math.min(i, 12) * 60}ms"><div class="vs-img">${x.img ? `<img src="${x.img}" alt="">` : ''}${n > 1 ? `<span class="vs-n">×${fmt(n)}</span>` : ''}
        ${x.rv > 0 && !done ? `<span class="vs-ckw"><input type="checkbox" class="vs-ck" data-k="${hx(x.name)}" data-v="${x.rv * n}" ${def ? 'checked' : ''} ${can ? '' : 'disabled'} aria-label="轉換 ${hx(x.name)} ×${n} 為 UC幣"></span>` : ''}${done ? `<span class="vs-done">已轉換</span>` : ''}</div>
        <span class="vs-lv">${x.lvName || ''}</span><b>${hx(x.name)}</b><span class="vs-rv">${done ? `+${fmt(done)} UC幣` : x.rv ? '回收值 ' + fmt(x.rv) + ' UC幣' : '不可回收'}</span></label>`; }).join('')}</div>
    ${L.some(({x}) => x.rv > 0) ? `<div class="vs-conv"><button type="button" class="btn" id="vsAll" data-act="vs-all">全選可轉換</button><button type="button" class="btn gold" id="vsConv" data-act="vs-conv"></button></div>
    <p class="vs-note">轉換後為不可退款 UC幣，可直接繼續抽；大獎與 2 獎預設不勾選，避免誤轉。目前餘額 <b class="num" id="vsBal">${fmt(S.coins)}</b> UC幣</p>` : ''}
    <dl class="vs-stub"><dt>交易編號</dt><dd class="num">${D.txn}</dd><dt>賞池</dt><dd>${hx(p.title)}</dd>${D.paid != null ? `<dt>扣款</dt><dd class="num">${fmt(D.paid)} UC幣</dd>` : ''}<dt>時間</dt><dd class="num">${twNow()}</dd></dl>
    <div class="acts"><button class="btn gold" type="button" data-act="vs-again">${ic('ticket','width:18px;height:18px')}再抽 ${D.packN} 抽</button><a class="btn" href="#/warehouse" data-act="close-stage">${ic('box')}前往中獎倉庫</a></div></div>`;
  box.hidden = false; vSyncBar(); requestAnimationFrame(() => box.classList.add('show')); setTimeout(() => { const b = $('.acts .btn', box); b && b.focus(); }, 60); }
function vConvert(){ const picks = [...document.querySelectorAll('#vsum .vs-ck:checked:not(:disabled)')].map(c => c.dataset.k); if (!picks.length) return;
  let total = 0, n = 0;
  S.wh.forEach(w => { if (D.whIds.includes(w.id) && w.st === 'stored' && w.rv > 0 && picks.includes(w.pname)){ w.st = 'recycled'; total += w.rv; n++; D.conv[w.pname] = (D.conv[w.pname] || 0) + w.rv; } });
  if (!total) return toast('這些獎品已不在倉庫中');
  S.coins += total; S.coinsNR += total; syncBal(); S.tx.unshift({t:`抽卡結算轉換 ${n} 張 → 不可退款 UC幣`, d:twNow(), a:total, ic:'recycle', nr:true});
  const keep = $('#vsum').scrollTop; vSummary(); $('#vsum').scrollTop = keep; toast(`已轉換 ${n} 張，獲得 ${fmt(total)} 不可退款 UC幣`); }
document.addEventListener('change', e => { if (e.target.classList && e.target.classList.contains('vs-ck')) vSyncBar(); });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="vs-conv"],[data-act="vs-all"],[data-act="vs-again"]'); if (!el || el.disabled || !D || !D.video) return; e.preventDefault();
  const a = el.dataset.act;
  if (a === 'vs-conv') return vConvert();
  if (a === 'vs-all'){ const L = [...document.querySelectorAll('#vsum .vs-ck:not(:disabled)')], on = !L.every(c => c.checked); L.forEach(c => c.checked = on); return vSyncBar(); }
  if (a === 'vs-again'){ const n = D.packN; closeStage(); setTimeout(() => quickDraw(n), 60); } });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="vskip"]'); if (!el) return; const st = $('#stage'); st && st._end && st._end(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && D && D.video && !$('#vsum:not([hidden])')){ const st = $('#stage'); st && st._end && st._end(); } });
document.head.insertAdjacentHTML('beforeend', `<style>
.vstage{position:fixed;inset:0;z-index:200;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.vstage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.vstage .vblack{position:absolute;inset:0;background:#000;opacity:0;transition:opacity .7s ease;pointer-events:none}
.vstage.dark .vblack{opacity:1}
.vstage{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:none}
.vff{position:absolute;left:50%;top:24px;transform:translateX(-50%);z-index:3;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 16px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;font-weight:700;line-height:1;opacity:0;transition:opacity .15s;pointer-events:none}
.vstage.ff .vff{opacity:1}
.vhint{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:3;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border-radius:999px;background:rgba(0,0,0,.45);color:rgba(255,255,255,.8);font-size:12px;line-height:1;pointer-events:none;animation:vhint 3s ease 1s forwards;opacity:0}
@keyframes vhint{0%{opacity:0}15%,75%{opacity:1}100%{opacity:0}}
.vstage.dark .vff,.vstage.dark .vhint{display:none}
.vskip{position:absolute;right:16px;top:16px;z-index:3;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:4px;background:rgba(0,0,0,.55)}
.vsum{position:absolute;inset:0;z-index:4;touch-action:pan-y;overflow:auto;padding:32px 16px;opacity:0;transition:opacity .5s ease;display:flex;justify-content:center}
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
.vstage video.fx-white{filter:saturate(0) brightness(1.35) contrast(1.05);transition:filter .35s ease}
.vstage video.fx-rainbow{animation:fxRain 1.2s linear infinite}
@keyframes fxRain{from{filter:hue-rotate(0deg) saturate(1.8) brightness(1.1)}to{filter:hue-rotate(360deg) saturate(1.8) brightness(1.1)}}
label.vs-it{cursor:pointer}
.vs-ckw{position:absolute;left:6px;top:6px;width:32px;height:32px;border-radius:8px;background:rgba(11,11,12,.75);display:flex;align-items:center;justify-content:center}
.vs-ck{width:18px;height:18px;margin:0;accent-color:var(--gold-2);cursor:pointer}
.vs-it:has(.vs-ck:checked) .vs-img{border-color:var(--gold-2);box-shadow:0 0 0 2px rgba(201,164,92,.45)}
.vs-it.done .vs-img img{opacity:.35;filter:grayscale(1)}
.vs-done{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#1a1408}
.vs-done::before{content:"";position:absolute;width:72px;height:32px;border-radius:999px;background:var(--gold-2);z-index:-1}
.vs-conv{display:flex;gap:8px;width:min(480px,100%)}
.vs-conv .btn{min-height:48px;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:normal;text-align:center}
.vs-conv .btn svg{flex:none}
.vs-conv .btn:first-child{flex:0 0 auto;padding:0 16px}
.vs-conv .btn.gold{flex:1}
.vs-note{margin:0;text-align:center;font-size:12px;line-height:18px;color:var(--tx-2);width:min(480px,100%)}
.vs-note b{color:var(--gold-2)}
.vs-in .acts .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px}
@keyframes vsIn{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
@media (max-width:599px){.vs-grid{gap:8px}.vs-grid .vs-it{width:calc((100% - 16px) / 3)}.vs-it b{font-size:12px}}
@media (prefers-reduced-motion:reduce){.vs-it{animation:none}.vsum,.vstage .vblack{transition:none}}
</style>`);
</script>
