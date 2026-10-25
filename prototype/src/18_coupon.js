<script>
/* =========================================================
   抽賞付款時使用優惠券折抵；VIP 禮與優惠券發放時通知會員
   ========================================================= */
const cpDisc = (c, sub) => c.kind === 'pct' ? Math.floor(sub * c.val / 100) : Math.min(c.val, sub);
function cpOptions(sub){ return myCoupons().map(c => { const why = todayTW() > c.exp ? '已過期' : c.min && sub < c.min ? `滿 ${fmt(c.min)} 可用` : '';
  return {c, ok:!why, why, d:why ? 0 : cpDisc(c, sub)}; }).sort((a, b) => b.d - a.d); }
const cpPick = sub => { const L = cpOptions(sub); if (S.cpSel === '') return null; const k = S.cpSel && L.find(o => o.ok && o.c.code === S.cpSel); return k || L.find(o => o.ok) || null; };

const _buyDialogCp = buyDialog;
buyDialog = function(){ _buyDialogCp(); const box = $('#modalRoot .dlg'); if (!box || !$('[data-act="confirm-buy"], a[href="#/wallet"]', box)) return; cpRender(); };
function cpRender(){ const box = $('#modalRoot .dlg'), p = curPool(); if (!box || !p) return;
  const sub = S.sel.length * p.price, L = cpOptions(sub), o = cpPick(sub), d = o ? o.d : 0, pay = sub - d, after = S.coins - pay;
  box.querySelectorAll('.cp-off').forEach(x => x.remove());
  const rows = [...box.querySelectorAll('.sumrow')], row = rows.find(r => /優惠券/.test(r.firstElementChild && r.firstElementChild.textContent));
  if (row) row.outerHTML = `<div class="sumrow cp-row"><label class="muted" for="cpSel">優惠券</label>
    ${L.length ? `<select class="input cp-sel" id="cpSel" data-act="cp-sel">${L.map(x => `<option value="${x.c.code}" ${o && o.c.code === x.c.code ? 'selected' : ''} ${x.ok ? '' : 'disabled'}>${hx(x.c.d)}${x.ok ? `（−${fmt(x.d)}）` : `・${x.why}`}</option>`).join('')}<option value="" ${o ? '' : 'selected'}>不使用優惠券</option></select>` : '<b class="dim">沒有可用的優惠券</b>'}</div>
    ${d ? `<div class="sumrow cp-off"><span class="muted">優惠折抵</span><b>−${fmt(d)} UC幣</b></div>` : ''}`;
  const R = [...box.querySelectorAll('.sumrow')];
  const payRow = R.find(r => /^應付/.test(r.textContent.trim())), afterRow = R.find(r => /扣款後餘額/.test(r.textContent));
  if (payRow) payRow.lastElementChild.innerHTML = d ? `<s class="dim cp-was">${fmt(sub)}</s>${fmt(pay)} UC幣` : `${fmt(pay)} UC幣`;
  if (afterRow){ const b = afterRow.lastElementChild; b.textContent = `${fmt(after)} UC幣`; b.className = after < 0 ? '' : 'muted'; b.style.color = after < 0 ? 'var(--bad)' : ''; }
  const cta = box.querySelector('[data-act="confirm-buy"], a.btn[href="#/wallet"]');
  if (cta && after >= 0 && cta.tagName === 'A') cta.outerHTML = `<button class="btn gold block" data-act="confirm-buy">${ic('ticket')}確認付款並抽賞</button>`;
  else if (cta && after < 0 && cta.tagName === 'BUTTON') cta.outerHTML = `<a class="btn gold block" href="#/wallet" data-act="close-modal">餘額不足，前往儲值</a>`; }
document.addEventListener('change', e => { if (e.target.id !== 'cpSel') return; S.cpSel = e.target.value; cpRender(); });

const _confirmBuyCp = confirmBuy;
confirmBuy = function(){ const p = curPool(); if (!p) return _confirmBuyCp();
  const sub = S.sel.length * p.price, o = cpPick(sub), d = o ? o.d : 0; if (!d) return _confirmBuyCp();
  const c0 = S.coins, nr0 = S.coinsNR, spend0 = S.vip ? S.vip.spend : 0;
  S.coins += d;                                   // 先墊入折抵額，原流程扣全額後實付＝小計－折抵
  _confirmBuyCp();
  if (S.coins === c0 + d){ S.coins = c0; syncBal(); return; }   // 未成交（鎖籤失效、未勾規則…），撤回
  S.coinsNR = Math.max(0, nr0 - (sub - d)); syncBal();
  if (S.vip) S.vip.spend = Math.max(spend0, S.vip.spend - d);   // VIP 累計以實付計
  const c = o.c; c.used = (c.used || 0) + 1; S.myCoupons = (S.myCoupons || []).filter(k => k !== c.code); S.cpSel = null;
  S.tx.unshift({t:`優惠券折抵 ・ ${c.d}`, d:twNow(), a:d, ic:'gift'});
  if (D) D.paid = sub - d; };

/* ---------- 通知：VIP 升級禮、生日禮、優惠券發放 ---------- */
function notify(t, ic2){ S.notifs = S.notifs || []; S.notifs.unshift({t, d:'剛剛', ic:ic2 || 'bell', unread:true}); bellSync(); }
const bellN = () => (S.notifs || []).filter(n => n.unread).length;
function bellSync(){ const n = bellN(); $$('[data-bell]').forEach(b => { b.textContent = n > 99 ? '99+' : n; b.hidden = !n; }); }
const _vipAdd = vipAddSpend;
vipAddSpend = function(v){ const before = vipLv(), got0 = S.vip.got.slice(); _vipAdd(v); const after = vipLv();
  for (let l = before + 1; l <= after; l++) if (!got0.includes(l) && vipT(l).gift) notify(`恭喜升級 VIP ${l} ${vipT(l).n}，升級禮 ${fmt(vipT(l).gift)} 不可退款 UC幣已入帳`, 'crown');
  if (after > before && vipT(after).cp && vipT(after).cp !== '—') notify(`VIP ${after} 每月優惠券（${vipT(after).cp}）將於每月 1 日發放`, 'gift'); };
/* 領取優惠碼時也通知 */
document.addEventListener('click', e => { const el = e.target.closest('[data-act="promo"]'); if (!el) return; const n0 = (S.myCoupons || []).length;
  setTimeout(() => { if ((S.myCoupons || []).length > n0){ const c = myCoupons()[myCoupons().length - 1]; if (c) notify(`已領取優惠券「${c.d}」，抽賞付款時可直接折抵`, 'gift'); } }, 0); }, true);
/* 會員中心的通知列表標示未讀；進入後清除 */
const _meCp = routes.me, _meCpA = routes.me.after;
routes.me = r => _meCp(r).replace(/<div class="tx"><span class="ic">/g, '<div class="tx"><span class="ic">');
routes.me.after = r => { if (_meCpA) _meCpA(r); const L = $$('#me-notify .tx'); (S.notifs || []).forEach((n, i) => { if (n.unread && L[i]) L[i].classList.add('unread'); });
  setTimeout(() => { (S.notifs || []).forEach(n => n.unread = false); bellSync(); }, 1500); };
/* 底部「我的」與頂部頭像加上未讀數 */
addEventListener('load', () => { const t = document.querySelector('.tabbar a[href="#/me"]'); if (t && !t.querySelector('[data-bell]')) t.insertAdjacentHTML('beforeend', '<span class="bell-n" data-bell hidden></span>');
  const a = document.querySelector('#nav a[href="#/me"]'); if (a && !a.querySelector('[data-bell]')) a.insertAdjacentHTML('beforeend', '<span class="bell-n" data-bell hidden></span>'); bellSync(); });

document.head.insertAdjacentHTML('beforeend', `<style>
.cp-row{gap:16px}
.cp-row label{flex:none}
.cp-sel{flex:1;min-width:0;max-width:70%;height:40px;padding:0 32px 0 12px;font-size:13px;text-align:left}
.cp-off b{color:var(--ok,#3ecf8e)}
.cp-was{font-size:14px;font-weight:400;margin-right:8px}
.tx.unread{background:rgba(201,164,92,.08);border-radius:8px}
.tabbar a,#nav a[href="#/me"]{position:relative}
.bell-n{position:absolute;top:4px;left:calc(50% + 8px);min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:var(--bad,#e5484d);color:#fff;font-size:11px;font-weight:700;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.bell-n[hidden]{display:none}
#nav a[href="#/me"] .bell-n{top:-4px;left:auto;right:-6px}
</style>`);
</script>
