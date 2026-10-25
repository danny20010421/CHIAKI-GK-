<script>
/* =========================================================
   VIP 制度（累計抽賞消費 UC幣）＋ 每日簽到（連續簽到）
   ========================================================= */
S.vipT = [
  {lv:0, n:'新手籤', min:0,       gift:0,    bday:0,     cp:'—',                     store:0,  perks:[]},
  {lv:1, n:'銅籤',   min:3000,    gift:50,   bday:50,    cp:'95 折券 ×1',            store:0,  perks:[]},
  {lv:2, n:'銀籤',   min:30000,   gift:100,  bday:100,   cp:'95 折券 ×2',            store:0,  perks:['生日禮']},
  {lv:3, n:'金籤',   min:200000,  gift:500,  bday:500,   cp:'95 折券 ×2',            store:0,  perks:['賞池頁即時機率顯示']},
  {lv:4, n:'白金籤', min:500000,  gift:1000, bday:2000,  cp:'9 折券 ×3',             store:7,  perks:['免費保管期限 +7 天']},
  {lv:5, n:'鑽石籤', min:1000000, gift:2500, bday:5000,  cp:'85 折券 ×3＋8 折券 ×1', store:14, perks:['專屬客服','免費保管期限 +14 天']},
  {lv:6, n:'黑金籤', min:2000000, gift:5000, bday:10000, cp:'8 折券 ×3',             store:14, perks:['專屬活動與限定賞池']}
];
S.vip = {spend:13800, got:[1]};
const VIP_ODDS = 3;
const vipLv = (spend = S.vip.spend) => S.vipT.reduce((l, t) => spend >= t.min ? t.lv : l, 0);
const vipT = lv => S.vipT[lv] || S.vipT[0];
function vipCan(k){ const lv = vipLv(); return k === 'odds' ? lv >= VIP_ODDS : true; }
const vipExtraDays = () => vipT(vipLv()).store || 0;
const oddsLock = () => `<a class="odds-lock" href="#/vip" aria-label="即時機率：VIP ${VIP_ODDS} 以上可查看">${ic('lock','width:14px;height:14px')}<span>VIP ${VIP_ODDS}</span></a>`;
const vipBadge = lv => `<span class="vip-b v${lv}">${ic('crown','width:14px;height:14px')}<span>VIP ${lv}</span></span>`;
function vipNext(){ const lv = vipLv(), nx = S.vipT[lv + 1]; if (!nx) return null; const cur = vipT(lv); return {t:nx, need:nx.min - S.vip.spend, pct:Math.min(100, Math.round((S.vip.spend - cur.min) / (nx.min - cur.min) * 100))}; }

/* 消費累計 → 升級禮（跨級時每一級都發） */
function vipAddSpend(v){
  const before = vipLv(); S.vip.spend += v; const after = vipLv(); if (after <= before) return;
  let sum = 0; for (let l = before + 1; l <= after; l++){ if (S.vip.got.includes(l)) continue; S.vip.got.push(l); const g = vipT(l).gift; if (g){ sum += g; S.tx.unshift({t:`VIP ${l} ${vipT(l).n} 升級禮`, d:twNow(), a:g, ic:'crown', nr:true}); } }
  if (sum){ S.coins += sum; S.coinsNR += sum; syncBal(); }
  setTimeout(() => toast(`恭喜升級 VIP ${after} ${vipT(after).n}${sum ? `，獲得升級禮 ${fmt(sum)} 不可退款 UC幣` : ''}`), 2600);
}
const _confirmBuy = confirmBuy;
confirmBuy = function(){ const c0 = S.coins; _confirmBuy(); const paid = c0 - S.coins; if (paid > 0) vipAddSpend(paid); };

/* ---------- VIP 頁 ---------- */
routes.vip = () => { const lv = vipLv(), t = vipT(lv), nx = vipNext();
  return `<div class="wrap">
    <div class="page-h"><h1>VIP 會員制度</h1><p>依累計抽賞消費（UC幣）自動升級，升級禮與各項權益即時生效。</p></div>
    <section class="vip-hero v${lv}">
      <div class="vh-l">${vipBadge(lv)}<h2>${t.n}</h2><p>累計消費 <b class="num">${fmt(S.vip.spend)}</b> UC幣</p></div>
      <div class="vh-r">${nx ? `<div class="row between"><span>距 VIP ${nx.t.lv} ${nx.t.n}</span><b class="num">${fmt(nx.need)} UC幣</b></div>
        <div class="meter" role="progressbar" aria-label="升級進度" aria-valuenow="${nx.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${nx.pct}%"></i></div>
        <p class="dim">升級可得 ${fmt(nx.t.gift)} 不可退款 UC幣${nx.t.lv === VIP_ODDS ? '，並解鎖賞池頁即時機率顯示' : ''}</p>` : '<p>已達最高等級，感謝支持！</p>'}</div>
    </section>
    <div class="tbl-wrap" style="margin-top:32px"><table class="tbl vip-tbl"><caption class="sr">VIP 等級與權益</caption>
      <thead><tr><th>等級</th><th class="r">累計消費</th><th class="r">升級禮</th><th class="r">生日禮</th><th>每月優惠券</th><th>其他權益</th></tr></thead><tbody>
      ${S.vipT.map(v => `<tr class="${v.lv === lv ? 'hl' : ''}"><td><div class="vt-n">${vipBadge(v.lv)}<b>${v.n}</b></div></td><td class="r num">${fmt(v.min)}</td><td class="r num">${v.gift ? fmt(v.gift) : '—'}</td><td class="r num">${v.bday ? fmt(v.bday) : '—'}</td><td>${v.cp}</td><td>${v.lv > 1 ? '<span class="dim">含前一級權益＋</span>' : ''}${v.perks.join('、') || (v.lv ? '—' : '會員基本權益')}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="layout2" style="margin-top:32px">
      <div class="panel"><h3>規則說明</h3><ul class="rules">
        <li>累計消費＝抽賞實際扣款的 UC幣（可退款與不可退款皆計入），退款訂單會扣回。</li>
        <li>升級禮於達標當下自動發放；一次跨越多級時，每一級的升級禮都會發放，同一級只發一次。</li>
        <li>生日禮於生日當月發放一次；每月優惠券於每月 1 日發放。</li>
        <li>每年 1 月 1 日依過去 12 個月的消費重新評等，每年最多降一級。</li>
        <li>升級禮、生日禮皆為不可退款 UC幣，抽賞時與一般 UC幣等值使用。</li></ul></div>
      <div class="panel"><h3>已領取的升級禮</h3>${S.vip.got.length ? S.vip.got.map(l => `<div class="sumrow"><span>${vipBadge(l)} ${vipT(l).n}</span><b class="num">+${fmt(vipT(l).gift)}</b></div>`).join('') : '<p class="dim">尚未領取</p>'}</div>
    </div></div>`; };

function vipCard(){ const lv = vipLv(), nx = vipNext();
  return `<a class="vip" href="#/vip"><div class="row between"><b class="vip-t">${ic('crown','width:16px;height:16px')}<span>VIP ${lv} ・ ${vipT(lv).n}</span></b><span>${nx ? `距 VIP ${nx.t.lv} 還差 ${fmt(nx.need)}` : '最高等級'}</span></div><div class="meter"><i style="width:${nx ? nx.pct : 100}%"></i></div><span class="dim" style="font-size:11px">查看 VIP 權益與升級禮 ›</span></a>`; }

/* ---------- 每日簽到 ---------- */
const CK_REW = () => S.cfg.ckRew || [2, 2, 2, 2, 2, 2, 10];
/* 連續簽到：昨天有簽才延續，漏簽一天就從第 1 天重新開始；第 7 天後再從第 1 天循環 */
const dayAdd = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
S.authed = true;
S.checkin = {last:dayAdd(twDate(), -1), n:4};
function ckState(){ const t = twDate(), c = S.checkin;
  if (c.last === t) return {n:c.n, done:true, next:null, broken:false};
  const cont = c.last === dayAdd(t, -1), n = cont ? c.n % 7 : 0;
  return {n, done:false, next:CK_REW()[n], broken:!cont && !!c.last && c.n > 0}; }
function ckSlots(){ const st = ckState(), R = CK_REW();
  return `<ol class="ck-slots" aria-label="連續簽到進度">${R.map((r, i) => `<li class="${i < st.n ? 'on' : ''} ${i === st.n && !st.done ? 'now' : ''} ${i === 6 ? 'big' : ''}"><span class="d">第 ${i + 1} 天</span><span class="c">${i < st.n ? ic('check','width:20px;height:20px') : `<b>${r}</b>`}</span><span class="r">${i < st.n ? '已簽到' : r + ' UC幣'}</span></li>`).join('')}</ol>`; }
function checkinModal(){ const st = ckState();
  openModal(`<h3 id="mdlT">每日簽到</h3><p class="muted" style="font-size:13px;margin:0 0 16px">連續簽到第 1～6 天各得 2 UC幣，第 7 天得 10 UC幣（不可退款）；漏簽一天就從第 1 天重新開始。${st.broken ? '<br><b style="color:var(--gold-2)">昨天沒有簽到，今天從第 1 天重新開始。</b>' : ''}</p>
    ${ckSlots()}
    <button class="btn gold block" data-act="ck-do" ${st.done || !st.next ? 'disabled' : ''} style="margin-top:24px">${st.done ? '今天已簽到，明天再來' : st.next ? `簽到領 ${st.next} UC幣` : '今天已簽到'}</button>`); }
function checkinCard(){ const st = ckState();
  return `<section class="panel ck-card" id="me-checkin" aria-labelledby="ckH"><div class="row between" style="margin-bottom:16px"><h3 id="ckH" style="margin:0">每日簽到</h3><span class="dim" style="font-size:12px">已連續 ${st.n} / 7 天・漏簽重新計算</span></div>
    ${ckSlots()}<button class="btn gold block" data-act="ck-do" ${st.done || !st.next ? 'disabled' : ''} style="margin-top:16px">${st.done ? '今天已簽到' : st.next ? `簽到領 ${st.next} UC幣` : '今天已簽到'}</button></section>`; }
function doCheckin(){ const st = ckState(); if (st.done || !st.next) return;
  S.checkin = {last:twDate(), n:st.n + 1}; S.coins += st.next; S.coinsNR += st.next; syncBal();
  S.tx.unshift({t:`每日簽到 第 ${st.n + 1} 天`, d:twNow(), a:st.next, ic:'gift', nr:true});
  const inModal = !!$('#modalRoot .dlg'); if (inModal) checkinModal(); if (['me','wallet'].includes(parseHash().name)) render(true);
  toast(`簽到成功，獲得 ${st.next} 不可退款 UC幣`); }
document.addEventListener('click', e => { const el = e.target.closest('[data-act="ck-do"],[data-act="ck-open"]'); if (!el || el.disabled) return; e.preventDefault();
  if (el.dataset.act === 'ck-do') doCheckin(); else checkinModal(); });
/* 登入狀態下，進站時若今天還沒簽到就跳出提醒 */
addEventListener('load', () => setTimeout(() => { if (!S.authed || /nobind|nocheckin/.test(location.search) || parseHash().name === 'admin') return;
  if (!ckState().done && !$('#modalRoot').innerHTML) checkinModal(); }, RM() ? 300 : 1200));

/* ---------- 會員頁：VIP 卡改為可點、加入簽到卡 ---------- */
const _meR = routes.me, _meA = routes.me.after;
routes.me = r => { let h = _meR(r);
  h = h.replace('<div class="menu-grid">', `${checkinCard()}<div class="menu-grid">`);
  return h; };
routes.me.after = _meA;

/* ---------- 後台：VIP 等級與簽到獎勵 ---------- */
ADM_VIEWS.vip = () => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>等級</th><th>名稱</th><th class="r">累計消費門檻</th><th class="r">升級禮</th><th class="r">生日禮</th><th>每月優惠券</th><th class="r">保管加天</th></tr></thead><tbody>
  ${S.vipT.map((v, i) => `<tr><td>${vipBadge(v.lv)}</td><td><label class="sr" for="vn${i}">VIP ${v.lv} 名稱</label><input class="input" id="vn${i}" value="${v.n}" data-act="x-vip" data-f="n" data-k="${i}" style="min-width:96px"></td>
    ${['min','gift','bday'].map(f => `<td class="r"><label class="sr" for="v${f}${i}">VIP ${v.lv} ${f}</label><input class="input num" type="number" min="0" id="v${f}${i}" value="${v[f]}" data-act="x-vip" data-f="${f}" data-k="${i}" ${f === 'min' && i === 0 ? 'disabled' : ''} style="max-width:120px"></td>`).join('')}
    <td><label class="sr" for="vcp${i}">VIP ${v.lv} 每月優惠券</label><input class="input" id="vcp${i}" value="${v.cp}" data-act="x-vip" data-f="cp" data-k="${i}" style="min-width:160px"></td>
    <td class="r"><label class="sr" for="vst${i}">VIP ${v.lv} 保管加天</label><input class="input num" type="number" min="0" id="vst${i}" value="${v.store}" data-act="x-vip" data-f="store" data-k="${i}" style="max-width:96px"></td></tr>`).join('')}
  </tbody></table></div>
  <p class="dim" style="font-size:12px;margin:12px 0 24px">門檻需逐級遞增；修改後即時套用並寫入操作日誌。VIP ${VIP_ODDS} 以上可在賞池頁看到即時機率。</p>
  <div class="panel"><h3>每日簽到獎勵（連續簽到，漏簽重新計算）</h3><div class="ck-cfg">${CK_REW().map((r, i) => `<div class="field"><label for="ckr${i}">第 ${i + 1} 天</label><input class="input num" type="number" min="0" id="ckr${i}" value="${r}" data-act="x-ckr" data-k="${i}"></div>`).join('')}</div></div>`;
document.addEventListener('change', e => { const el = e.target, a = el.dataset.act; if (a !== 'x-vip' && a !== 'x-ckr') return; const k = +el.dataset.k;
  if (a === 'x-ckr'){ const R = CK_REW().slice(); R[k] = Math.max(0, Math.floor(+el.value || 0)); el.value = R[k]; S.cfg.ckRew = R; S.audit.unshift({t:'剛剛', who:'輝', a:`簽到第 ${k + 1} 天獎勵改為 ${R[k]}`}); return toast('已更新簽到獎勵'); }
  const f = el.dataset.f, v = f === 'n' || f === 'cp' ? el.value.trim() : Math.max(0, Math.floor(+el.value || 0));
  if (f === 'min'){ const lo = S.vipT[k - 1] ? S.vipT[k - 1].min + 1 : 0, hi = S.vipT[k + 1] ? S.vipT[k + 1].min - 1 : Infinity; if (v < lo || v > hi){ el.value = S.vipT[k].min; el.focus(); return toast(`門檻需介於 ${fmt(lo)}～${hi === Infinity ? '∞' : fmt(hi)}`); } }
  S.vipT[k][f] = v; if (typeof v === 'number') el.value = v; S.audit.unshift({t:'剛剛', who:'輝', a:`VIP ${k} ${f} → ${v}`}); toast('已更新 VIP 設定'); });
</script>
