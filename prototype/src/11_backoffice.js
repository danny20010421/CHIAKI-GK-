<script>
/* =========================================================
   BACK OFFICE — 讓後勤人員一眼看出「先做哪件事」
   1. 今日待辦看板（依急迫度上色，點了直接到該模組並套用篩選）
   2. 全站統一狀態色：紅＝需立即處理、橘＝待處理／待審、藍＝進行中、綠＝完成、灰＝結束
   3. 後台萬用查詢：會員編號、手機末碼、出貨單、工單、退款、交易編號、賞池
   4. 物流：狀態篩選、等待時間、大件提醒、批次推進、匯出揀貨單
   ========================================================= */
const TONES = [
  ['bad',  /逾時|待處理|駁回|異常|凍結|失敗|不可超商/],
  ['warn', /申請|揀貨|包裝|待審|待覆核|草稿|未啟用|待填入/],
  ['info', /處理中|已出貨|待用戶回覆|已核准|排程/],
  ['ok',   /已送達|已結案|已入帳|上架中|正常|啟用|已驗證|相符/]
];
const tone = st => (TONES.find(([, re]) => re.test(st)) || ['mute'])[0];
const stTagT = st => `<span class="tag ${tone(st) === 'mute' ? '' : tone(st)}">${st}</span>`;
const LEGEND = `<div class="st-legend" aria-label="狀態顏色說明"><span><i class="bad"></i>需立即處理</span><span><i class="warn"></i>待處理・待審</span><span><i class="info"></i>進行中</span><span><i class="ok"></i>已完成</span><span><i class="mute"></i>已結束</span></div>`;

/* --- sample data: when each shipment was requested, what is inside --- */
(() => {
  const ago = h => Date.now() - h * 36e5;
  S.shipments.unshift({id:'SH-0013', user:'r***n', items:2, m:'home', st:'申請', carrier:'', no:'', t:ago(4), names:['CHIAKI GK 原創雕像 白模版','明信片（全 10 種）'], bulky:true},
                      {id:'SH-0010', user:'w***l', items:1, m:'c711', st:'包裝', carrier:'', no:'', t:ago(60), names:['朽木白哉 胸像'], bulky:true});
  const meta = {'SH-0012':[30,['壓克力立牌（全 6 種）','金屬徽章（全 5 種）','明信片（全 10 種）']], 'SH-0011':[50,['設定原畫 收藏卡組']], 'SH-0009':[96,['印花毛巾（全 5 種）','鏡面徽章（全 10 種）']]};
  S.shipments.forEach(s => { if (!s.t && meta[s.id]){ s.t = ago(meta[s.id][0]); s.names = meta[s.id][1]; } s.bulky = !!s.bulky; });
  S.poolDrafts = S.poolDrafts || [];
  if (!S.poolDrafts.some(d => d.st === '待覆核')) S.poolDrafts.push({title:'CHIAKI GK 雕像一番賞 第一彈 第 3 套', ip:'CHIAKI ORIGINAL', src:'s', play:'std', price:300, sets:1, home:200, cvs:100, st:'待覆核', by:'營運 A'});
  S.shipF = '全部'; S.shipSel = [];
})();
const ageH = s => s.t ? Math.floor((Date.now() - s.t) / 36e5) : 0;
const shipOpen = s => !['已出貨','已送達'].includes(s.st);
const shipLate = s => shipOpen(s) && ageH(s) >= 48;
const ageTxt = h => h >= 24 ? `${Math.floor(h/24)} 天 ${h%24} 小時` : `${h} 小時`;
const ageShort = h => h >= 24 ? `${Math.floor(h/24)} 天` : `${h} 小時`;

/* ---------- 今日待辦 ---------- */
function todoBoard(){
  const open = S.shipments.filter(shipOpen), late = open.filter(shipLate), oldest = open.reduce((m, s) => Math.max(m, ageH(s)), 0);
  const conflict = open.filter(s => s.bulky && s.m !== 'home');
  const csP = S.tickets.filter(t => t.st === '待處理').length, csL = S.tickets.filter(t => t.due < 0 && t.st !== '已結案').length;
  const rf = S.refunds.filter(f => f.st === '待審核'), rfSum = rf.reduce((s, f) => s + f.amt, 0);
  const rev = S.poolDrafts.filter(d => d.st === '待覆核').length;
  const exp = S.wh.filter(w => w.st === 'stored' && daysLeft(w.at).d <= 7).length;
  const T = [
    {k:'ship', f:'待出貨', n:open.length, t: late.length ? 'bad' : open.length ? 'warn' : 'ok', l:'待出貨', s: late.length ? `逾時 ${late.length} 張・最久 ${ageShort(oldest)}` : open.length ? `最久 ${ageShort(oldest)}` : '全部已出貨'},
    {k:'ship', f:'大件', n:conflict.length, t: conflict.length ? 'bad' : 'ok', l:'大件選了超商', s: conflict.length ? '需聯繫會員改宅配' : '沒有衝突'},
    {k:'cs', n:csP, t: csL ? 'bad' : csP ? 'warn' : 'ok', l:'客服待處理', s: csL ? `逾時 SLA ${csL} 張` : 'SLA 內'},
    {k:'refund', n:rf.length, t: rf.length ? 'warn' : 'ok', l:'退款待審核', s: rf.length ? `合計 NT$ ${fmt(rfSum)}` : '沒有待審'},
    {k:'pool', n:rev, t: rev ? 'warn' : 'ok', l:'賞池待覆核', s: rev ? '需第二位管理員' : '沒有待覆核'},
    {k:'risk', n:S.blocked.length, t: S.blocked.length ? 'bad' : 'ok', l:'風控封鎖中', s: S.blocked.length ? '請確認是否解除' : '正常'},
    {k:'member', n:exp, t: exp ? 'info' : 'ok', l:'7 天內到期保管', s: '系統將自動提醒'}
  ];
  return `<div class="todo-h"><h2>今日待辦</h2>${LEGEND}</div>
    <div class="todo">${T.map(x => `<button class="todo-t ${x.t}" data-act="x-todo" data-k="${x.k}" data-f="${x.f || ''}"><b class="num">${x.n}</b><span>${x.l}</span><small>${x.s}</small></button>`).join('')}</div>`;
}

/* ---------- 萬用查詢 ---------- */
function lookupIndex(){
  const R = [];
  (S.members || []).forEach(m => R.push({type:'會員', id:m.uid, label:`${m.n}・${m.ph}`, sub:`${m.vip}・${m.st}`, go:'member', hay:[m.uid, m.n, m.ph, m.ph.slice(-3)].join(' ')}));
  S.shipments.forEach(s => R.push({type:'出貨單', id:s.id, label:`${s.user}・${s.items} 件・${SHIP_M[s.m]}`, sub:s.st + (s.no ? '・' + s.no : ''), go:'ship', hay:[s.id, s.user, s.no, ...(s.names||[])].join(' ')}));
  S.tickets.forEach(t => R.push({type:'工單', id:t.id, label:t.subj, sub:`${t.user}・${t.st}`, go:'cs', hay:[t.id, t.subj, t.user, t.link].join(' ')}));
  S.refunds.forEach(f => R.push({type:'退款', id:f.id, label:`${f.user}・${f.kind==='coin' ? fmt(f.amt) + ' 幣' : 'NT$ ' + fmt(f.amt)}`, sub:f.st, go:'refund', hay:[f.id, f.user, f.note].join(' ')}));
  POOLS.forEach(p => R.push({type:'賞池', id:p.id, label:p.title.split(' ～')[0], sub:p.ip, go:'pool', hay:[p.id, p.title, p.ip].join(' ')}));
  if (typeof drawRows === 'function') drawRows().slice(0, 300).forEach(r => R.push({type:'抽賞', id:r.tx, label:`${r.user}・${r.pool}`, sub:`No.${r.no}・${r.res}`, go:'draw', q:r.tx, hay:[r.tx, r.user, r.pool].join(' ')}));
  return R;
}
function lookupHTML(){
  const q = (S.lookQ || '').trim().toLowerCase();
  const rank = r => r.id.toLowerCase() === q ? 0 : r.id.toLowerCase().includes(q) ? 1 : 2;
  const res = q ? lookupIndex().filter(r => r.hay.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 8) : [];
  return `<form class="lookup" data-act="x-look" role="search"><label class="sr" for="lookQ">後台查詢</label>${ic('search','width:18px;height:18px')}
      <input class="input" id="lookQ" name="q" value="${(S.lookQ||'').replace(/"/g,'&quot;')}" placeholder="會員編號、手機末 3 碼，或 SH／CS／RF／CK 編號" autocomplete="off">
      ${q ? '<button class="ibtn" type="button" data-act="x-lookclr" aria-label="清除查詢">' + ic('x','width:16px;height:16px') + '</button>' : ''}<button class="btn s gold" type="submit">查詢</button></form>
    ${q ? `<div class="look-res" role="list">${res.map(r => `<button role="listitem" data-act="x-lookgo" data-k="${r.go}" data-id="${r.id}" data-q="${r.q || ''}"><span class="lt">${r.type}</span><b class="num">${r.id}</b><span class="ll">${r.label}</span><span class="dim">${r.sub}</span></button>`).join('') || '<p class="dim" style="margin:0;padding:12px 16px">找不到「' + S.lookQ + '」，請確認編號或改用手機末 3 碼。</p>'}</div>` : ''}`;
}

/* ---------- 物流管理 ---------- */
ADM_VIEWS.ship = () => {
  const F = ['全部','待出貨','逾時','大件', ...SHIP_FLOW];
  const pass = s => S.shipF === '全部' || (S.shipF === '待出貨' ? shipOpen(s) : S.shipF === '逾時' ? shipLate(s) : S.shipF === '大件' ? s.bulky : s.st === S.shipF);
  const list = S.shipments.filter(pass).sort((a, b) => (shipOpen(b) - shipOpen(a)) || (b.bulky && b.m !== 'home') - (a.bulky && a.m !== 'home') || ageH(b) - ageH(a));
  const cnt = f => S.shipments.filter(s => f === '全部' || (f === '待出貨' ? shipOpen(s) : f === '逾時' ? shipLate(s) : f === '大件' ? s.bulky : s.st === f)).length;
  const sel = S.shipSel.filter(id => list.some(s => s.id === id)), batchable = sel.filter(id => ['申請','揀貨'].includes((S.shipments.find(s => s.id === id) || {}).st));
  return `<div class="flow">${SHIP_FLOW.map(st => `<button class="flow-s ${S.shipF === st ? 'on' : ''}" data-act="x-shipf" data-k="${st}"><b>${S.shipments.filter(s => s.st === st).length}</b><span>${st}</span></button>`).join('')}</div>
    <div class="adm-bar" style="margin-top:24px">${F.slice(0,4).map(f => `<button class="chip ${S.shipF === f ? 'on' : ''}" data-act="x-shipf" data-k="${f}">${f}<span class="cn">${cnt(f)}</span></button>`).join('')}
      <span style="flex:1"></span><button class="btn s" data-act="x-pick" ${list.filter(shipOpen).length ? '' : 'disabled'}>${ic('doc','width:16px;height:16px')}匯出揀貨單</button></div>
    ${sel.length ? `<div class="batch"><b>已選 ${sel.length} 張</b><button class="btn s gold" data-act="x-shipbatch" ${batchable.length ? '' : 'disabled'}>批次推進下一步（${batchable.length}）</button><button class="btn s ghost" data-act="x-shipclr">取消選取</button><span class="dim">「包裝」需逐張輸入物流單號</span></div>` : ''}
    <div class="tbl-wrap"><table class="tbl ship-t"><thead><tr><th><label class="sr" for="shAll">全選</label><input type="checkbox" id="shAll" data-act="x-shipall" ${sel.length && sel.length === list.length ? 'checked' : ''}></th><th>出貨單</th><th>內容</th><th>配送方式</th><th>狀態</th><th class="r">已等待</th><th>物流單號</th><th></th></tr></thead><tbody>
    ${list.map(s => { const h = ageH(s), late = shipLate(s), clash = s.bulky && s.m !== 'home'; return `<tr class="${S.hl === s.id ? 'hl' : ''} ${late || clash ? 'row-bad' : ''}">
      <td><label class="sr" for="shs_${s.id}">選取 ${s.id}</label><input type="checkbox" id="shs_${s.id}" data-act="x-shipsel" data-id="${s.id}" ${S.shipSel.includes(s.id) ? 'checked' : ''}></td>
      <td><b class="num">${s.id}</b><div class="dim" style="font-size:12px">${s.user}</div></td>
      <td><span class="row" style="gap:8px">${s.items} 件${s.bulky ? '<span class="tag warn">大件</span>' : ''}</span><div class="dim cell-ell" title="${(s.names||[]).join('、')}">${(s.names||[]).join('、') || '—'}</div></td>
      <td>${SHIP_M[s.m]}${clash ? '<div><span class="tag bad">大件不可超商・改宅配</span></div>' : ''}</td>
      <td>${stTagT(s.st)}</td>
      <td class="r"><span class="${late ? 'bad-t' : h >= 24 && shipOpen(s) ? 'warn-t' : 'dim'}">${shipOpen(s) ? (late ? '逾時 ' : '') + ageTxt(h) : '—'}</span></td>
      <td class="num">${s.no ? `${CARRIERS[s.carrier].n} ${s.no}` : '<span class="dim">—</span>'}</td>
      <td>${s.st === '已送達' ? '' : `<button class="btn s ${s.st==='包裝'?'gold':''}" data-act="x-shipnext" data-k="${s.id}">${s.st==='包裝' ? '輸入單號並出貨' : '下一步：' + SHIP_FLOW[SHIP_FLOW.indexOf(s.st)+1]}</button>`}</td></tr>`; }).join('') || '<tr><td colspan="8" class="dim">此篩選沒有出貨單</td></tr>'}
    </tbody></table></div>
    <div class="ship-cards">${list.map(s => { const h = ageH(s), late = shipLate(s), clash = s.bulky && s.m !== 'home'; return `<div class="shc ${late || clash ? 'bad' : ''} ${S.hl === s.id ? 'hl' : ''}">
      <div class="shc-h"><label class="sr" for="shm_${s.id}">選取 ${s.id}</label><input type="checkbox" id="shm_${s.id}" data-act="x-shipsel" data-id="${s.id}" ${S.shipSel.includes(s.id) ? 'checked' : ''}><b class="num">${s.id}</b>${stTagT(s.st)}<span class="${late ? 'bad-t' : h >= 24 && shipOpen(s) ? 'warn-t' : 'dim'}">${shipOpen(s) ? (late ? '逾時 ' : '') + ageShort(h) : (s.no ? s.no : '')}</span></div>
      <div class="shc-b"><span>${s.user}・${s.items} 件・${SHIP_M[s.m]}</span>${s.bulky ? '<span class="tag warn">大件</span>' : ''}${clash ? '<span class="tag bad">大件不可超商・改宅配</span>' : ''}<div class="dim cell-ell" style="max-width:none">${(s.names||[]).join('、')}</div></div>
      ${s.st === '已送達' ? '' : `<button class="btn s block ${s.st==='包裝'?'gold':''}" data-act="x-shipnext" data-k="${s.id}">${s.st==='包裝' ? '輸入單號並出貨' : '下一步：' + SHIP_FLOW[SHIP_FLOW.indexOf(s.st)+1]}</button>`}</div>`; }).join('') || '<div class="empty">此篩選沒有出貨單</div>'}</div>
    <p class="dim" style="font-size:12px;margin-top:12px">排序：未出貨在前，其中「大件選超商」與等待最久的排最前面。超過 48 小時未出貨標為逾時（紅色），超過 24 小時為橘色。標記「已出貨」必須填寫物流單號，系統會通知會員。</p>`;
};

/* ---------- 運費退款 ---------- */
const _refundView = ADM_VIEWS.refund;
ADM_VIEWS.refund = () => { const f = S.rfF || '待審核';
  const list = S.refunds.filter(x => f === '全部' || (f === '待審核' ? x.st === '待審核' : x.st !== '待審核'));
  let h = _refundView();
  const tbl = h.indexOf('<div class="tbl-wrap">');
  const tabs = `<div class="adm-bar">${['待審核','已處理','全部'].map(k => `<button class="chip ${f === k ? 'on' : ''}" data-act="x-rff" data-k="${k}">${k}<span class="cn">${S.refunds.filter(x => k === '全部' || (k === '待審核' ? x.st === '待審核' : x.st !== '待審核')).length}</span></button>`).join('')}</div>`;
  const rows = list.map(x => `<tr class="${S.hl === x.id ? 'hl' : ''}"><td class="num">${x.id}</td><td>${x.user}</td><td>${x.kind==='coin'?'代幣':'台幣'}</td><td>${x.via}</td><td class="r num">${x.kind==='coin'?fmt(x.amt)+' 幣':'NT$ '+fmt(x.amt)}</td><td class="dim">${x.note}</td><td>${stTagT(x.st)}</td>
      <td>${x.st==='待審核' ? `<span class="row" style="gap:8px"><button class="btn s gold" data-act="x-rfok" data-k="${x.id}">核准</button><button class="btn s" data-act="x-rfno" data-k="${x.id}">駁回</button></span>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="dim">沒有資料</td></tr>';
  return h.slice(0, tbl) + tabs + `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>編號</th><th>會員</th><th>類型</th><th>管道</th><th class="r">金額</th><th>說明</th><th>狀態</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

/* ---------- wrap the admin page: lookup bar + 今日待辦 + unified tags ---------- */
const _adminPage = routes.admin;
routes.admin = r => {
  let h = _adminPage(r);
  if (!S.adminOk) return h;
  h = h.replace('登出</button></div></div>', '登出</button></div></div>' + lookupHTML());
  if (S.admin === 'dash'){ h = h.replace('<div class="kpis">', todoBoard() + '<div class="kpis" style="margin-top:32px">');
    const op = S.shipments.filter(shipOpen); h = h.replace('<span>待出貨件數</span><b style="color:var(--warn)">12</b><em style="color:var(--tx-3)">最久 2 天</em>', `<span>待出貨件數</span><b style="color:var(--warn)">${op.reduce((n, s) => n + s.items, 0)}</b><em style="color:var(--tx-3)">${op.length} 張出貨單</em>`); }
  if (['ship','refund','cs','pool'].includes(S.admin) && !h.includes('st-legend')) h = h.replace(lookupHTML(), lookupHTML() + LEGEND);
  return h;
};

document.addEventListener('submit', e => { if (e.target.matches('[data-act="x-look"]')){ e.preventDefault(); S.lookQ = e.target.q.value; render(true); const b = $('.look-res button'); (b || $('#lookQ')).focus(); } });
document.addEventListener('change', e => { const el = e.target;
  if (el.matches('[data-act="x-shipsel"]')){ const id = el.dataset.id, i = S.shipSel.indexOf(id); if (i >= 0) S.shipSel.splice(i, 1); else S.shipSel.push(id); render(true); }
  if (el.matches('[data-act="x-shipall"]')){ const vis = [...new Set([...document.querySelectorAll('[data-act="x-shipsel"]')].map(x => x.dataset.id))]; S.shipSel = el.checked ? vis : []; render(true); }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act^="x-"]'); if (!el || el.tagName === 'FORM' || el.tagName === 'INPUT') return;
  const a = el.dataset.act, k = el.dataset.k;
  const A = {
    'x-todo': () => { S.admin = k; if (k === 'ship') S.shipF = el.dataset.f || '待出貨'; if (k === 'cs') S.csTab = '待處理'; if (k === 'refund') S.rfF = '待審核'; render(true); scrollTo(0, 0); },
    'x-lookclr': () => { S.lookQ = ''; render(true); $('#lookQ').focus(); },
    'x-lookgo': () => { const id = el.dataset.id; S.admin = k; S.hl = id; S.lookQ = '';
      if (k === 'cs'){ S.csTab = '全部'; S.csSel = id; } if (k === 'ship') S.shipF = '全部'; if (k === 'refund') S.rfF = '全部'; if (k === 'draw') S.drawQ = el.dataset.q; if (k === 'pool') S.admPool = id;
      render(true); const row = $('tr.hl'); if (row) row.scrollIntoView({block:'center'}); },
    'x-shipf': () => { S.shipF = k; S.shipSel = []; render(true); },
    'x-shipclr': () => { S.shipSel = []; render(true); },
    'x-shipbatch': () => { let n = 0; S.shipSel.forEach(id => { const s = S.shipments.find(x => x.id === id); if (s && ['申請','揀貨'].includes(s.st)){ s.st = SHIP_FLOW[SHIP_FLOW.indexOf(s.st) + 1]; n++; } });
      S.audit.unshift({t:'剛剛', who:'輝', a:`批次推進出貨單 ${n} 張`}); S.shipSel = []; render(true); toast(`已推進 ${n} 張出貨單`); },
    'x-pick': () => { const rows = S.shipments.filter(shipOpen), csv = '﻿出貨單,會員,配送方式,狀態,大件,件數,內容,已等待(小時)\n' + rows.map(s => [s.id, s.user, SHIP_M[s.m], s.st, s.bulky ? '是' : '', s.items, (s.names||[]).join('、'), ageH(s)].map(x => `"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
      const u = URL.createObjectURL(new Blob([csv], {type:'text/csv'})), l = document.createElement('a'); l.href = u; l.download = 'chiaki-picking-' + twDate() + '.csv'; l.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); toast(`已匯出揀貨單 ${rows.length} 張`); },
    'x-rff': () => { S.rfF = k; render(true); }
  };
  if (A[a]){ e.preventDefault(); A[a](); }
});
</script>
