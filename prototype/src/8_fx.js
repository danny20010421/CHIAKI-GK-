<script>
/* =========================================================
   SOUND — synthesised with Web Audio (no files to load).
   Paper rustle while peeling, rising cue tones that stop at the
   real tier, heartbeat on the big pause, tiered reveal fanfares.
   ========================================================= */
const SFX = {
  ctx: null, master: null, lastTick: 0,
  on: (() => { try { return localStorage.getItem('ck_sfx') !== '0'; } catch(_) { return true; } })(),
  ensure(){
    if (!this.on) return null;
    try {
      if (!this.ctx){ const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
        this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = .55; this.master.connect(this.ctx.destination); }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch(_) { return null; }
  },
  toggle(){ this.on = !this.on; try { localStorage.setItem('ck_sfx', this.on ? '1' : '0'); } catch(_){} if (this.on){ this.ensure(); this.chime(); } return this.on; },
  tone(f, d, o = {}){
    const c = this.ensure(); if (!c) return; const t = c.currentTime + (o.at || 0);
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(f, t); if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || .2, t + (o.a || .01)); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(g); g.connect(this.master); osc.start(t); osc.stop(t + d + .05);
  },
  noise(d, o = {}){
    const c = this.ensure(); if (!c) return; const t = c.currentTime + (o.at || 0);
    const len = Math.max(1, Math.floor(c.sampleRate * d)), buf = c.createBuffer(1, len, c.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (o.crackle ? (Math.random() < .08 ? 1 : .25) : 1);
    const src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; bp.type = 'bandpass'; bp.frequency.setValueAtTime(o.f || 2400, t); if (o.to) bp.frequency.exponentialRampToValueAtTime(o.to, t + d); bp.Q.value = o.q || .8;
    g.gain.setValueAtTime(o.vol || .25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(bp); bp.connect(g); g.connect(this.master); src.start(t);
  },
  enter(){ this.noise(.35, {f:600, to:2600, vol:.12}); this.tone(90, .25, {vol:.25, type:'sine', to:60}); },
  peel(){ const now = performance.now(); if (now - this.lastTick < 45) return; this.lastTick = now; this.noise(.06, {f:3200 + Math.random()*1800, vol:.18, crackle:true, q:1.4}); },
  tear(){ this.noise(.28, {f:1800, to:5200, vol:.32, crackle:true}); this.tone(140, .16, {vol:.18, to:80}); },
  cue(t){ const scale = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    for (let k = 0; k <= t; k++) this.tone(scale[k], .22, {type:'triangle', vol:.12 + k*.03, at:k*.07});
    if (t >= 2) this.tone(55, .35, {vol:.35, to:40, at:.05}); },
  heartbeat(n = 2){ for (let k = 0; k < n; k++){ this.tone(60, .18, {vol:.45, at:k*.45, to:45}); this.tone(55, .16, {vol:.35, at:k*.45 + .18, to:42}); } },
  reveal(t){
    if (t <= 0){ this.tone(880, .18, {type:'triangle', vol:.12}); this.tone(1320, .22, {type:'sine', vol:.06, at:.05}); return; }
    if (t === 1){ [1046.5, 1568].forEach((f,i) => this.tone(f, .5, {type:'triangle', vol:.14, at:i*.06})); return; }
    if (t === 2){ [523.25, 659.25, 783.99, 1046.5].forEach((f,i) => this.tone(f, .9, {type:'triangle', vol:.13, at:i*.07})); return; }
    // 3 = 大獎 / A賞, 4 = 確定 / 最後賞: fanfare + shimmer
    const fan = t === 4 ? [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98, 2093] : [523.25, 659.25, 783.99, 1046.5, 1318.5];
    fan.forEach((f,i) => this.tone(f, 1.2, {type:'sawtooth', vol:.06, at:i*.08}));
    fan.forEach((f,i) => this.tone(f*2, 1.4, {type:'sine', vol:.05, at:.5 + i*.05}));
    this.noise(1.2, {f:7000, vol:.06, at:.4});
    this.tone(65, .6, {vol:.4, to:40});
  },
  chime(){ [1318.5, 1760].forEach((f,i) => this.tone(f, .6, {type:'sine', vol:.08, at:i*.09})); }
};

/* ---------- hook sound + win glow into the draw stage ---------- */
(() => {
  const wrap = (name, before, after) => { const orig = window[name]; window[name] = function(...a){ before && before.apply(this, a); const r = orig.apply(this, a); after && after.apply(this, a); return r; }; };
  wrap('runDraw', () => SFX.ensure(), () => {
    const tl = $('#stage .top .tl'); if (!tl) return;
    const b = document.createElement('span'); b.innerHTML = `<button class="btn s ghost" data-act="x-sfx" aria-pressed="${SFX.on}" aria-label="音效${SFX.on ? '開' : '關'}">${ic(SFX.on ? 'sound' : 'mute','width:16px;height:16px')}<span class="lbl">音效${SFX.on ? '開' : '關'}</span></button>`;
    tl.appendChild(b.firstChild);
  });
  wrap('nextTicket', null, () => SFX.enter());
  wrap('setPeel', null, f => { if (f > 1 && f < 49 && D && !D.done) SFX.peel(); });
  wrap('cueFx', null, t => SFX.cue(t));
  wrap('showSummary', null, () => SFX.chime());
  const origFinish = window.finishPeel;
  window.finishPeel = async function(){
    if (!D || D.done) return origFinish();
    const r = D.results[D.i], t = r.tier;
    SFX.tear(); setTimeout(() => SFX.reveal(t), 200);
    const out = await origFinish();
    const tx = $('#tix'); if (tx && t >= 1){ tx.classList.add('win', 'win-t' + t); if (!$('.halo', tx)){ const h = document.createElement('div'); h.className = 'halo'; tx.prepend(h); }
      if (t >= 3 && !RM()) fx.sparkle(tx.getBoundingClientRect(), 2600); }
    return out;
  };
  // the big pause (溜め) gets a heartbeat
  const origAuto = window.autoPeel;
  window.autoPeel = async function(){ if (D && !D.done && !D.busy && D.results[D.i].tier >= 3) setTimeout(() => SFX.heartbeat(2), 1400); return origAuto(); };
})();
fx.sparkle = function(rc, ms){
  const end = performance.now() + ms, self = this;
  const spawn = () => { if (performance.now() > end || !self.ctx) return;
    for (let k = 0; k < 3; k++){ const side = Math.random() * 4 | 0;
      const x = side === 0 ? rc.left + Math.random()*rc.width : side === 1 ? rc.right : side === 2 ? rc.left + Math.random()*rc.width : rc.left;
      const y = side === 0 ? rc.top : side === 1 ? rc.top + Math.random()*rc.height : side === 2 ? rc.bottom : rc.top + Math.random()*rc.height;
      self.ps.push({x, y, vx:(Math.random()-.5)*1.2, vy:-Math.random()*1.4, g:-.01, r:1.5+Math.random()*2.5, c:['#fff6d6','#e6c77f','#ffffff'][k], life:1, dec:.018, dot:true}); }
    if (!self.raf) self.loop();
    setTimeout(spawn, 60); };
  spawn();
};
IP.sound = '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>';
IP.mute = '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>';
document.addEventListener('click', e => { const b = e.target.closest('[data-act="x-sfx"]'); if (!b) return;
  const on = SFX.toggle(); b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', '音效' + (on ? '開' : '關')); b.innerHTML = `${ic(on ? 'sound' : 'mute','width:16px;height:16px')}<span class="lbl">音效${on ? '開' : '關'}</span>`; });
</script>
