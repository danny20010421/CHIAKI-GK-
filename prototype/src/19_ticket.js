<script>
/* =========================================================
   籤紙 v3：
   ・內頁（撕開後）：文字全部限制在內框內（CHIAKI／籤號／賞別／獎品名）
   ・封面：外框以內可以撕，外框以外固定不動；「CHIAKI 一番賞」與「請從此處撕開兌獎」在外框內垂直水平置中
   ・撕動時有輕微「喀喀喀」紙張撕裂聲
   ========================================================= */
/* 內頁外框（圖 1），viewBox 300×204 */
/* 封面可撕範圍外框（圖 2） */
const KF_CV = 'M 23 17 L 37.5 11.5 L 56.5 11.5 L 69 15 L 82 11.5 L 107 11.5 L 120 15 L 133 11.5 L 158 11.5 L 171 15 L 184 11.5 L 209 11.5 L 222 15 L 235 11.5 L 260 11.5 L 267 14 L 280 28.5 L 280 54 L 291 67 L 291 82 L 296 86 L 296 108 L 291 112.5 L 291 126.5 L 280 139 L 280 166 L 266 183 L 260 185.5 L 235 185.5 L 222 182 L 209 185.5 L 184 185.5 L 171 182 L 158 185.5 L 133 185.5 L 120 182 L 107 185.5 L 82 185.5 L 69 182 L 56.5 185.5 L 31 185.5 L 28 184.5 L 19.5 177 L 18 160 L 15.6 153 L 15.6 111.5 L 25 98.4 L 15.6 85.7 L 15.6 31 Z';
const KF_IN = KF_CV;   // 內頁與封面共用同一個外框，上下左右完全重合
/* 實際畫出的框線：左上角留一段開口當撕口 */
const KF_LINE = 'M 56.5 11.5 L 69 15 L 82 11.5 L 107 11.5 L 120 15 L 133 11.5 L 158 11.5 L 171 15 L 184 11.5 L 209 11.5 L 222 15 L 235 11.5 L 260 11.5 L 267 14 L 280 28.5 L 280 54 L 291 67 L 291 82 L 296 86 L 296 108 L 291 112.5 L 291 126.5 L 280 139 L 280 166 L 266 183 L 260 185.5 L 235 185.5 L 222 182 L 209 185.5 L 184 185.5 L 171 182 L 158 185.5 L 133 185.5 L 120 182 L 107 185.5 L 82 185.5 L 69 182 L 56.5 185.5 L 31 185.5 L 28 184.5 L 19.5 177 L 18 160 L 15.6 153 L 15.6 111.5 L 25 98.4 L 15.6 85.7 L 15.6 31 L 23 17 L 37.5 11.5 L 56.5 11.5 L 69 15 L 82 11.5 L 107 11.5 L 120 15 L 133 11.5 L 158 11.5 L 171 15 L 184 11.5 L 209 11.5 L 222 15 L 235 11.5 L 260 11.5 L 267 14 L 280 28.5 L 280 54 L 291 67 L 291 82 L 296 86 L 296 108 L 291 112.5 L 291 126.5 L 280 139 L 280 166 L 266 183 L 260 185.5 L 235 185.5 L 222 182 L 209 185.5 L 184 185.5 L 171 182 L 158 185.5 L 133 185.5 L 120 182 L 107 185.5 L 82 185.5 L 69 182 L 56.5 185.5 L 31 185.5 L 28 184.5 L 19.5 177 L 18 160 L 15.6 153 L 15.6 111.5 L 25 98.4 L 15.6 85.7 L 15.6 31';
const KF_DASH = 'stroke-dasharray="4.5 2.5"';
const KF_ARROW = 'M 7 98.4 H 19.5 M 16.5 95.4 L 19.5 98.4 L 16.5 101.4';
/* 封面框的左右邊界（撕開比例換算用） */
const KF_X0 = 15.6 / 300, KF_X1 = 296 / 300;

function kujiBg(id){ return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#524c49"/><stop offset=".55" stop-color="#47423f"/><stop offset="1" stop-color="#3c3735"/></linearGradient>
  <pattern id="${id}n" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".35" fill="rgba(255,255,255,.05)"/></pattern></defs>`; }
function kujiCoverText(){
  const vt = [...'請從此處撕開兌獎'].map((c, i) => `<text x="41" y="${51.5 + i * 14.5}" text-anchor="middle" font-size="11" font-weight="700" fill="#3d3836" font-family="Noto Serif TC,Noto Serif CJK TC,serif">${c}</text>`).join('');
  return `<rect x="31" y="30.5" width="20" height="136" rx="10" fill="#f4f1ec"/>${vt}
    <text x="148" y="96.7" text-anchor="middle" font-family="Noto Serif TC,Noto Serif CJK TC,serif" font-weight="700" font-size="24" letter-spacing="1" fill="#f2eee8">CHIAKI</text>
    <text x="148" y="122.7" text-anchor="middle" font-family="Noto Serif TC,Noto Serif CJK TC,serif" font-weight="700" font-size="18" letter-spacing="4" fill="#d9d2c8">一番賞</text>`; }
/* 完整封面（首頁背景、籤紙預覽用） */
kujiCover = function(){ const id = 'kc' + (++_kid);
  return `<svg viewBox="0 0 300 204" role="img" aria-label="CHIAKI 一番賞 籤紙封面">${kujiBg(id)}
    <rect width="300" height="204" fill="url(#${id})"/><rect width="300" height="204" fill="url(#${id}n)"/>
    <path d="${KF_LINE}" fill="none" stroke="rgba(215,223,224,.7)" stroke-width="1.2" stroke-linejoin="round" ${KF_DASH}/>
    <path d="${KF_ARROW}" fill="none" stroke="rgba(215,223,224,.75)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    ${kujiCoverText()}</svg>`; };
/* 撕籤用的兩層：外框以外固定不動、外框以內可撕 */
function kujiCoverStatic(){ const id = 'ks' + (++_kid);
  return `<svg viewBox="0 0 300 204" aria-hidden="true">${kujiBg(id)}<defs><mask id="${id}m"><rect width="300" height="204" fill="#fff"/><path d="${KF_CV}" fill="#000"/></mask></defs>
    <g mask="url(#${id}m)"><rect width="300" height="204" fill="url(#${id})"/><rect width="300" height="204" fill="url(#${id}n)"/></g>
    <path d="${KF_LINE}" fill="none" stroke="rgba(215,223,224,.7)" stroke-width="1.2" stroke-linejoin="round" ${KF_DASH}/>
    <path d="${KF_ARROW}" fill="none" stroke="rgba(215,223,224,.75)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function kujiCoverTear(){ const id = 'kt' + (++_kid);
  return `<svg viewBox="0 0 300 204" aria-hidden="true">${kujiBg(id)}<defs><clipPath id="${id}c"><path d="${KF_CV}"/></clipPath></defs>
    <g clip-path="url(#${id}c)"><rect width="300" height="204" fill="url(#${id})"/><rect width="300" height="204" fill="url(#${id}n)"/>${kujiCoverText()}</g></svg>`; }

/* 文字寬度估算（中日文＝1 字寬，英數＝0.6 字寬）與換行 */
const kW = (s, fs) => [...s].reduce((w, c) => w + (/[ -~]/.test(c) ? .6 : 1) * fs, 0);
function kWrap(s, maxW, maxLines, sizes){
  for (const fs of sizes){ const lines = []; let cur = '';
    for (const ch of [...s]){ if (kW(cur + ch, fs) > maxW && cur){ const sp = cur.lastIndexOf(' '); if (sp > 0 && /[ -~]/.test(ch)){ lines.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch; } else { lines.push(cur); cur = ch.trim(); } } else cur += ch; }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines){
      if (lines.length === 2){ const all = [...s]; let best = null;
        for (let i = 1; i < all.length; i++){ const a = all.slice(0, i).join('').trim(), b = all.slice(i).join('').trim(); const wa = kW(a, fs), wb = kW(b, fs); if (wa > maxW || wb > maxW || !a || !b) continue;
          const brk = /[\s（(＋+・、，]/.test(all[i]) || /[\s）)、，]/.test(all[i - 1]) ? 0 : (/[\u0020-\u007e]/.test(all[i - 1]) && /[\u0020-\u007e]/.test(all[i]) ? 9e3 : fs * .8);
          const cost = Math.max(wa, wb) + brk; if (!best || cost < best.c) best = {c:cost, l:[a, b]}; }
        if (best) return {fs, lines:best.l}; }
      return {fs, lines}; } }
  const fs = sizes[sizes.length - 1], out = []; let cur = '';
  for (const ch of [...s]){ if (kW(cur + ch + '…', fs) > maxW){ out.push(cur); cur = ch; if (out.length === maxLines) break; } else cur += ch; }
  if (out.length < maxLines && cur) out.push(cur); out[maxLines - 1] = out[maxLines - 1].replace(/.$/, '…'); return {fs, lines:out.slice(0, maxLines)}; }

/* 內頁：所有文字在內框安全區（x 34–266、y 26–180）內 */
kujiInner = function(r, opts = {}){ const id = 'ki' + (++_kid);
  const t = r.tier != null ? r.tier : (r.rk ? RK[r.rk].tier : 0), foil = TIER[t].foil, rainbow = foil === 'rainbow';
  const fill = t >= 1 ? `url(#${id}g)` : '#f4f6f6', stroke = rainbow ? `url(#${id}r)` : (t >= 1 ? foil : 'rgba(215,223,224,.75)');
  const lm = (r.lvName || '').match(/^([A-Z])賞$/), serif = 'Noto Serif TC,Noto Serif CJK TC,serif';
  let grade;
  if (r.rk === 'LAST') grade = `<text x="150" y="114" text-anchor="middle" font-family="${serif}" font-weight="700" font-size="34" letter-spacing="2" fill="${fill}">最後賞</text>`;
  else if (lm || (!r.custom && r.rk && RK[r.rk] && r.rk !== 'P')){ const L = lm ? lm[1] : r.rk;
    grade = `<text x="150" y="118" text-anchor="middle" fill="${fill}" font-weight="700"><tspan font-family="Cormorant Garamond,Noto Serif TC,serif" font-size="58">${L}</tspan><tspan font-family="${serif}" font-size="18" dx="3">賞</tspan></text>`; }
  else { const g = r.rk === 'P' ? '參加獎' : lvLabel(r) || ''; const fs = kW(g, 34) > 200 ? 26 : 34;
    grade = `<text x="150" y="114" text-anchor="middle" font-family="${serif}" font-weight="700" font-size="${fs}" letter-spacing="2" fill="${fill}">${hx(g)}</text>`; }
  const name = (r.name || opts.foot || '').trim();
  const nm = name ? kWrap(name, 212, 2, [15, 14, 13, 12, 11]) : {fs:0, lines:[]};
  const ny = nm.lines.length > 1 ? [150, 150 + nm.fs + 4] : [158];
  const nameSvg = nm.lines.map((l, k) => `<text x="150" y="${ny[k]}" text-anchor="middle" font-family="${serif}" font-weight="700" font-size="${nm.fs}" letter-spacing="1" fill="${t >= 2 && !rainbow ? foil : '#f4f6f6'}">${hx(l)}</text>`).join('');
  const sub = (opts.sub || (r.no ? 'No.' + pad(r.no) : '')).toString();
  const subFs = kW(sub, 9.5) > 212 ? 8 : 9.5;
  return `<svg viewBox="0 0 300 204" role="img" aria-label="${hx(labelOf(r))}${name ? ' ' + hx(name) : ''}">
    <defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">${rainbow
        ? '<stop offset="0" stop-color="#ffe1f0"/><stop offset=".5" stop-color="#ffd56b"/><stop offset="1" stop-color="#8fd3ff"/>'
        : `<stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="${foil}"/><stop offset="1" stop-color="${t>=3?'#9b7330':foil}"/>`}</linearGradient>
      <linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff8a8a"/><stop offset=".33" stop-color="#ffd56b"/><stop offset=".66" stop-color="#7fe0ff"/><stop offset="1" stop-color="#c79bff"/></linearGradient>
      <radialGradient id="${id}b" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="${t>=3?'#26363a':'#223238'}"/><stop offset="1" stop-color="#1b272b"/></radialGradient>
    </defs>
    <rect width="300" height="204" fill="url(#${id}b)"/>
    <path d="${KF_LINE}" fill="none" stroke="${stroke}" stroke-width="${t >= 2 ? 1.6 : 1.2}" stroke-linejoin="round" ${KF_DASH}/>
    <text x="150" y="44" text-anchor="middle" font-family="${serif}" font-weight="700" font-size="12" letter-spacing="2" fill="#f4f6f6">CHIAKI</text>
    <text x="150" y="60" text-anchor="middle" font-family="${serif}" font-size="${subFs}" fill="#c9d3d5">${hx(sub)}</text>
    ${grade}${nameSvg}
  </svg>`; };

/* 撕籤舞台：封面拆成固定外圍＋可撕內框；只有在外框內按下才能撕 */
const _nextTicketK = nextTicket;
nextTicket = function(){ _nextTicketK(); const tx = $('#tix'); if (!tx) return;
  const cv = $('.cover', tx); if (cv) cv.innerHTML = `<div class="cv-tear">${kujiCoverTear()}</div><div class="cv-static">${kujiCoverStatic()}</div>`;
  tx.classList.add('k3'); };
const inCoverFrame = (el, x, y) => { const r = el.getBoundingClientRect(), u = (x - r.left) / r.width * 300, v = (y - r.top) / r.height * 204;
  if (!kInFrame.p) kInFrame.p = new Path2D(KF_CV); const c = kInFrame.c || (kInFrame.c = document.createElement('canvas').getContext('2d')); return c.isPointInPath(kInFrame.p, u, v); };
function kInFrame(){}
document.addEventListener('pointerdown', e => { const tx = e.target.closest && e.target.closest('#tix.k3'); if (!tx) return;
  if (!inCoverFrame(tx, e.clientX, e.clientY)){ e.stopPropagation(); tx.classList.add('nope'); setTimeout(() => tx.classList.remove('nope'), 260); } }, true);

/* 撕紙聲：每撕開一小段發出一次很輕的「喀」 */
const TEAR = {last:0, lastT:0, buf:null};
function tearClick(strength){ if (!SFX || !SFX.on) return; const c = SFX.ensure && SFX.ensure(); if (!c) return;
  const now = performance.now(); if (now - TEAR.lastT < 28) return; TEAR.lastT = now;
  if (!TEAR.buf){ const n = Math.floor(c.sampleRate * .03), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3); TEAR.buf = b; }
  const s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain(), t0 = c.currentTime;
  s.buffer = TEAR.buf; s.playbackRate.value = .85 + Math.random() * .5;
  bp.type = 'bandpass'; bp.frequency.value = 1800 + Math.random() * 2200; bp.Q.value = 1.4;
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.18 * (strength || 1), t0 + .002); g.gain.exponentialRampToValueAtTime(.0005, t0 + .03 + Math.random() * .02);
  s.connect(bp).connect(g).connect(SFX.master || c.destination); s.start(t0); s.stop(t0 + .06); }
const _setPeelK = setPeel;
setPeel = function(f){ const prev = D ? D.f || 0 : 0; _setPeelK(f);
  if (!D || f <= prev){ TEAR.last = f; return; }
  if (f < TEAR.last) TEAR.last = f;
  while (f - TEAR.last >= 2.4){ TEAR.last += 2.4; tearClick(f >= 100 ? .6 : 1); } };

document.head.insertAdjacentHTML('beforeend', `<style>
.tix.k3 .cover{clip-path:none;overflow:visible}
.tix.k3 .cv-static,.tix.k3 .cv-tear{position:absolute;inset:0}
.tix.k3 .cv-tear{clip-path:inset(0 0 0 calc(${(KF_X0 * 100).toFixed(2)}% + var(--f,0%) * ${(KF_X1 - KF_X0).toFixed(4)}))}
.tix.k3 .cv-static{pointer-events:none}
.tix.k3 .tab-nudge{display:none}
.tix.k3 .flap{top:6%;bottom:9%;left:calc(${(KF_X0 * 100).toFixed(2)}% + var(--f,0%) * ${(KF_X1 - KF_X0).toFixed(4)});width:calc(var(--fw,0%) * ${(KF_X1 - KF_X0).toFixed(4)})}
.tix.k3 .seam{top:6%;bottom:9%;left:calc(${(KF_X0 * 100).toFixed(2)}% + var(--f,0%) * ${(KF_X1 - KF_X0).toFixed(4)})}
.tix.k3.nope{animation:kNope .26s ease}
@keyframes kNope{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
</style>`);
</script>
