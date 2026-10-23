<script>
/* =========================================================
   OPERATIONS: admin gate, customer service, fulfilment,
   shipping refunds, notifications, IP management, firewall,
   plus member-side notification settings and full rules page.
   ========================================================= */
const ADMIN_HASH = '4be1a191ec62fa1deb76d7c64fc6eaa259207c898a1ea1a621069a3ca4fc99ab'; // front-end test gate only
const shipRefundRatio = () => ((S.cfg && S.cfg.refundPct != null) ? S.cfg.refundPct : 50) / 100;
const CARRIERS = {
  tcat:{n:'黑貓宅急便', url:'https://www.t-cat.com.tw/inquire/trace.aspx'},
  hct:{n:'新竹物流', url:'https://www.hct.com.tw/search/searchgoods_n.aspx'},
  post:{n:'中華郵政', url:'https://postserv.post.gov.tw/pstmail/main_mail.html'},
  c711:{n:'7-ELEVEN 交貨便', url:'https://eservice.7-11.com.tw/e-tracking/search.aspx'},
  fami:{n:'全家店到店', url:'https://fmec.famiport.com.tw/FP_Entrance/QueryBox'}
};
const IP_CATS = ['原創','動畫','遊戲','漫畫'];
const SHIP_FLOW = ['申請','揀貨','包裝','已出貨','已送達'];

Object.assign(S, {
  adminOk: (() => { try { return sessionStorage.getItem('ck_admin') === '1'; } catch(_) { return false; } })(),
  coinsNR: 0,
  invite: {code:'CHK8A2', ok:2, goal:20, reward:1000, got:false},
  notifPref: {inapp:true, sms:true, line:false, push:false, email:true},
  notifEv: {draw:true, expiry:true, ship:true, refund:true, ticket:true, news:false},
  notifs: [
    {t:'星屑學園 鏡面徽章（雫）將於 6 天後到期，請盡快申請出貨', d:'今天 09:00', ic:'clock'},
    {t:'出貨單 SH-0011 已寄出，7-ELEVEN 交貨便單號 F2610231188', d:'10/21 14:20', ic:'truck'}
  ],
  tickets: [
    {id:'CS-1026', cat:'出貨/物流', user:'k***a', subj:'想更改 7-11 取貨門市', st:'待處理', due:+2, link:'出貨單 SH-0012', msgs:[{f:'u', t:'您好，我剛申請出貨，想把取貨門市改成台北車站門市，可以嗎？', d:'10/23 05:10'}]},
    {id:'CS-1025', cat:'抽賞爭議', user:'Chiaki 玩家', subj:'動畫卡住但代幣已扣除', st:'處理中', due:+6, link:'抽賞 CK20261022-391502', msgs:[{f:'u', t:'剛剛抽的時候畫面卡住，代幣有扣但沒看到結果。', d:'10/22 23:41'},{f:'s', t:'已查詢伺服器紀錄，結果已成立並存入您的中獎倉庫，請重新整理查看。', d:'10/23 00:02'}]},
    {id:'CS-1023', cat:'退款', user:'t***2', subj:'預收運費改台幣退款', st:'待用戶回覆', due:-1, link:'退款 RF-0003', msgs:[{f:'u', t:'回收了小獎，運費想退回銀行帳戶。', d:'10/21 18:20'},{f:'s', t:'已收到申請，請提供銀行代碼與帳號末五碼以便核對。', d:'10/21 19:02'}]}
  ],
  csSel: 'CS-1026', csTab: '全部',
  shipments: [
    {id:'SH-0012', user:'k***a', items:3, m:'c711', st:'揀貨', carrier:'', no:''},
    {id:'SH-0011', user:'Chiaki 玩家', items:1, m:'c711', st:'已出貨', carrier:'c711', no:'F2610231188'},
    {id:'SH-0009', user:'y***i', items:5, m:'home', st:'已送達', carrier:'tcat', no:'9012 3456 7788'}
  ],
  refunds: [
    {id:'RF-0003', user:'t***2', kind:'twd', via:'銀行轉帳', amt:100, st:'待審核', note:'回收小獎後多出 1 份運費'},
    {id:'RF-0002', user:'s***o', kind:'coin', via:'自動', amt:60, st:'已入帳', note:'部分退還 50%'}
  ],
  blocked: [{ip:'203.0.113.24', why:'1 分鐘內 180 次鎖籤請求', at:'10:42'}],
  ips: null
});
// warehouse sample shipment now carries a real tracking number
(() => { const w = S.wh.find(x => x.id === 'w4'); if (w){ w.track = null; w.ship = {carrier:'c711', no:'F2610231188', st:'已出貨'}; } })();
S.ips = [...new Set(POOLS.map(p => p.ip))].map((n,i) => ({n, cat: n.includes('CHIAKI') ? '原創' : ['動畫','遊戲','漫畫'][i % 3], vis:true}));
const ipOrder = name => { const i = S.ips.findIndex(x => x.n === name); return i < 0 ? 999 : i; };

/* ---------- helpers ---------- */
async function sha256(t){ const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join(''); }
const nrTag = '<span class="tag warn" title="如有疑問請聯絡官方小編">不可退款・無法轉換</span>';
function trackHTML(sh){
  if (!sh || !sh.no) return '<span class="dim">揀貨中，出貨後顯示單號</span>';
  const c = CARRIERS[sh.carrier];
  return `<span class="row" style="gap:8px;flex-wrap:wrap;font-size:12px">${c.n} ・ <b class="num">${sh.no}</b>
    <button class="btn s ghost" style="height:28px;padding:0 8px" data-act="x-copy" data-v="${sh.no}">複製</button>
    <a class="btn s ghost" style="height:28px;padding:0 8px" href="${c.url}" target="_blank" rel="noopener">查詢物流</a></span>`;
}

/* ---------- admin gate ---------- */
const _adminRoute = routes.admin;
routes.admin = r => S.adminOk ? _adminRoute(r) : `<div class="wrap" style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 160px);padding:48px 16px">
  <form class="panel" data-act="x-admin-login" style="width:100%;max-width:400px;display:flex;flex-direction:column;gap:16px;padding:32px">
    <span class="brand" style="font-size:28px;text-align:center">CHIAKI</span>
    <h1 style="margin:0;text-align:center;font-family:var(--serif-tc);font-size:20px">管理後台登入</h1>
    <div class="field"><label for="admPw">管理密碼</label><input class="input" id="admPw" name="pw" type="password" inputmode="numeric" autocomplete="current-password" required></div>
    <p class="dim" style="margin:0;font-size:12px">提示：兩個輝的生日</p>
    <button class="btn gold block" type="submit">${ic('lock','width:18px;height:18px')}登入</button>
    <p class="dim" style="margin:0;font-size:12px;text-align:center" id="admMsg" aria-live="polite"></p>
  </form></div>`;

/* ---------- admin module views ---------- */
const ADM_VIEWS = {};
ADM_VIEWS.cs = () => {
  const tabs = ['全部','待處理','處理中','待用戶回覆','已結案'];
  const list = S.tickets.filter(t => S.csTab === '全部' || t.st === S.csTab);
  const cur = list.find(t => t.id === S.csSel) || list[0];
  if (cur) S.csSel = cur.id;
  const stTag = st => ({'待處理':'bad','處理中':'warn','待用戶回覆':'info','已結案':'ok'}[st]);
  const cnt = st => S.tickets.filter(t => t.st === st).length;
  return `<div class="kpis">
      <div class="kpi"><span>待處理</span><b style="color:var(--bad)">${cnt('待處理')}</b><em style="color:var(--tx-3)">新進工單</em></div>
      <div class="kpi"><span>處理中</span><b>${cnt('處理中')}</b><em style="color:var(--tx-3)">已指派</em></div>
      <div class="kpi"><span>待用戶回覆</span><b>${cnt('待用戶回覆')}</b><em style="color:var(--tx-3)">48 小時未回覆自動結案</em></div>
      <div class="kpi"><span>逾時 SLA</span><b style="color:var(--warn)">${S.tickets.filter(t => t.due < 0 && t.st !== '已結案').length}</b><em style="color:var(--tx-3)">需優先處理</em></div>
    </div>
    <div class="hscroll" style="margin:24px 0 16px">${tabs.map(t => `<button class="chip ${S.csTab===t?'on':''}" data-act="x-cstab" data-k="${t}">${t}</button>`).join('')}</div>
    <div class="cs">
      <div class="cs-list">${list.map(t => `<button class="cs-item ${t.id===cur.id?'on':''}" data-act="x-cssel" data-k="${t.id}">
          <span class="row between" style="width:100%"><b>${t.subj}</b><span class="tag ${stTag(t.st)}">${t.st}</span></span>
          <span class="dim">${t.id} ・ ${t.cat} ・ ${t.user}</span>
          <span class="${t.due<0?'bad-t':'dim'}">${t.st==='已結案' ? '已結案' : t.due < 0 ? `逾時 ${-t.due} 小時` : `SLA 剩 ${t.due} 小時`}</span></button>`).join('') || '<div class="empty">沒有工單</div>'}</div>
      ${cur ? `      <div class="panel cs-detail">
        <div class="row between" style="flex-wrap:wrap;gap:8px"><div><b style="font-size:16px">${cur.subj}</b><div class="dim" style="font-size:12px">${cur.id} ・ ${cur.user} ・ 關聯：<a href="#/admin">${cur.link}</a></div></div><span class="tag ${stTag(cur.st)}">${cur.st}</span></div>
        <div class="thread">${cur.msgs.map(m => `<div class="msg ${m.f}"><p>${m.t}</p><span>${m.f==='u'?cur.user:'客服'} ・ ${m.d}</span></div>`).join('')}</div>
        <div class="cs-acts" role="group" aria-label="快速處理">
          <button class="btn s" data-act="x-csdo" data-k="resend">${ic('truck','width:16px;height:16px')}重新安排出貨</button>
          <button class="btn s" data-act="x-csdo" data-k="extend">${ic('clock','width:16px;height:16px')}延長保管 7 天</button>
          <button class="btn s" data-act="x-csdo" data-k="refund">${ic('recycle','width:16px;height:16px')}核准退款</button>
          <button class="btn s" data-act="x-csdo" data-k="comp">${ic('gift','width:16px;height:16px')}補償點數</button>
        </div>
        <div class="field"><label for="csTpl">快速回覆範本</label><select class="input" id="csTpl" data-act="x-cstpl" style="width:100%"><option value="">選擇範本…</option>
          <option>已收到您的問題，我們將於 24 小時內回覆，謝謝您的耐心。</option>
          <option>已查詢伺服器紀錄，結果已成立並存入您的中獎倉庫，請重新整理查看。</option>
          <option>已為您更新取貨門市，出貨後將以簡訊通知物流單號。</option>
          <option>退款已核准，款項將於 3–5 個工作天內退回，請留意入帳通知。</option></select></div>
        <div class="field"><label for="csReply">回覆內容</label><textarea class="input" id="csReply" placeholder="輸入回覆，或選擇上方範本"></textarea></div>
        <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn gold" data-act="x-csreply">送出並設為待用戶回覆</button><button class="btn" data-act="x-csclose">結案</button></div>
      </div>` : '<div class="panel cs-detail"><div class="empty">此分類沒有工單</div></div>'}
    </div>`;
};
ADM_VIEWS.ship = () => `<div class="flow">${SHIP_FLOW.map(st => `<div class="flow-s"><b>${S.shipments.filter(s => s.st === st).length}</b><span>${st}</span></div>`).join('')}</div>
    <div class="tbl-wrap" style="margin-top:24px"><table class="tbl"><thead><tr><th>出貨單</th><th>會員</th><th class="r">件數</th><th>配送方式</th><th>狀態</th><th>物流單號</th><th></th></tr></thead><tbody>
    ${S.shipments.map(s => `<tr><td class="num">${s.id}</td><td>${s.user}</td><td class="r">${s.items}</td><td>${SHIP_M[s.m]}</td>
      <td><span class="tag ${s.st==='已送達'?'ok':s.st==='已出貨'?'info':'warn'}">${s.st}</span></td>
      <td class="num">${s.no ? `${CARRIERS[s.carrier].n} ${s.no}` : '<span class="dim">—</span>'}</td>
      <td>${s.st === '已送達' ? '' : `<button class="btn s ${s.st==='包裝'?'gold':''}" data-act="x-shipnext" data-k="${s.id}">${s.st==='包裝' ? '輸入單號並出貨' : '下一步：' + SHIP_FLOW[SHIP_FLOW.indexOf(s.st)+1]}</button>`}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="dim" style="font-size:12px;margin-top:12px">標記「已出貨」時必須填寫物流單號，系統會自動以簡訊／站內通知告知會員，會員可於中獎倉庫查看並查詢物流。</p>`;
ADM_VIEWS.refund = () => `<div class="panel" style="margin-bottom:24px"><h3>運費退款設定</h3>
      <div class="kv"><span>代幣部分退還比例（優先）</span><b>${shipRefundRatio()*100}%・不可退款代幣</b></div>
      <div class="kv"><span>台幣退款管道</span><b>銀行轉帳／綠界刷卡退刷</b></div>
      <div class="kv"><span>台幣退款撥款</span><b>需第二位管理員覆核</b></div></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>編號</th><th>會員</th><th>類型</th><th>管道</th><th class="r">金額</th><th>說明</th><th>狀態</th><th></th></tr></thead><tbody>
    ${S.refunds.map(f => `<tr><td class="num">${f.id}</td><td>${f.user}</td><td>${f.kind==='coin'?'代幣（部分）':'台幣'}</td><td>${f.via}</td><td class="r">${f.kind==='coin'?fmt(f.amt)+' 幣':'NT$ '+fmt(f.amt)}</td><td class="dim">${f.note}</td>
      <td><span class="tag ${f.st==='待審核'?'warn':f.st==='已駁回'?'bad':'ok'}">${f.st}</span></td>
      <td>${f.st==='待審核' ? `<span class="row" style="gap:8px"><button class="btn s gold" data-act="x-rfok" data-k="${f.id}">核准</button><button class="btn s" data-act="x-rfno" data-k="${f.id}">駁回</button></span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
ADM_VIEWS.notify = () => {
  const ch = [['inapp','站內通知','已啟用','ok'],['sms','簡訊（三竹 Mitake）','待填入 API 帳號','warn'],['line','LINE 官方帳號推播','待填入 Channel Token','warn'],['push','網頁推播（Web Push）','待產生 VAPID 金鑰','warn'],['email','Email','待設定寄件網域','warn']];
  const ev = [['抽賞結果','draw'],['保管到期提醒（7 天前／當天）','expiry'],['出貨通知（含物流單號）','ship'],['退款進度','refund'],['客服回覆','ticket'],['邀請好友獎勵','invite']];
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>通道</th><th>狀態</th><th></th></tr></thead><tbody>
    ${ch.map(([k,n,s,c]) => `<tr><td>${n}</td><td><span class="tag ${c}">${s}</span></td><td><button class="btn s" data-act="x-notest" data-k="${n}">發送測試</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="tbl-wrap" style="margin-top:24px"><table class="tbl"><thead><tr><th>通知事件</th><th>站內</th><th>簡訊</th><th>LINE</th><th>推播</th><th>Email</th></tr></thead><tbody>
    ${ev.map(([n]) => `<tr><td>${n}</td>${['inapp','sms','line','push','email'].map((k,i) => `<td>${i===0||(i===1&&n.match(/到期|出貨/))||i===4 ? ic('check','width:16px;height:16px;color:var(--ok)') : '<span class="dim">—</span>'}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <p class="dim" style="font-size:12px;margin-top:12px">每則通知具唯一編號，失敗自動重試；會員可於會員中心自行選擇接收管道。</p>`;
};
ADM_VIEWS.ip = () => {
  const pc = n => POOLS.filter(p => p.ip === n).length;
  return `<div class="row between" style="margin-bottom:16px;flex-wrap:wrap;gap:8px"><div class="ipf">${IP_CATS.map(c => `<span class="chip">${c} ${S.ips.filter(x => x.cat === c).length}</span>`).join('')}</div>
      <button class="btn s gold" data-act="x-ipadd">${ic('plus','width:16px;height:16px')}新增 IP</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="r">排序</th><th>IP 名稱</th><th>分類</th><th class="r">賞池數</th><th>前台顯示</th><th>調整順序</th></tr></thead><tbody>
    ${S.ips.map((x,i) => `<tr><td class="r num">${i+1}</td><td><label class="sr" for="ipn${i}">IP 名稱</label><input class="input" id="ipn${i}" data-act="x-ipn" data-k="${i}" value="${x.n.replace(/"/g,'&quot;')}" style="height:32px;min-width:160px"></td>
      <td><label class="sr" for="ipc${i}">分類</label><select class="input" id="ipc${i}" data-act="x-ipcat" data-k="${i}" style="height:32px;padding:0 32px 0 12px">${IP_CATS.map(c => `<option ${c===x.cat?'selected':''}>${c}</option>`).join('')}</select></td>
      <td class="r">${pc(x.n)}</td>
      <td><button class="btn s ${x.vis?'':'ghost'}" data-act="x-ipvis" data-k="${i}" aria-pressed="${x.vis}">${x.vis?'顯示中':'已隱藏'}</button></td>
      <td><span class="row" style="gap:8px"><button class="ibtn" data-act="x-ipmv" data-k="${i}" data-d="-1" aria-label="上移" ${i?'':'disabled'}>${ic('down','transform:rotate(180deg)')}</button><button class="ibtn" data-act="x-ipmv" data-k="${i}" data-d="1" aria-label="下移" ${i<S.ips.length-1?'':'disabled'}>${ic('down')}</button></span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="dim" style="font-size:12px;margin-top:12px">排序與顯示設定會立即套用到前台抽賞大廳；隱藏的 IP 不會出現在篩選，其賞池也不會出現在大廳列表。</p>`;
};
ADM_VIEWS.risk = () => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>防護規則</th><th>設定</th><th>狀態</th></tr></thead><tbody>
    ${[['邊緣防火牆（WAF）','SQL 注入、XSS、惡意爬蟲、已知攻擊特徵阻擋'],['速率限制','每 IP 每分鐘 60 次；鎖籤／抽賞每帳號每分鐘 30 次'],['機器人偵測','異常快速操作、無人類互動軌跡'],['登入保護','5 次失敗鎖定 15 分鐘，逐次延長'],
       ['後台存取','超級管理員 MFA、可限定 IP 白名單、高風險操作雙人覆核'],['金流回呼','綠界簽章驗證、來源 IP 白名單、重放攔截'],['安全標頭','CSP、HSTS、禁止嵌入（X-Frame-Options）'],['多帳號偵測','同裝置／同 IP 異常註冊與邀請']]
      .map(([n,d]) => `<tr><td>${n}</td><td class="dim" style="white-space:normal">${d}</td><td><span class="tag ok">啟用</span></td></tr>`).join('')}
    </tbody></table></div>
    <div class="panel" style="margin-top:24px"><h3>封鎖名單 <span class="tag bad">${S.blocked.length}</span></h3>
      ${S.blocked.map((b,i) => `<div class="risk"><span class="dot" style="background:var(--bad)"></span><div style="flex:1"><b class="num">${b.ip}</b><div class="dim">${b.why} ・ ${b.at}</div></div><button class="btn s" data-act="x-unblock" data-k="${i}">解除</button></div>`).join('') || '<p class="dim">目前沒有封鎖的 IP</p>'}</div>`;

/* ---------- full rules page ---------- */
routes.rules = () => `<div class="wrap"><article class="rules">
  <div class="page-h"><h1>CHIAKI 線上一番賞｜遊戲規則、規範與注意事項</h1><p>最後更新：2026 年 10 月 23 日</p></div>
  ${RULES.map(([h, body]) => `<section><h2>${h}</h2>${body}</section>`).join('')}
  <div class="rules-end"><b>抽賞是一種娛樂與收藏體驗，而不是投資。</b><p>每一次抽賞結果皆具有隨機性，請依個人經濟能力適度消費；請勿借款、超額消費，或因追求特定獎項而影響日常生活及財務狀況。</p><p class="gold-t">CHIAKI 提醒您：理性抽賞，享受收藏的樂趣。</p></div>
</article></div>`;

/* ---------- events ---------- */
document.addEventListener('submit', async e => {
  if (!e.target.matches('[data-act="x-admin-login"]')) return;
  e.preventDefault();
  const h = await sha256(e.target.pw.value.trim());
  if (h === ADMIN_HASH){ S.adminOk = true; try { sessionStorage.setItem('ck_admin','1'); } catch(_){} render(); }
  else { $('#admMsg').textContent = '密碼錯誤，請再試一次'; e.target.pw.select(); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.matches('[data-act="x-cstpl"]') && el.value) $('#csReply').value = el.value;
  if (el.matches('[data-act="x-ipcat"]')){ S.ips[+el.dataset.k].cat = el.value; toast('已更新分類'); }
  if (el.matches('[data-act="x-ipn"]')){ const x = S.ips[+el.dataset.k], v = el.value.trim(); if (!v){ el.value = x.n; toast('IP 名稱不可空白'); return; } if (S.ips.some(o => o !== x && o.n === v)){ el.value = x.n; toast('已有相同名稱的 IP'); return; } POOLS.forEach(p => { if (p.ip === x.n) p.ip = v; }); S.follow = S.follow.map(f => f === x.n ? v : f); x.n = v; toast('已更新 IP 名稱'); }
  if (el.matches('[data-act="x-notif"]')){ S.notifPref[el.dataset.k] = el.checked; toast('通知設定已儲存'); }
  if (el.matches('[data-act="x-notev"]')){ S.notifEv[el.dataset.k] = el.checked; toast('通知設定已儲存'); }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act^="x-"]'); if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  const a = el.dataset.act, k = el.dataset.k;
  const T = S.tickets.find(t => t.id === S.csSel);
  const now = () => twNow().slice(5);
  const A = {
    'x-copy': () => copyText(el.dataset.v, '已複製物流單號'),
    'x-logout': () => { S.adminOk = false; try { sessionStorage.removeItem('ck_admin'); } catch(_){} render(); },
    'x-cstab': () => { S.csTab = k; render(true); },
    'x-cssel': () => { S.csSel = k; render(true); },
    'x-csdo': () => { const m = {resend:'已重新安排出貨，並通知會員', extend:'已延長保管 7 天', refund:'已送出退款核准（需第二位管理員覆核）', comp:'已發放補償 50 點'}[k];
      T.msgs.push({f:'s', t:`【系統】${m}`, d:now()}); if (T.st === '待處理') T.st = '處理中'; toast(m); render(true); },
    'x-csreply': () => { const v = $('#csReply').value.trim(); if (!v){ toast('請輸入回覆內容'); $('#csReply').focus(); return; } T.msgs.push({f:'s', t:v, d:now()}); T.st = '待用戶回覆'; toast('已回覆，會員將收到通知'); render(true); },
    'x-csclose': () => { T.st = '已結案'; toast('工單已結案'); render(true); },
    'x-shipnext': () => { const s = S.shipments.find(x => x.id === k); const i = SHIP_FLOW.indexOf(s.st);
      if (s.st === '包裝'){ openModal(`<h3 id="mdlT">輸入物流單號 ・ ${s.id}</h3>
          <div class="field" style="margin-bottom:16px"><label for="shC">物流商</label><select class="input" id="shC" style="width:100%">${Object.entries(CARRIERS).map(([c,v]) => `<option value="${c}" ${c===(s.m==='home'?'tcat':s.m)?'selected':''}>${v.n}</option>`).join('')}</select></div>
          <div class="field" style="margin-bottom:24px"><label for="shN">物流單號</label><input class="input" id="shN" placeholder="例：F2610231200" autocomplete="off"></div>
          <button class="btn gold block" data-act="x-shipgo" data-k="${s.id}">確認出貨並通知會員</button>`); return; }
      s.st = SHIP_FLOW[i+1]; toast(`${s.id} → ${s.st}`); render(true); },
    'x-shipgo': () => { const s = S.shipments.find(x => x.id === k), no = $('#shN').value.trim(); if (!no){ toast('請輸入物流單號'); $('#shN').focus(); return; }
      s.carrier = $('#shC').value; s.no = no; s.st = '已出貨'; closeModal(); toast('已出貨，會員已收到物流單號通知'); render(true); },
    'x-rfok': () => { const f = S.refunds.find(x => x.id === k); f.st = '已核准（待覆核撥款）'; toast('已核准，待第二位管理員覆核撥款'); render(true); },
    'x-rfno': () => { const f = S.refunds.find(x => x.id === k); f.st = '已駁回'; if (f.back){ S.coins += f.amt; syncBal(); S.tx.unshift({t:`退款申請 ${f.id} 已駁回，代幣退回`, d:twNow(), a:f.amt, ic:'card'}); } toast('已駁回並通知會員'); render(true); },
    'x-notest': () => toast(`已送出測試：${k}`),
    'x-ipmv': () => { const i = +k, j = i + +el.dataset.d; [S.ips[i], S.ips[j]] = [S.ips[j], S.ips[i]]; render(true); },
    'x-ipvis': () => { S.ips[+k].vis = !S.ips[+k].vis; render(true); },
    'x-ipadd': () => { const n = 'NEW IP ' + (S.ips.length + 1); S.ips.push({n, cat:'動畫', vis:false}); toast('已新增，請設定名稱與分類'); render(true); },
    'x-unblock': () => { S.blocked.splice(+k, 1); toast('已解除封鎖'); render(true); },
    'x-invite': () => copyText(location.origin + location.pathname + '#/?ref=' + S.invite.code, '邀請連結已複製'),
    'x-ntwd': () => { const v = +el.dataset.v; S.refunds.unshift({id:'RF-00' + (S.refunds.length + 4), user:'Chiaki 玩家', kind:'twd', via:el.dataset.via, amt:v, st:'待審核', note:'會員申請台幣退款'}); closeModal(); toast('已送出台幣退款申請，審核後通知您'); }
  };
  if (A[a]){ e.preventDefault(); A[a](); }
});
</script>
