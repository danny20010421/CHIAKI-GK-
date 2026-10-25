<script>
/* =========================================================
   首頁籤紙隨手機擺動晃動、點擊籤紙會被彈飛；
   賞池頁獎品縮圖自動橫向輪播
   ========================================================= */
heroFx = function(){
  const cv = $('#heroCv'), hero = $('#hero'); if (!cv) return;
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, raf = 0, vis = true, mx = 0, my = 0, tx = 0, ty = 0;
  const mob = innerWidth < 600;
  const T = [], P = [], B = []; let tilted = false;
  const rnd = (a,b) => a + Math.random()*(b-a);
  function resize(){ const d = Math.min(devicePixelRatio||1, 2); W = cv.clientWidth; H = cv.clientHeight; cv.width = W*d; cv.height = H*d; ctx.setTransform(d,0,0,d,0,0); }
  resize();
  for (let i = 0; i < (mob ? 12 : 22); i++){ const z = rnd(.25, 1); T.push({x:rnd(0,W), y:rnd(0,H), z, r:rnd(-.6,.6), vr:rnd(-.003,.003), f:rnd(0,6.28), vf:rnd(.005,.014), vy:rnd(.18,.5)*z, vx:rnd(-.1,.1), sw:rnd(0,6.28), wx:0, wy:0}); T[T.length-1].vf0 = T[T.length-1].vf; }
  for (let i = 0; i < (mob ? 50 : 110); i++) P.push({x:rnd(0,W), y:rnd(0,H), z:rnd(.2,1), t:rnd(0,6.28), vy:-rnd(.05,.25)});
  T.sort((a,b) => a.z - b.z);
  /* rasterise the real CHIAKI GK ticket (front = cover, back = teal side) once */
  const IMG = {front:null, back:null};
  const raster = (svg, key) => {
    const im = new Image();
    im.onload = () => { const c = document.createElement('canvas'); c.width = 600; c.height = 408; const g = c.getContext('2d');
      g.beginPath(); if (g.roundRect) g.roundRect(0,0,600,408,20); else g.rect(0,0,600,408); g.clip(); g.drawImage(im,0,0,600,408); IMG[key] = c; };
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  };
  /* 首頁飄落的籤紙：正面＝新版封面，背面＝撕開後的內頁樣式（同一個虛線框） */
  raster(kujiCover(), 'front');
  raster(`<svg viewBox="0 0 300 204"><rect width="300" height="204" fill="#000"/></svg>`, 'back');
  function ticket(t, sy){
    const w = 44 + 76*t.z, h = w*.68;
    const px = t.x + tx*36*t.z, py = t.y + ty*24*t.z - sy*.35*t.z;
    const flip = Math.cos(t.f), im = flip >= 0 ? IMG.front : IMG.back;
    if (!im) return;
    ctx.save(); ctx.translate(px, py); ctx.rotate(t.r + tx*.45*t.z + Math.sin(t.sw*1.7)*Math.abs(tx)*.12); ctx.scale(Math.max(.05, Math.abs(flip)), 1);
    ctx.globalAlpha = .14 + .72*t.z*t.z;
    if (t.z > .7){ ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 18*t.z; ctx.shadowOffsetY = 8*t.z; }
    ctx.drawImage(im, -w/2, -h/2, w, h);
    ctx.restore();
  }
  function frame(){
    const sy = window.scrollY;
    tx += (mx - tx)*.05; ty += (my - ty)*.05;
    ctx.clearRect(0,0,W,H);
    for (const p of P){ p.y += p.vy; p.t += .03; if (p.y < -10){ p.y = H + 10; p.x = rnd(0,W); }
      const a = (.25 + .55*Math.abs(Math.sin(p.t)))*p.z; ctx.fillStyle = `rgba(230,199,127,${a})`;
      ctx.beginPath(); ctx.arc(p.x + tx*14*p.z, p.y + ty*10*p.z - sy*.2*p.z, .6 + 1.4*p.z, 0, 6.28); ctx.fill(); }
    for (const t of T){ t.sw += .01; const dmp = t.fly ? .992 : .96; t.wx *= dmp; t.wy *= dmp; if (t.fly && !t.gone && Math.hypot(t.wx, t.wy) < 1.2) t.fly = false; t.vr *= .985; t.vf += (t.vf0 - t.vf) * .02;
      t.y += t.vy + t.wy + (tilted ? ty*.6*t.z : 0); t.x += t.vx + t.wx + Math.sin(t.sw)*.35*t.z + (tilted ? tx*1.4*t.z : 0); t.r += t.vr; t.f += t.vf;
      if (t.y > H + 120 || t.y < -260 || t.x < -160 || t.x > W + 160){ if (t.gone){ t.dead = true; } else if (t.y > H + 120){ t.y = -120; t.x = rnd(0,W); t.wx = t.wy = 0; t.fly = false; t.vr = rnd(-.003,.003); } else if (t.x < -160) t.x = W + 140; else if (t.x > W + 160) t.x = -140; }
      ticket(t, sy); }
    for (let k = T.length - 1; k >= 0; k--) if (T[k].dead) T.splice(k, 1);
    for (let k = B.length - 1; k >= 0; k--){ const b = B[k]; b.x += b.vx; b.y += b.vy; b.vy += .12; b.l -= .025; if (b.l <= 0){ B.splice(k, 1); continue; } ctx.fillStyle = `rgba(240,212,140,${b.l})`; ctx.beginPath(); ctx.arc(b.x, b.y, 1 + 2*b.l, 0, 6.28); ctx.fill(); }
    const logo = $('#heroLogo');
    if (logo){ logo.parentElement.style.transform = `translate3d(0,${sy*.25}px,0)`; logo.parentElement.style.opacity = Math.max(0, 1 - sy/(H*.7)); }  // keep logo + tagline centred: no horizontal parallax
    if (vis && !RM()) raf = requestAnimationFrame(frame);
  }
  /* wind: pointer movement pushes nearby tickets and turns them; phone shake throws them around */
  let lpx = null, lpy = null;
  const gust = (x, y, vx, vy, radius) => { for (const t of T){ const dx = t.x - x, dy = t.y - y, d = Math.hypot(dx, dy);
      if (d < radius){ const f = (1 - d/radius) * t.z; t.wx += vx * f * .06; t.wy += vy * f * .06; t.vr += (vx * dy - vy * dx) / (radius*radius) * f * .002; t.vf += Math.min(.08, Math.hypot(vx,vy) * f * .0008); } } };
  const onMove = e => { mx = (e.clientX / innerWidth - .5)*2; my = (e.clientY / innerHeight - .5)*2;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (lpx != null && y >= 0 && y <= r.height) gust(x, y, x - lpx, y - lpy, 220);
    lpx = x; lpy = y; };
  const onShake = e => { const a = e.accelerationIncludingGravity || e.acceleration; if (!a) return;
    const ax = a.x || 0, ay = a.y || 0, last = onShake.l || {x:ax, y:ay}; const jx = ax - last.x, jy = ay - last.y; onShake.l = {x:ax, y:ay};
    if (Math.hypot(jx, jy) > 12) for (const t of T){ t.wx += (-jx + (Math.random()-.5)*8) * .5 * t.z; t.wy += (jy + (Math.random()-.5)*8) * .5 * t.z; t.vr += (Math.random()-.5) * .04; t.vf += .05; } };
  const askMotion = () => { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') DeviceMotionEvent.requestPermission().catch(() => {}); if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().catch(() => {}); hero.removeEventListener('touchend', askMotion); };
  hero.addEventListener('touchend', askMotion, {passive:true});
  addEventListener('devicemotion', onShake, {passive:true});
  const onTilt = e => { if (e.gamma == null) return; tilted = true; mx = Math.max(-1, Math.min(1, e.gamma/30)); my = Math.max(-1, Math.min(1, (e.beta-45)/30)); };
  /* a new ticket starts falling from the top for every one that is flicked away */
  const spawn = () => { const z = rnd(.45, 1), n = {x:rnd(40, W - 40), y:-rnd(80, 160), z, r:rnd(-.6,.6), vr:rnd(-.003,.003), f:rnd(0,6.28), vf:rnd(.005,.014), vy:rnd(.18,.5)*z, vx:rnd(-.1,.1), sw:rnd(0,6.28), wx:0, wy:0}; n.vf0 = n.vf; T.push(n); T.sort((a, b) => a.z - b.z); };
  const onTap = e => { if (e.target.closest('a,button,input,label')) return; const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, sy = window.scrollY;
    for (let k = T.length - 1; k >= 0; k--){ const t = T[k], w = 44 + 76*t.z, h = w*.68, px = t.x + tx*36*t.z, py = t.y + ty*24*t.z - sy*.35*t.z;
      const c = Math.cos(-t.r), s = Math.sin(-t.r), lx = (x - px)*c - (y - py)*s, ly = (x - px)*s + (y - py)*c;
      if (Math.abs(lx) <= w/2 + 10 && Math.abs(ly) <= h/2 + 10){ const dir = lx >= 0 ? -1 : 1, sp = rnd(16, 26);
        t.fly = true; t.wx = dir*sp*(.6 + Math.random()*.6) - lx*.08; t.wy = -rnd(8, 16) - ly*.1; t.vr = dir*rnd(.12, .25); t.vf = rnd(.18, .32);
        for (let n = 0; n < 14; n++){ const a = rnd(0, 6.28), v = rnd(1.5, 4.5); B.push({x, y, vx:Math.cos(a)*v, vy:Math.sin(a)*v - 1.5, l:1}); }
        t.gone = true; spawn();
        if (navigator.vibrate) try { navigator.vibrate(12); } catch(_){}
        return; } } };
  hero.addEventListener('pointerdown', onTap); hero._T = T; hero._view = () => ({tx, ty, B:B.length});
  addEventListener('pointermove', onMove, {passive:true});
  addEventListener('deviceorientation', onTilt, {passive:true});
  addEventListener('resize', resize);
  const io = new IntersectionObserver(([e]) => { vis = e.isIntersecting; cancelAnimationFrame(raf); if (vis) raf = requestAnimationFrame(frame); });
  io.observe(hero);
  frame();
  cleanup.push(() => { cancelAnimationFrame(raf); io.disconnect(); removeEventListener('pointermove', onMove); removeEventListener('deviceorientation', onTilt); removeEventListener('devicemotion', onShake); hero.removeEventListener('touchend', askMotion); hero.removeEventListener('pointerdown', onTap); removeEventListener('resize', resize); });
};

/* 賞池頁：獎品縮圖改為自動橫向輪播（暫停：滑鼠移入／手指按住；減少動態時改為可手動滑動） */
(() => {
  const _pool = routes.pool, _after = routes.pool.after;
    routes.pool = r => { const h = _pool(r), p = poolById(r.arg); if (!p) return h;
    const i = h.indexOf('<div class="thumbs">'); if (i < 0) return h;
    const items = p.prizes.filter(pr => pr.img).map(pr => ({img:pr.img, lv:pr.lvName, n:pr.name}));
    if (p.last && p.lastImg) items.push({img:p.lastImg, lv:'最後賞', n:p.last});
    if (items.length < 2) return h;
    S.zoomList = items;
    const card = (x, i) => `<button type="button" class="mq-it" data-act="zoom" data-i="${i}" aria-label="放大查看：${x.lv} ${x.n}"><img src="${x.img}" alt="" loading="lazy"><span class="mq-lv">${x.lv}</span></button>`;
    const strip = `<div class="thumbs mq" aria-label="本賞池獎品"><div class="mq-row" style="--t:${items.length * 3.2}s">${items.map((x, i) => card(x, i)).join('')}<span class="mq-dup" aria-hidden="true">${items.map((x, i) => card(x, i).replace('<button ', '<button tabindex="-1" ')).join('')}</span></div></div>`;
    let depth = 0, k = i; while (k < h.length){ const o = h.indexOf('<div', k), c = h.indexOf('</div>', k); if (o > -1 && o < c){ depth++; k = o + 4; } else { depth--; k = c + 6; if (depth === 0) break; } }
    return h.slice(0, i) + strip + h.slice(k); };
  routes.pool.after = r => { if (_after) _after(r); const m = $('.thumbs.mq'); if (!m) return;
    const hold = () => m.classList.add('hold'), go = () => m.classList.remove('hold');
    m.addEventListener('touchstart', hold, {passive:true}); m.addEventListener('touchend', go); m.addEventListener('touchcancel', go);
    m.addEventListener('focusin', hold); m.addEventListener('focusout', go); };
  document.head.insertAdjacentHTML('beforeend', `<style>
.pd .thumbs.mq{display:block;overflow:hidden;container-type:inline-size;-webkit-mask:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);mask:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}
.mq-row{display:flex;gap:8px;width:max-content;animation:mqMove var(--t,30s) linear infinite}
.mq-dup{display:contents}
.thumbs.mq:hover .mq-row,.thumbs.mq.hold .mq-row{animation-play-state:paused}
@keyframes mqMove{to{transform:translateX(calc(-50% - 4px))}}
.mq-it{position:relative;flex:none;padding:0;cursor:pointer;font:inherit;width:96px;width:calc((100cqw - 32px) / 5);aspect-ratio:1/1;border-radius:var(--r-1);border:1px solid var(--line);background:#fff;overflow:hidden;display:flex;align-items:center;justify-content:center}
.mq-it img{width:100%;height:100%;object-fit:contain;display:block}
.mq-lv{position:absolute;left:4px;bottom:4px;display:inline-flex;align-items:center;justify-content:center;height:20px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:700;line-height:1;background:rgba(11,11,12,.78);color:var(--gold-2);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.pd .thumbs.mq{overflow-x:auto;-webkit-mask:none;mask:none}.mq-row{animation:none}.mq-dup{display:none}}
</style>`);
})();

/* 點縮圖 → 放大檢視（左右切換、滑動、Esc 關閉） */
function zoomOpen(i){ const L = S.zoomList || []; if (!L.length) return; let k = (i + L.length) % L.length, x0 = null; const back = document.activeElement;
  const root = document.createElement('div'); root.className = 'zoom'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '獎品放大檢視');
  const draw = () => { const x = L[k]; root.innerHTML = `<div class="zm-bg" data-z="close"></div>
    <figure class="zm-fig"><div class="zm-img"><img src="${x.img}" alt="${x.lv} ${x.n}"></div><figcaption><span class="mq-lv">${x.lv}</span><b>${x.n}</b><span class="dim num">${k + 1} / ${L.length}</span></figcaption></figure>
    <button type="button" class="zm-btn zm-x" data-z="close" aria-label="關閉">${ic('x','width:22px;height:22px')}</button>
    ${L.length > 1 ? `<button type="button" class="zm-btn zm-p" data-z="prev" aria-label="上一張">${ic('right','width:22px;height:22px;transform:rotate(180deg)')}</button><button type="button" class="zm-btn zm-n" data-z="next" aria-label="下一張">${ic('right','width:22px;height:22px')}</button>` : ''}`; };
  const close = () => { root.remove(); removeEventListener('keydown', key, true); document.documentElement.style.overflow = ''; back && back.focus && back.focus({preventScroll:true}); };
  const go = d => { k = (k + d + L.length) % L.length; draw(); const b = root.querySelector(d < 0 ? '.zm-p' : '.zm-n'); b && b.focus(); };
  const key = e => { if (e.key === 'Escape'){ e.preventDefault(); close(); } else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'Tab'){ const f = [...root.querySelectorAll('button')]; const a = f.indexOf(document.activeElement); if (e.shiftKey && a <= 0){ e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && a === f.length - 1){ e.preventDefault(); f[0].focus(); } } };
  root.addEventListener('click', e => { const z = e.target.closest('[data-z]'); if (!z) return; const a = z.dataset.z; if (a === 'close') close(); else go(a === 'prev' ? -1 : 1); });
  root.addEventListener('pointerdown', e => { x0 = e.clientX; });
  root.addEventListener('pointerup', e => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1); });
  draw(); document.body.appendChild(root); document.documentElement.style.overflow = 'hidden'; addEventListener('keydown', key, true); root.querySelector('.zm-x').focus(); }
document.addEventListener('click', e => { const el = e.target.closest('[data-act="zoom"]'); if (!el) return; e.preventDefault(); zoomOpen(+el.dataset.i); });
document.head.insertAdjacentHTML('beforeend', `<style>
.zoom{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:64px 16px;animation:zmIn .2s ease-out}
.zm-bg{position:absolute;inset:0;background:rgba(5,5,6,.9);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.zm-fig{position:relative;margin:0;width:min(640px,100%);display:flex;flex-direction:column;gap:16px}
.zm-img{width:100%;aspect-ratio:1/1;max-height:calc(100svh - 200px);border-radius:16px;background:#fff;overflow:hidden;display:flex;align-items:center;justify-content:center;touch-action:pan-y}
.zm-img img{width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none}
.zm-fig figcaption{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;text-align:center;font-size:14px;line-height:20px}
.zm-fig figcaption .mq-lv{position:static}
.zm-btn{position:absolute;z-index:2;width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(20,20,22,.8);color:#fff;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}
.zm-btn svg{display:block}
.zm-x{top:16px;right:16px}
.zm-p{left:max(16px,calc(50% - 400px));top:50%;transform:translateY(-50%)}
.zm-n{right:max(16px,calc(50% - 400px));top:50%;transform:translateY(-50%)}
@media (max-width:599px){.zm-p,.zm-n{top:auto;bottom:16px;transform:none}.zm-p{left:calc(50% - 56px)}.zm-n{right:calc(50% - 56px)}}
@keyframes zmIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.zoom{animation:none}}
</style>`);
</script>
