<script>
/* coupons the member actually holds (codes from 行銷管理, still enabled) */
const myCoupons = () => { S.myCoupons = S.myCoupons || ['WELCOME90']; return S.myCoupons.map(c => (S.coupons || []).find(x => x.code === c && x.on)).filter(Boolean); };
/* =========================================================
   WAREHOUSE (我的收藏)
   ========================================================= */
const WH_TABS = [['stored','倉庫中'],['ship','出貨中'],['done','已完成'],['recycled','已回收']];
routes.warehouse = () => {
  const list = S.wh.filter(w => w.st === S.whTab);
  const n = S.whSel.length;
  return `<div class="wrap">
    <div class="page-h"><h1>中獎倉庫</h1><p>中獎獎品自動入庫。可勾選多件合併出貨，或依各獎品回收值換成不可退款 CC幣。</p></div>
    <div class="tabs" role="tablist" aria-label="倉庫狀態">${WH_TABS.map(([k,t]) => `<button role="tab" aria-selected="${S.whTab===k}" data-act="whtab" data-k="${k}">${t}<span class="n">${S.wh.filter(w=>w.st===k).length}</span></button>`).join('')}</div>
    ${S.whTab==='stored' && list.length ? `<div class="row between" style="margin-bottom:16px;flex-wrap:wrap"><span class="muted" style="font-size:13px">${ic('clock','width:16px;height:16px;vertical-align:-3px')} 免費保管 ${storeDays()} 天・到期前 7 天及當天提醒・逾期依回收值自動轉為不可退款 CC幣</span><button class="btn s ghost" data-act="whall">${n===list.length?'取消全選':'全選'}</button></div>` : ''}
    ${list.length ? `<div class="wlist">${list.map(w => `
      <label class="witem ${S.whSel.includes(w.id)?'sel':''}">
        ${S.whTab==='stored' ? `<input type="checkbox" data-act="whsel" data-id="${w.id}" ${S.whSel.includes(w.id)?'checked':''} aria-label="選取 ${w.name}">` : ''}
        ${art(w.hue, glyphOf(w), '', '', w.img)}
        <div class="i"><b>${w.name}</b><span>${w.st==='stored' ? (() => { const x = daysLeft(w.at); return `保管至 ${x.end} ・ ${SHIP_M[whShip(w)]} ・ 回收 ${w.rv ? fmt(w.rv)+' CC幣' : '不可回收'}`; })() : w.at + ' 入庫' + (w.track ? ' ・ ' + w.track : '')}</span>${w.st==='ship' && w.ship ? trackHTML(w.ship) : ''}
          <div class="row" style="gap:8px">${tagOf(w)}${w.st==='stored' ? (() => { const x = daysLeft(w.at); return x.d <= 0 ? '<span class="tag bad">今日到期</span>' : x.d <= 7 ? `<span class="tag warn">${x.d} 天後到期</span>` : ''; })() : w.st==='ship'?(w.ship && ['已出貨','已送達'].includes(w.ship.st) ? '<span class="tag info">運送中</span>' : '<span class="tag warn">揀貨中</span>'):w.st==='done'?'<span class="tag ok">已簽收</span>':w.st==='recycled'?'<span class="tag">已轉 CC幣</span>':''}</div></div>
      </label>`).join('')}</div>` : `<div class="empty">${S.whTab==='stored'?'倉庫目前是空的，去抽一抽吧！<br><br><a class="btn gold" href="#/lobby">前往抽賞大廳</a>':'沒有紀錄'}</div>`}
    ${S.whTab==='stored' && list.length ? `<div class="actbar"><span class="t">已選 <b class="num">${n}</b> 件</span>
      <button class="btn" data-act="recycle" ${n?'':'disabled'}>${ic('recycle','width:18px;height:18px')}回收換 CC幣</button>
      <button class="btn gold" data-act="ship" ${n?'':'disabled'}>${ic('truck','width:18px;height:18px')}申請出貨</button></div>` : ''}
  </div>`;
};
/* 寄送方式由後台於上架時依獎品預設，會員不可選；不同方式分開出貨，運費到付 */
function whShip(w){ if (w.sm) return w.sm; const p = poolById(w.pool), pr = p && p.prizes.find(x => x.name === w.pname);
  return (pr && pr.ship) || (typeof isBulky === 'function' && isBulky(w) ? 'home' : 'c711'); }
function shipGroups(ids){ const g = {}; S.wh.filter(w => ids.includes(w.id)).forEach(w => { const m = whShip(w); (g[m] = g[m] || []).push(w); });
  const ord = Object.keys(SHIP_M); return Object.entries(g).sort((a, b) => ord.indexOf(a[0]) - ord.indexOf(b[0])); }
function shipDialog(){
  const n = S.whSel.length; if (!n) return;
  const G = shipGroups(S.whSel), A = (S.profile && S.profile.addrs) || [], def = A.find(a => a.def) || A[0] || {}, esc = typeof hx === 'function' ? hx : (x => x);
  openModal(`<h3 id="mdlT">申請出貨（${n} 件）</h3>
    <p class="dim" style="font-size:12px;margin:0 0 16px">每件獎品的寄送方式已由平台預先設定，無法變更；不同寄送方式將分成 ${G.length} 張出貨單寄出。</p>
    <div class="field" style="margin-bottom:16px"><label for="rcv">收件人</label><input class="input" id="rcv" autocomplete="name" value="${esc(def.name || '')}" placeholder="真實姓名（取件需核對證件）"></div>
    <div class="field" style="margin-bottom:16px"><label for="rcvP">收件人手機</label><input class="input" id="rcvP" inputmode="tel" autocomplete="tel" value="${def.phone ? phoneFmt(def.phone) : ''}" placeholder="09xx-xxx-xxx"></div>
    ${G.map(([m, ws]) => { const opts = A.filter(a => a.m === m), d = opts.find(a => a.def) || opts[0];
      return `<div class="shgrp">
        <div class="shgrp-h"><span class="tag ${m === 'home' ? 'info' : ''}">${SHIP_M[m]}</span><b class="num">${ws.length} 件</b></div>
        <p class="shgrp-n">${ws.map(w => esc(w.pname || w.name)).join('、')}</p>
        ${opts.length ? `<div class="field" style="margin-bottom:8px"><label for="shAd_${m}">常用${m === 'home' ? '地址' : '門市'}</label><select class="input" id="shAd_${m}" data-act="y-shad" data-m="${m}">${opts.map(a => `<option value="${a.id}" ${a === d ? 'selected' : ''}>${esc(a.addr)}</option>`).join('')}<option value="">手動填寫</option></select></div>` : ''}
        <div class="field"><label for="addr_${m}">${m === 'home' ? '收件地址' : '取貨門市'}</label><input class="input" id="addr_${m}" value="${d ? esc(d.addr) : ''}" placeholder="${m === 'home' ? '縣市／區／路段門牌' : '門市名稱或店號'}" autocomplete="street-address"></div>
      </div>`; }).join('')}
    <div class="sumrow" style="border-bottom:0"><span class="muted">運費</span><b>運費到付</b></div>
    <p class="dim" style="font-size:12px;margin:0 0 16px">申請出貨不需先付運費，由物流業者於送達（宅配）或取件（超商）時向收件人收取，金額依物流業者公告。出貨後可於「出貨中」查看物流追蹤。</p>
    <button class="btn gold block" data-act="ship-ok">確認出貨（${G.length} 張出貨單）</button>`);
}
function recycleDialog(){
  const items = S.wh.filter(w => S.whSel.includes(w.id));
  const pts = items.reduce((s,w) => s + (w.rv||0), 0);
  const blocked = items.filter(w => !w.rv);
  openModal(`<h3 id="mdlT">回收換 CC幣</h3>
    ${items.map(w => `<div class="sumrow"><span style="display:flex;gap:8px;align-items:center;min-width:0">${tagOf(w,true)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${w.name}</span></span><b>${w.rv ? '+'+fmt(w.rv) : '不可回收'}</b></div>`).join('')}
    <div class="sumrow" style="border-bottom:0;min-height:56px"><span>合計（不可退款 CC幣）</span><b style="font-size:20px;color:var(--gold-2)">+${fmt(pts)}</b></div>
    <p class="dim" style="font-size:12px;margin:0 0 16px">回收值依各套公開之設定計算，回收所得一律為<b>不可退款 CC幣</b>：抽賞時與一般 CC幣等值使用，但不得申請退款或兌換現金；確認回收後無法撤回。${blocked.length?`<br>其中 ${blocked.length} 件不提供回收。`:''}</p>
    <button class="btn gold block" data-act="recycle-ok" ${pts?'':'disabled'}>確認回收</button>`);
}

/* =========================================================
   WALLET (儲值 / 交易紀錄)
   ========================================================= */
const PACKS = [[500,0],[1000,0],[3000,30],[5000,80],[10000,200],[30000,800]];
const PAYS = [['card','信用卡','card','綠界'],['atm','ATM 虛擬帳號','bank','綠界'],['cvs','超商代碼','store','綠界'],['bank','銀行轉帳','bank','人工對帳']];
routes.wallet = () => `<div class="wrap">
  <div class="page-h"><h1>錢包與儲值</h1><p>站內統一使用 CC幣；抽賞時每 1 CC幣價值相同，差別只在是否可申請退款。</p></div>
  <div class="wal-top">
    <div class="balance main"><span>CC幣餘額</span><b><span class="coin" style="width:32px;height:32px;font-size:16px">C</span><span class="num">${fmt(S.coins)}</span></b><small>可退款 ${fmt(S.coins - S.coinsNR)} ・ 不可退款 ${fmt(S.coinsNR)}</small></div>
    <div class="balance"><span>扣款順序</span><b style="font-size:18px">先扣不可退款</b><small>不可退款 CC幣用完後才扣可退款 CC幣</small></div>
    <div class="balance"><span>可用優惠券</span><b class="num">${myCoupons().length}</b><small><a href="#/me">查看優惠券</a></small></div>
  </div>
  <div class="layout2" style="margin-top:32px">
    <div class="panel">
      <h3>選擇儲值金額</h3>
      <div class="packs" role="radiogroup" aria-label="儲值金額">${PACKS.map(([v,b]) => `<button class="pack" role="radio" data-act="pack" data-v="${v}" aria-checked="${S.pick.pack===v}" aria-pressed="${S.pick.pack===v}">
        ${b?`<em>+${b} CC幣</em>`:''}<b><span class="coin" style="width:20px;height:20px;font-size:11px">C</span>${fmt(v)}</b><span>NT$ ${fmt(v)}</span></button>`).join('')}</div>
      <h3 style="margin-top:32px">付款方式</h3>
      <div class="pays" role="radiogroup" aria-label="付款方式">${PAYS.map(([k,t,i,s]) => `<button class="pay" role="radio" data-act="paym" data-k="${k}" aria-checked="${S.pick.pay===k}" aria-pressed="${S.pick.pay===k}" style="flex-direction:column;height:72px;gap:4px">${ic(i,'width:20px;height:20px')}<span>${t}</span><span class="dim" style="font-size:11px">${s}</span></button>`).join('')}</div>
      <div class="field" style="margin-top:24px"><label for="promo">邀請碼／優惠碼（選填）</label><div class="invite"><input class="input" id="promo" placeholder="輸入代碼"><button class="btn" data-act="promo">套用</button></div></div>
      <hr class="sep">
      <div class="sumrow" style="border-bottom:0"><span class="muted">應付金額</span><b style="font-size:22px">NT$ ${fmt(S.pick.pack)}</b></div>
      <button class="btn gold block" style="margin-top:16px" data-act="topup">前往付款</button>
      <p class="dim" style="font-size:12px;margin:12px 0 0">付款由綠界科技 ECPay 處理，本平台不儲存任何信用卡資料。</p>
    </div>
    <div class="panel">
      <h3 class="row between">交易紀錄 ${S.tx.length > 8 ? `<button class="btn s ghost" data-act="txall" aria-expanded="${!!S.txAll}">${S.txAll ? '收合' : `全部 ${S.tx.length} 筆`}</button>` : ''}</h3>
      <div class="txl">${S.tx.slice(0, S.txAll ? S.tx.length : 8).map(x => `<div class="tx"><span class="ic">${ic(x.ic)}</span><div class="d"><b>${x.t}</b><span>${x.d}</span></div><span class="a ${x.a>0?'p':''}">${x.a>0?'+':''}${fmt(x.a)}${x.pt?' CC幣':''}${x.nr?'<br><span class="tag warn" style="height:20px;font-size:11px">不可退款</span>':''}</span></div>`).join('')}</div>
      <button class="btn block ghost" style="margin-top:16px" data-act="refund">${ic('doc','width:18px;height:18px')}申請未使用 CC幣退款</button>
    </div>
  </div></div>`;

/* =========================================================
   MEMBER CENTER
   ========================================================= */
routes.me = () => {
  const ips = [...new Set(POOLS.map(p => p.ip))];
  return `<div class="wrap">
  <div class="page-h"><h1>會員中心</h1></div>
  <div class="me-head">
    <span class="avatar" aria-hidden="true">C</span>
    <div class="who"><b>Chiaki 玩家</b><span class="dim" style="font-size:12px">UID 20261023-0001 ・ 2026-03 加入</span>
      <div class="row" style="gap:8px;flex-wrap:wrap"><span class="tag ok">手機已驗證</span>${S.verified?'<span class="tag ok">年齡已驗證</span>':'<span class="tag warn">年齡未驗證</span>'}<span class="tag">MFA 未啟用</span></div></div>
    <div class="vip"><div class="row"><b style="color:var(--gold-2);font-size:14px">${ic('crown','width:16px;height:16px;vertical-align:-3px')} VIP 2 ・ 銀籤</b><span>距 VIP 3 還差 6,200</span></div><div class="meter"><i style="width:58%"></i></div><span class="dim" style="font-size:11px">權益：生日點數、出貨優惠、新賞優先通知</span></div>
  </div>
  <div class="menu-grid">
    <button class="mg" data-act="scroll" data-to="me-draws">${ic('ticket')}抽賞紀錄</button><a class="mg" href="#/wallet">${ic('list')}消費紀錄</a>
    <button class="mg" data-act="scroll" data-to="me-coupon">${ic('gift')}優惠券</button><button class="mg" data-act="scroll" data-to="me-invite">${ic('users')}邀請好友</button>
    <button class="mg" data-act="scroll" data-to="me-follow">${ic('heart')}追蹤 IP</button><button class="mg" data-act="scroll" data-to="me-notify">${ic('bell')}通知設定</button>
    <button class="mg" data-act="scroll" data-to="me-sec">${ic('shield')}登入安全</button><a class="mg" href="#/support">${ic('help')}客服工單</a>
  </div>
  <div class="layout2" style="margin-top:32px">
    <div style="display:grid;gap:24px">
      <div class="panel" id="me-draws"><h3>抽賞紀錄 <span class="dim" style="font-size:12px;font-weight:400">保留最近 3 個月</span></h3>
        <div class="tbl-wrap" style="border:0;background:none"><table class="tbl" style="min-width:520px"><thead><tr><th>時間</th><th>賞池</th><th>籤號</th><th>結果</th></tr></thead><tbody>
          ${S.wh.filter(w => (new Date() - new Date(w.at)) / 864e5 <= 90).slice(0,8).map((w,i) => `<tr><td class="dim">${w.at}</td><td>${(poolById(w.pool)||{}).ip||'-'}</td><td class="num">${w.no ? 'No.' + pad(w.no) : '—'}</td><td>${tagOf(w,true)}</td></tr>`).join('')}
        </tbody></table></div><p class="dim" style="font-size:12px;margin:12px 0 0">抽賞紀錄僅保留最近 3 個月，超過者自最舊一筆起自動移除。</p></div>
      <div class="panel" id="me-notify"><h3>通知</h3>
        ${S.notifs.map(n => `<div class="tx"><span class="ic">${ic(n.ic)}</span><div class="d"><b style="font-weight:400">${n.t}</b><span>${n.d}</span></div></div>`).join('')}
        <h3 style="margin-top:24px">接收方式</h3>
        <div class="toggles">${[['inapp','站內通知'],['sms','簡訊'],['line','LINE'],['push','手機推播'],['email','Email']].map(([k,t]) => `<label class="tg"><input type="checkbox" data-act="x-notif" data-k="${k}" ${S.notifPref[k]?'checked':''} ${k==='inapp'?'disabled':''}><span>${t}</span></label>`).join('')}</div>
        <h3 style="margin-top:24px">通知項目</h3>
        <div class="toggles">${[['draw','抽賞結果'],['expiry','保管到期'],['ship','出貨與物流'],['refund','退款進度'],['ticket','客服回覆'],['news','新賞上架與活動']].map(([k,t]) => `<label class="tg"><input type="checkbox" data-act="x-notev" data-k="${k}" ${S.notifEv[k]?'checked':''}><span>${t}</span></label>`).join('')}</div></div>
      <div class="panel" id="me-follow"><h3>追蹤的 IP 與收藏喜好</h3>
        <p class="muted" style="font-size:13px;margin:0 0 16px">追蹤後，新賞池上架與開賣前 1 小時將通知你。</p>
        <div class="ipf">${ips.map(x => `<button class="chip" data-act="follow" data-ip="${x}" aria-pressed="${S.follow.includes(x)}">${S.follow.includes(x)?ic('check','width:14px;height:14px'):''}${x}</button>`).join('')}</div></div>
    </div>
    <div style="display:grid;gap:24px">
      <div class="panel" id="me-bind"><h3>綁定獎勵 <span class="tag" style="background:var(--gold);color:var(--gold-ink)">限定</span></h3>
        ${BIND_TASKS.map(t => { const st = S.binds[t.k]; return `<div class="task"><span class="ic">${ic(t.ic,'width:20px;height:20px;color:'+(t.c||'var(--gold-2)'))}</span>
          <div class="d"><b>${t.t}</b><span>${t.reward}</span></div>
          ${st === 'done' ? '<span class="tag ok">已領取</span>' : st === 'review' ? '<span class="tag warn">審核中</span>' : `<button class="btn s ${t.k==='line'||t.k==='group'?'line':''}" data-act="bind-task" data-k="${t.k}">${t.cta}</button>`}</div>`; }).join('')}
        <p class="dim" style="font-size:12px;margin:12px 0 0">LINE 官方帳號綁定完成後自動發放；IG／FB 追蹤獎勵經客服確認後於 3 個工作天內發放。</p></div>
      <div class="panel" id="me-invite"><h3>邀請好友</h3>
        <div class="invite"><code>${S.invite.code}</code><button class="btn" data-act="x-invite">${ic('copy','width:18px;height:18px')}複製連結</button></div>
        <div class="row between" style="margin:16px 0 8px;font-size:13px"><span>已成功邀請 <b class="num">${S.invite.ok}</b> / ${S.cfg.inviteGoal || S.invite.goal} 人</span><b style="color:var(--gold-2)">贈 ${fmt(S.cfg.inviteReward != null ? S.cfg.inviteReward : S.invite.reward)} 不可退款 CC幣</b></div>
        <div class="meter"><i style="width:${Math.min(100, S.invite.ok/(S.cfg.inviteGoal || S.invite.goal)*100)}%"></i></div>
        <p class="dim" style="font-size:12px;margin:12px 0 0">好友需完成註冊與手機驗證才計入；贈送之不可退款 CC幣為不可退款CC幣，如有疑問請聯絡官方小編。</p></div>
      <div class="panel" id="me-coupon"><h3>優惠券</h3>
        ${myCoupons().map(c => `<div class="coupon"><div class="l"><b>${(c.d.match(/(\d)\s*折/) || [])[1] ? c.d.match(/(\d)\s*折/)[1] + ' 折' : /免運/.test(c.d) ? '免運' : '優惠'}</b><span>${/免運/.test(c.d) ? '出貨' : '抽賞'}</span></div><div class="r"><b>${c.d}</b><span>${c.exp} 到期 ・ 代碼 ${c.code}</span></div></div>`).join('') || '<p class="muted" style="margin:0">目前沒有可用的優惠券</p>'}</div>
      <div class="panel" id="me-sec"><h3>登入與安全</h3>
        <div class="kv"><span>登入方式</span><b>手機 OTP ・ Google</b></div>
        <div class="kv"><span>兩步驟驗證 MFA</span><button class="btn s" data-act="mfa">啟用</button></div>
        <div class="kv"><span>減少動態效果</span><button class="btn s" data-act="rm-toggle" aria-pressed="${document.body.classList.contains('rm')}">${document.body.classList.contains('rm')?'已開啟':'關閉中'}</button></div>
        <div class="kv"><span>登入裝置</span><span class="dim" style="font-size:13px">iPhone ・ 台北 ・ 目前</span></div>
        <div class="kv"><span>收貨地址</span><a href="#/warehouse">管理</a></div></div>
    </div>
  </div></div>`;
};

const BIND_TASKS = [
  {k:'line', t:'綁定 LINE 官方帳號', reward:'抽賞 9 折券 ×1', cta:'綁定', ic:'chat', c:'#06c755', url:null},
  {k:'group', t:'加入 LINE 社群（GK 雕像討論／分享群）', reward:'不可退款 CC幣 +50', cta:'加入', ic:'users', c:'#06c755', url:LINKS.line, pts:50},
  {k:'ig', t:'追蹤 Instagram @chiaki_gk.studies', reward:'不可退款 CC幣 +30（人工審核）', cta:'前往', ic:'ig', url:LINKS.ig, review:true},
  {k:'fb', t:'追蹤 Facebook 粉絲專頁', reward:'不可退款 CC幣 +30（人工審核）', cta:'前往', ic:'fb', url:LINKS.fb, review:true},
  {k:'phone', t:'綁定手機・簡訊開賞通知', reward:'抽賞 95 折券 ×1', cta:'綁定', ic:'phone'}
];
function bindPopup(){
  openModal(`<div class="bind-hero" aria-hidden="true"><div class="fan">${kujiInner({rk:'C'},{sub:'No.12'})}${kujiInner({rk:'A'},{sub:'No.01'})}${kujiCover()}</div>
      <span class="spark" style="left:18%;top:28%"></span><span class="spark" style="left:80%;top:22%;animation-delay:.6s"></span><span class="spark" style="left:72%;top:76%;animation-delay:1.1s"></span><span class="spark" style="left:26%;top:72%;animation-delay:1.5s"></span></div>
    <h3 id="mdlT" style="text-align:center;padding:0">加入社群領會員限定優惠券</h3>
    <p class="muted" style="text-align:center;margin:0 0 24px;font-size:14px">最新開賞情報＋限定優惠券，直送你的 LINE</p>
    <a class="btn line block" href="${LINKS.line}" target="_blank" rel="noopener" data-act="bind-line">${ic('chat')}加入 LINE 社群</a>
    <div class="row" style="margin:24px 0 16px;gap:12px"><hr class="sep" style="flex:1;margin:0"><span class="dim" style="font-size:12px">或以簡訊接收開賞通知</span><hr class="sep" style="flex:1;margin:0"></div>
    <div class="phone-row"><label class="sr" for="bCc">國碼</label><select class="input" id="bCc" style="width:100%;padding:0 32px 0 12px"><option>TW +886</option></select>
      <label class="sr" for="bPhone">手機號碼</label><input class="input" id="bPhone" inputmode="tel" placeholder="請輸入手機號碼" autocomplete="tel-national"></div>
    <button class="btn gold block" style="margin-top:8px" data-act="bind-sms">立即訂閱</button>
    <p class="dim" style="font-size:12px;text-align:center;margin:16px 0 0">訂閱完全免費，可隨時取消。優惠券於綁定會員後發送至會員中心。</p>`);
}

/* =========================================================
   SHOP (直購)
   ========================================================= */
routes.shop = () => `<div class="wrap">
  <div class="page-h row between" style="align-items:flex-end;flex-wrap:wrap"><div><h1>直購商城</h1><p>固定價格購買，無機率抽取。</p></div>
    <button class="btn" data-act="cart">${ic('cart')}購物車 <span class="tag" style="background:var(--gold);color:var(--gold-ink)">${S.cart.length}</span></button></div>
  <div class="grid">${PRODUCTS.map(x => `<div class="pc reveal">
    <div class="badges">${x.stock<=10?'<span class="tag hot">庫存少量</span>':''}</div>
    ${art(x.hue || 30, '◆', '', x.name+' 商品圖')}
    <div class="body"><h3>${x.name}</h3><span class="dim" style="font-size:12px">${x.ip}</span>
      <div class="price">NT$ ${fmt(x.price)}</div>
      <button class="btn s block" data-act="addcart" data-id="${x.id}" style="margin-top:auto">${ic('plus','width:16px;height:16px')}加入購物車</button></div></div>`).join('')}</div></div>`;

/* =========================================================
   SUPPORT
   ========================================================= */
const DOCS = {
  terms:['使用者條款',[
    ['服務內容與帳號','CHIAKI 提供線上一番賞抽賞、直購商城、中獎倉庫保管與出貨等服務。會員應以真實資料註冊，每人限持有一個帳號，並妥善保管登入資訊。'],
    ['付費抽賞服務之性質','抽賞為支付固定費用、自公開獎池中隨機取得實體商品之服務。各賞池之獎項組成、數量、機率與規則均於賞池頁完整揭露，付款前請詳閱。'],
    ['CC幣與優惠券','站內統一使用 CC幣，抽賞時每 1 CC幣價值相同。CC幣分為可退款（儲值取得、未使用）與不可退款（活動贈送、獎品回收取得），扣款時先扣不可退款 CC幣；不可退款 CC幣不得申請退款或兌換現金。優惠券依各券面說明之條件與期限使用。'],
    ['獎品所有權與保管','抽賞完成後，獎品所有權即移轉予會員並存入中獎倉庫，自入庫日起免費保管 30 天，會員可隨時申請出貨；逾期未申請者，可回收之獎品依回收值自動轉為不可退款 CC幣，不可回收之獎品由客服另行通知處理。'],
    ['禁止行為','禁止以程式自動化操作、多重帳號、盜用他人支付工具或其他不正當方式使用本服務。違者本平台得暫停或終止帳號，並保留法律追訴權利。'],
    ['責任限制與爭議處理','因不可抗力或第三方系統異常致服務中斷時，本平台將盡速修復並依交易紀錄處理。對抽賞結果有疑義者，可於客服中心提出工單，本平台將調閱稽核紀錄回覆。'],
    ['條款修訂','本平台得修訂本條款，修訂內容將於網站公告並自公告日起生效；已發布賞池之規則不因條款修訂而變更。']]],
  privacy:['隱私權政策',[
    ['蒐集之個人資料','包括姓名、手機號碼、電子郵件、收件地址、出生日期、交易與抽賞紀錄，以及登入裝置與 IP 等使用紀錄。'],
    ['蒐集目的與利用期間','用於會員管理、交易履行、物流配送、客戶服務、年齡驗證、風險控管與法令遵循；於會員存續期間及法定保存期限內利用。'],
    ['年齡驗證資料','年齡驗證資料僅用於確認會員符合使用資格，並以加密方式保存，不作其他用途。'],
    ['第三方提供','僅於完成交易之必要範圍內，提供予金流服務商（綠界科技）與物流業者；除法令要求外，不會提供予其他第三方。'],
    ['資料安全','本平台採用傳輸加密、存取權限控管、操作稽核與定期備份等措施保護您的個人資料。'],
    ['當事人權利','您可依個人資料保護法請求查詢、閱覽、製給複製本、補充更正、停止蒐集處理利用或刪除，請透過客服中心提出。'],
    ['Cookie 使用','本網站使用 Cookie 維持登入狀態與偏好設定，您可於瀏覽器設定中停用，惟部分功能可能因此無法使用。']]],
  rules:['抽賞規則與機率揭露',[
    ['賞池組成與來源','每個賞池均公開獎項總數、剩餘數、商品來源與商品狀況。官方套組以 A 賞、B 賞等賞級標示；自製套組直接標示獎品名稱，並由平台公開設定大獎、中獎、小獎等級。混合套組逐項標示官方正版、CHIAKI 自製或合作工坊。'],
    ['選籤與鎖籤','會員可自行選擇剩餘籤號或使用隨機選籤；選定後保留 3 分鐘，逾時未付款即自動釋出。'],
    ['機率計算方式','採固定獎品清單、無放回抽取。各賞級機率 ＝ 該賞剩餘數 ÷ 總剩餘數，每完成一抽即時更新。'],
    ['保底挑戰','保底條件與保底專用庫存數量於賞池頁事前公開；保底獎品由專用庫存另行發放，不影響原籤表機率。保底庫存用罄即停止並公告。'],
    ['單挑賞池','單挑賞池完整揭露大賞與參加獎之數量，未抽中大賞者獲得參加獎。'],
    ['最後賞','抽出該套最後一籤之會員，額外獲得該賞池公告之最後賞。'],
    ['結果鎖定與驗證','賞池發布時即固定全部籤號與獎項對應，並公開 SHA-256 承諾雜湊；完售後公開完整籤表，任何人皆可自行驗證。'],
    ['斷線與重複付款','抽賞結果於付款完成時由伺服器確定，斷線、重新整理或略過動畫均不影響結果；重複送出之同筆交易僅扣款一次。']]],
  refund:['退款與配送規範',[
    ['未使用 CC幣退款','未使用之 CC幣可於客服中心或錢包頁提出退款申請，經審核後退還至原付款方式或指定帳戶；活動贈送及回收取得之不可退款 CC幣不予退還。'],
    ['抽賞商品之退換貨','抽賞屬隨機取得商品之服務，結果確定後恕不接受退換或更換賞級。'],
    ['瑕疵品處理','收到商品如有非人為之瑕疵或運送破損，請於簽收後 7 日內拍照並透過工單聯繫，本平台將協助補寄或換貨。'],
    ['配送方式與運費','每件獎品的寄送方式（宅配到府、7-ELEVEN 交貨便或全家店到店）由平台於上架時預先設定，並標示於賞池頁獎項表，會員無法自行變更；大型獎品依材積限制以宅配寄送。申請出貨時，不同寄送方式的獎品會分成不同出貨單。運費一律到付：抽賞與申請出貨時均不收取運費，由物流業者於送達或取件時向收件人收取，金額依物流業者公告。'],
    ['出貨時效','官方商品依官方出貨時程辦理，平台商品依平台公告之出貨時程辦理；材積超過超商限制之商品將改以宅配寄送。'],
    ['保管期限','獎品入庫後免費保管 30 天，到期前 7 天及到期當天以站內通知提醒；逾期未申請出貨者，可回收之獎品依回收值自動轉為不可退款 CC幣；不可回收之獎品（如大獎）不會自動轉換，將由客服另行通知處理。'],
    ['獎品回收','各獎品之回收值依各套設定公開於賞池頁；回收所得一律為不可退款 CC幣，抽賞時與一般 CC幣等值使用，但不得申請退款或兌換現金；確認回收後無法撤回。']]],
  minor:['未成年保護',[
    ['年齡限制','本平台付費抽賞服務限年滿 18 歲之會員使用。'],
    ['年齡驗證','首次付費抽賞前須完成手機驗證與出生日期確認，必要時本平台得要求提供進一步證明。'],
    ['未成年使用','經發現未滿 18 歲之會員進行付費抽賞，本平台將暫停其付費功能，並協助法定代理人辦理相關事宜。'],
    ['理性消費提醒','抽賞屬娛樂性消費，請依個人經濟能力量力而為。如需暫停帳號付費功能，可隨時透過客服中心申請。']]]
};
function docDialog(k){
  const d = DOCS[k]; if (!d) return;
  openModal(`<h3 id="mdlT">${d[0]}</h3><p class="dim" style="margin:0 0 24px;font-size:12px">最後更新：2026 年 10 月 23 日</p>
    <div class="doc">${d[1].map(([h,p],n) => `<section><h4>第 ${n+1} 條　${h}</h4><p>${p}</p></section>`).join('')}</div>`, {wide:true});
}
routes.support = () => `<div class="wrap">
  <div class="page-h"><h1>客服與公告</h1><p>常見問題、服務規範與問題回報。</p></div>
  <div class="layout2">
    <div style="display:grid;gap:24px">
      <div class="panel faq"><h3>常見問題</h3>
        ${[['抽賞結果是怎麼決定的？','賞池發布時即固定全部籤號與獎品對應，並公開 SHA-256 承諾雜湊。付款後伺服器確定結果，動畫僅為呈現，略過動畫或斷線都不會改變結果。'],
           ['機率如何計算？','採固定清單、無放回抽取。每個賞級的機率 = 該賞剩餘數 ÷ 總剩餘數，每抽一次即時更新於賞池頁。'],
           ['保底挑戰怎麼運作？','於賞池頁事前公開保底條件與保底專用庫存數量；保底庫存用罄即停止並公告。實際條款以法務審定版本為準。'],
           ['中獎後多久出貨？','官方商品依官方出貨時程，平台商品依平台公告之出貨時程辦理；獎品入庫後可隨時申請出貨，並可合併多件。'],
           ['運費怎麼計算？','運費一律到付。抽賞時和申請出貨時都不用先付運費，由物流業者在送達（宅配）或取件（超商）時向收件人收取。每件獎品的寄送方式是上架時就設定好的，可在賞池頁的獎項表看到。'],
           ['獎品可以放多久？','入庫後免費保管 30 天，到期前 7 天及到期當天會提醒；逾期未申請出貨的可回收獎品，將依回收值自動轉為不可退款 CC幣；大獎等不可回收的獎品則由客服另行通知。'],
           ['CC幣可以退款嗎？','未使用之 CC幣可依《退款與配送規範》提出申請，經審核後辦理退款；已用於抽賞之 CC幣恕不退還；活動贈送與獎品回收取得的不可退款 CC幣不得退款。扣款時會先扣不可退款 CC幣。'],
           ['回收 CC幣可以換現金嗎？','不行。不可退款 CC幣僅可在站內折抵使用，不得提領或兌換現金。']].map(([q,a],i) =>
          `<details ${i===0?'open':''}><summary>${q}${ic('down','width:16px;height:16px')}</summary><p>${a}</p></details>`).join('')}
      </div>
      <div class="panel"><h3>問題回報／工單</h3>
        <div class="field" style="margin-bottom:16px"><label for="tkType">問題類型</label><select class="input" id="tkType" style="width:100%"><option>抽賞結果爭議</option><option>儲值／付款</option><option>出貨／物流</option><option>帳號與安全</option><option>其他</option></select></div>
        <div class="field" style="margin-bottom:16px"><label for="tkNo">相關交易編號（選填）</label><input class="input" id="tkNo" placeholder="例：CK20261023-000123"></div>
        <div class="field" style="margin-bottom:16px"><label for="tkMsg">問題描述</label><textarea class="input" id="tkMsg" placeholder="請描述發生的狀況"></textarea></div>
        <button class="btn gold" data-act="ticket">送出工單</button>
      </div>
    </div>
    <div style="display:grid;gap:24px;align-content:start">
      <div class="panel"><h3>我的工單</h3>
        ${S.tickets.filter(t => t.user === 'Chiaki 玩家').map(t => `<div class="kv"><span>${t.subj}<br><span class="dim" style="font-size:12px">${t.id} ・ ${t.cat}</span></span><span class="tag ${t.st==='已結案'?'ok':'info'}">${t.st==='待用戶回覆'?'待您回覆':t.st}</span></div>`).join('')}</div>
      <div class="panel"><h3>服務規範</h3><div class="doclist"><a href="#/rules">遊戲規則與注意事項${ic('right','width:16px;height:16px')}</a>${Object.entries(DOCS).map(([k,d]) => `<a href="#/support" data-doc="${k}">${d[0]}${ic('right','width:16px;height:16px')}</a>`).join('')}</div></div>
      <div class="panel"><h3>官方社群</h3><div class="doclist">
        <a href="${LINKS.ig}" target="_blank" rel="noopener"><span class="row" style="gap:12px">${ic('ig')}Instagram ・ @chiaki_gk.studies</span>${ic('link','width:16px;height:16px')}</a>
        <a href="${LINKS.line}" target="_blank" rel="noopener"><span class="row" style="gap:12px">${ic('chat')}LINE 社群 ・ GK 雕像討論／分享群</span>${ic('link','width:16px;height:16px')}</a>
        <a href="${LINKS.fb}" target="_blank" rel="noopener"><span class="row" style="gap:12px">${ic('fb')}Facebook 粉絲專頁</span>${ic('link','width:16px;height:16px')}</a></div></div>
      <div class="panel"><h3>合作塗裝師・維修師</h3><div class="doclist">${PARTNERS.map(x => `<a href="${x.url}" target="_blank" rel="noopener"><span class="row" style="gap:12px">${ic(x.role.includes('塗裝')?'brush':'wrench')}<span>${x.role} ・ @${x.h}</span></span>${ic('link','width:16px;height:16px')}</a>`).join('')}</div>
        <p class="dim" style="font-size:12px;margin:8px 0 0">GK 塗裝、修復委託，歡迎直接聯繫合作夥伴。</p></div>
    </div>
  </div></div>`;

/* =========================================================
   ADMIN (overview mock)
   ========================================================= */
const ADM = [
  ['營運','dash','總覽','chart'],
  ['營運','pool','賞池管理','ticketbox',['建立賞池','編輯與規則版本','送審／雙人覆核','排程上架','結束與完售揭露']],
  ['營運','prize','獎品管理','gift',['獎品資料與圖片規格','數量與賞級','庫存連動','目前抽數','已創造實際收益']],
  ['營運','ip','IP 管理','grid'],
  ['營運','draw','抽賞管理','list',['購買紀錄','籤號與結果','承諾雜湊與規則版本','稽核軌跡（不可竄改）','異常重送與補償']],
  ['會員','member','會員管理','users',['搜尋與標籤','身分／年齡驗證狀態','帳號狀態（停權／凍結）','交易歷史']],
  ['會員','vip','VIP 系統','crown',['等級門檻','等級優惠','權益發放紀錄']],
  ['會員','cs','客服中心','help',['問題回報','爭議處理','工單紀錄與 SLA']],
  ['金流','wallet','錢包管理','wallet',['儲值紀錄','扣款／退款','可退款／不可退款分帳','對帳（綠界回調）']],
  ['金流','order','訂單管理','doc',['付款訂單','異常訂單','取消與退款','發票開立']],
  ['金流','refund','退款審核','recycle'],
  ['金流','report','報表中心','chart',['營運 GMV','毛利（成本 vs 收益）','轉換漏斗','用戶留存分析','未履約責任']],
  ['物流','ship','物流管理','truck',['出貨申請','揀貨單','物流狀態（超商／宅配）','退件處理','進貨與庫存盤點']],
  ['行銷','mkt','行銷管理','mega',['優惠券','Banner 排程','活動頁','分眾推播','邀請碼成效']],
  ['系統','notify','通知中心','bell'],
  ['系統','risk','防火牆與風控','alert',['異常抽賞偵測','刷單與多帳號','支付風險','IP／裝置指紋','風險名單']],
  ['系統','role','權限管理','lock',['角色','操作授權','高風險操作雙人覆核','操作日誌']],
  ['系統','set','系統設定','gear',['公告','費率與寄送','金流設定（綠界）','物流設定','保管期限']],
  ['系統','ext','擴充服務','api',['合作商家入駐','寄售與平台抽成','分潤結算','開放 API','外部連結 IG／LINE／FB']]
];
routes.admin = () => {
  const cur = ADM.find(a => a[1] === S.admin) || ADM[0];
  let grp = '';
  const side = ADM.map(a => { const g = a[0] !== grp ? `<div class="grp">${a[0]}</div>` : ''; grp = a[0];
    return g + `<button data-act="adm" data-k="${a[1]}" aria-current="${S.admin===a[1]}">${ic(a[3],'width:18px;height:18px')}${a[2]}${a[1]==='risk'?(S.blocked.length?`<span class="bd">${S.blocked.length}</span>`:''):a[1]==='ship'?`<span class="bd" style="background:var(--warn)">${S.shipments.filter(x=>!['已出貨','已送達'].includes(x.st)).length}</span>`:a[1]==='cs'?`<span class="bd">${S.tickets.filter(t=>t.st==='待處理').length}</span>`:a[1]==='refund'?(S.refunds.some(f=>f.st==='待審核')?`<span class="bd" style="background:var(--warn)">${S.refunds.filter(f=>f.st==='待審核').length}</span>`:''):a[1]==='forum'?(forumPending()?`<span class="bd" style="background:var(--warn)">${forumPending()}</span>`:''):a[1]==='pool'?((S.poolDrafts||[]).some(d=>d.st==='待覆核')?`<span class="bd" style="background:var(--warn)">${S.poolDrafts.filter(d=>d.st==='待覆核').length}</span>`:''):''}</button>`; }).join('');
  const live = POOLS.filter(p => !p.soon);
  const poolTable = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>賞池</th><th>來源／玩法</th><th class="r">單價</th><th class="r">已抽 / 總數</th><th class="r">實際收益</th><th>狀態</th><th></th></tr></thead><tbody>
    ${POOLS.map(p => { const d = soldAll(p); return `<tr><td>${p.title.split(' ～')[0]}</td><td><span class="tag ${SRC[p.src].c}">${SRC[p.src].t.slice(0,2)}</span> <span class="dim" style="font-size:12px">${PLAY[p.play]}</span></td>
      <td class="r">${fmt(p.price)}</td><td class="r">${d} / ${totalAll(p)}</td><td class="r">${fmt(d*p.price)}</td>
      <td>${p.soon?'<span class="tag info">排程上架</span>':remaining(p)?'<span class="tag ok">上架中</span>':'<span class="tag">已完售</span>'}</td><td><button class="btn s ghost" data-act="x-pooled" data-k="${p.id}">編輯</button></td></tr>`; }).join('')}
    </tbody></table></div>`;
  const body = ADM_VIEWS[cur[1]] ? ADM_VIEWS[cur[1]]() : cur[1] === 'dash' ? `
    <div class="kpis">
      <div class="kpi"><span>今日 GMV</span><b>NT$ 86,450</b><em>▲ 12% vs 昨日</em></div>
      <div class="kpi"><span>累計抽數</span><b>${fmt(live.reduce((s,p)=>s+soldAll(p),0))}</b><em style="color:var(--tx-3)">全部賞池・全部套數</em></div>
      <div class="kpi"><span>新註冊會員</span><b>42</b><em>轉換率 18%</em></div>
      <div class="kpi"><span>待出貨件數</span><b style="color:var(--warn)">12</b><em style="color:var(--tx-3)">最久 2 天</em></div>
    </div>
    <div class="agrid">
      <div><div class="row between" style="margin-bottom:12px"><b>賞池管理</b><button class="btn s gold" data-act="x-pooled">${ic('plus','width:16px;height:16px')}建立賞池</button></div>${poolTable}</div>
      <div class="panel"><h3>風控警示 <span class="tag bad">1</span></h3>
        <div class="risk"><span class="dot" style="background:var(--bad)"></span><div><b>同裝置 4 帳號連續搶籤</b><div class="dim">航海王 ・ 10:42 ・ 已暫停鎖籤權限</div></div></div>
        <h3 style="margin-top:24px">待辦覆核</h3>
        <div class="risk"><span class="dot" style="background:var(--info)"></span><div><b>賞池發布：CHIAKI GK 第一彈 第 3 套</b><div class="dim">建立者：營運 A ・ 需第二人覆核</div></div></div>
      </div>
    </div>` : `
    <div class="feat">${cur[4].map(f => `<div><b>${f}</b><p>${featDesc(f)}</p></div>`).join('')}</div>
    ${['pool','prize','draw'].includes(cur[1]) ? `<div style="margin-top:24px">${poolTable}</div>` : ''}`;
  return `<div class="adm-mtabs" role="tablist" aria-label="後台模組">${ADM.map(a => `<button class="chip ${S.admin===a[1]?'on':''}" data-act="adm" data-k="${a[1]}">${a[2]}</button>`).join('')}</div>
  <div class="admin">
    <aside class="aside" aria-label="後台選單">${side}</aside>
    <div class="amain">
      <div class="row between" style="margin-bottom:24px;flex-wrap:wrap"><div><h1 style="margin:0;font-family:var(--serif-tc);font-size:24px">${cur[2]}</h1><span class="dim" style="font-size:12px">CHIAKI 管理後台 ・ 角色：超級管理員</span></div>
        <div class="row" style="gap:8px"><span class="tag ok">${ic('shield','width:14px;height:14px')} MFA 已驗證</span><button class="btn s ghost" data-act="x-logout">登出</button></div></div>
      ${body}
    </div>
  </div>`;
};
function featDesc(f){
  const m = {'建立賞池':'設定來源、玩法、單價、獎項與籤數，自動產生籤表','編輯與規則版本':'發布後鎖定，修改即產生新版本並公告','送審／雙人覆核':'高風險操作需第二位管理員核准',
    '已創造實際收益':'已抽數 × 單價，扣除優惠折抵','稽核軌跡（不可竄改）':'所有操作紀錄僅可新增，任何竄改皆可偵測','對帳（綠界回調）':'付款通知驗證、重複通知防護、每日自動對帳',
    '合作商家入駐':'商家申請、審核、商家後台與權限','寄售與平台抽成':'寄售品管理與抽成規則','異常抽賞偵測':'搶籤頻率、重試、多帳號同裝置'};
  return m[f] || '';
}

/* =========================================================
   HERO — layered motion (floating kuji papers + gold dust)
   ========================================================= */
function heroFx(){
  const cv = $('#heroCv'), hero = $('#hero'); if (!cv) return;
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, raf = 0, vis = true, mx = 0, my = 0, tx = 0, ty = 0;
  const mob = innerWidth < 600;
  const T = [], P = [];
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
    im.onload = () => { const c = document.createElement('canvas'); c.width = 300; c.height = 204; const g = c.getContext('2d');
      g.beginPath(); if (g.roundRect) g.roundRect(0,0,300,204,10); else g.rect(0,0,300,204); g.clip(); g.drawImage(im,0,0,300,204); IMG[key] = c; };
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  };
  raster(kujiCover(), 'front'); raster('<svg viewBox="0 0 300 204"><rect width="300" height="204" rx="10" fill="#050505"/><rect x="1" y="1" width="298" height="202" rx="9" fill="none" stroke="rgba(255,255,255,.08)"/></svg>', 'back');
  function ticket(t, sy){
    const w = 44 + 76*t.z, h = w*.68;
    const px = t.x + tx*36*t.z, py = t.y + ty*24*t.z - sy*.35*t.z;
    const flip = Math.cos(t.f), im = flip >= 0 ? IMG.front : IMG.back;
    if (!im) return;
    ctx.save(); ctx.translate(px, py); ctx.rotate(t.r); ctx.scale(Math.max(.05, Math.abs(flip)), 1);
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
    for (const t of T){ t.sw += .01; t.wx *= .96; t.wy *= .96; t.vr *= .985; t.vf += (t.vf0 - t.vf) * .02;
      t.y += t.vy + t.wy; t.x += t.vx + t.wx + Math.sin(t.sw)*.35*t.z; t.r += t.vr; t.f += t.vf;
      if (t.y > H + 120){ t.y = -120; t.x = rnd(0,W); } if (t.x < -140) t.x = W + 140; if (t.x > W + 140) t.x = -140;
      ticket(t, sy); }
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
  const askMotion = () => { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') DeviceMotionEvent.requestPermission().catch(() => {}); hero.removeEventListener('touchend', askMotion); };
  hero.addEventListener('touchend', askMotion, {passive:true});
  addEventListener('devicemotion', onShake, {passive:true});
  const onTilt = e => { if (e.gamma == null) return; mx = Math.max(-1, Math.min(1, e.gamma/30)); my = Math.max(-1, Math.min(1, (e.beta-45)/30)); };
  addEventListener('pointermove', onMove, {passive:true});
  addEventListener('deviceorientation', onTilt, {passive:true});
  addEventListener('resize', resize);
  const io = new IntersectionObserver(([e]) => { vis = e.isIntersecting; cancelAnimationFrame(raf); if (vis) raf = requestAnimationFrame(frame); });
  io.observe(hero);
  frame();
  cleanup.push(() => { cancelAnimationFrame(raf); io.disconnect(); removeEventListener('pointermove', onMove); removeEventListener('deviceorientation', onTilt); removeEventListener('devicemotion', onShake); hero.removeEventListener('touchend', askMotion); removeEventListener('resize', resize); });
}

/* carousel with autoplay + swipe */
function carousel(){
  const c = $('#car'); if (!c) return;
  const slides = $$('.slide', c), dots = $$('.dots button', c);
  let i = 0, tm = 0, x0 = null;
  const go = n => { i = (n + slides.length) % slides.length;
    slides.forEach((s,k) => s.classList.toggle('on', k === i));
    dots.forEach((d,k) => { d.setAttribute('aria-current', k === i); const ii = d.querySelector('i'); ii.replaceWith(ii.cloneNode()); });
    clearTimeout(tm); if (!RM()) tm = setTimeout(() => go(i+1), 6000); };
  dots.forEach((d,k) => d.addEventListener('click', () => go(k)));
  c.addEventListener('pointerdown', e => x0 = e.clientX);
  c.addEventListener('pointerup', e => { if (x0 == null) return; const dx = e.clientX - x0; if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1)); x0 = null; });
  c.addEventListener('mouseenter', () => clearTimeout(tm));
  c.addEventListener('mouseleave', () => go(i));
  go(0);
  cleanup.push(() => clearTimeout(tm));
}

/* =========================================================
   EVENTS (delegated)
   ========================================================= */
document.addEventListener('click', e => {
  const doc = e.target.closest('[data-doc]');
  if (doc){ e.preventDefault(); if (parseHash().name !== 'support' && doc.closest('footer')){ S.pendingDoc = doc.dataset.doc; location.hash = '#/support'; } else docDialog(doc.dataset.doc); return; }
  const tk = e.target.closest('[data-tk]');
  if (tk){ toggleTicket(+tk.dataset.tk); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  const acts = {
    'close-modal': () => closeModal(),
    'quick': () => quickPick(el.dataset.n),
    'buy': () => { if ($('#fsBar')) closeModal(); buyDialog(); },
    'fullboard': () => fullBoard(),
    'verify': () => { const ph = $('#vPhone').value.replace(/[-\s]/g,''), b = $('#vBirth').value, min = (S.cfg && S.cfg.ageMin) || 18;
      if (!/^09\d{8}$/.test(ph)){ toast('請輸入正確的手機號碼（09 開頭共 10 碼）'); $('#vPhone').focus(); return; }
      if (!b){ toast('請填寫出生年月日'); $('#vBirth').focus(); return; }
      const [y, m, d] = b.split('-').map(Number), t = twDate().split('-').map(Number);
      const age = t[0] - y - ((t[1] < m || (t[1] === m && t[2] < d)) ? 1 : 0);
      if (!(age >= min) || age > 120){ toast(age < min ? `付費抽賞限年滿 ${min} 歲之會員使用` : '請確認出生年月日'); $('#vBirth').focus(); return; }
      if (!$('#vOk').checked){ toast('請勾選年齡確認'); $('#vOk').focus(); return; }
      S.verified = true; closeModal(); toast('身分驗證完成'); buyDialog(); },
    'confirm-buy': () => confirmBuy(),
    'next': () => { if (!D || D.busy) return; if (D.i >= D.results.length) showSummary(); else nextTicket(); },
    'auto': () => { if (!D) return; D.auto = !D.auto; el.setAttribute('aria-pressed', D.auto); el.textContent = D.auto ? '自動撕開中' : '全部自動撕開';
      if (D.auto){ if (!D.done && !D.busy) autoPeel(); else if (D.done && !D.busy && D.i < D.results.length) nextTicket(); } },
    'skip': () => { if (D){ D.auto = false; showSummary(); } },
    'close-stage': () => closeStage(),
    'rm-toggle': () => { document.body.classList.toggle('rm'); const on = document.body.classList.contains('rm'); el.setAttribute('aria-pressed', on); toast(on ? '已開啟減少動態效果' : '已關閉減少動態效果'); if (parseHash().name === 'me') render(true); },
    'follow': () => { const ip = el.dataset.ip; const i = S.follow.indexOf(ip); if (i >= 0) S.follow.splice(i,1); else S.follow.push(ip); toast(i >= 0 ? `已取消追蹤 ${ip}` : `已追蹤 ${ip}，上新將通知你`); render(true); },
    'notify': () => toast('已設定開賣提醒'),
    'toggle-filter': () => { const f = $('#filters'); S.filterOpen = f.classList.toggle('open'); el.setAttribute('aria-expanded', S.filterOpen); },
    'open-search': () => { openModal(`<h3 id="mdlT">搜尋</h3><form data-act="search" class="invite" role="search"><label class="sr" for="mq">關鍵字</label><input class="input" id="mq" name="q" type="search" placeholder="作品、角色、英文名或標籤" autocomplete="off"><button class="btn gold" type="submit">搜尋</button></form>
        <p class="dim" style="font-size:12px;margin:16px 0 8px">標籤</p><div class="ipf">${TAGS.map(c=>`<a class="chip" href="#/lobby?tag=${encodeURIComponent(c.k)}">${c.k}</a>`).join('')}</div><p class="dim" style="font-size:12px;margin:16px 0 8px">熱門 IP</p><div class="ipf">${[...new Set(POOLS.map(p=>p.ip))].map(x=>`<a class="chip" href="#/lobby?ip=${encodeURIComponent(x)}">${x}</a>`).join('')}</div>`); setTimeout(() => { const m = $('#mq'); m && m.focus(); }, 60); },
    'set': () => { const p = curPool(); if (!p || (p.sets[+el.dataset.k] || {}).off) return; clearHold(); p.setIdx = +el.dataset.k; render(true); },
    'bind-line': () => { S.binds.group = 'done'; S.coins += 50; S.coinsNR += 50; syncBal(); closeModal(); toast('歡迎加入 LINE 社群，已獲得 50 不可退款 CC幣'); if (parseHash().name === 'me') render(true); },
    'bind-sms': () => { const v = ($('#bPhone')||{}).value || ''; if (!/^0?9\d{8}$/.test(v.replace(/[-\s]/g,''))){ toast('請輸入正確的手機號碼'); $('#bPhone').focus(); return; } closeModal(); toast('訂閱成功，開賞消息將以簡訊通知'); },
    'bind-task': () => { const k = el.dataset.k, t = BIND_TASKS.find(x => x.k === k); if (!t) return;
      if (t.url) window.open(t.url, '_blank', 'noopener');
      S.binds[k] = t.review ? 'review' : 'done'; if (!t.review && t.pts){ S.coins += t.pts; S.coinsNR += t.pts; syncBal(); }
      toast(t.review ? '已送出，將由客服人工審核發放' : `已完成：${t.reward}`); render(true); },
    'scroll': () => { const t = document.getElementById(el.dataset.to); if (t){ t.scrollIntoView({behavior: RM() ? 'auto' : 'smooth', block:'start'}); if (t.tabIndex < 0 && !/^(A|BUTTON|INPUT)$/.test(t.tagName)) t.setAttribute('tabindex','-1'); t.focus({preventScroll:true}); } },
    'whtab': () => { S.whTab = el.dataset.k; S.whSel = []; render(true); },
    'whall': () => { const ids = S.wh.filter(w => w.st === 'stored').map(w => w.id); S.whSel = S.whSel.length === ids.length ? [] : ids; render(true); },
    'ship': () => shipDialog(),
    'shipm': () => { S.shipM = el.dataset.k; $$('[data-act="shipm"]').forEach(b => { b.setAttribute('aria-pressed', b === el); b.setAttribute('aria-checked', b === el); });
      const home = el.dataset.k === 'home'; $('#addrL').textContent = home ? '收件地址' : '取貨門市'; $('#addr').placeholder = home ? '縣市／區／路段門牌' : '選擇門市（串接超商電子地圖）'; },
    'ship-ok': () => { const rcv = $('#rcv').value.trim(), ph = $('#rcvP').value.replace(/[-\s]/g,''), G = shipGroups(S.whSel);
      if (!rcv){ toast('請填寫收件人姓名'); $('#rcv').focus(); return; }
      if (!/^09\d{8}$/.test(ph)){ toast('請輸入正確的收件人手機'); $('#rcvP').focus(); return; }
      for (const [m] of G){ const f = $('#addr_' + m); if (f.value.trim().length < (m === 'home' ? 6 : 2)){ toast(m === 'home' ? '請填寫完整收件地址' : `請填寫${SHIP_M[m]}取貨門市`); f.focus(); return; } }
      const ids = [];
      G.forEach(([m, its]) => { const sh = {id:'SH-' + String(14 + S.shipments.length).padStart(4,'0'), user:'Chiaki 玩家', items:its.length, m, st:'申請', carrier:'', no:'', to:$('#addr_' + m).value.trim(), at:twNow(), t:Date.now(), rcv, phone:ph, cod:true, log:[{st:'申請', at:twNow(), by:'會員', note:'運費到付'}], names:its.map(w => w.pname || w.name), bulky:typeof isBulky === 'function' && its.some(isBulky)};
        S.shipments.unshift(sh); ids.push(sh.id); its.forEach(w => { w.st = 'ship'; w.track = sh.id; w.ship = sh; w.sm = w.sm || m; }); });
      S.whSel = []; closeModal(); render(true); toast(`已申請出貨，出貨單 ${ids.join('、')}（運費到付）`); },
    'recycle': () => recycleDialog(),
    'recycle-ok': () => { let v = 0; S.wh.forEach(w => { if (S.whSel.includes(w.id) && w.rv){ w.st = 'recycled'; v += w.rv; } });
      S.coins += v; S.coinsNR += v; syncBal();
      S.tx.unshift({t:'回收獎品 → 不可退款 CC幣', d:twNow(), a:v, ic:'recycle', nr:true}); S.whSel = []; closeModal(); render(true); toast(`已回收，獲得 ${fmt(v)} 不可退款 CC幣`); },
    'pack': () => { S.pick.pack = +el.dataset.v; render(true); },
    'paym': () => { S.pick.pay = el.dataset.k; render(true); },
    'txall': () => { S.txAll = !S.txAll; render(true); },
    'promo': () => { const v = ($('#promo').value || '').trim().toUpperCase(); if (!v){ toast('請輸入邀請碼或優惠碼'); $('#promo').focus(); return; }
      const cp = (S.coupons || []).find(c => c.code === v && c.on);
      if (cp){ S.myCoupons = S.myCoupons || []; if (!S.myCoupons.includes(v)) S.myCoupons.push(v); toast(`已領取：${cp.d}`); }
      else if (/^CHK[0-9A-Z]{3}$/.test(v)) toast('邀請碼已綁定，完成首次儲值後雙方各得獎勵');
      else toast('查無此代碼或已過期，請確認大小寫與有效期限'); },
    'topup': () => { const v = S.pick.pack, b = (PACKS.find(p => p[0] === v)||[0,0])[1]; const pay = PAYS.find(p => p[0] === S.pick.pay);
      openModal(`<h3 id="mdlT">確認付款</h3><p class="muted" style="font-size:14px">即將前往綠界科技 ECPay 安全付款頁面，付款完成後CC幣將自動入帳。</p>
        <div class="sumrow"><span class="muted">付款方式</span><b>${pay[1]}</b></div><div class="sumrow"><span class="muted">金額</span><b>NT$ ${fmt(v)}</b></div>${b?`<div class="sumrow"><span class="muted">活動贈點</span><b>+${b} CC幣</b></div>`:''}
        <button class="btn gold block" style="margin-top:24px" data-act="paid">前往付款</button>`); },
    'paid': () => { const v = S.pick.pack, b = (PACKS.find(p => p[0] === v)||[0,0])[1]; S.coins += v + b; S.coinsNR += b; syncBal();
      S.tx.unshift({t:'儲值 ・ ' + PAYS.find(p => p[0] === S.pick.pay)[1], d:twNow(), a:v, ic:'card'}); closeModal(); render(true); toast(`儲值成功 +${fmt(v)} CC幣`); },
    'refund': () => { const can = Math.max(0, S.coins - S.coinsNR); openModal(`<h3 id="mdlT">申請未使用 CC幣退款</h3><p class="muted" style="font-size:14px">未使用之 CC幣可依《退款與配送規範》申請退款，客服將以 Email 通知審核結果。不可退款CC幣（活動、運費退還、逾期轉換）不在此列。</p>
        <div class="sumrow"><span class="muted">可申請退款</span><b>${fmt(can)} CC幣</b></div>${S.coinsNR ? `<div class="sumrow"><span class="muted">不可退款CC幣</span><b class="dim">${fmt(S.coinsNR)} CC幣</b></div>` : ''}
        <div class="field" style="margin:16px 0"><label for="rfAmt">申請金額（CC幣）</label><input class="input num" id="rfAmt" inputmode="numeric" value="${can}" data-max="${can}"></div><button class="btn gold block" data-act="refund-ok" ${can ? '' : 'disabled'}>送出申請</button>`); },
    'copy': () => copyText('CHK8A2', '邀請碼已複製'),
    'shipsel': () => { S.shipPick = el.dataset.k; const ok = $('#ruleOk') && $('#ruleOk').checked; if (ok) S.rulesOk = true; buyDialog(); },
    'refund-ok': () => { const inp = $('#rfAmt'), raw = inp.value.trim(), v = Number(raw), max = +inp.dataset.max;
      if (!/^\d+$/.test(raw) || v < 1){ toast('請輸入正整數金額'); inp.focus(); return; }
      if (v > max){ toast(`最多可申請 ${fmt(max)} CC幣`); inp.focus(); return; }
      const id = 'RF-' + twDate().replace(/-/g,'') + '-' + String(S.refunds.length + 1).padStart(4,'0');
      S.coins -= v; syncBal();
      S.refunds.unshift({id, user:'Chiaki 玩家', kind:'twd', via:'原付款方式退回', amt:v, st:'待審核', note:'未使用 CC幣退款', back:true});
      S.tx.unshift({t:`退款申請 ${id}（審核中，駁回時退回）`, d:twNow(), a:-v, ic:'card'});
      closeModal(); toast(`退款申請已送出，案件編號 ${id}`); render(true); },
    'mfa': () => toast('已寄送兩步驟驗證設定說明至您的信箱'),
    'addcart': () => { S.cart.push(el.dataset.id); toast('已加入購物車'); render(true); },
    'cart': () => { const items = S.cart.map(id => PRODUCTS.find(p => p.id === id)).filter(Boolean); const sum = items.reduce((s,x) => s + x.price, 0);
      openModal(`<h3 id="mdlT">購物車</h3>${items.length ? items.map((x,i) => `<div class="sumrow"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x.name}</span><span class="row" style="gap:8px;flex:none"><b>NT$ ${fmt(x.price)}</b><button class="ibtn" data-act="cartrm" data-k="${i}" aria-label="移除 ${x.name}">${ic('x','width:16px;height:16px')}</button></span></div>`).join('') + `<div class="sumrow" style="border-bottom:0;min-height:56px"><span>小計</span><b style="font-size:20px">NT$ ${fmt(sum)}</b></div><p class="dim" style="font-size:12px;margin:0 0 16px">商城商品以新台幣結帳，將前往綠界付款頁面；運費於結帳頁計算。</p><button class="btn gold block" data-act="checkout">前往結帳</button>` : '<p class="muted">購物車是空的</p>'}`); },
    'cartrm': () => { S.cart.splice(+el.dataset.k, 1); acts.cart(); if (parseHash().name === 'shop') render(true); },
    'checkout': () => { const sum = S.cart.map(id => PRODUCTS.find(p => p.id === id)).filter(Boolean).reduce((s,x) => s + x.price, 0), id = 'SO-' + twDate().replace(/-/g,'') + '-' + String(Math.floor(Math.random()*1e4)).padStart(4,'0');
      S.tx.unshift({t:`商城訂單 ${id}（綠界付款）`, d:twNow(), a:0, ic:'card'}); S.cart = []; closeModal(); toast(`訂單 ${id} 已成立，NT$ ${fmt(sum)} 已付款`); render(true); },
    'ticket': () => { const m = ($('#tkMsg')||{}).value || ''; if (!m.trim()){ toast('請描述問題內容'); $('#tkMsg').focus(); return; }
      const id = 'CS-10' + (27 + S.tickets.length); S.tickets.unshift({id, cat:$('#tkType').value.replace('抽賞結果爭議','抽賞爭議').replace('儲值／付款','儲值/付款').replace('出貨／物流','出貨/物流').replace('帳號與安全','帳號'), user:'Chiaki 玩家', subj:m.trim().slice(0,18), st:'待處理', due:+24, link:$('#tkNo').value || '—', msgs:[{f:'u', t:m.trim(), d:'剛剛'}]});
      toast(`工單已送出，編號 ${id}，客服將於 24 小時內回覆`); render(true); },
    'adm': () => { S.admin = el.dataset.k; render(true); }
  };
  if (acts[a]){ if (el.tagName === 'A' && a !== 'close-stage' && a !== 'close-modal') e.preventDefault(); acts[a](); }
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-act="sort"]')){ const r = parseHash(); r.q.set('sort', e.target.value); location.hash = '#/lobby?' + r.q.toString(); }
  if (e.target.matches('[data-act="whsel"]')){ const id = e.target.dataset.id; const i = S.whSel.indexOf(id); if (i >= 0) S.whSel.splice(i,1); else S.whSel.push(id); render(true); }
});
document.addEventListener('submit', e => {
  if (e.target.matches('[data-act="search"]')){ e.preventDefault(); const kw = e.target.q.value.trim(); location.hash = '#/lobby' + (kw ? '?q=' + encodeURIComponent(kw) : ''); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){ if ($('#modalRoot').innerHTML) closeModal(); else if (D && $('#sum.show')) closeStage(); }
});
addEventListener('resize', () => fx.resize());
addEventListener('scroll', () => $('#nav').classList.toggle('scrolled', scrollY > 8), {passive:true});
addEventListener('hashchange', () => { if ($('#stageRoot').innerHTML) closeStage(); closeModal(); render(); const de = document.documentElement; de.classList.add('rt'); window.scrollTo(0, 0); requestAnimationFrame(() => de.classList.remove('rt'));
  if (S.pendingDoc){ const k = S.pendingDoc; S.pendingDoc = null; docDialog(k); } });

</script>
